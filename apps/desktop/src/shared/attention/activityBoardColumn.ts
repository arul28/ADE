import type { AttentionItem } from "../types/attention";
import {
  isWorkBoardColumn,
  isWorkBoardWaitingReason,
  type WorkBoardColumn,
  type WorkBoardWaitingReason,
} from "../types/chat";

/**
 * The one state model every Activity surface counts by: the Work board's four
 * columns. The desktop panel, the phone's Hub and drawer, the widgets and the
 * Live Activity all group agent items with this function, so "2 need you"
 * means the same rows everywhere.
 *
 * The publishing brain writes `boardColumn` with the board's own rules. This
 * function trusts a valid value and otherwise derives one from the phase, for
 * items an older brain published:
 *
 *   needs_you, failed           → needs_you  (a failure is the user's move)
 *   idle tier                   → done       (finished, or resting)
 *   starting, running, stale    → working
 *   anything else               → done
 *
 * An older brain cannot say why a row waits, so the fallback never answers
 * `waiting`; that column fills as brains update.
 *
 * Pull-request items return null. They are notifications, not agents, and are
 * never counted in a column.
 *
 * The same table is implemented in Swift (iOS) and in the push relay, which
 * cannot import this file. `activityBoardColumn.cases.json` beside this file
 * pins all three: change the rule here, update the cases, and let the other
 * suites fail until they follow.
 */
export function activityBoardColumn(
  item: Pick<AttentionItem, "kind" | "phase" | "activityTier" | "boardColumn">,
): WorkBoardColumn | null {
  if (item.kind !== "agent") return null;
  if (isWorkBoardColumn(item.boardColumn)) return item.boardColumn;
  if (item.phase === "needs_you" || item.phase === "failed") return "needs_you";
  if (item.activityTier === "idle") return "done";
  if (item.phase === "starting" || item.phase === "running" || item.phase === "stale") {
    return "working";
  }
  return "done";
}

/** Why a Waiting item waits, or null for every other column. */
export function activityWaitingReason(
  item: Pick<AttentionItem, "kind" | "phase" | "activityTier" | "boardColumn" | "waitingReason">,
): WorkBoardWaitingReason | null {
  if (activityBoardColumn(item) !== "waiting") return null;
  return isWorkBoardWaitingReason(item.waitingReason) ? item.waitingReason : null;
}

/** Agent items per column. Pull requests are not counted. */
export function countActivityBoardColumns(
  items: Iterable<Pick<AttentionItem, "kind" | "phase" | "activityTier" | "boardColumn">>,
): Record<WorkBoardColumn, number> {
  const counts: Record<WorkBoardColumn, number> = {
    needs_you: 0,
    working: 0,
    waiting: 0,
    done: 0,
  };
  for (const item of items) {
    const column = activityBoardColumn(item);
    if (column) counts[column] += 1;
  }
  return counts;
}
