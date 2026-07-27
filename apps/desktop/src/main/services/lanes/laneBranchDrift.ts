import type { LaneBranchDrift } from "../../../shared/types";
import { normalizeBranchName } from "../shared/utils";

/**
 * Branch drift = the lane worktree's live HEAD no longer points at the branch
 * ADE recorded in `lanes.branch_ref`. It happens whenever an agent or the user
 * runs `git checkout` inside the worktree; without detection ADE keeps showing
 * — and PR-matching against — a branch the lane no longer tracks.
 *
 * Detection piggybacks on the `git status` call the lane-status refresh already
 * makes (see `computeLaneStatus`), so it costs no extra process spawns and needs
 * no timer of its own.
 */

/** git reports a detached HEAD as this literal in porcelain v2 `branch.head`. */
const DETACHED_HEAD_SENTINEL = "(detached)";

export type WorktreeStatusPorcelainV2 = {
  dirty: boolean;
  /** `null` for a detached HEAD or when git did not report the header. */
  headBranchRef: string | null;
};

/**
 * Parse `git status --porcelain=v2 --branch`.
 *
 * Header lines are prefixed `# `; entry lines always start with `1`, `2`, `u`,
 * `?` or `!`, never `#`, so the split is unambiguous. Ignored files are not
 * listed unless `--ignored` is passed, matching the previous porcelain v1
 * dirty semantics exactly.
 */
export function parseWorktreeStatusPorcelainV2(stdout: string): WorktreeStatusPorcelainV2 {
  let dirty = false;
  let headBranchRef: string | null = null;
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line) continue;
    if (line.startsWith("#")) {
      const match = /^# branch\.head (.*)$/.exec(line);
      if (!match) continue;
      const value = (match[1] ?? "").trim();
      if (!value || value === DETACHED_HEAD_SENTINEL) continue;
      headBranchRef = normalizeBranchName(value).trim() || null;
      continue;
    }
    dirty = true;
  }
  return { dirty, headBranchRef };
}

/**
 * Compare the lane's recorded branch against the worktree's live HEAD.
 *
 * Returns `null` (no drift) when either side is unknown — an unavailable
 * worktree or a detached HEAD is not something the drift affordances can act
 * on, and nagging about it would be noise.
 */
/**
 * True when the lane's display name is just restating the branch it tracks —
 * either the whole ref (`ade/fix-auth`) or its last segment (`fix-auth`).
 *
 * Only those names are re-pointed when a lane adopts a drifted HEAD; a
 * hand-written name like "Auth work" advertises no branch and is left alone.
 */
export function laneNameAdvertisesBranch(
  laneName: string | null | undefined,
  branchRef: string | null | undefined,
): boolean {
  const name = (laneName ?? "").trim().toLowerCase();
  const branch = normalizeBranchName((branchRef ?? "").trim()).trim().toLowerCase();
  if (!name || !branch) return false;
  if (name === branch) return true;
  const lastSegment = branch.split("/").filter(Boolean).pop() ?? "";
  return Boolean(lastSegment) && name === lastSegment;
}

export function detectLaneBranchDrift(args: {
  expectedBranchRef: string | null | undefined;
  headBranchRef: string | null | undefined;
}): LaneBranchDrift | null {
  const expectedBranchRef = normalizeBranchName((args.expectedBranchRef ?? "").trim()).trim();
  const headBranchRef = normalizeBranchName((args.headBranchRef ?? "").trim()).trim();
  if (!expectedBranchRef || !headBranchRef) return null;
  if (expectedBranchRef === headBranchRef) return null;
  return { expectedBranchRef, headBranchRef };
}
