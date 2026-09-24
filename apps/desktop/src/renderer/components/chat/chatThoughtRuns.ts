import { mergeReasoningTextFragments } from "../../../shared/chatActivityPhase";
import { isInlineCardSpawnNotice } from "../../../shared/chatSubagents";
import { parseTimestampMs } from "../../../shared/timestamps";
import type { ChatTranscriptGroupedEnvelope, RenderReasoningEvent } from "./chatTranscriptRows";

// Thought runs: Thought rows that end up next to each other on screen drawn as
// ONE Thought row. Runs on the drawn rows — in `AgentChatMessageList` right
// after the turn fold is applied — so every row the timeline does not draw is
// already gone: tool groups (they live in the tools toggle), an open fold's
// duplicate answer copy, and covered diff summaries. The few rows that are
// still in the list but draw nothing (`drawsNothingBetweenThoughts`) are
// stepped over and move ahead of the merged row.

type ReasoningEnvelope = ChatTranscriptGroupedEnvelope & { event: RenderReasoningEvent };

function isReasoningRow(row: ChatTranscriptGroupedEnvelope): row is ReasoningEnvelope {
  return row.event.type === "reasoning";
}

/**
 * Rows the timeline keeps in the list but renders as nothing, so they must not
 * split a run: the `subagent_spawned` notice an inline card already carries,
 * the "Promoted to Cursor Cloud" marker, a queued-command lifecycle that did
 * not cancel, a conversation reset, and an empty non-failure status.
 */
export function drawsNothingBetweenThoughts(row: ChatTranscriptGroupedEnvelope): boolean {
  const event = row.event;
  switch (event.type) {
    case "system_notice": {
      if (event.noticeKind === "info" && event.message === "Promoted to Cursor Cloud") return true;
      return isInlineCardSpawnNotice(event);
    }
    case "command_lifecycle":
      return event.status !== "cancelled" && event.status !== "discarded";
    case "conversation_reset":
      return true;
    case "status":
      return event.turnStatus !== "failed"
        && event.turnStatus !== "interrupted"
        && !(event.message ?? "").trim().length;
    default:
      return false;
  }
}

/**
 * Measured thinking time of a finished Thought row, or null when the row has
 * no real timing (one chunk, or a sub-second span).
 */
export function thoughtDurationSeconds(
  startTimestamp: string | null | undefined,
  endTimestamp: string | null | undefined,
): number | null {
  const start = parseTimestampMs(startTimestamp);
  const end = parseTimestampMs(endTimestamp);
  if (start == null || end == null) return null;
  const seconds = Math.floor((end - start) / 1000);
  return seconds >= 1 ? seconds : null;
}

function turnIdOf(row: ReasoningEnvelope): string | null {
  return row.event.turnId?.trim() || null;
}

/**
 * A single Thought row's measured duration, or null when it has none: one
 * chunk, a sub-second span, or an activity-phase merge whose span also covers
 * tool work.
 */
export function reasoningRowDurationSeconds(row: ReasoningEnvelope): number | null {
  if (row.event.latestStartTimestamp) return null;
  return thoughtDurationSeconds(row.event.startTimestamp, row.timestamp);
}

/** Sum of every member's duration; null as soon as one member has none. */
function sumMemberDurations(members: readonly ReasoningEnvelope[]): number | null {
  let total = 0;
  for (const member of members) {
    const seconds = reasoningRowDurationSeconds(member);
    if (seconds == null) return null;
    total += seconds;
  }
  return total;
}

const membersByMergedRow = new WeakMap<ChatTranscriptGroupedEnvelope, readonly ChatTranscriptGroupedEnvelope[]>();

function sameMembers(
  left: readonly ChatTranscriptGroupedEnvelope[] | undefined,
  right: readonly ChatTranscriptGroupedEnvelope[],
): boolean {
  if (!left || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameMergedRow(previous: ChatTranscriptGroupedEnvelope, next: ReasoningEnvelope): boolean {
  if (previous.event.type !== "reasoning" || previous.timestamp !== next.timestamp) return false;
  const a = previous.event;
  const b = next.event;
  if (
    a.text !== b.text
    || a.startTimestamp !== b.startTimestamp
    || a.thoughtRunDurationSeconds !== b.thoughtRunDurationSeconds
    || a.turnId !== b.turnId
    || a.thoughtMemberKeys?.length !== b.thoughtMemberKeys?.length
  ) return false;
  return (a.thoughtMemberKeys ?? []).every((key, index) => key === b.thoughtMemberKeys?.[index]);
}

function buildMergedRow(members: readonly ReasoningEnvelope[]): ReasoningEnvelope {
  const first = members[0]!;
  const last = members[members.length - 1]!;
  const { latestStartTimestamp: _latestStart, ...firstEvent } = first.event;
  return {
    key: first.key,
    timestamp: last.timestamp,
    event: {
      ...firstEvent,
      text: mergeReasoningTextFragments(members.map((member) => member.event.text ?? "")),
      startTimestamp: first.event.startTimestamp ?? first.timestamp,
      thoughtMemberKeys: members.map((member) => member.key),
      thoughtRunDurationSeconds: sumMemberDurations(members),
    },
  };
}

/**
 * Fold each run of 2+ Thought rows of one turn that sit next to each other on
 * screen into ONE Thought row keyed by its first member. A drawn row of any
 * kind (text, a card, a divider, a fold row) ends a run.
 *
 * `liveRowKey` — the reasoning row that is still streaming — never joins an
 * earlier run: that would hand the live row the earlier row's key and remount
 * it mid-stream. Once it stops being live it joins like any other thought.
 *
 * `previous` (the last pass's merged rows by key) lets an unchanged merged row
 * keep its envelope identity across streaming deltas elsewhere, so the row
 * does not re-render. Returns the input array itself when nothing merges.
 */
export function mergeAdjacentThoughtRows(
  rows: ChatTranscriptGroupedEnvelope[],
  liveRowKey: string | null = null,
  previous?: ReadonlyMap<string, ChatTranscriptGroupedEnvelope>,
): ChatTranscriptGroupedEnvelope[] {
  let result: ChatTranscriptGroupedEnvelope[] | null = null;
  let index = 0;
  while (index < rows.length) {
    const row = rows[index]!;
    if (!isReasoningRow(row) || row.key === liveRowKey) {
      result?.push(row);
      index += 1;
      continue;
    }
    const turnId = turnIdOf(row);
    const members: ReasoningEnvelope[] = [row];
    const skipped: ChatTranscriptGroupedEnvelope[] = [];
    let pendingSkipped: ChatTranscriptGroupedEnvelope[] = [];
    let end = index + 1;
    while (end < rows.length) {
      const candidate = rows[end]!;
      if (drawsNothingBetweenThoughts(candidate)) {
        pendingSkipped.push(candidate);
        end += 1;
        continue;
      }
      if (!isReasoningRow(candidate) || candidate.key === liveRowKey) break;
      if (turnIdOf(candidate) !== turnId) break;
      skipped.push(...pendingSkipped);
      pendingSkipped = [];
      members.push(candidate);
      end += 1;
    }
    // Trailing invisible rows were not inside the run; leave them in place.
    end -= pendingSkipped.length;
    if (members.length < 2) {
      result?.push(row);
      index += 1;
      continue;
    }
    if (!result) result = rows.slice(0, index);
    result.push(...skipped);
    const reused = previous?.get(row.key);
    if (reused && sameMembers(membersByMergedRow.get(reused), members)) {
      result.push(reused);
    } else {
      const merged = buildMergedRow(members);
      const kept = reused && sameMergedRow(reused, merged) ? reused : merged;
      membersByMergedRow.set(kept, members);
      result.push(kept);
    }
    index = end;
  }
  return result ?? rows;
}

/** The merged Thought rows of a pass, by key, for the next pass's `previous`. */
export function collectMergedThoughtRows(
  rows: readonly ChatTranscriptGroupedEnvelope[],
): Map<string, ChatTranscriptGroupedEnvelope> {
  const byKey = new Map<string, ChatTranscriptGroupedEnvelope>();
  for (const row of rows) {
    if (row.event.type === "reasoning" && row.event.thoughtMemberKeys) byKey.set(row.key, row);
  }
  return byKey;
}

/**
 * Member Thought key -> the merged row that draws it. Jumps, highlights, event
 * anchors, inline proof, and scroll-memory anchors that name a merged member
 * resolve through this. The first member maps to itself.
 */
export function thoughtRunKeyByMemberKey(
  rows: readonly ChatTranscriptGroupedEnvelope[],
): Map<string, string> {
  const byMember = new Map<string, string>();
  for (const row of rows) {
    if (row.event.type !== "reasoning" || !row.event.thoughtMemberKeys) continue;
    for (const memberKey of row.event.thoughtMemberKeys) byMember.set(memberKey, row.key);
  }
  return byMember;
}

/** Same member -> row mapping; lets the list keep the map's identity across deltas. */
