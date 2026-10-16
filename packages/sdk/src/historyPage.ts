import { AdeError } from "./errors.js";
import type { PersonalChatsApi } from "./personalChats.js";
import type { AgentChatEventEnvelope, ThreadHistoryPage } from "./types.js";

/** Options for `historyPage`. */
export type HistoryPageOptions = {
  /**
   * Return events strictly older than this `sequence`. Omit for the newest
   * page. Pass the previous page's `nextBeforeSequence` to walk backwards.
   */
  beforeSequence?: number;
  /**
   * At most this many events. The runtime pages by bytes, so a page can hold
   * fewer; when it holds more, the SDK keeps the newest `limit` and moves the
   * cursor so nothing is skipped. Defaults to 200.
   */
  limit?: number;
};

const DEFAULT_HISTORY_PAGE_LIMIT = 200;

/** The lowest `sequence` in a page, or null when none of its envelopes carry one. */
function lowestSequence(events: readonly AgentChatEventEnvelope[]): number | null {
  let lowest: number | null = null;
  for (const envelope of events) {
    if (typeof envelope.sequence !== "number") continue;
    if (lowest === null || envelope.sequence < lowest) lowest = envelope.sequence;
  }
  return lowest;
}

/** Keep the newest `limit` events of a page and report the cursor before them. */
function trimPage(
  events: AgentChatEventEnvelope[],
  limit: number,
  runtimeHasMore: boolean,
): ThreadHistoryPage {
  const trimmed = events.length > limit;
  const kept = trimmed ? events.slice(-limit) : events;
  const cursor = lowestSequence(kept);
  // An un-numbered page cannot be continued by sequence, so it must not claim
  // more: a "load older" affordance gated on `hasMore` would spin forever.
  const hasMore = (trimmed || runtimeHasMore) && cursor !== null && cursor > 1;
  return { events: kept, hasMore, nextBeforeSequence: hasMore ? cursor : null };
}

/**
 * One page of a session's durable transcript. The body of `AdeThread.historyPage`.
 *
 * The newest page comes from the tail read every runtime has; an older page
 * needs the `getEventHistoryPage` action, and without it `onUnsupported` runs
 * and the page is empty with `hasMore: false`.
 */
export async function readHistoryPage(args: {
  chats: PersonalChatsApi;
  sessionId: string;
  opts: HistoryPageOptions;
  /**
   * Whether the CURRENT runtime lists `getEventHistoryPage`. The thread reads
   * it at call time, because the runtime may have been replaced since the
   * thread opened.
   */
  pageSupported: boolean;
  onUnsupported: () => void;
}): Promise<ThreadHistoryPage> {
  const { chats, sessionId, opts } = args;
  const limit =
    typeof opts.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.floor(opts.limit)
      : DEFAULT_HISTORY_PAGE_LIMIT;
  const before = opts.beforeSequence;
  if (before === undefined || before === null) {
    // Asking for one more than the limit is how "is there anything older?" is
    // answered on a runtime that does not report `hasOlderHistory`.
    const snapshot = await chats.getEventHistory({ sessionId, maxEvents: limit + 1 });
    const events = snapshot?.events ?? [];
    const runtimeHasMore = snapshot?.hasOlderHistory === true || snapshot?.truncated === true;
    return trimPage(events, limit, runtimeHasMore);
  }
  if (typeof before !== "number" || !Number.isInteger(before) || before < 0) {
    throw new AdeError("invalid_option", "historyPage({ beforeSequence }) takes a non-negative integer.");
  }
  if (!args.pageSupported) {
    args.onUnsupported();
    return { events: [], hasMore: false, nextBeforeSequence: null };
  }
  const page = await chats.getEventHistoryPage({ sessionId, beforeSequence: before });
  // The byte-bounded read can overlap the cursor by an envelope; drop anything
  // at or past it so a caller walking back never sees a repeat.
  const events = (page?.events ?? []).filter(
    (envelope) => typeof envelope.sequence !== "number" || envelope.sequence < before,
  );
  return trimPage(events, limit, page?.hasMore === true);
}
