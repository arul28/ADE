import type { AdeDb } from "../state/kvDb";
import { runGit } from "../git/git";
import { branchNameFromLaneRef } from "../../../shared/laneBaseResolution";
import type { Logger } from "../logging/logger";

/**
 * A lane built on another lane that was squash-merged still carries that
 * lane's commits. A plain `git rebase <base>` replays them on top of their own
 * squash and conflicts wherever they overlap. Knowing the merged PR's head
 * lets a rebase replay only the lane's own work (`--onto <base> <merged head>`)
 * and lets the conflict prediction replay exactly the same thing.
 */

const MERGED_WORK_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

export type MergedPrHead = {
  number: number;
  title: string | null;
  headBranch: string;
  baseBranch: string;
  laneId: string | null;
  mergedHeadSha: string;
};

/** How far back in the base a PR's merge commit is looked for. */
const BASE_MERGE_SEARCH_COMMITS = 5_000;

function subjectIsMergeOfPr(subject: string, prNumber: number): boolean {
  return subject.endsWith(`(#${prNumber})`) || subject.startsWith(`Merge pull request #${prNumber} `);
}

/** PRs merged in the last 30 days whose head commit is known. */
export function listRecentMergedPrHeads(args: { db: AdeDb; projectId: string; logger: Logger }): MergedPrHead[] {
  const since = new Date(Date.now() - MERGED_WORK_LOOKBACK_MS).toISOString();
  try {
    return args.db.all<{
      github_pr_number: number | null;
      title: string | null;
      head_branch: string | null;
      base_branch: string | null;
      lane_id: string | null;
      merged_head_sha: string | null;
    }>(
      `
        select github_pr_number, title, head_branch, base_branch, lane_id, merged_head_sha
          from pull_requests
         where project_id = ?
           and state = 'merged'
           and merged_head_sha is not null
           and coalesce(merged_at, updated_at) >= ?
         order by coalesce(merged_at, updated_at) desc
      `,
      [args.projectId, since],
    ).flatMap((row) => {
      const sha = String(row.merged_head_sha ?? "").trim();
      const number = Number(row.github_pr_number);
      if (!sha || !Number.isFinite(number)) return [];
      return [{
        number,
        title: row.title ?? null,
        headBranch: branchNameFromLaneRef(row.head_branch),
        baseBranch: branchNameFromLaneRef(row.base_branch),
        laneId: row.lane_id ?? null,
        mergedHeadSha: sha,
      }];
    });
  } catch (err) {
    args.logger.warn("conflicts.rebase_needs.merged_prs_read_failed", { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/**
 * The PR this lane was built on: one of the lane's own commits (on the lane,
 * not in the base) is the head of a PR that merged into this base. Listing the
 * lane's own commits once is the same answer as asking
 * `merge-base --is-ancestor` per merged PR, for one git call per lane.
 *
 * Only when the base holds that PR's merge commit. GitHub can report the merge
 * before the local base is fetched, and replaying past the PR's head then would
 * drop its work from the lane with nothing in the base to replace it. A squash
 * title GitHub did not number proves nothing, so that lane gets a plain rebase.
 */
export async function findBuiltOnMergedPr(args: {
  cwd: string;
  laneId: string;
  laneBranch: string;
  baseBranch: string;
  baseHead: string;
  laneHead: string;
  mergedPrs: readonly MergedPrHead[];
}): Promise<MergedPrHead | null> {
  const candidates = args.mergedPrs.filter((pr) =>
    pr.baseBranch === args.baseBranch
    && pr.laneId !== args.laneId
    && pr.headBranch !== args.laneBranch);
  if (candidates.length === 0) return null;
  const own = await runGit(
    ["rev-list", `${args.baseHead}..${args.laneHead}`],
    { cwd: args.cwd, timeoutMs: 15_000 },
  );
  if (own.exitCode !== 0) return null;
  const ownCommits = new Set(own.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const inLane = candidates.filter((pr) => ownCommits.has(pr.mergedHeadSha));
  if (inLane.length === 0) return null;
  const baseOnly = await runGit(
    ["log", `--max-count=${BASE_MERGE_SEARCH_COMMITS}`, "--format=%s", `${args.laneHead}..${args.baseHead}`],
    { cwd: args.cwd, timeoutMs: 15_000 },
  );
  if (baseOnly.exitCode !== 0) return null;
  const subjects = baseOnly.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return inLane.find((pr) => subjects.some((subject) => subjectIsMergeOfPr(subject, pr.number))) ?? null;
}

/** The arguments for rebasing onto `target`, replaying only the lane's own work when it has a merged PR under it. */
export function rebaseArgsFor(target: string, builtOn: MergedPrHead | null): string[] {
  return builtOn ? ["rebase", "--onto", target, builtOn.mergedHeadSha] : ["rebase", target];
}
