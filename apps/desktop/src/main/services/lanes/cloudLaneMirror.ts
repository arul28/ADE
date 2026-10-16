import type { Logger } from "../logging/logger";
import { runGit } from "../git/git";
import { getErrorMessage } from "../shared/utils";

export type CloudLaneMirrorSyncResult =
  | "fast_forwarded"
  | "skipped_no_branch"
  | "skipped_fetch_failed"
  | "skipped_wrong_branch"
  | "skipped_dirty"
  | "skipped_not_fast_forward"
  | "failed";

/**
 * Fast-forward a cloud lane's mirror worktree to what the cloud agent pushed.
 *
 * The mirror is never edited in ADE, so a plain fast-forward is always the
 * right move. Anything else is left alone and logged rather than merged,
 * because merging would invent history the cloud agent never wrote:
 * - the worktree is not checked out on `branch` (someone switched it), or
 * - it has uncommitted changes, or
 * - the branch diverged.
 */
export async function syncCloudLaneMirror(args: {
  worktreePath: string | null | undefined;
  branch: string | null | undefined;
  logger: Logger;
}): Promise<CloudLaneMirrorSyncResult> {
  const branch = args.branch?.trim();
  const cwd = args.worktreePath?.trim();
  if (!branch || !cwd) return "skipped_no_branch";
  const { logger } = args;
  try {
    const fetched = await runGit(["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
      cwd,
      timeoutMs: 60_000,
    });
    if (fetched.exitCode !== 0) {
      logger.info("cloud_lane_mirror.fetch_failed", { branch, stderr: fetched.stderr.slice(-300) });
      return "skipped_fetch_failed";
    }
    const head = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd, timeoutMs: 15_000 });
    const checkedOut = head.exitCode === 0 ? head.stdout.trim() : null;
    if (checkedOut !== branch) {
      logger.info("cloud_lane_mirror.wrong_branch", { branch, checkedOut });
      return "skipped_wrong_branch";
    }
    const status = await runGit(["status", "--porcelain=v1", "--untracked-files=no"], { cwd, timeoutMs: 15_000 });
    if (status.exitCode !== 0 || status.stdout.trim().length) {
      logger.info("cloud_lane_mirror.dirty", { branch });
      return "skipped_dirty";
    }
    const merged = await runGit(["merge", "--ff-only", "--quiet", `refs/remotes/origin/${branch}`], {
      cwd,
      timeoutMs: 30_000,
    });
    if (merged.exitCode !== 0) {
      logger.info("cloud_lane_mirror.not_fast_forward", { branch, stderr: merged.stderr.slice(-300) });
      return "skipped_not_fast_forward";
    }
    return "fast_forwarded";
  } catch (error) {
    logger.warn("cloud_lane_mirror.sync_failed", { branch, error: getErrorMessage(error) });
    return "failed";
  }
}
