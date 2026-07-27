import type { AgentChatEventEnvelope } from "../../../shared/types";

/**
 * Keeps the selected chat's event stream flowing while its pane is not mounted.
 *
 * WHY A RENDERER MODULE AND NOT PRELOAD
 * -------------------------------------
 * The remote event pump in preload only polls while
 * `hasRemoteRuntimeEventSubscribers()` is true — that predicate counts the
 * renderer-held `agentChat.onEvent` callbacks. A retention subscription that
 * lives in the renderer therefore keeps the pump alive for free; moving this
 * into preload would have to re-create that accounting (and would leave the
 * pump idle for exactly the case this module exists to fix). That property is
 * load-bearing: do not "optimise" this into a preload-side buffer.
 *
 * HANDOFF, NOT A SHARED SUBSCRIPTION
 * ----------------------------------
 * While a pane is visible it owns the only subscription (unchanged). When that
 * pane hides or unmounts it calls `retainChatSession(sessionId)`, and this
 * module opens its OWN subscription with a minimal handler that filters by
 * session id and appends into the same module-level view cache the pane reads
 * back, under the same trim caps. On return the pane calls
 * `adoptRetainedSession(sessionId)`, which tears the module handler down again.
 *
 * BATCHED, LIKE THE LIVE PATH
 * ---------------------------
 * Envelopes are buffered per session and handed to the host in one batch on a
 * ~16ms timer — the same cadence the visible pane's own flush uses. Appending
 * one-at-a-time makes a HIDDEN chat cost more per event than a visible one
 * (each append re-walks the whole transcript to dedupe, trim, derive and
 * measure), which janks the tab the user is actually looking at. Adoption and
 * release flush synchronously, so a returning pane never reads a partial view.
 *
 * NO PANE CLOSURES
 * ----------------
 * The retained handler must never capture pane state, setters, or refs. It
 * talks only to the injected host adapter (module-level functions). Anything
 * else is a setState-after-unmount bug and a component-instance leak, which is
 * precisely what an unmounted-but-subscribed pane would be.
 *
 * TURN STATE
 * ----------
 * This module never computes `turnActive` policy. It stores events and the
 * scalars the existing cache write derives, exactly as the pane's live flush
 * does; adoption still funnels through `chatTurnState.resolveTurnActive` at the
 * pane's `applyCachedSessionView`, so terminal transcript evidence continues to
 * outrank a stale cached `turnActive: true`
 * (see `docs/features/chat/README.md`, "Terminal transcript evidence outranks a
 * stale active summary").
 */

/**
 * How long a hidden chat keeps its own subscription open. On expiry the
 * subscription is dropped but the cached view is KEPT — warm, just no longer
 * live — so returning still paints instantly and only the reconcile fetch
 * closes the gap.
 */
export const CHAT_SESSION_RETENTION_TTL_MS = 5 * 60 * 1000;

/**
 * Only the chat the user was actually looking at is retained (plus, briefly,
 * the one they just switched away from). A hard cap keeps a pathological
 * caller — a grid of tiles all hiding at once — from fanning out into one
 * subscription per session.
 */
export const MAX_RETAINED_CHAT_SESSIONS = 2;

/**
 * Coalescing window for buffered envelopes. Matches the visible pane's own
 * queued-event flush so a hidden chat costs no more per event than a shown one.
 */
export const CHAT_SESSION_RETENTION_FLUSH_MS = 16;

export type ChatSessionRetentionHost = {
  /**
   * Open a raw chat-event subscription (`window.ade.agentChat.onEvent`).
   * Returns its unsubscribe.
   */
  subscribe: (listener: (envelope: AgentChatEventEnvelope) => void) => () => void;
  /**
   * Append a BATCH of live envelopes into the module-level view cache for
   * `sessionId`, deduped and trimmed by the caller's own resident caps. Called
   * once per flush, never once per event. Must not touch React state.
   */
  appendEvents: (sessionId: string, envelopes: readonly AgentChatEventEnvelope[]) => void;
};

type RetainedChatSession = {
  unsubscribe: () => void;
  /** `window.setTimeout` handle for the TTL, or null once it has fired. */
  ttlHandle: number | null;
  /** Envelopes received since the last flush, in arrival order. */
  pending: AgentChatEventEnvelope[];
  /** `window.setTimeout` handle for the coalescing flush, or null when idle. */
  flushHandle: number | null;
};

let retentionHost: ChatSessionRetentionHost | null = null;

/**
 * Insertion-ordered, so the cap evicts the least recently retained session.
 */
const retainedChatSessions = new Map<string, RetainedChatSession>();

/**
 * Wire the module to the renderer bridge + view cache. Called once from
 * `AgentChatPane`'s module scope (never from a component body — a per-instance
 * host would be a pane closure).
 */
export function configureChatSessionRetention(host: ChatSessionRetentionHost | null): void {
  retentionHost = host;
}

function clearRetentionTtl(entry: RetainedChatSession): void {
  if (entry.ttlHandle == null) return;
  if (typeof window !== "undefined") window.clearTimeout(entry.ttlHandle);
  entry.ttlHandle = null;
}

function clearRetentionFlushTimer(entry: RetainedChatSession): void {
  if (entry.flushHandle == null) return;
  if (typeof window !== "undefined") window.clearTimeout(entry.flushHandle);
  entry.flushHandle = null;
}

/**
 * Hand everything buffered for a session to the host in ONE call. Safe to call
 * with nothing pending. Never throws into a timer callback.
 */
function drainRetainedChatSession(sessionId: string, entry: RetainedChatSession): void {
  clearRetentionFlushTimer(entry);
  if (!entry.pending.length) return;
  const batch = entry.pending;
  // Swap before dispatching so a host that (re-)enters cannot double-append.
  entry.pending = [];
  try {
    retentionHost?.appendEvents(sessionId, batch);
  } catch {
    // The cache write is best-effort; a throwing host must not kill retention.
  }
}

/**
 * Flush a retained session's buffer immediately. Exported for the pane's
 * adoption path, which must read a complete view.
 */
export function flushRetainedChatSession(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  const entry = retainedChatSessions.get(sessionId);
  if (!entry) return;
  drainRetainedChatSession(sessionId, entry);
}

/**
 * Drop the module-held subscription for a session. Idempotent: the map entry is
 * removed BEFORE `unsubscribe()` runs, so a re-entrant call (TTL firing while
 * adoption is in flight) can never unsubscribe twice or re-enter the handler.
 * The cached view is deliberately left in place — and anything still buffered
 * is flushed first, so releasing never silently drops up to a frame of events.
 */
export function releaseRetainedChatSession(sessionId: string): boolean {
  const entry = retainedChatSessions.get(sessionId);
  if (!entry) return false;
  drainRetainedChatSession(sessionId, entry);
  retainedChatSessions.delete(sessionId);
  clearRetentionTtl(entry);
  try {
    entry.unsubscribe();
  } catch {
    // A bridge that already tore itself down is not an error here.
  }
  return true;
}

/**
 * Hand a hidden/unmounting pane's session over to the module subscription.
 * Returns true when the session is (or already was) retained.
 */
export function retainChatSession(
  sessionId: string | null | undefined,
  options?: { ttlMs?: number },
): boolean {
  const host = retentionHost;
  if (!host || !sessionId) return false;
  // Already live — re-retaining must not stack a second subscription.
  if (retainedChatSessions.has(sessionId)) return true;

  while (retainedChatSessions.size >= MAX_RETAINED_CHAT_SESSIONS) {
    const oldest = retainedChatSessions.keys().next().value;
    if (typeof oldest !== "string") break;
    releaseRetainedChatSession(oldest);
  }

  // Declared up front so the subscribe handler can buffer into it. The handler
  // closes over `sessionId` and this entry only — no pane state.
  const entry: RetainedChatSession = {
    unsubscribe: () => undefined,
    ttlHandle: null,
    pending: [],
    flushHandle: null,
  };

  let unsubscribe: () => void;
  try {
    unsubscribe = host.subscribe((envelope) => {
      if (!envelope || envelope.sessionId !== sessionId) return;
      // A released entry can still see one in-flight envelope if the bridge
      // dispatches after unsubscribe; dropping it is correct (the pane that
      // adopted the session owns the stream again).
      if (retainedChatSessions.get(sessionId) !== entry) return;
      entry.pending.push(envelope);
      if (entry.flushHandle != null) return;
      if (typeof window === "undefined") {
        drainRetainedChatSession(sessionId, entry);
        return;
      }
      entry.flushHandle = window.setTimeout(() => {
        entry.flushHandle = null;
        drainRetainedChatSession(sessionId, entry);
      }, CHAT_SESSION_RETENTION_FLUSH_MS);
    });
  } catch {
    return false;
  }

  entry.unsubscribe = unsubscribe;
  retainedChatSessions.set(sessionId, entry);
  const ttlMs = options?.ttlMs ?? CHAT_SESSION_RETENTION_TTL_MS;
  if (typeof window !== "undefined" && ttlMs > 0) {
    entry.ttlHandle = window.setTimeout(() => {
      entry.ttlHandle = null;
      releaseRetainedChatSession(sessionId);
    }, ttlMs);
  }
  return true;
}

/**
 * Take the session back for a pane that just became visible.
 *
 * Any buffered envelopes are flushed synchronously before the subscription is
 * torn down, so the caller always reads a COMPLETE view — never one that is
 * missing the last coalescing window.
 *
 * Returns true when this module was still live for the session, which tells the
 * caller its cached view already contains the events that arrived while hidden
 * — so it should fire its ONE reconcile fetch promptly instead of the slower
 * "restored from a possibly-stale cache" second refresh.
 */
export function adoptRetainedSession(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  return releaseRetainedChatSession(sessionId);
}

/** Test/diagnostic helper: is this session currently retained? */
export function isChatSessionRetained(sessionId: string | null | undefined): boolean {
  return Boolean(sessionId) && retainedChatSessions.has(sessionId as string);
}

/** Test/diagnostic helper: how many sessions are retained right now. */
export function retainedChatSessionCount(): number {
  return retainedChatSessions.size;
}

/** Test/diagnostic helper: envelopes buffered but not yet flushed. */
export function pendingRetainedChatEventCount(sessionId: string | null | undefined): number {
  if (!sessionId) return 0;
  return retainedChatSessions.get(sessionId)?.pending.length ?? 0;
}

/** Release everything (used by tests and by a full renderer teardown). */
export function releaseAllRetainedChatSessions(): void {
  for (const sessionId of [...retainedChatSessions.keys()]) {
    releaseRetainedChatSession(sessionId);
  }
}
