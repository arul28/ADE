import { useSyncExternalStore } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import { isRemoteOutcomeUnknownError } from "../../../shared/runtimeErrors";
import { REMOTE_RUNTIME_MANUALLY_DISCONNECTED_MESSAGE } from "../../../shared/types/remoteRuntime";

/**
 * State behind the Work input box for a running agent CLI: the person's
 * "terminal or box" choice, each session's draft and sent history, and the
 * queue of texts waiting for the CLI's prompt.
 *
 * The queue lives in this module, not in the box, so a text keeps going out
 * after the person switches to another session or tab. It is kept in
 * localStorage so a reload or a dropped connection does not lose it, and its
 * runner only exists while there is something to send: an empty queue costs
 * nothing.
 *
 * Every send goes to the session's own machine (`route.pin`), and the host
 * types it only at a free prompt (`chat.typeIntoCli`). A busy CLI answers
 * `deferred` and nothing is typed; the runner asks again a little later.
 */

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** False when storage is full or unavailable, so the value is not kept. */
function writeStorage(key: string, value: string | null): boolean {
  try {
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
    return true;
  } catch (error) {
    console.warn("[cliInputBox] storage write failed", { key, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

function readJsonArray(key: string): unknown[] {
  const raw = readStorage(key);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function randomId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

// ---------------------------------------------------------------------------
// Terminal or box (one choice per person, every CLI session)
// ---------------------------------------------------------------------------

export type CliInputMode = "terminal" | "box";

const INPUT_MODE_KEY = "ade.work.cliInputMode";
const modeListeners = new Set<() => void>();
let cachedMode: CliInputMode | null = null;

function readMode(): CliInputMode {
  if (cachedMode) return cachedMode;
  // Typing in the terminal stays the default, so nobody's habits change.
  cachedMode = readStorage(INPUT_MODE_KEY) === "box" ? "box" : "terminal";
  return cachedMode;
}

export function setCliInputMode(mode: CliInputMode): void {
  if (readMode() === mode) return;
  cachedMode = mode;
  writeStorage(INPUT_MODE_KEY, mode === "box" ? "box" : null);
  for (const listener of modeListeners) listener();
}

function subscribeMode(listener: () => void): () => void {
  modeListeners.add(listener);
  return () => modeListeners.delete(listener);
}

export function useCliInputMode(): CliInputMode {
  return useSyncExternalStore(subscribeMode, readMode, () => "terminal");
}

// ---------------------------------------------------------------------------
// Draft and history (per session)
// ---------------------------------------------------------------------------

const DRAFT_KEY_PREFIX = "ade.work.cliInputDraft.";
const HISTORY_KEY_PREFIX = "ade.work.cliInputHistory.";
const HISTORY_MAX = 50;
/** The ended-session continue box's draft (`WorkCliContinuationComposer`); same key. */
const CONTINUE_DRAFT_KEY_PREFIX = "ade.work.cliContinueDraft.";
/** Tells a mounted continue box that its draft gained text. */
export const CLI_CONTINUE_DRAFT_CHANGED_EVENT = "ade:cli-continue-draft-changed";

export function readCliInputDraft(sessionId: string): string {
  return readStorage(`${DRAFT_KEY_PREFIX}${sessionId}`) ?? "";
}

export function writeCliInputDraft(sessionId: string, text: string): void {
  writeStorage(`${DRAFT_KEY_PREFIX}${sessionId}`, text.trim() ? text : null);
}

/** Sent texts, oldest first. */
export function readCliInputHistory(sessionId: string): string[] {
  return readJsonArray(`${HISTORY_KEY_PREFIX}${sessionId}`)
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .slice(-HISTORY_MAX);
}

function appendCliInputHistory(sessionId: string, text: string): void {
  const history = readCliInputHistory(sessionId);
  if (history[history.length - 1] === text) return;
  history.push(text);
  writeStorage(`${HISTORY_KEY_PREFIX}${sessionId}`, JSON.stringify(history.slice(-HISTORY_MAX)));
  historyVersion.set(sessionId, (historyVersion.get(sessionId) ?? 0) + 1);
}

const historyVersion = new Map<string, number>();
export function cliInputHistoryVersion(sessionId: string): number {
  return historyVersion.get(sessionId) ?? 0;
}

function appendToContinueDraft(sessionId: string, texts: readonly string[]): void {
  if (texts.length === 0) return;
  const key = `${CONTINUE_DRAFT_KEY_PREFIX}${sessionId}`;
  const existing = readStorage(key)?.trim() ?? "";
  const next = [existing, ...texts.map((text) => text.trim())].filter(Boolean).join("\n\n");
  writeStorage(key, next || null);
  try {
    window.dispatchEvent(new CustomEvent(CLI_CONTINUE_DRAFT_CHANGED_EVENT, { detail: { sessionId } }));
  } catch {
    // No window events (tests): the continue box reads storage when it mounts.
  }
}

// ---------------------------------------------------------------------------
// The queue (per session)
// ---------------------------------------------------------------------------

/**
 * `queued`: waits for the CLI's prompt. `sending`: being typed now.
 * `offline`: the CLI's machine is not connected; goes out when it is.
 * `unconfirmed`: the connection dropped mid-send, so it may or may not have
 * been typed; only the person can say, so it is never retried by itself.
 * `failed`: the host refused it; the person edits, retries or discards it.
 */
export type CliInputQueueState = "queued" | "sending" | "offline" | "unconfirmed" | "failed";

export type CliInputQueueItem = {
  id: string;
  text: string;
  createdAt: number;
  state: CliInputQueueState;
  error: string | null;
  /** The window typing it, so two windows on one session do not both send it. */
  claimedBy: string | null;
  claimedAt: number | null;
};

const QUEUE_KEY_PREFIX = "ade.work.cliInputQueue.";
const WINDOW_ID = randomId();
/** A claim older than this is a window that went away mid-send. */
const CLAIM_STALE_MS = 60_000;
const EMPTY_QUEUE: readonly CliInputQueueItem[] = Object.freeze([]);

const queues = new Map<string, readonly CliInputQueueItem[]>();
const queueListeners = new Map<string, Set<() => void>>();

function parseQueueItem(value: unknown): CliInputQueueItem | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.text !== "string" || !record.text.trim()) return null;
  const state: CliInputQueueState = record.state === "offline"
    || record.state === "unconfirmed"
    || record.state === "failed"
    || record.state === "sending"
    ? record.state
    : "queued";
  return {
    id: record.id,
    text: record.text,
    createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
    state,
    error: typeof record.error === "string" ? record.error : null,
    claimedBy: typeof record.claimedBy === "string" ? record.claimedBy : null,
    claimedAt: typeof record.claimedAt === "number" ? record.claimedAt : null,
  };
}

function loadQueue(sessionId: string): readonly CliInputQueueItem[] {
  const items = readJsonArray(`${QUEUE_KEY_PREFIX}${sessionId}`)
    .map(parseQueueItem)
    .filter((item): item is CliInputQueueItem => item !== null)
    .map((item) => {
      // A send this window started before a reload, or one a window that went
      // away started: nobody can say whether it was typed.
      if (item.state !== "sending") return item;
      const otherWindowStillOnIt = item.claimedBy !== WINDOW_ID
        && item.claimedAt != null
        && Date.now() - item.claimedAt < CLAIM_STALE_MS;
      if (otherWindowStillOnIt) return item;
      return {
        ...item,
        state: "unconfirmed" as const,
        error: "ADE was interrupted while typing this. Check the terminal before sending it again.",
        claimedBy: null,
        claimedAt: null,
      };
    });
  return items.length > 0 ? Object.freeze(items) : EMPTY_QUEUE;
}

function getQueue(sessionId: string): readonly CliInputQueueItem[] {
  let queue = queues.get(sessionId);
  if (!queue) {
    queue = loadQueue(sessionId);
    queues.set(sessionId, queue);
  }
  return queue;
}

/** False when the queue could not be saved: it lives in this window only. */
function setQueue(sessionId: string, items: readonly CliInputQueueItem[]): boolean {
  const next = items.length > 0 ? Object.freeze([...items]) : EMPTY_QUEUE;
  queues.set(sessionId, next);
  const saved = writeStorage(`${QUEUE_KEY_PREFIX}${sessionId}`, next.length > 0 ? JSON.stringify(next) : null);
  for (const listener of queueListeners.get(sessionId) ?? []) listener();
  return saved;
}

function updateItem(sessionId: string, itemId: string, patch: Partial<CliInputQueueItem>): void {
  const queue = getQueue(sessionId);
  if (!queue.some((item) => item.id === itemId)) return;
  setQueue(sessionId, queue.map((item) => (item.id === itemId ? { ...item, ...patch } : item)));
}

// Another window changed a queue: take its copy, so a text it sent or
// discarded is not sent again here.
if (typeof window !== "undefined") {
  try {
    window.addEventListener("storage", (event) => {
      if (!event.key?.startsWith(QUEUE_KEY_PREFIX)) return;
      const sessionId = event.key.slice(QUEUE_KEY_PREFIX.length);
      if (!queues.has(sessionId)) return;
      queues.set(sessionId, loadQueue(sessionId));
      for (const listener of queueListeners.get(sessionId) ?? []) listener();
      kickCliInputQueue(sessionId);
    });
  } catch {
    // No window events (tests).
  }
}

export function useCliInputQueue(sessionId: string): readonly CliInputQueueItem[] {
  return useSyncExternalStore(
    (listener) => {
      let listeners = queueListeners.get(sessionId);
      if (!listeners) {
        listeners = new Set();
        queueListeners.set(sessionId, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners!.delete(listener);
      };
    },
    () => getQueue(sessionId),
    () => EMPTY_QUEUE,
  );
}

/**
 * Queue a text. False when it could not be saved (storage full): it still
 * sends from this window, but a reload before then loses it.
 */
export function enqueueCliInput(sessionId: string, text: string): boolean {
  const item: CliInputQueueItem = {
    id: randomId(),
    text,
    createdAt: Date.now(),
    state: "queued",
    error: null,
    claimedBy: null,
    claimedAt: null,
  };
  const saved = setQueue(sessionId, [...getQueue(sessionId), item]);
  kickCliInputQueue(sessionId);
  return saved;
}

/** Take a waiting text out of the queue (cancel or edit). A text being typed stays. */
export function removeCliInput(sessionId: string, itemId: string): CliInputQueueItem | null {
  const queue = getQueue(sessionId);
  const item = queue.find((entry) => entry.id === itemId) ?? null;
  if (!item || item.state === "sending") return null;
  setQueue(sessionId, queue.filter((entry) => entry.id !== itemId));
  kickCliInputQueue(sessionId);
  return item;
}

/** The person says send it (again): a failed or unconfirmed text goes back in line. */
export function retryCliInput(sessionId: string, itemId: string): void {
  updateItem(sessionId, itemId, { state: "queued", error: null, claimedBy: null, claimedAt: null });
  kickCliInputQueue(sessionId);
}

/**
 * The CLI has ended: whatever was still waiting moves into its continue box,
 * where sending it continues the session, instead of sitting here unseen.
 */
export function moveCliInputQueueToContinueDraft(sessionId: string): void {
  const queue = getQueue(sessionId);
  const waiting = queue.filter((item) => item.state !== "sending");
  if (waiting.length === 0) return;
  appendToContinueDraft(sessionId, waiting.map((item) => item.text));
  setQueue(sessionId, queue.filter((item) => item.state === "sending"));
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

export type CliInputRoute = {
  /** The CLI's machine. Null: the tab's own machine (unpinned route). */
  pin: OpenProjectBinding | null;
  /** The CLI's machine is known to be disconnected. */
  offline: boolean;
};

type Runner = {
  route: CliInputRoute;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  /** When the CLI first answered "busy" for the text at the head, for backoff. */
  busySince: number | null;
};

const runners = new Map<string, Runner>();

/** Busy CLI: ask often at first, then less, so a long turn is not polled hard. */
function busyRetryDelayMs(busySince: number): number {
  const waited = Date.now() - busySince;
  if (waited < 30_000) return 1_500;
  if (waited < 5 * 60_000) return 4_000;
  return 10_000;
}

const OFFLINE_RETRY_MS = 5_000;

const UNREACHABLE_PATTERN = /not connected|disconnected|reconnecting|host_unavailable|unreachable|not reachable|couldn'?t reach|could not reach|offline|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Refused before it left this window or reached the machine: safe to send again. */
function isUnreachableError(error: unknown): boolean {
  const message = errorText(error);
  return message.includes(REMOTE_RUNTIME_MANUALLY_DISCONNECTED_MESSAGE) || UNREACHABLE_PATTERN.test(message);
}

function friendlyError(error: unknown): string {
  return errorText(error)
    .replace(/^Error invoking remote method '[^']+': /, "")
    .replace(/^Error: /, "");
}

/**
 * Where this session's texts go, and whether that machine is connected. The
 * box sets it while it is shown; the route stays after the box goes away, so
 * a queued text still reaches the CLI it was written for.
 */
export function setCliInputRoute(sessionId: string, route: CliInputRoute): void {
  const runner = runners.get(sessionId);
  if (runner) {
    const cameOnline = runner.route.offline && !route.offline;
    runner.route = route;
    if (cameOnline) {
      const queue = getQueue(sessionId);
      // Back on line: the texts that waited for it go back in line, in order.
      if (queue.some((item) => item.state === "offline")) {
        setQueue(sessionId, queue.map((item) => (item.state === "offline" ? { ...item, state: "queued" as const, error: null } : item)));
      }
    }
  } else {
    runners.set(sessionId, { route, timer: null, inFlight: false, busySince: null });
  }
  kickCliInputQueue(sessionId);
}

function schedule(sessionId: string, runner: Runner, delayMs: number): void {
  if (runner.timer) clearTimeout(runner.timer);
  runner.timer = setTimeout(() => {
    runner.timer = null;
    void step(sessionId);
  }, delayMs);
}

/** Try the text at the head of the queue now (a send, a CLI that went idle, a reconnect). */
export function kickCliInputQueue(sessionId: string): void {
  const runner = runners.get(sessionId);
  if (!runner || runner.inFlight) return;
  if (runner.timer) {
    clearTimeout(runner.timer);
    runner.timer = null;
  }
  void step(sessionId);
}

async function step(sessionId: string): Promise<void> {
  const runner = runners.get(sessionId);
  if (!runner || runner.inFlight) return;
  const head = getQueue(sessionId)[0];
  if (!head) {
    runner.busySince = null;
    return;
  }
  // These wait for the person: they may already have been typed, or the host refused them.
  if (head.state === "unconfirmed" || head.state === "failed") return;
  if (head.state === "sending") {
    // Another window is typing it; look again once its claim would be stale.
    const claimAge = head.claimedAt != null ? Date.now() - head.claimedAt : CLAIM_STALE_MS;
    if (head.claimedBy !== WINDOW_ID && claimAge < CLAIM_STALE_MS) {
      schedule(sessionId, runner, CLAIM_STALE_MS - claimAge + 500);
    }
    return;
  }
  if (runner.route.offline) {
    // Nothing to ask while the machine is gone. A shown input box kicks the
    // queue when it reconnects; with the box hidden nothing follows the
    // connection, so look again on a timer too.
    if (head.state !== "offline") updateItem(sessionId, head.id, { state: "offline", error: null });
    runner.route = { ...runner.route, offline: false };
    schedule(sessionId, runner, OFFLINE_RETRY_MS);
    return;
  }
  const api = typeof window !== "undefined" ? window.ade?.agentChat?.typeIntoCli : undefined;
  if (typeof api !== "function") {
    updateItem(sessionId, head.id, { state: "failed", error: "This ADE cannot type into a CLI session." });
    return;
  }
  runner.inFlight = true;
  // In flight is always `sending`, even a retry while the machine looked
  // offline: Edit and Remove are off while a send may still reach the CLI.
  updateItem(sessionId, head.id, { state: "sending", error: null, claimedBy: WINDOW_ID, claimedAt: Date.now() });
  try {
    const { pin } = runner.route;
    // The item's id makes the send idempotent on the host: another window
    // that claimed the same item at the same moment gets this one's answer.
    const args = { sessionId, text: head.text, clientMessageId: head.id };
    const result = await (pin ? api(args, pin) : api(args));
    if (result.outcome === "delivered" || result.outcome === "held") {
      setQueue(sessionId, getQueue(sessionId).filter((item) => item.id !== head.id));
      appendCliInputHistory(sessionId, head.text);
      runner.busySince = null;
      runner.inFlight = false;
      // The next text waits for the turn this one started to end; give the
      // CLI a moment to show it is busy before asking.
      if (getQueue(sessionId).length > 0) schedule(sessionId, runner, 1_500);
      return;
    }
    if (result.outcome === "ended") {
      updateItem(sessionId, head.id, { state: "queued", claimedBy: null, claimedAt: null });
      moveCliInputQueueToContinueDraft(sessionId);
      runner.busySince = null;
      return;
    }
    // Busy: nothing was typed. Back in line, ask again shortly.
    updateItem(sessionId, head.id, { state: "queued", claimedBy: null, claimedAt: null });
    runner.busySince ??= Date.now();
    runner.inFlight = false;
    schedule(sessionId, runner, busyRetryDelayMs(runner.busySince));
    return;
  } catch (error) {
    if (isRemoteOutcomeUnknownError(error)) {
      updateItem(sessionId, head.id, {
        state: "unconfirmed",
        error: "The connection dropped while this was being typed. Check the terminal before sending it again.",
        claimedBy: null,
        claimedAt: null,
      });
    } else if (runner.route.offline || isUnreachableError(error)) {
      updateItem(sessionId, head.id, { state: "offline", error: null, claimedBy: null, claimedAt: null });
      runner.inFlight = false;
      // The connection snapshot may not say so yet: look again on a timer too.
      schedule(sessionId, runner, OFFLINE_RETRY_MS);
      return;
    } else {
      updateItem(sessionId, head.id, {
        state: "failed",
        error: friendlyError(error),
        claimedBy: null,
        claimedAt: null,
      });
    }
  } finally {
    runner.inFlight = false;
  }
}

/** An `offline` item is retried by the runner itself; this is only for display. */
export function cliInputQueueSummary(items: readonly CliInputQueueItem[]): {
  waiting: number;
  needsAttention: boolean;
} {
  return {
    waiting: items.length,
    needsAttention: items.some((item) => item.state === "failed" || item.state === "unconfirmed"),
  };
}
