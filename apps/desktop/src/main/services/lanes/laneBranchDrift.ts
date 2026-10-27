import type { LaneBranchDrift, LaneBranchDriftKind } from "../../../shared/types";
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
  /**
   * Commits on HEAD's upstream that HEAD lacks (`# branch.ab`'s `-N`); `null`
   * with no upstream, or one whose ref is gone (git then omits `branch.ab`).
   */
  upstreamBehind: number | null;
  /** HEAD's commit (`# branch.oid`); `null` before the first commit. */
  headOid: string | null;
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
  let upstreamBehind: number | null = null;
  let headOid: string | null = null;
  const nulDelimited = stdout.includes("\0");
  const records = stdout.split(nulDelimited ? "\0" : "\n");
  for (let index = 0; index < records.length; index += 1) {
    const rawRecord = records[index] ?? "";
    const record = nulDelimited ? rawRecord : rawRecord.replace(/\r$/, "");
    if (!record) continue;
    if (record.startsWith("#")) {
      const oid = /^# branch\.oid ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(record);
      if (oid) {
        headOid = oid[1]!;
        continue;
      }
      const aheadBehind = /^# branch\.ab \+\d+ -(\d+)$/.exec(record);
      if (aheadBehind) {
        upstreamBehind = Number(aheadBehind[1]);
        continue;
      }
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
  return { dirty, changedFileCount, staged, unstaged, untracked, headBranchRef, upstreamBehind, headOid };
}

/**
 * Compare the lane's recorded branch against the worktree's live HEAD.
 *
 * Returns `null` (no drift) when either side is unknown — an unavailable
 * worktree or a detached HEAD is not something the drift affordances can act
 * on, and nagging about it would be noise.
 *
 * `kind` is the lane service's classification of an existing drift. It is left
 * out for `switched` on purpose: that keeps the object the shape every reader
 * (and older client) already expects, and a reader must treat a missing kind
 * as `switched` anyway.
 */
export function detectLaneBranchDrift(args: {
  expectedBranchRef: string | null | undefined;
  headBranchRef: string | null | undefined;
  /** Why HEAD left the recorded branch, when the lane service classified it. */
  kind?: LaneBranchDriftKind | null;
}): LaneBranchDrift | null {
  const expectedBranchRef = normalizeBranchName((args.expectedBranchRef ?? "").trim()).trim();
  const headBranchRef = normalizeBranchName((args.headBranchRef ?? "").trim()).trim();
  if (!expectedBranchRef || !headBranchRef) return null;
  if (expectedBranchRef === headBranchRef) return null;
  if (args.kind && args.kind !== "switched") return { expectedBranchRef, headBranchRef, kind: args.kind };
  return { expectedBranchRef, headBranchRef };
}

// ---------------------------------------------------------------------------
// Renamed vs. missing
// ---------------------------------------------------------------------------

/**
 * `git branch -m` (and `git checkout -m`) record the rename in the reflog as
 * `Branch: renamed refs/heads/<old> to refs/heads/<new>`. That subject is the
 * only durable evidence that distinguishes "the recorded branch was renamed
 * to the branch we are on" from "the recorded branch is gone", and it is what
 * decides whether the lane can still be switched back at all.
 */
const RENAME_SUBJECT_PREFIX = "Branch: renamed ";
const RENAME_SUBJECT_SEPARATOR = " to ";

/** `refs/heads/x` → `x`; anything else (a tag, `HEAD`, a raw id) → null. */
function branchNameFromRenameRef(ref: string): string | null {
  const value = ref.trim();
  if (!value.startsWith("refs/heads/")) return null;
  const name = normalizeBranchName(value).trim();
  return name || null;
}

/**
 * One reflog subject as a rename link. Branch names cannot contain spaces, so
 * the last ` to ` is the separator git itself wrote; a trailing `\r` from a
 * Windows checkout is trimmed with the rest of the whitespace.
 */
function parseBranchRenameReflogSubject(subject: string): { from: string; to: string } | null {
  const line = subject.trim();
  if (!line.startsWith(RENAME_SUBJECT_PREFIX)) return null;
  const rest = line.slice(RENAME_SUBJECT_PREFIX.length);
  const splitAt = rest.lastIndexOf(RENAME_SUBJECT_SEPARATOR);
  if (splitAt <= 0) return null;
  const from = branchNameFromRenameRef(rest.slice(0, splitAt));
  const to = branchNameFromRenameRef(rest.slice(splitAt + RENAME_SUBJECT_SEPARATOR.length));
  if (!from || !to) return null;
  return { from, to };
}

/**
 * Whether rename links connect `from` to `to`. Renames chain (a→b→c), and the
 * links from every rename on the way sit in the log of the surviving name, so
 * start at the live name and walk back. A name may not be visited twice: a
 * rename that thrashes back onto its own old name is ambiguous evidence, and
 * "missing" is the honest answer there.
 */
function reflogRenamesReach(subjects: readonly string[], from: string, to: string): boolean {
  const links: Array<{ from: string; to: string }> = [];
  for (const subject of subjects) {
    const link = parseBranchRenameReflogSubject(subject);
    if (link) links.push(link);
  }
  if (!links.length) return false;
  const visited = new Set<string>([to]);
  let cursor = to;
  for (let hop = 0; hop < links.length; hop += 1) {
    const link = links.find((candidate) => candidate.to === cursor);
    if (!link) return false;
    if (link.from === from) return true;
    if (visited.has(link.from)) return false;
    visited.add(link.from);
    cursor = link.from;
  }
  return false;
}

/**
 * Tell a rename apart from a branch that was simply deleted, for a drift whose
 * recorded ref is already known to be gone (the caller probes
 * `refs/heads/<expected>` first: an existing ref is `switched`, and only the
 * missing case reaches here). `switched` is never returned.
 */
export function classifyMissingLaneBranchDriftKind(args: {
  expectedBranchRef: string | null | undefined;
  headBranchRef: string | null | undefined;
  /** `git reflog show --format=%gs` subjects, newest first. */
  reflogSubjects?: readonly string[];
}): Extract<LaneBranchDriftKind, "renamed" | "missing"> {
  const expectedBranchRef = normalizeBranchName((args.expectedBranchRef ?? "").trim()).trim();
  const headBranchRef = normalizeBranchName((args.headBranchRef ?? "").trim()).trim();
  if (!expectedBranchRef || !headBranchRef || expectedBranchRef === headBranchRef) return "missing";
  if (!reflogRenamesReach(args.reflogSubjects ?? [], expectedBranchRef, headBranchRef)) return "missing";
  return "renamed";
}
