import type { AgentChatEventEnvelope } from "../../../desktop/src/shared/types/chat";
import {
  mergeAgentChatHistorySnapshot,
  orderAgentChatEventsChronologically,
} from "../../../desktop/src/shared/chatHistoryMerge";
import { dedupeTuiEvents, tuiEventDedupKey } from "./eventDedup";

/**
 * Hard ceiling on how many transcript events the TUI keeps loaded for one
 * session (tail + paged-in older history). A 50MB transcript can hold far
 * more JSONL lines than a terminal process should inflate into JS objects,
 * so scroll-back uses a sliding window once this many events are resident.
 */
export const TUI_LOADED_EVENT_CAP = 60_000;

/**
 * How many of the hydration snapshot's newest events are DISPLAYED initially
 * (matches the historical dedupeTuiEvents default, so the render path's perf
 * characteristics are unchanged); the rest of the snapshot waits in a
 * per-session local buffer and is drained on scroll-back BEFORE any
 * byte-cursor network paging.
 */
export const TUI_SNAPSHOT_DISPLAY_CAP = 500;

/**
 * Split a fully-deduped hydration snapshot into the displayed tail and the
 * older local buffer.
 *
 * Seam guarantee chain: `display` is exactly the newest `displayCount`
 * snapshot events and `buffer` is everything older from the SAME snapshot, so
 * display ← buffer is contiguous by construction. The byte cursor
 * (tailStartOffset) pages events strictly older than the snapshot tail, so
 * buffer ← byte-cursor is contiguous by the backend's contract — but only
 * once the buffer has been fully drained. The buffer is capped at `bufferCap`
 * (newest kept) so a pathological snapshot can't balloon memory.
 */
export function splitSnapshotForDisplay(
  events: readonly AgentChatEventEnvelope[],
  displayCount = TUI_SNAPSHOT_DISPLAY_CAP,
  bufferCap = TUI_LOADED_EVENT_CAP,
): { display: AgentChatEventEnvelope[]; buffer: AgentChatEventEnvelope[] } {
  const display = events.slice(-Math.max(1, displayCount));
  const buffer = events
    .slice(0, Math.max(0, events.length - display.length))
    .slice(-Math.max(0, bufferCap));
  return { display, buffer };
}

/**
 * Take the NEWEST `count` events off a snapshot buffer — the chunk adjacent
 * to the currently displayed oldest event, so each drain stays contiguous —
 * and return the remainder for subsequent drains.
 */
export function takeNewestChunk(
  buffer: readonly AgentChatEventEnvelope[],
  count = TUI_SNAPSHOT_DISPLAY_CAP,
): { chunk: AgentChatEventEnvelope[]; rest: AgentChatEventEnvelope[] } {
  const chunk = buffer.slice(-Math.max(1, count));
  return { chunk, rest: buffer.slice(0, Math.max(0, buffer.length - chunk.length)) };
}

/**
 * Seam identity for deduping a paged-in older history block against the
 * already-loaded transcript. Sequence numbers can restart across provider
 * runs, so use the same full event identity as the live/replay dedupe path.
 */
function seamIdentityKey(envelope: AgentChatEventEnvelope): string {
  return tuiEventDedupKey(envelope);
}

/**
 * Prepend one page of OLDER transcript events in front of the already-loaded
 * events, deduping at the seam (older pages end exactly where the hydrated
 * tail began, so overlap is defensive, not expected).
 *
 * Returns the SAME array reference when nothing was prepended so callers can
 * cheaply skip state updates.
 */
export function prependOlderTuiHistory(
  existing: readonly AgentChatEventEnvelope[],
  older: readonly AgentChatEventEnvelope[],
  limit = TUI_LOADED_EVENT_CAP,
): AgentChatEventEnvelope[] {
  if (older.length === 0) return existing as AgentChatEventEnvelope[];
  // Dedupe inside the page itself (transcript replays can repeat lines) without
  // applying the tail-window cap — pass the page's own length as the limit.
  const dedupedOlder = dedupeTuiEvents(older, Math.max(1, older.length));
  // Only the seam can collide: compare against the oldest already-loaded
  // events rather than the entire (potentially 60k-entry) transcript.
  const seamWindow = existing.slice(0, Math.min(existing.length, dedupedOlder.length + 32));
  const seamKeys = new Set(seamWindow.map(seamIdentityKey));
  const fresh = dedupedOlder.filter((envelope) => !seamKeys.has(seamIdentityKey(envelope)));
  if (fresh.length === 0) return existing as AgentChatEventEnvelope[];
  const combined = [...fresh, ...existing];
  // Scroll-back is a sliding window. Once the resident cap is full, keep the
  // newly requested OLDEST side and evict the newest tail; otherwise every
  // page beyond the cap is fetched and immediately discarded. The caller
  // marks the session detached and rehydrates the authoritative tail on End.
  return combined.length > limit ? combined.slice(0, limit) : combined;
}

/**
 * Resolve the initial scroll-back byte cursor from a hydration snapshot.
 * Returns 0 when there is nothing to page.
 *
 * `hasOlderHistory` is authoritative when the host sends it: the chat service
 * derives it from the tail READ (transcript/window truncation), never from
 * envelope object identity. A `false` therefore means there is genuinely
 * nothing older even when a non-zero `tailStartOffset` is reported — the
 * offset is the byte position of the oldest RETURNED transcript line, which is
 * routinely > 0 for an untruncated transcript whose first physical lines carry
 * no parent-visible event (meta/summary records, filtered subagent lines).
 * Seeding a cursor from that offset arms a "load earlier…" affordance that can
 * only ever come back empty. Older hosts omit the field; those fall back to
 * the legacy offset-only rule.
 */
export function resolveSnapshotHistoryCursor(snapshot: {
  hasOlderHistory?: boolean | null;
  tailStartOffset?: number | null;
}): number {
  if (snapshot.hasOlderHistory === false) return 0;
  return typeof snapshot.tailStartOffset === "number"
    && Number.isFinite(snapshot.tailStartOffset)
    && snapshot.tailStartOffset > 0
    ? snapshot.tailStartOffset
    : 0;
}

export type OlderHistoryCursorAdvance = {
  beforeOffset: number;
  hasMore: boolean;
};

export type OlderHistoryStatus = "loading" | "available" | "exhausted" | "error";

/**
 * Rebuild the authoritative latest tail after a detached sliding-window view.
 * The detached resident window is intentionally excluded by callers: it
 * contains the oldest loaded events, not a continuation of this fresh tail.
 * Live events buffered while detached are appended and deduped at the seam.
 */
export function mergeDetachedTuiHistoryTail(
  snapshotTail: readonly AgentChatEventEnvelope[],
  bufferedLiveEvents: readonly AgentChatEventEnvelope[],
): AgentChatEventEnvelope[] {
  const combined = mergeAgentChatHistorySnapshot(
    [...snapshotTail],
    [...snapshotTail, ...bufferedLiveEvents],
    tuiEventDedupKey,
  );
  return dedupeTuiEvents(
    orderAgentChatEventsChronologically(combined),
    Math.min(TUI_LOADED_EVENT_CAP, Math.max(1, combined.length)),
  );
}

/**
 * Reconcile a refreshed authoritative tail with cached scrollback and events
 * received while hydration was in flight. Older cached rows stay before the
 * tail; replayed historical rows are never appended after it.
 */
export function mergeHydratedTuiHistory(
  snapshotTail: readonly AgentChatEventEnvelope[],
  existing: readonly AgentChatEventEnvelope[],
  pending: readonly AgentChatEventEnvelope[],
): AgentChatEventEnvelope[] {
  const merged = mergeAgentChatHistorySnapshot(
    [...snapshotTail],
    [...existing, ...pending],
    tuiEventDedupKey,
  );
  return dedupeTuiEvents(
    orderAgentChatEventsChronologically(merged),
    Math.max(TUI_LOADED_EVENT_CAP, snapshotTail.length, existing.length + pending.length),
  );
}

export function shouldRequestOlderTuiHistory(args: {
  scrollMaxOffset: number;
  scrollOffset: number;
  bufferedEventCount: number;
  cursor: { hasMore: boolean; loading: boolean } | null;
  status: OlderHistoryStatus | null;
}): boolean {
  if (args.status === "loading") return false;
  if (args.scrollMaxOffset > 0 && args.scrollOffset < args.scrollMaxOffset - 3) return false;
  // A cached snapshot remainder is local and remains immediately usable even
  // when background revalidation of the remote byte cursor failed.
  if (args.bufferedEventCount > 0) return true;
  if (args.status === "error") return false;
  return Boolean(args.cursor?.hasMore && !args.cursor.loading);
}

/**
 * Advance the scroll-back cursor after one page arrives.
 *
 * Cursor protocol (see agentChatService.getChatEventHistoryPage): each page's
 * `startOffset` becomes the next `beforeOffset` and must be strictly
 * decreasing; `startOffset` 0 means the head of the transcript was reached.
 * A non-decreasing offset would loop forever, so it defensively ends paging.
 */
export function advanceOlderHistoryCursor(
  cursor: OlderHistoryCursorAdvance,
  page: { startOffset: number; hasMore: boolean; sessionFound?: boolean; unavailable?: boolean },
): OlderHistoryCursorAdvance {
  if (page.unavailable === true) return cursor;
  if (page.sessionFound === false) {
    return { beforeOffset: cursor.beforeOffset, hasMore: false };
  }
  const progressed = page.startOffset < cursor.beforeOffset;
  if (!progressed) {
    return { beforeOffset: cursor.beforeOffset, hasMore: false };
  }
  return {
    beforeOffset: page.startOffset,
    hasMore: page.hasMore && page.startOffset > 0,
  };
}
