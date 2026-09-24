import type { AgentChatEventEnvelope } from "../../../shared/types/chat";
import { buildDrawnRowKeyIndex } from "./chatDrawnRowIndex";
import {
  collapseChatTranscriptEvents,
  filterVisibleTranscriptRows,
  groupChatTranscriptRows,
  subagentCardKeyForLifecycleEvent,
  type ChatTranscriptGroupedEnvelope,
} from "./chatTranscriptRows";
import { CHAT_TIMELINE_ROW_GAP_PX } from "./chatUserMinimap.logic";

/** Number of extra rows to render above/below the visible viewport. */
export const CHAT_TRANSCRIPT_OVERSCAN = 10;
export const STICK_THRESHOLD_PX = 160;
export const STICK_RESUME_THRESHOLD_PX = 24;

export function shouldAbsorbProgrammaticScrollEvent({
  scrollTop,
  programmaticTarget,
}: {
  scrollTop: number;
  programmaticTarget: number | null;
}): boolean {
  return programmaticTarget != null && Math.abs(scrollTop - programmaticTarget) < 1;
}

export function shouldStickToBottomAfterScroll({
  distanceFromBottom,
  wasStuckToBottom,
}: {
  distanceFromBottom: number;
  wasStuckToBottom: boolean;
}): boolean {
  return wasStuckToBottom
    ? distanceFromBottom < STICK_THRESHOLD_PX
    : distanceFromBottom <= STICK_RESUME_THRESHOLD_PX;
}

export function shouldKeepPinnedThroughViewportShrink({
  wasStuckToBottom,
  previousClientHeight,
  nextClientHeight,
}: {
  wasStuckToBottom: boolean;
  previousClientHeight: number;
  nextClientHeight: number;
}): boolean {
  if (!wasStuckToBottom || previousClientHeight <= 0) return false;
  return nextClientHeight < previousClientHeight - 0.5;
}

export function calculateVirtualWindow({
  rowCount,
  scrollTop,
  containerHeight,
  rowHeight,
  overscan = CHAT_TRANSCRIPT_OVERSCAN,
  rowGap = CHAT_TIMELINE_ROW_GAP_PX,
}: {
  rowCount: number;
  scrollTop: number;
  containerHeight: number;
  rowHeight: (index: number) => number;
  overscan?: number;
  rowGap?: number;
}): {
  startIndex: number;
  endIndex: number;
  totalHeight: number;
  offsetTop: number;
} {
  if (rowCount <= 0) {
    return { startIndex: 0, endIndex: 0, totalHeight: 0, offsetTop: 0 };
  }

  let cumulative = 0;
  const offsets: number[] = new Array(rowCount);
  for (let i = 0; i < rowCount; i += 1) {
    offsets[i] = cumulative;
    cumulative += rowHeight(i) + rowGap;
  }
  const totalHeight = cumulative - rowGap;
  const viewTop = scrollTop;
  const viewBottom = scrollTop + containerHeight;

  let lo = 0;
  let hi = rowCount - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const rowBottom = offsets[mid]! + rowHeight(mid);
    if (rowBottom < viewTop) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const firstVisible = lo;

  let lastVisible = firstVisible;
  while (lastVisible < rowCount - 1 && offsets[lastVisible + 1]! < viewBottom) {
    lastVisible += 1;
  }

  const startIndex = Math.max(0, firstVisible - overscan);
  const endIndex = Math.min(rowCount, lastVisible + 1 + overscan);

  return {
    startIndex,
    endIndex,
    totalHeight,
    offsetTop: offsets[startIndex] ?? 0,
  };
}

/**
 * Window anchored to the *end* of the list, used while we're following the
 * bottom of a streaming turn. Estimate-based `scrollTop` windowing drifts on
 * long transcripts (a single rendered row whose stored height lags its real
 * DOM height desyncs the spacer math from `el.scrollTop`), which strands the
 * tail above a phantom gap and "locks" — new content keeps landing at the top
 * while the space above the composer stays empty. Anchoring directly to the
 * last row keeps the tail permanently mounted and re-measured every frame, so
 * `bottomSpacerHeight` is always 0 and the streaming indicator sits flush
 * against the final message regardless of how stale the off-screen estimates
 * upstream are.
 */
export function calculateVirtualWindowAnchoredToEnd({
  rowCount,
  containerHeight,
  rowHeight,
  overscan = CHAT_TRANSCRIPT_OVERSCAN,
  rowGap = CHAT_TIMELINE_ROW_GAP_PX,
}: {
  rowCount: number;
  containerHeight: number;
  rowHeight: (index: number) => number;
  overscan?: number;
  rowGap?: number;
}): {
  startIndex: number;
  endIndex: number;
  totalHeight: number;
  offsetTop: number;
} {
  if (rowCount <= 0) {
    return { startIndex: 0, endIndex: 0, totalHeight: 0, offsetTop: 0 };
  }

  let total = 0;
  for (let i = 0; i < rowCount; i += 1) {
    total += rowHeight(i) + rowGap;
  }
  const totalHeight = total - rowGap;

  // Walk back from the last row until the rendered rows cover the viewport.
  let firstVisible = rowCount - 1;
  let filled = rowHeight(firstVisible);
  while (firstVisible > 0 && filled < containerHeight) {
    firstVisible -= 1;
    filled += rowHeight(firstVisible) + rowGap;
  }
  const startIndex = Math.max(0, firstVisible - overscan);

  let offsetTop = 0;
  for (let i = 0; i < startIndex; i += 1) {
    offsetTop += rowHeight(i) + rowGap;
  }

  return { startIndex, endIndex: rowCount, totalHeight, offsetTop };
}

export function reconcileMeasuredScrollTop({
  index,
  previousHeight,
  nextHeight,
  scrollTop,
  rowHeight,
  rowGap = CHAT_TIMELINE_ROW_GAP_PX,
}: {
  index: number;
  previousHeight: number;
  nextHeight: number;
  scrollTop: number;
  rowHeight: (index: number) => number;
  rowGap?: number;
}): number {
  const delta = nextHeight - previousHeight;
  if (delta === 0) return scrollTop;

  let rowTop = 0;
  for (let i = 0; i < index; i += 1) {
    rowTop += rowHeight(i) + rowGap;
  }

  // Any row that STARTS above the viewport top pushes what the reader sees when
  // it changes height — including one straddling the top edge, whose growth
  // lands below the edge (a code block highlighting, an image loading).
  if (rowTop < scrollTop) {
    return Math.max(0, scrollTop + delta);
  }
  return scrollTop;
}

export function findAnchoredChatEventIndex({
  events,
  anchorEvent,
  hasFullHistory,
}: {
  events: AgentChatEventEnvelope[];
  anchorEvent: number;
  hasFullHistory: boolean;
}): number {
  if (!Number.isInteger(anchorEvent) || anchorEvent < 0) return -1;
  const sequenceIndex = events.findIndex((envelope) => envelope.sequence === anchorEvent);
  if (sequenceIndex >= 0) return sequenceIndex;
  if (!hasFullHistory) return -1;
  return anchorEvent < events.length ? anchorEvent : -1;
}

export function resolveAnchoredChatRowIndex({
  events,
  groupedRows,
  anchorEvent,
  hasFullHistory,
}: {
  events: AgentChatEventEnvelope[];
  groupedRows: ChatTranscriptGroupedEnvelope[];
  anchorEvent: number;
  hasFullHistory: boolean;
}): number {
  const eventIndex = findAnchoredChatEventIndex({ events, anchorEvent, hasFullHistory });
  if (eventIndex < 0) return -1;
  const collapsedRows = collapseChatTranscriptEvents(events.slice(0, eventIndex + 1));
  const targetRows = groupChatTranscriptRows(filterVisibleTranscriptRows(collapsedRows));
  const targetRow = targetRows[targetRows.length - 1];
  if (!targetRow) return -1;
  // A subagent card drawn inside a grid row (or folded into a stopped group)
  // resolves to that row.
  const visibleKeys = buildDrawnRowKeyIndex(groupedRows);
  // A subagent's progress or result updates its card in place, earlier in the
  // thread, so the event's row is that card, not the last row.
  const subagentCardKey = subagentCardKeyForLifecycleEvent(collapsedRows, events[eventIndex]!.event);
  const subagentCardIndex = subagentCardKey ? visibleKeys.get(subagentCardKey) : undefined;
  if (subagentCardIndex !== undefined) return subagentCardIndex;
  const directIndex = visibleKeys.get(targetRow.key);
  if (directIndex !== undefined) return directIndex;

  // Tool-only rows are intentionally absent from the presented transcript.
  // Keep event anchors useful by resolving a hidden target to the closest
  // visible row around it instead of treating it as missing history.
  for (let index = targetRows.length - 2; index >= 0; index -= 1) {
    const visibleIndex = visibleKeys.get(targetRows[index]!.key);
    if (visibleIndex !== undefined) return visibleIndex;
  }
  const targetMs = Date.parse(targetRow.timestamp);
  if (Number.isFinite(targetMs)) {
    const followingIndex = groupedRows.findIndex((row) => {
      const rowMs = Date.parse(row.timestamp);
      return Number.isFinite(rowMs) && rowMs >= targetMs;
    });
    if (followingIndex >= 0) return followingIndex;
  }
  return groupedRows.length > 0 ? groupedRows.length - 1 : -1;
}
