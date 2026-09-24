import {
  classifyTurnFoldEvent,
  deriveTurnFolds,
  isTrivialTurnFoldEvent,
  type TurnEndSnapshot,
  type TurnFold,
  type TurnFoldRow,
} from "../../../shared/chatTurnFold";
import type { ChatTranscriptGroupedEnvelope } from "./chatTranscriptRows";

export function groupedEnvelopeTurnId(row: ChatTranscriptGroupedEnvelope): string | null {
  const event = row.event;
  if (event.type === "work_log_group") return event.turnId ?? event.entries[0]?.turnId ?? null;
  if (event.type === "activity_bundle") {
    return event.turnId ?? event.items.find((item) => item.event.turnId)?.event.turnId ?? null;
  }
  const turnId = "turnId" in event ? event.turnId : null;
  return typeof turnId === "string" && turnId.trim().length ? turnId.trim() : null;
}


export function describeTurnFoldRow(row: ChatTranscriptGroupedEnvelope): TurnFoldRow {
  const { event } = row;
  const described: TurnFoldRow = {
    key: row.key,
    role: classifyTurnFoldEvent(event),
    turnId: groupedEnvelopeTurnId(row),
  };
  if (event.type === "text") described.phase = event.phase ?? null;
  if (event.type === "done") described.status = event.status;
  if (event.type === "activity_bundle") described.liveKeys = event.items.map((item) => item.key);
  if (event.type === "background_job_group") described.liveKeys = event.memberKeys;
  // The prose lets the fold spot an earlier row that repeats the answer.
  if (event.type === "text") described.text = event.text;
  if (isTrivialTurnFoldEvent(event)) described.trivial = true;
  return described;
}

/**
 * Same folds, same spans, same hidden and kept rows. The fold list is derived
 * on every streaming delta; keeping its identity while nothing about the folds
 * changed spares everything keyed on it (hidden-row lookups, jump remaps, the
 * scroll anchor's "did a turn just fold" check).
 */
export function sameTurnFolds(left: readonly TurnFold[], right: readonly TurnFold[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (
      a.foldId !== b.foldId
      || a.turnEndKey !== b.turnEndKey
      || a.status !== b.status
      || a.answerKey !== b.answerKey
      || a.spanStartIndex !== b.spanStartIndex
      || a.answerIndex !== b.answerIndex
      || a.subagentCount !== b.subagentCount
      || a.hiddenKeys.size !== b.hiddenKeys.size
      || a.keptKeys.length !== b.keptKeys.length
    ) return false;
    for (let kept = 0; kept < a.keptKeys.length; kept += 1) {
      if (a.keptKeys[kept] !== b.keptKeys[kept]) return false;
    }
    for (const key of a.hiddenKeys) if (!b.hiddenKeys.has(key)) return false;
    if (a.duplicateAnswerKeys.size !== b.duplicateAnswerKeys.size) return false;
    for (const key of a.duplicateAnswerKeys) if (!b.duplicateAnswerKeys.has(key)) return false;
  }
  return true;
}

/** Folds for the rows the timeline would draw (after presentation filtering). */
export function deriveChatTranscriptTurnFolds(
  rows: readonly ChatTranscriptGroupedEnvelope[],
  snapshots: ReadonlyMap<string, TurnEndSnapshot>,
): TurnFold[] {
  return deriveTurnFolds(rows.map(describeTurnFoldRow), (turnId) => snapshots.get(turnId));
}

/**
 * Background jobs in a fold's span (hidden and kept alike, like the subagent
 * count), and how many of them failed. A job's status is read now, not at turn
 * end, so a job that fails after the turn still counts as failed.
 */
function countTurnFoldJobs(
  rows: readonly ChatTranscriptGroupedEnvelope[],
  fold: TurnFold,
): { jobCount: number; failedJobCount: number } {
  let jobCount = 0;
  let failedJobCount = 0;
  for (let index = fold.spanStartIndex; index < fold.answerIndex; index += 1) {
    const event = rows[index]?.event;
    if (event?.type === "background_job_line") {
      jobCount += 1;
      if (event.status === "failed") failedJobCount += 1;
    } else if (event?.type === "background_job_group") {
      for (const member of event.members) {
        jobCount += 1;
        if (member.event.status === "failed") failedJobCount += 1;
      }
    }
  }
  return { jobCount, failedJobCount };
}

function turnFoldRowFor(
  fold: TurnFold,
  timestamp: string,
  previous: ReadonlyMap<string, ChatTranscriptGroupedEnvelope> | undefined,
  jobs: { jobCount: number; failedJobCount: number },
): ChatTranscriptGroupedEnvelope {
  const reused = previous?.get(fold.foldId);
  if (
    reused?.event.type === "turn_fold"
    && reused.timestamp === timestamp
    && reused.event.turnEndKey === fold.turnEndKey
    && reused.event.status === fold.status
    && reused.event.hiddenCount === fold.hiddenKeys.size
    && reused.event.subagentCount === fold.subagentCount
    && (reused.event.jobCount ?? 0) === jobs.jobCount
    && (reused.event.failedJobCount ?? 0) === jobs.failedJobCount
  ) {
    return reused;
  }
  return {
    key: fold.foldId,
    timestamp,
    event: {
      type: "turn_fold",
      foldId: fold.foldId,
      turnId: fold.turnId,
      turnEndKey: fold.turnEndKey,
      status: fold.status,
      hiddenCount: fold.hiddenKeys.size,
      subagentCount: fold.subagentCount,
      jobCount: jobs.jobCount,
      failedJobCount: jobs.failedJobCount,
    },
  };
}

/**
 * The timeline with every fold applied: the fold row takes the place of its
 * span's first row, a closed fold drops its hidden rows, and every other row
 * keeps its own envelope (and so its key and measured height). An open fold
 * shows the whole span in original order under the fold row.
 *
 * `previousFoldRows` lets the caller reuse unchanged fold envelopes so a
 * streaming delta elsewhere does not re-render every fold row.
 */
export function applyChatTranscriptTurnFolds(
  rows: ChatTranscriptGroupedEnvelope[],
  folds: readonly TurnFold[],
  openFoldIds: ReadonlySet<string>,
  previousFoldRows?: ReadonlyMap<string, ChatTranscriptGroupedEnvelope>,
): ChatTranscriptGroupedEnvelope[] {
  if (!folds.length) return rows;
  const out: ChatTranscriptGroupedEnvelope[] = [];
  let nextFold = 0;
  let active: TurnFold | null = null;
  // An open fold still drops earlier rows that repeat its answer word for word.
  let openFold: TurnFold | null = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const fold = folds[nextFold];
    if (fold && index === fold.spanStartIndex) {
      out.push(turnFoldRowFor(fold, row.timestamp, previousFoldRows, countTurnFoldJobs(rows, fold)));
      const open = openFoldIds.has(fold.foldId);
      active = open ? null : fold;
      openFold = open ? fold : null;
      nextFold += 1;
    }
    if (active && index >= active.answerIndex) active = null;
    if (openFold && index >= openFold.answerIndex) openFold = null;
    if (active?.hiddenKeys.has(row.key)) continue;
    if (openFold?.duplicateAnswerKeys.has(row.key)) continue;
    out.push(row);
  }
  return out;
}
