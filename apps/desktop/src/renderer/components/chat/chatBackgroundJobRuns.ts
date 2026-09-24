import type { TurnEndSnapshot } from "../../../shared/chatTurnFold";
import { isInlineCardSpawnNotice } from "../../../shared/chatSubagents";
import { collectConsecutiveRun, sameRunMembers } from "./chatTranscriptRunCollector";
import type {
  BackgroundJobGroupMember,
  BackgroundJobLineRenderEvent,
  ChatTranscriptGroupedEnvelope,
} from "./chatTranscriptRows";

// Background job runs: consecutive `background_job_line` rows drawn as ONE
// compact row. Runs on the drawn rows (after the presentation filter, before the
// turn fold) in `AgentChatMessageList`'s `presentedRows`, beside
// `groupSubagentCardGrids`.

/**
 * Rows that draw nothing between two job lines and so must not split a run:
 * the `subagent_spawned` notice whose announcement an inline card already
 * carries (`hasInlineCard`).
 */
function drawsNothingBetweenJobs(row: ChatTranscriptGroupedEnvelope): boolean {
  return isInlineCardSpawnNotice(row.event);
}

function isBackgroundJobLineRow(row: ChatTranscriptGroupedEnvelope): row is BackgroundJobGroupMember {
  return row.event.type === "background_job_line";
}

/**
 * Row keys that were still live when their turn ended, across every recorded
 * turn-end snapshot. Only these decide whether two job lines share a fold fate.
 */
export function collectTurnEndLiveRowKeys(
  snapshots: ReadonlyMap<string, TurnEndSnapshot>,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const snapshot of snapshots.values()) {
    for (const key of snapshot.liveRowKeys) keys.add(key);
  }
  return keys;
}

/**
 * Fold each run of 2+ consecutive background job lines into one
 * `background_job_group` row keyed by its first member. Labels and statuses do
 * not matter. Invisible spawn notices inside a run move ahead of the group.
 *
 * `liveAtTurnEnd` splits a run where the turn fold would split it: a job still
 * running when its turn ended stays visible below the fold row, while jobs that
 * finished before then fold. Grouping those together would either hide a live
 * job or keep finished ones on screen. Before a turn ends no member is in the
 * set, so a live turn's jobs always share one row.
 *
 * Returns the input array itself when nothing groups, so identity-keyed memos
 * downstream see no change.
 */
export function groupBackgroundJobRuns(
  rows: ChatTranscriptGroupedEnvelope[],
  liveAtTurnEnd: ReadonlySet<string> = EMPTY_KEYS,
  previousRows: readonly ChatTranscriptGroupedEnvelope[] = [],
): ChatTranscriptGroupedEnvelope[] {
  const previousByKey = new Map(previousRows.map((row) => [row.key, row]));
  let result: ChatTranscriptGroupedEnvelope[] | null = null;
  let index = 0;
  while (index < rows.length) {
    const row = rows[index]!;
    const run = collectConsecutiveRun(rows, index, {
      isMember: isBackgroundJobLineRow,
      isIgnorable: drawsNothingBetweenJobs,
      canJoin: (first, candidate) => liveAtTurnEnd.has(first.key) === liveAtTurnEnd.has(candidate.key),
    });
    if (!run) {
      result?.push(row);
      index += 1;
      continue;
    }
    if (!result) result = rows.slice(0, index);
    result.push(...run.skipped);
    const members = run.members;
    const timestamp = members[members.length - 1]!.timestamp;
    const memberKeys = members.map((member) => member.key);
    const previous = previousByKey.get(row.key);
    if (
      previous?.event.type === "background_job_group"
      && previous.timestamp === timestamp
      && sameRunMembers(previous.event.members, members)
      && sameRunMembers(previous.event.memberKeys, memberKeys)
    ) {
      result.push(previous);
      index = run.nextIndex;
      continue;
    }
    result.push({
      key: row.key,
      timestamp,
      event: {
        type: "background_job_group",
        members,
        memberKeys,
      },
    });
    index = run.nextIndex;
  }
  return result ?? rows;
}

const EMPTY_KEYS: ReadonlySet<string> = new Set();

/**
 * Member job-line key -> the group row that draws it, for every group whose
 * members are not all the row's own key. Jumps, highlights, and scroll-memory
 * anchors that name a job line resolve through this.
 */
export function backgroundJobGroupKeyByMemberKey(
  rows: readonly ChatTranscriptGroupedEnvelope[],
): Map<string, string> {
  const byMember = new Map<string, string>();
  for (const row of rows) {
    if (row.event.type !== "background_job_group") continue;
    for (const memberKey of row.event.memberKeys) byMember.set(memberKey, row.key);
  }
  return byMember;
}

export type BackgroundJobCounts = {
  total: number;
  running: number;
  done: number;
  failed: number;
  stopped: number;
};

export function countBackgroundJobs(jobs: readonly BackgroundJobLineRenderEvent[]): BackgroundJobCounts {
  const counts: BackgroundJobCounts = { total: jobs.length, running: 0, done: 0, failed: 0, stopped: 0 };
  for (const job of jobs) {
    if (job.status === "running") counts.running += 1;
    else if (job.status === "completed") counts.done += 1;
    else if (job.status === "failed") counts.failed += 1;
    else counts.stopped += 1;
  }
  return counts;
}

/** The status word a finished job reads with: `done`, `failed`, `stopped`. */
export function backgroundJobStatusWord(status: BackgroundJobLineRenderEvent["status"]): string {
  if (status === "completed") return "done";
  return status;
}
