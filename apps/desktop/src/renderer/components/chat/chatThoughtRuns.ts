import { mergeReasoningTextFragments } from "../../../shared/chatActivityPhase";
import { isInlineCardSpawnNotice } from "../../../shared/chatSubagents";
import { CLAUDE_SESSION_QUOTA_CARD_VARIANT } from "../../../shared/claudeSessionQuota";
import { isHostSleepNoticeEvent } from "../../../shared/hostSleepNotice";
import { isLegacyProviderRetryNotice } from "../../../shared/providerRetryPresentation";
import { parseTimestampMs } from "../../../shared/timestamps";
import type { AgentChatEvent } from "../../../shared/types/chat";
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

/** Identity of a stop receipt, shared with the list's stale-receipt tracking. */
export function interruptReceiptIdentity(
  event: Extract<AgentChatEvent, { type: "interrupt_receipt" }>,
): string {
  return `${event.turnId ?? ""}:${(event.stillQueuedUuids ?? []).join(",")}`;
}

/** List state a row's "draws nothing" answer depends on. */
export type TranscriptRowDrawContext = {
  /** Interrupt-receipt identities whose queued messages already ran. */
  staleInterruptReceipts?: ReadonlySet<string>;
  /** A usage limit is live: the composer pill owns the quota card's story. */
  usageLimitResumeActive?: boolean;
};

const SYSTEM_NOTICE_STATUSES_WITH_OWN_ROW = new Set([
  "model_switched",
  "spawn_takeover",
  "spawn_parent_gone",
  "spawn_completed",
]);

/**
 * THE rule for an event the timeline keeps in the list but renders as nothing.
 * `renderEvent` returns null exactly when this is true, and Thought runs step
 * over exactly these rows, so the two can never drift. `done` is not here: its
 * row draws the end-of-turn divider.
 */
export function transcriptEventDrawsNothing(
  // Raw events too: `renderEvent` also draws events the row pipeline drops.
  event: ChatTranscriptGroupedEnvelope["event"] | AgentChatEvent,
  context?: TranscriptRowDrawContext,
): boolean {
  switch (event.type) {
    case "user_message":
      // Queued steers live in the composer's staging area only.
      return event.deliveryState === "queued" && Boolean(event.steerId);
    case "codex_moderation_metadata":
    case "conversation_reset":
    case "api_retry":
    case "step_boundary":
      return true;
    case "interrupt_receipt":
      return Boolean(context?.staleInterruptReceipts?.has(interruptReceiptIdentity(event)))
        || (event.stillQueuedUuids ?? []).length === 0;
    case "queue_recovery":
      return event.state === "expired" || event.state === "restored";
    case "command_lifecycle":
      return event.status !== "cancelled" && event.status !== "discarded";
    case "ade_card":
      return event.variant === CLAUDE_SESSION_QUOTA_CARD_VARIANT && context?.usageLimitResumeActive === true;
    case "status":
      return event.turnStatus !== "failed"
        && event.turnStatus !== "interrupted"
        && !(event.message ?? "").trim().length;
    case "system_notice": {
      if (event.noticeKind === "info" && event.status === "subagent_spawned") return isInlineCardSpawnNotice(event);
      if (event.status === "model_switched") return false;
      if (event.noticeKind === "info" && SYSTEM_NOTICE_STATUSES_WITH_OWN_ROW.has(event.status ?? "")) return false;
      if (event.noticeKind === "info" && event.message === "Promoted to Cursor Cloud") return true;
      if (isHostSleepNoticeEvent(event)) return false;
      if (event.detail && typeof event.detail === "object" && (event.detail as { kind?: unknown }).kind === "continuity_recovery") {
        return false;
      }
      return isLegacyProviderRetryNotice(event);
    }
    default:
      return false;
  }
}

/** Rows that draw nothing never split a Thought run (see `transcriptEventDrawsNothing`). */
export function drawsNothingBetweenThoughts(
  row: ChatTranscriptGroupedEnvelope,
  context?: TranscriptRowDrawContext,
): boolean {
  return transcriptEventDrawsNothing(row.event, context);
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
    || a.latestStartTimestamp !== b.latestStartTimestamp
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
      // When the last member started: a run whose last member is still
      // streaming times the live thought, not the tool work before it.
      latestStartTimestamp: last.event.latestStartTimestamp ?? last.event.startTimestamp ?? last.timestamp,
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
 * The reasoning row that is still streaming joins the run above it like any
 * other thought. The run keeps its FIRST member's key, so the drawn row the
 * reader already sees simply becomes the live preview: the streaming content
 * never mounts as a separate row and nothing remounts when it settles. The
 * list passes `liveThinking` to the run whose members include the live row.
 *
 * `context` feeds the "draws nothing" rule (`transcriptEventDrawsNothing`).
 *
 * `previous` (the last pass's merged rows by key) lets an unchanged merged row
 * keep its envelope identity across streaming deltas elsewhere, so the row
 * does not re-render. Returns the input array itself when nothing merges.
 */
export function mergeAdjacentThoughtRows(
  rows: ChatTranscriptGroupedEnvelope[],
  previous?: ReadonlyMap<string, ChatTranscriptGroupedEnvelope>,
  context?: TranscriptRowDrawContext,
): ChatTranscriptGroupedEnvelope[] {
  let result: ChatTranscriptGroupedEnvelope[] | null = null;
  let index = 0;
  while (index < rows.length) {
    const row = rows[index]!;
    if (!isReasoningRow(row)) {
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
      if (drawsNothingBetweenThoughts(candidate, context)) {
        pendingSkipped.push(candidate);
        end += 1;
        continue;
      }
      if (!isReasoningRow(candidate)) break;
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
