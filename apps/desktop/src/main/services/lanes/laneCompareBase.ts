import type { AdeDb } from "../state/kvDb";
import { branchNameFromLaneRef, resolveLaneCompareBase } from "../../../shared/laneBaseResolution";

/**
 * Base branch of the lane's open or draft pull request, or null when it has
 * none. Only a PR whose head is the lane's current branch counts, so a lane
 * that switched branches does not inherit the old branch's PR base.
 */
export function readOpenPrBaseForLane(
  db: AdeDb,
  projectId: string,
  laneId: string,
  branchRef: string | null | undefined,
): string | null {
  const laneBranch = branchNameFromLaneRef(branchRef);
  if (!laneBranch) return null;
  const rows = db.all<{ base_branch: string | null; head_branch: string | null }>(
    `
      select base_branch, head_branch
        from pull_requests
       where project_id = ?
         and lane_id = ?
         and state in ('open', 'draft')
         and detached_at is null
       order by updated_at desc, created_at desc
    `,
    [projectId, laneId],
  );
  for (const row of rows) {
    if (branchNameFromLaneRef(row.head_branch) !== laneBranch) continue;
    const base = branchNameFromLaneRef(row.base_branch);
    if (base) return base;
  }
  return null;
}

/**
 * The branch a non-primary lane compares against: its open PR's base branch,
 * else the project's default branch. See `resolveLaneCompareBase`.
 */
export function readLaneCompareBase(args: {
  db: AdeDb;
  projectId: string;
  laneId: string;
  branchRef: string | null | undefined;
  defaultBranch: string;
}): string {
  return resolveLaneCompareBase({
    prBaseBranch: readOpenPrBaseForLane(args.db, args.projectId, args.laneId, args.branchRef),
    defaultBranch: args.defaultBranch,
  });
}
