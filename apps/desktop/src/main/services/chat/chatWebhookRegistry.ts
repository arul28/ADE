import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { randomUUID } from "node:crypto";
import { isPublicIpAddress, pinnedLookup } from "../net/publicHostGuard";
import { chatWaitTargetMatches } from "../../../shared/chatWait";
import type { Logger } from "../logging/logger";
import { writeFileAtomic } from "../state/durableFile";

/**
 * Tells an outside URL when a chat stops needing no one: its turn is done, it
 * waits on input, or it failed. This is how something that is not running
 * right now (a cloud bot) hears about a chat; `chat.getChatEvents` is the
 * polling path for everything that can only make calls.
 *
 * Lives in the machine's secrets folder, never the project database: that one
 * syncs between machines, and the receiver's bearer key must not.
 */

const FILE_NAME = "chat-webhooks.json";
const DEFAULT_LIFETIME_MS = 7 * 24 * 60 * 60_000;
const CHECK_DEBOUNCE_MS = 250;
const BACKSTOP_MS = 15_000;
const POST_TIMEOUT_MS = 10_000;
const MAX_WEBHOOKS = 200;
/** Delay before each try; one failed POST never loses the news, five do. */
const RETRY_DELAYS_MS = [0, 5_000, 30_000, 2 * 60_000, 10 * 60_000];

export type ChatWebhookEvent = "chat.idle" | "chat.needs_input" | "chat.failed";

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
  deliveries: Delivery[];
};

export type ChatWebhookView = Pick<StoredChatWebhook, "id" | "sessionId" | "url" | "createdAt" | "expiresAt"> & { hasToken: boolean };

export type ArmChatWebhookArgs = { sessionId: string; url: string; token?: string | null };

const PRIVATE_HOST = /^(?:localhost|.*\.local|.*\.internal|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:|\[?fe80:)/i;

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
  if (PRIVATE_HOST.test(url.hostname)) return "The notify URL must be a public address, not this computer or a private network.";
  return null;
}

function stateOfChat(summary: Record<string, unknown>): ChatWebhookState | null {
  if (summary.awaitingInput === true || summary.phase === "blocked") return "needs_input";
  if (summary.status === "failed") return "failed";
  return chatWaitTargetMatches(summary, "idle") || chatWaitTargetMatches(summary, "terminal") ? "idle" : null;
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
  /** Only the brain running a chat reports on it. */
  ownedByAnotherBrain: (sessionId: string) => boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const filePath = path.join(deps.secretsDir, FILE_NAME);
  const load = (): StoredChatWebhook[] => {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return Array.isArray(raw) ? (raw as StoredChatWebhook[]).filter((entry) => typeof entry?.id === "string") : [];
    } catch {
      return [];
    }
  };
  let hooks = load();
  /** Ids this brain removed, so a merge with the file does not bring them back. */
  const removed = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let backstop: ReturnType<typeof setInterval> | null = null;
  let checking = false;
  let recheck = false;
  let disposed = false;

  /**
   * Two brains can run one project (a dev brain beside the installed one).
   * Each writes only what it changed: webhooks the other one added stay.
   */
  const persist = (): void => {
    try {
      const mine = new Set(hooks.map((hook) => hook.id));
      const theirs = load().filter((hook) => !mine.has(hook.id) && !removed.has(hook.id));
      hooks = [...hooks, ...theirs];
      fs.mkdirSync(deps.secretsDir, { recursive: true, mode: 0o700 });
      writeFileAtomic(filePath, JSON.stringify(hooks), { mode: 0o600 });
    } catch (error) {
      deps.logger.warn("agent_chat.webhooks_persist_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  };

  const syncBackstop = (): void => {
    if (hooks.length === 0) {
      if (backstop) clearInterval(backstop);
      backstop = null;
    } else if (!backstop && !disposed) {
      backstop = setInterval(() => void check(), BACKSTOP_MS);
      backstop.unref?.();
    }
  };

  const schedule = (): void => {
    if (timer || disposed) return;
    timer = setTimeout(() => {
      timer = null;
      void check();
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
    let status = 0;
    if (deps.fetchImpl) {
      status = await deps.fetchImpl(hook.url, {
        method: "POST", headers, body: delivery.body, redirect: "manual", signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      }).then((response) => response.status, () => 0);
    } else {
      status = await postPinned(hook.url, headers, delivery.body);
      if (status === PRIVATE_ADDRESS) {
        deps.logger.warn("agent_chat.webhook_private_address", { webhookId: hook.id, sessionId: hook.sessionId });
        return true;
      }
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
    if (!deps.ownedByAnotherBrain(hook.sessionId)) {
      const summary = await deps.readSummary(hook.sessionId).catch(() => undefined);
      if (summary) {
        const state = stateOfChat(summary);
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
          if (state === "idle") hook.seenRunning = false;
          changed = true;
        }
      }
    }
    for (const delivery of hook.deliveries.filter((entry) => entry.nextAt <= now())) {
      const finished = await post(hook, delivery);
      if (finished) hook.deliveries = hook.deliveries.filter((entry) => entry !== delivery);
      changed = true;
    }
    return changed;
  };

  const check = async (): Promise<void> => {
    if (disposed) return;
    if (checking) {
      recheck = true;
      return;
    }
    checking = true;
    try {
      let changed = false;
      for (const hook of [...hooks]) {
        if (await checkHook(hook).catch(() => false)) changed = true;
      }
      const at = now();
      const kept = hooks.filter((hook) => hook.deliveries.length > 0 || Date.parse(hook.expiresAt) > at);
      if (kept.length !== hooks.length) changed = true;
      for (const hook of hooks) if (!kept.includes(hook)) removed.add(hook.id);
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
    signal(sessionId: string): void {
      if (hooks.some((hook) => hook.sessionId === sessionId)) schedule();
    },

    /** Arms (or replaces) this chat's webhook for this URL. The chat may not exist yet: a launch arms it first. */
    async arm(args: ArmChatWebhookArgs): Promise<ChatWebhookView> {
      const sessionId = String(args?.sessionId ?? "").trim();
      const url = String(args?.url ?? "").trim();
      if (!sessionId) throw new Error("Name the chat to report on.");
      const problem = chatWebhookUrlProblem(url);
      if (problem) throw new Error(problem);
      const others = hooks.filter((hook) => !(hook.sessionId === sessionId && hook.url === url));
      for (const hook of hooks) if (!others.includes(hook)) removed.add(hook.id);
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
      hooks = [...others, hook];
      persist();
      syncBackstop();
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
      for (const hook of hooks) if (hook.id === args?.webhookId || hook.sessionId === args?.sessionId) removed.add(hook.id);
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
      schedule();
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
