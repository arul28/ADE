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
  /** Number of changed tracked entries in the worktree. */
  changedFileCount: number;
  /** Number of entries with index/staged changes. */
  staged: number;
  /** Number of entries with worktree/unstaged changes. */
  unstaged: number;
  /** Number of untracked entries. */
  untracked: number;
  /** `null` for a detached HEAD or when git did not report the header. */
  headBranchRef: string | null;
};

/**
 * Parse `git status --porcelain=v2 --branch`.
 *
 * With `-z`, records are NUL-delimited and rename/copy entries carry a second
 * NUL-delimited pathname after the status record. Consume that pathname as part
 * of the rename entry so it is not counted as a second change. The LF fallback
 * keeps older callers and test doubles useful; ignored files are not listed
 * unless `--ignored` is passed, matching the previous porcelain v1 semantics.
 */
export function parseWorktreeStatusPorcelainV2(stdout: string): WorktreeStatusPorcelainV2 {
  let dirty = false;
  let changedFileCount = 0;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let headBranchRef: string | null = null;
  const nulDelimited = stdout.includes("\0");
  const records = stdout.split(nulDelimited ? "\0" : "\n");
  for (let index = 0; index < records.length; index += 1) {
    const rawRecord = records[index] ?? "";
    const record = nulDelimited ? rawRecord : rawRecord.replace(/\r$/, "");
    if (!record) continue;
    if (record.startsWith("#")) {
      const match = /^# branch\.head (.*)$/.exec(record);
      if (!match) continue;
      const value = (match[1] ?? "").trim();
      if (!value || value === DETACHED_HEAD_SENTINEL) continue;
      headBranchRef = normalizeBranchName(value).trim() || null;
      continue;
    }

    // Porcelain v2 `2` records have a second pathname after the NUL that
    // terminates the record. It is the old/original path, not another change.
    const isRenameOrCopy = record.startsWith("2 ");
    if (isRenameOrCopy && nulDelimited) index += 1;

    dirty = true;
    changedFileCount += 1;
    if (record.startsWith("?")) {
      untracked += 1;
      continue;
    }
    // Porcelain v2 tracked entries are `1 XY`, `2 XY`, or `u XY`: X is the
    // index/staged state and Y is the worktree/unstaged state. A file that has
    // both kinds of change is counted in both breakdowns, but only once in the
    // total entry count above.
    const stagedCode = record[2] ?? " ";
    const unstagedCode = record[3] ?? " ";
    if (stagedCode !== " " && stagedCode !== "." && stagedCode !== "?") staged += 1;
    if (unstagedCode !== " " && unstagedCode !== "." && unstagedCode !== "?") unstaged += 1;
  }
  return { dirty, changedFileCount, staged, unstaged, untracked, headBranchRef };
}

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

/**
 * Compare the lane's recorded branch against the worktree's live HEAD.
 *
 * Returns `null` (no drift) when either side is unknown — an unavailable
 * worktree or a detached HEAD is not something the drift affordances can act
 * on, and nagging about it would be noise.
 */
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
