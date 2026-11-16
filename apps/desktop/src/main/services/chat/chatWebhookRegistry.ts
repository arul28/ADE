import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { isLocalHostname, isPrivateIpAddress, isPublicIpAddress, pinnedLookup } from "../net/publicHostGuard";
import { chatWaitTargetMatches } from "../../../shared/chatWait";
import type { Logger } from "../logging/logger";
import { createFileVersionTracker, writeFileAtomic } from "../state/durableFile";
import { securePrivatePath } from "../../../../../ade-cli/src/lib/trustedWindowsTools";

/**
 * Tells an outside URL when a chat stops needing no one: its turn is done, it
 * waits on input, or it failed. This is how something that is not running
 * right now (a cloud bot) hears about a chat; `chat.getChatEvents` is the
 * polling path for everything that can only make calls.
 *
 * Lives in the project's `.ade/secrets` folder (owner-only, on Windows by
 * ACL), never the project database: that one syncs between machines, and the
 * receiver's bearer key must not.
 *
 * Only the brain that runs a chat reads its state and queues news, so two
 * brains on one project never both report one change. A delivery already
 * queued (a retry after a restart, say) goes out from any brain no other live
 * brain runs the chat for. On write, a brain keeps only the state it changed
 * itself; everything else comes from the file.
 */

const FILE_NAME = "chat-webhooks.json";
const DEFAULT_LIFETIME_MS = 7 * 24 * 60 * 60_000;
const CHECK_DEBOUNCE_MS = 250;
const BACKSTOP_MS = 15_000;
const POST_TIMEOUT_MS = 10_000;
const MAX_WEBHOOKS = 200;
/** A removal is remembered past any webhook's lifetime, so no brain revives it. */
const REMOVED_KEEP_MS = DEFAULT_LIFETIME_MS + 24 * 60 * 60_000;
/** Delay before each try; one failed POST never loses the news, five do. */
const RETRY_DELAYS_MS = [0, 5_000, 30_000, 2 * 60_000, 10 * 60_000];

type ChatWebhookEvent = "chat.idle" | "chat.needs_input" | "chat.failed";

type ChatWebhookState = "idle" | "needs_input" | "failed";

type Delivery = { body: string; attempts: number; nextAt: number };

type StoredChatWebhook = {
  id: string;
  sessionId: string;
  url: string;
  token: string | null;
  createdAt: string;
  expiresAt: string;
  lastState: ChatWebhookState | null;
  seenRunning: boolean;
  /** The last turn ended failed. A chat's own status never says it: it goes idle, and only the turn's end event carries the failure. */
  lastTurnFailed?: boolean;
  deliveries: Delivery[];
};

type ChatWebhookView = Pick<StoredChatWebhook, "id" | "sessionId" | "url" | "createdAt" | "expiresAt"> & { hasToken: boolean };

type ArmChatWebhookArgs = { sessionId: string; url: string; token?: string | null };


/** A public https URL, or a sentence saying why it can't be one. */
export function chatWebhookUrlProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "The notify URL isn't a valid URL.";
  }
  if (url.protocol !== "https:") return "The notify URL must use https.";
  if (url.username || url.password) return "The notify URL can't carry a user name or password; use the notify token.";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // Other names are resolved and checked before each POST (`postPinned`).
  if (net.isIP(host) ? isPrivateIpAddress(host) : isLocalHostname(host)) {
    return "The notify URL must be a public address, not this computer or a private network.";
  }
  return null;
}

function stateOfChat(summary: Record<string, unknown>, lastTurnFailed: boolean): ChatWebhookState | null {
  if (chatWaitTargetMatches(summary, "awaiting-input")) return "needs_input";
  const settled = chatWaitTargetMatches(summary, "idle") || chatWaitTargetMatches(summary, "terminal");
  if (summary.status === "failed" || (settled && lastTurnFailed)) return "failed";
  return settled ? "idle" : null;
}

const EVENT_OF_STATE: Record<ChatWebhookState, ChatWebhookEvent> = {
  idle: "chat.idle",
  needs_input: "chat.needs_input",
  failed: "chat.failed",
};

/** `postPinned`'s answer when the URL's name points at this computer or a private network. */
const PRIVATE_ADDRESS = -1;

/**
 * POSTs to the address the name resolved to, checked public, so DNS can't
 * swap in a private one between the check and the request. 0 when it failed.
 */
async function postPinned(rawUrl: string, headers: Record<string, string>, body: string): Promise<number> {
  const url = new URL(rawUrl);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let target: { address: string; family: number };
  try {
    const addresses = await lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((entry) => !isPublicIpAddress(entry.address))) return PRIVATE_ADDRESS;
    target = addresses[0]!;
  } catch {
    // A name that does not resolve now is tried again like any failed POST, and logged when it is given up on.
    return 0;
  }
  return await new Promise<number>((resolve) => {
    const request = https.request(url, {
      method: "POST",
      headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
      lookup: pinnedLookup(target.address, target.family === 6 ? 6 : 4),
      timeout: POST_TIMEOUT_MS,
    }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(0));
    request.end(body);
  });
}

export function createChatWebhookRegistry(deps: {
  logger: Pick<Logger, "info" | "warn">;
  secretsDir: string;
  /** The chat's summary; null when it is gone. */
  readSummary: (sessionId: string) => Promise<Record<string, unknown> | null>;
  /** This brain runs the chat now. */
  runsHere: (sessionId: string) => boolean;
  /** Another live brain runs the chat. */
  ownedElsewhere: (sessionId: string) => boolean;
}) {
  const now = Date.now;
  const filePath = path.join(deps.secretsDir, FILE_NAME);
  /** What this brain last read or wrote, so it sees another brain's write even in the same timestamp tick. */
  const fileVersion = createFileVersionTracker(filePath);
  const warn = (event: string, error: unknown, data: Record<string, unknown> = {}) =>
    deps.logger.warn(event, { ...data, error: error instanceof Error ? error.message : String(error) });
  /**
   * The file: its webhooks, and the ids removed (cancelled, replaced or
   * expired), kept so another brain on this project drops them too. Null when
   * it could not be read, so a write would drop another brain's webhooks.
   */
  const load = (): { hooks: StoredChatWebhook[]; removed: Record<string, number> } | null => {
    try {
      const raw: unknown = JSON.parse(fileVersion.read());
      // The first version of the file was a bare list.
      const record = Array.isArray(raw) ? { hooks: raw } : (raw ?? {}) as { hooks?: unknown; removed?: unknown };
      const list = Array.isArray(record.hooks) ? (record.hooks as StoredChatWebhook[]).filter((entry) => typeof entry?.id === "string") : [];
      const tombstones = record.removed && typeof record.removed === "object" ? record.removed as Record<string, number> : {};
      return { hooks: list, removed: tombstones };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { hooks: [], removed: {} };
      warn("agent_chat.webhooks_read_failed", error);
      return null;
    }
  };
  const initial = load();
  /** Ids removed here or by another brain, and when; kept past any webhook's lifetime. */
  const removed = new Map<string, number>(Object.entries(initial?.removed ?? {}));
  let hooks = (initial?.hooks ?? []).filter((hook) => !removed.has(hook.id));
  const markRemoved = (id: string): void => {
    removed.set(id, now());
  };
  /** Takes in what another brain wrote: its removals win, its new webhooks are added. */
  const absorb = (onDisk: NonNullable<ReturnType<typeof load>>): void => {
    for (const [id, at] of Object.entries(onDisk.removed)) if (!removed.has(id)) removed.set(id, at);
    const known = new Set(hooks.map((hook) => hook.id));
    hooks = [...hooks.filter((hook) => !removed.has(hook.id)), ...onDisk.hooks.filter((hook) => !known.has(hook.id) && !removed.has(hook.id))];
  };
  /** Webhooks whose state this brain changed since its last write: its copy of those wins. */
  const changedHere = new Set<string>();
  const checksHook = (hook: StoredChatWebhook): boolean =>
    deps.runsHere(hook.sessionId) || (hook.deliveries.length > 0 && !deps.ownedElsewhere(hook.sessionId));
  let fileCheckedAt = 0;
  /** Another brain wrote the file since this one last looked (checked at most once a second). */
  const fileChanged = (): boolean => {
    if (now() - fileCheckedAt < 1_000) return false;
    fileCheckedAt = now();
    return fileVersion.changed();
  };
  /** Sessions with an event since the last check; the backstop checks every hook. */
  const signalled = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let backstop: ReturnType<typeof setInterval> | null = null;
  let checking = false;
  let recheck = false;
  let disposed = false;

  /**
   * Two brains can run one project (a dev brain beside the installed one).
   * A webhook this brain owns is written as it holds it; any other is taken
   * from the file, so neither brain overwrites the other's newer state.
   */
  const persist = (): void => {
    const onDisk = load();
    if (onDisk === null) return;
    const disk = new Map(onDisk.hooks.map((hook) => [hook.id, hook]));
    hooks = hooks.map((hook) => (changedHere.has(hook.id) || !disk.has(hook.id) ? hook : disk.get(hook.id)!));
    absorb(onDisk);
    changedHere.clear();
    const cutoff = now() - REMOVED_KEEP_MS;
    for (const [id, at] of removed) if (at < cutoff) removed.delete(id);
    try {
      fs.mkdirSync(deps.secretsDir, { recursive: true, mode: 0o700 });
      const text = JSON.stringify({ hooks, removed: Object.fromEntries(removed) });
      writeFileAtomic(filePath, text, { mode: 0o600 });
      // After the ACL: on Windows that changes the file's ctime.
      securePrivatePath(filePath);
      fileVersion.wrote(text);
    } catch (error) {
      warn("agent_chat.webhooks_persist_failed", error);
    }
  };

  const syncBackstop = (): void => {
    if (hooks.length === 0) {
      if (backstop) clearInterval(backstop);
      backstop = null;
    } else if (!backstop && !disposed) {
      backstop = setInterval(() => void check(null), BACKSTOP_MS);
      backstop.unref?.();
    }
  };

  const schedule = (): void => {
    if (timer || disposed) return;
    timer = setTimeout(() => {
      timer = null;
      const sessions = new Set(signalled);
      signalled.clear();
      void check(sessions);
    }, CHECK_DEBOUNCE_MS);
    timer.unref?.();
  };

  /** True when the delivery is finished with, delivered or given up on. */
  const post = async (hook: StoredChatWebhook, delivery: Delivery): Promise<boolean> => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "ADE chat webhook",
      ...(hook.token ? { authorization: `Bearer ${hook.token}` } : {}),
    };
    const status = await postPinned(hook.url, headers, delivery.body);
    if (status === PRIVATE_ADDRESS) {
      deps.logger.warn("agent_chat.webhook_private_address", { webhookId: hook.id, sessionId: hook.sessionId });
      return true;
    }
    if (status >= 200 && status < 300) return true;
    const permanent = status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429;
    delivery.attempts += 1;
    const delay = RETRY_DELAYS_MS[delivery.attempts];
    if (permanent || delay === undefined) {
      deps.logger.warn("agent_chat.webhook_dropped", { webhookId: hook.id, sessionId: hook.sessionId, status, attempts: delivery.attempts });
      return true;
    }
    delivery.nextAt = now() + delay;
    return false;
  };

  const checkHook = async (hook: StoredChatWebhook): Promise<boolean> => {
    let changed = false;
    // An expired webhook only finishes the deliveries it already queued.
    if (Date.parse(hook.expiresAt) > now() && deps.runsHere(hook.sessionId)) {
      const summary = await deps.readSummary(hook.sessionId).catch((error: unknown) => {
        warn("agent_chat.webhook_summary_failed", error, { webhookId: hook.id, sessionId: hook.sessionId });
        return null;
      });
      if (summary) {
        const state = stateOfChat(summary, hook.lastTurnFailed === true);
        if (state === null) {
          if (!hook.seenRunning || hook.lastState !== null) changed = true;
          hook.seenRunning = true;
          hook.lastState = null;
        } else if (state !== hook.lastState && (state !== "idle" || hook.seenRunning)) {
          hook.deliveries.push({
            body: JSON.stringify({
              event: EVENT_OF_STATE[state],
              sessionId: hook.sessionId,
              laneId: summary.laneId ?? null,
              title: summary.title ?? null,
              status: summary.status ?? null,
              at: new Date(now()).toISOString(),
            }),
            attempts: 0,
            nextAt: now(),
          });
          hook.lastState = state;
          if (state === "idle" || state === "failed") hook.seenRunning = false;
          changed = true;
        }
      }
    }
    for (const delivery of hook.deliveries.filter((entry) => entry.nextAt <= now() && !removed.has(hook.id))) {
      const finished = await post(hook, delivery);
      if (finished) hook.deliveries = hook.deliveries.filter((entry) => entry !== delivery);
      changed = true;
    }
    return changed;
  };

  /** Checks the webhooks of `sessions` (every one with null) that this brain owns. */
  const check = async (sessions: ReadonlySet<string> | null): Promise<void> => {
    if (disposed) return;
    if (checking) {
      for (const session of sessions ?? hooks.map((hook) => hook.sessionId)) signalled.add(session);
      recheck = true;
      return;
    }
    checking = true;
    try {
      // The full check also picks up webhooks another brain on this project armed for chats this one runs.
      // Any other check reads a changed file first, so it never posts a webhook another brain cancelled.
      if (sessions === null || fileVersion.changed()) {
        const onDisk = load();
        if (onDisk) absorb(onDisk);
      }
      let changed = false;
      for (const hook of hooks.filter((entry) => checksHook(entry) && (!sessions || sessions.has(entry.sessionId)))) {
        // Marked before the awaits: a write while this check reads or posts must keep this copy, not the file's.
        changedHere.add(hook.id);
        const hookChanged = await checkHook(hook).catch((error: unknown) => {
          warn("agent_chat.webhook_check_failed", error, { webhookId: hook.id, sessionId: hook.sessionId });
          return false;
        });
        // Again after: a write during the check cleared the mark, and this copy is still the newest.
        if (hookChanged) {
          changed = true;
          changedHere.add(hook.id);
        }
      }
      const at = now();
      const kept = hooks.filter((hook) => hook.deliveries.length > 0 || Date.parse(hook.expiresAt) > at);
      if (kept.length !== hooks.length) changed = true;
      for (const hook of hooks) if (!kept.includes(hook)) markRemoved(hook.id);
      hooks = kept;
      if (changed) persist();
      syncBackstop();
    } finally {
      checking = false;
      if (recheck) {
        recheck = false;
        schedule();
      }
    }
  };

  const view = (hook: StoredChatWebhook): ChatWebhookView => ({
    id: hook.id,
    sessionId: hook.sessionId,
    url: hook.url,
    createdAt: hook.createdAt,
    expiresAt: hook.expiresAt,
    hasToken: Boolean(hook.token),
  });

  return {
    /**
     * A chat emitted an event. A turn's start is recorded at once: a turn
     * that starts and ends between two checks would otherwise read as idle
     * all along, and its end would never be reported.
     */
    signal(sessionId: string, event?: { type: string; turnStatus?: string; status?: string }): void {
      // A webhook another brain armed for a chat this one runs arrives through the file.
      // This runs inside chat event handling, so it never throws.
      try {
        if (fileChanged()) {
          const onDisk = load();
          if (onDisk) absorb(onDisk);
          syncBackstop();
        }
      } catch (error) {
        warn("agent_chat.webhooks_read_failed", error);
      }
      const mine = hooks.filter((hook) => hook.sessionId === sessionId);
      if (!mine.length) return;
      if (event?.type === "status" && event.turnStatus === "started") {
        for (const hook of mine) {
          hook.seenRunning = true;
          hook.lastState = null;
          hook.lastTurnFailed = false;
          changedHere.add(hook.id);
        }
      }
      const failedEnd = (event?.type === "done" && event.status === "failed") || (event?.type === "status" && event.turnStatus === "failed");
      if (failedEnd) {
        for (const hook of mine) {
          hook.lastTurnFailed = true;
          changedHere.add(hook.id);
        }
      }
      signalled.add(sessionId);
      schedule();
    },

    /** Arms (or replaces) this chat's webhook for this URL. The chat may not exist yet: a launch arms it first. */
    async arm(args: ArmChatWebhookArgs): Promise<ChatWebhookView> {
      const sessionId = String(args?.sessionId ?? "").trim();
      const url = String(args?.url ?? "").trim();
      if (!sessionId) throw new Error("Name the chat to report on.");
      const problem = chatWebhookUrlProblem(url);
      if (problem) throw new Error(problem);
      const others = hooks.filter((hook) => !(hook.sessionId === sessionId && hook.url === url));
      for (const hook of hooks) if (!others.includes(hook)) markRemoved(hook.id);
      if (others.length >= MAX_WEBHOOKS) throw new Error(`At most ${MAX_WEBHOOKS} chat webhooks can be armed at once.`);
      const at = now();
      const hook: StoredChatWebhook = {
        id: randomUUID(),
        sessionId,
        url,
        token: args.token?.trim() || null,
        createdAt: new Date(at).toISOString(),
        expiresAt: new Date(at + DEFAULT_LIFETIME_MS).toISOString(),
        lastState: null,
        seenRunning: false,
        deliveries: [],
      };
      changedHere.add(hook.id);
      hooks = [...others, hook];
      persist();
      syncBackstop();
      signalled.add(sessionId);
      schedule();
      return view(hook);
    },

    /** Never returns the bearer key. */
    async list(args: { sessionId?: string } = {}): Promise<ChatWebhookView[]> {
      const id = args?.sessionId?.trim();
      return hooks.filter((hook) => !id || hook.sessionId === id).map(view);
    },

    async cancel(args: { webhookId?: string; sessionId?: string }): Promise<{ cancelled: number }> {
      const before = hooks.length;
      for (const hook of hooks) if (hook.id === args?.webhookId || hook.sessionId === args?.sessionId) markRemoved(hook.id);
      hooks = hooks.filter((hook) => hook.id !== args?.webhookId && hook.sessionId !== args?.sessionId);
      const cancelled = before - hooks.length;
      if (cancelled > 0) {
        persist();
        syncBackstop();
      }
      return { cancelled };
    },

    start(): void {
      if (hooks.length === 0) return;
      syncBackstop();
      void check(null);
    },

    dispose(): void {
      disposed = true;
      if (backstop) clearInterval(backstop);
      if (timer) clearTimeout(timer);
      backstop = null;
      timer = null;
    },
  };
}

export type ChatWebhookRegistry = ReturnType<typeof createChatWebhookRegistry>;
