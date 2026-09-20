import fs from "node:fs";
import path from "node:path";
import { runGit } from "../git/git";

/**
 * What a turn changed, for the "Files changed" row at the end of it.
 *
 * Two shapes of turn, one summary. A turn that committed is a range
 * (`before..after`). A turn that edited files and did not commit reports the
 * SAME head on both sides — and used to get no summary at all, because "the sha
 * did not move" was read as "nothing happened". It is the opposite: an
 * uncommitted turn is the common case for an agent that edits and waits for
 * review, so its diff is the one the reader most needs. For that turn the
 * comparison is `beforeSha` against the working tree, plus the files git does
 * not track yet, which a diff against a commit cannot see at all.
 *
 * Paths come back `-z`-delimited, so a filename containing a tab, a newline or
 * a non-ASCII byte survives. The pre-`-z` parser split on tabs and would have
 * silently truncated any of those.
 */

export type TurnDiffFile = {
  path: string;
  additions: number;
  deletions: number;
  /** Git's status letter: `A`, `M`, `D`, `R`, `C`, `T`. */
  status: string;
};

export type TurnDiffSummary = {
  files: TurnDiffFile[];
  totalAdditions: number;
  totalDeletions: number;
};

const GIT_TIMEOUT_MS = 10_000;

/**
 * An untracked file big enough that counting its lines is not worth the read.
 * Git itself stops diffing well before this; the number only has to be an upper
 * bound that no source file reaches.
 */
const MAX_UNTRACKED_COUNT_BYTES = 8 * 1024 * 1024;

function parseCount(value: string): number {
  // Git writes "-" for a binary file's line counts.
  if (value === "-") return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * `--numstat -z` records are `adds\tdels\tpath\0`, except renames and copies,
 * which write `adds\tdels\t\0source\0destination\0` — the empty third field is
 * the signal that two more records follow.
 */
export function parseNumstatZ(stdout: string): TurnDiffFile[] {
  const tokens = stdout.split("\0");
  const files: TurnDiffFile[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const firstTab = token.indexOf("\t");
    if (firstTab < 0) continue;
    const secondTab = token.indexOf("\t", firstTab + 1);
    if (secondTab < 0) continue;
    const additions = parseCount(token.slice(0, firstTab));
    const deletions = parseCount(token.slice(firstTab + 1, secondTab));
    let filePath = token.slice(secondTab + 1);
    if (!filePath) {
      const source = tokens[index + 1] ?? "";
      const destination = tokens[index + 2] ?? "";
      index += 2;
      filePath = destination || source;
    }
    if (!filePath) continue;
    files.push({ path: filePath, additions, deletions, status: "M" });
  }
  return files;
}

/**
 * `--name-status -z` records are `X\0path\0`, except renames and copies, whose
 * score-suffixed letter (`R100`) is followed by BOTH the source and the
 * destination. The destination is the path the numstat record names, so that is
 * the one the map is keyed by.
 */
export function parseNameStatusZ(stdout: string): Map<string, string> {
  const tokens = stdout.split("\0");
  const statuses = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const code = tokens[index];
    if (!code) continue;
    const letter = code.trim().charAt(0);
    if (!letter) continue;
    const first = tokens[index + 1] ?? "";
    index += 1;
    if (letter === "R" || letter === "C") {
      const destination = tokens[index + 1] ?? "";
      index += 1;
      if (destination) statuses.set(destination, letter);
      continue;
    }
    if (first) statuses.set(first, letter);
  }
  return statuses;
}

/**
 * Untracked paths from `git status --porcelain=v1 -z`.
 *
 * `-uall` rather than the default: without it git collapses a new directory to
 * a single `dir/` entry, and a turn that created a folder of files would report
 * one "file" that is not a file. `.gitignore` is still honoured, so build
 * output does not land in the summary.
 */
/**
 * Every path `git status` reports as dirty — modified, staged, deleted,
 * renamed (destination), or untracked. The turn fingerprint is keyed by these.
 */
export function parseDirtyPorcelainZ(stdout: string): string[] {
  const tokens = stdout.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const code = token.slice(0, 2);
    const filePath = token.slice(3);
    if (code.startsWith("R") || code.startsWith("C")) index += 1;
    if (filePath && !filePath.endsWith("/")) paths.push(filePath);
  }
  return paths;
}

/**
 * What the dirty part of the working tree looked like at one instant: each
 * dirty path → `size:mtime`, or `missing` for a path git lists but the
 * filesystem no longer has (a staged deletion).
 *
 * Captured when a turn starts and compared when it ends, so an uncommitted
 * turn reports only the files the turn itself touched. Without it, a lane
 * with three hundred dirty files answered every one-line edit with "348 files
 * changed" — the whole tree's dirt, not the turn's.
 */
export type WorkingTreeFingerprint = Map<string, string>;

export async function captureWorkingTreeFingerprint(cwd: string): Promise<WorkingTreeFingerprint | null> {
  const status = await runGit(["status", "--porcelain=v1", "-z", "-uall"], {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (status.exitCode !== 0) return null;
  const fingerprint: WorkingTreeFingerprint = new Map();
  for (const relativePath of parseDirtyPorcelainZ(status.stdout)) {
    try {
      const stat = await fs.promises.stat(path.join(cwd, relativePath));
      fingerprint.set(relativePath, `${stat.size}:${stat.mtimeMs}`);
    } catch {
      fingerprint.set(relativePath, "missing");
    }
  }
  return fingerprint;
}

/** Paths whose fingerprint changed between two captures, plus paths new to the second. */
export function fingerprintChanges(
  before: WorkingTreeFingerprint,
  after: WorkingTreeFingerprint,
): Set<string> {
  const changed = new Set<string>();
  for (const [filePath, stamp] of after) {
    if (before.get(filePath) !== stamp) changed.add(filePath);
  }
  return changed;
}

export function parseUntrackedPorcelainZ(stdout: string): string[] {
  const tokens = stdout.split("\0");
  const untracked: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const code = token.slice(0, 2);
    const filePath = token.slice(3);
    // A rename record carries its source as the NEXT NUL-delimited token; skip
    // it so a renamed file's old path is never mistaken for an untracked one.
    if (code.startsWith("R") || code.startsWith("C")) index += 1;
    if (code !== "??") continue;
    if (filePath && !filePath.endsWith("/")) untracked.push(filePath);
  }
  return untracked;
}

/**
 * Line count of a new file, the way `git diff` would count it: every line is an
 * addition, and a final line without a trailing newline still counts.
 */
export function countAddedLines(contents: Buffer): number {
  if (contents.length === 0) return 0;
  if (contents.includes(0)) return 0; // binary; git reports "-" here
  let lines = 0;
  for (const byte of contents) {
    if (byte === 0x0a) lines += 1;
  }
  if (contents[contents.length - 1] !== 0x0a) lines += 1;
  return lines;
}

async function untrackedFiles(cwd: string): Promise<TurnDiffFile[]> {
  const status = await runGit(["status", "--porcelain=v1", "-z", "-uall"], {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (status.exitCode !== 0) return [];
  const files: TurnDiffFile[] = [];
  for (const relativePath of parseUntrackedPorcelainZ(status.stdout)) {
    let additions = 0;
    try {
      const absolute = path.join(cwd, relativePath);
      const stat = await fs.promises.stat(absolute);
      if (stat.isFile() && stat.size <= MAX_UNTRACKED_COUNT_BYTES) {
        additions = countAddedLines(await fs.promises.readFile(absolute));
      } else if (!stat.isFile()) {
        continue;
      }
    } catch {
      // Created and removed again inside one turn, or unreadable: it is still a
      // path the turn touched, so it is listed with no line count rather than
      // dropped.
    }
    files.push({ path: relativePath, additions, deletions: 0, status: "A" });
  }
  return files;
}

/**
 * The turn's diffstat, or `null` when git could not answer.
 *
 * `null` and an empty `files` array mean different things — the first is "ask
 * again", the second is "the turn changed nothing" — so callers that only
 * render on content should check `files.length`, not truthiness.
 */
export async function collectTurnDiffSummary(args: {
  cwd: string;
  beforeSha: string;
  afterSha: string;
  /**
   * The dirty tree as it stood when the turn started. When supplied, an
   * uncommitted turn is scoped to the paths that changed since — see
   * {@link captureWorkingTreeFingerprint}. Omitted (never `null`) only by
   * callers that want the whole tree's dirt, which no chat surface does.
   */
  beforeTree?: WorkingTreeFingerprint | null;
}): Promise<TurnDiffSummary | null> {
  const { cwd, beforeSha, afterSha, beforeTree } = args;
  // Equal shas is the uncommitted turn: compare the commit to the working tree
  // (`git diff <sha>` with no second ref), which also picks up staged edits.
  const uncommitted = beforeSha === afterSha;
  const range = uncommitted ? beforeSha : `${beforeSha}..${afterSha}`;

  const numstat = await runGit(["diff", "--numstat", "--find-renames", "-z", range], {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (numstat.exitCode !== 0) return null;

  const files = parseNumstatZ(numstat.stdout);

  const nameStatus = await runGit(["diff", "--name-status", "--find-renames", "-z", range], {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (nameStatus.exitCode === 0) {
    const statuses = parseNameStatusZ(nameStatus.stdout);
    for (const file of files) {
      file.status = statuses.get(file.path) ?? "M";
    }
  }

  let scoped = files;
  if (uncommitted) {
    // A file git has never seen produces no diff record at all, so the turn
    // that created it would otherwise report zero changes.
    const seen = new Set(files.map((file) => file.path));
    for (const file of await untrackedFiles(cwd)) {
      if (seen.has(file.path)) continue;
      files.push(file);
    }
    if (beforeTree !== undefined) {
      // Only what this turn touched. A capture that failed at either end
      // (`null`) leaves the turn with no honest scope, and "nothing to show"
      // beats the whole tree's dirt presented as the turn's work.
      const afterTree = await captureWorkingTreeFingerprint(cwd);
      if (!beforeTree || !afterTree) return null;
      const touched = fingerprintChanges(beforeTree, afterTree);
      scoped = files.filter((file) => touched.has(file.path));
    }
  }

  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const file of scoped) {
    totalAdditions += file.additions;
    totalDeletions += file.deletions;
  }
  return { files: scoped, totalAdditions, totalDeletions };
}
