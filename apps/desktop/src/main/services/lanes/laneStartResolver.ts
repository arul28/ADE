import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AdeExpectedError, markExpected } from "../../../shared/expectedError";
import {
  formatGitExecutionError,
  gitCommandError,
  GitUntrustedFolderError,
  runGit,
  type GitRunResult,
} from "../git/git";
import { fetchRemoteTrackingBranch } from "../shared/remoteTrackingBranch";
import {
  laneStartRefLabel,
  laneStartSourceBranch,
  plainLaneStartBranch,
  type LaneStart,
} from "../../../shared/laneStart";

/** A lane folder that may hold uncommitted changes for a branch. */
export type LaneStartFolder = {
  name: string;
  branchRef: string;
  worktreePath: string;
};

export type ResolvedLaneStart = {
  start: LaneStart;
  /** The branch the start points at, e.g. `main`. */
  sourceBranch: string;
  /** The ref the lane branched from, as the user reads it: `origin/main` or `main`. */
  startRef: string;
  startSha: string;
  /** The folder whose uncommitted changes get copied; null when there is nothing to copy. */
  copyFrom: LaneStartFolder | null;
  /** Plain-language notes about fallbacks, for the caller to show. */
  notes: string[];
};

async function verifyCommit(ref: string, cwd: string): Promise<string | null> {
  const result = await runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd, timeoutMs: 10_000 });
  const sha = result.exitCode === 0 ? result.stdout.trim() : "";
  return sha || null;
}

/**
 * The error for a branch listing git itself refused, with git's own words: the
 * branch may well be there. A machine with no git, or a folder git will not
 * trust, is the user's to fix; any other failure stays reported.
 */
function branchListingError(result: GitRunResult): Error {
  if (result.timedOut) return new Error("ADE couldn't read this repository's branches: Git took too long to answer.");
  // A message, not a log: git's first lines say why.
  const raw = (result.stderr.trim() || result.stdout.trim() || `git exited with code ${result.exitCode}`).slice(0, 1_000);
  const error = gitCommandError(raw, `ADE couldn't read this repository's branches. ${formatGitExecutionError(raw)}`);
  return error instanceof GitUntrustedFolderError ? markExpected(error, "user") : error;
}

/**
 * The error for a start branch that does not resolve. A repository with no
 * commit at all (a fresh `git init`) has no branch to start from yet, and
 * "wasn't found" would send the user looking for a branch that cannot exist.
 */
async function missingStartBranchError(projectRoot: string, refs: readonly string[], message: string): Promise<Error> {
  const anyRef = await runGit(["for-each-ref", "--count=1", "--format=%(refname)"], { cwd: projectRoot, timeoutMs: 10_000 });
  // A branch the user named that is not there, or a repository with no
  // commits, is their answer. A failed listing says why in git's words, and
  // stays an issue unless the cause is the user's; so does a `rev-parse`
  // that timed out on a branch that is there.
  if (anyRef.exitCode !== 0) return branchListingError(anyRef);
  if (!anyRef.stdout.trim()) {
    return new AdeExpectedError("This repository has no commits yet. Make a first commit, then create a lane.", "user");
  }
  const named = await runGit(["for-each-ref", "--format=%(refname)", ...refs], { cwd: projectRoot, timeoutMs: 10_000 });
  if (named.exitCode !== 0) return branchListingError(named);
  const listed = named.stdout.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!listed) return new AdeExpectedError(message, "user");
  // The branch is there, but its commit did not read ("wasn't found" would
  // be wrong). Ask once more without --quiet, so the message carries git's
  // reason; this stays reported, because the cause is not known.
  const retry = await runGit(["rev-parse", "--verify", `${listed}^{commit}`], { cwd: projectRoot, timeoutMs: 10_000 });
  const reason = retry.timedOut
    ? "Git took too long to answer"
    : retry.exitCode === 0
      ? "Git answered only on a second try"
      : (retry.stderr.trim().split(/\r?\n/, 1)[0] ?? "").slice(0, 300) || `git exited with code ${retry.exitCode}`;
  return new Error(`ADE found ${listed} but couldn't read its commit (${reason}). Try again.`);
}

/**
 * Resolve a {@link LaneStart} into the commit a new lane branches from.
 *
 * Never throws for a fallback it can explain: a failed fetch uses the last
 * fetched copy, a missing remote branch uses the local one (and the reverse),
 * and each fallback adds a note. It throws only when the branch exists nowhere.
 */
export async function resolveLaneStart(args: {
  start: LaneStart;
  projectRoot: string;
  defaultBranch: string;
  primary: LaneStartFolder | null;
  /** Every active lane folder, primary included, to find who has the branch checked out. */
  folders: LaneStartFolder[];
  /** The caller already fetched (the chat launch's own fetch stage). */
  skipFetch?: boolean;
}): Promise<ResolvedLaneStart> {
  const { start, projectRoot } = args;
  const sourceBranch = laneStartSourceBranch(start, {
    defaultBranch: args.defaultBranch,
    primaryBranch: args.primary?.branchRef ?? null,
  });
  if (!sourceBranch) {
    throw new Error(
      start.from === "primary"
        ? "The primary lane has no branch checked out, so a new lane can't start from it."
        : "Choose a branch for the new lane to start from.",
    );
  }
  const notes: string[] = [];
  const remoteRef = `origin/${sourceBranch}`;

  if (start.on === "remote") {
    if (!args.skipFetch) {
      const fetched = await fetchRemoteTrackingBranch({ projectRoot, targetBranch: sourceBranch }).catch(() => false);
      if (!fetched) notes.push(`Couldn't fetch ${remoteRef}; used the last fetched copy.`);
    }
    const remoteSha = await verifyCommit(`refs/remotes/${remoteRef}`, projectRoot);
    if (remoteSha) {
      return { start, sourceBranch, startRef: remoteRef, startSha: remoteSha, copyFrom: null, notes };
    }
    const localSha = await verifyCommit(`refs/heads/${sourceBranch}`, projectRoot);
    if (localSha) {
      notes.push(`${sourceBranch} isn't on the remote yet; started from your local ${sourceBranch}.`);
      return { start, sourceBranch, startRef: sourceBranch, startSha: localSha, copyFrom: null, notes };
    }
    throw await missingStartBranchError(
      projectRoot,
      [`refs/remotes/${remoteRef}`, `refs/heads/${sourceBranch}`],
      `Branch ${sourceBranch} wasn't found on the remote or locally.`,
    );
  }

  let startRef = laneStartRefLabel(start, sourceBranch);
  let startSha = await verifyCommit(`refs/heads/${sourceBranch}`, projectRoot);
  if (!startSha) {
    startSha = await verifyCommit(`refs/remotes/${remoteRef}`, projectRoot);
    if (!startSha) {
      throw await missingStartBranchError(
        projectRoot,
        [`refs/heads/${sourceBranch}`, `refs/remotes/${remoteRef}`],
        `Branch ${sourceBranch} wasn't found locally or on the remote.`,
      );
    }
    startRef = remoteRef;
    notes.push(`There's no local ${sourceBranch}; started from ${remoteRef}.`);
  }

  let copyFrom: LaneStartFolder | null = null;
  if (start.on === "uncommitted") {
    copyFrom = args.folders.find((folder) => plainLaneStartBranch(folder.branchRef) === sourceBranch) ?? null;
    if (!copyFrom) {
      notes.push(`${sourceBranch} isn't open in any lane, so there were no uncommitted changes to copy.`);
    }
  }
  return { start, sourceBranch, startRef, startSha, copyFrom, notes };
}

/**
 * Copy a folder's uncommitted work (staged, unstaged and untracked, minus
 * ignored files) into another worktree of the same repository, as unstaged
 * changes. The source folder and its index are never written: the snapshot is
 * built in a temporary index.
 *
 * Returns the number of files the copy touched; 0 when there was nothing to copy.
 */
export async function copyUncommittedChanges(args: {
  fromPath: string;
  toPath: string;
}): Promise<number> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ade-lane-copy-"));
  try {
    const indexPathResult = await runGit(["rev-parse", "--git-path", "index"], { cwd: args.fromPath, timeoutMs: 10_000 });
    const tmpIndex = path.join(tmpDir, "index");
    if (indexPathResult.exitCode !== 0) {
      throw new Error(indexPathResult.stderr.trim() || "Couldn't find the folder's git index.");
    }
    // Start from the folder's real index. Only a folder with no index yet may
    // start empty: an empty index would turn ignored-but-tracked files into
    // deletions in the copy.
    const indexPath = path.resolve(args.fromPath, indexPathResult.stdout.trim());
    try {
      await fs.promises.copyFile(indexPath, tmpIndex);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw new Error(`Couldn't read the folder's git index. ${error instanceof Error ? error.message : String(error)}`.trim());
      }
    }
    const env = { GIT_INDEX_FILE: tmpIndex };
    // A personal `core.safecrlf` must not refuse a file ADE only snapshots.
    const add = await runGit(["-c", "core.safecrlf=false", "-c", "core.sparseCheckout=false", "add", "-A"], { cwd: args.fromPath, timeoutMs: 120_000, env });
    if (add.exitCode !== 0) throw new Error(add.stderr.trim() || "Couldn't read the uncommitted changes.");
    const tree = await runGit(["write-tree"], { cwd: args.fromPath, timeoutMs: 60_000, env });
    const treeSha = tree.exitCode === 0 ? tree.stdout.trim() : "";
    if (!treeSha) throw new Error(tree.stderr.trim() || "Couldn't snapshot the uncommitted changes.");

    const patchPath = path.join(tmpDir, "changes.patch");
    const diff = await runGit(
      ["diff", "--binary", "--full-index", "--no-color", "--no-ext-diff", `--output=${patchPath}`, "HEAD", treeSha],
      { cwd: args.fromPath, timeoutMs: 120_000 },
    );
    if (diff.exitCode !== 0) throw new Error(diff.stderr.trim() || "Couldn't read the uncommitted changes.");
    const patchSize = (await fs.promises.stat(patchPath).catch(() => null))?.size ?? 0;
    if (patchSize === 0) return 0;

    const names = await runGit(["diff", "--name-only", "HEAD", treeSha], { cwd: args.fromPath, timeoutMs: 60_000 });
    const fileCount = names.stdout.split("\n").filter((line) => line.trim()).length;

    const apply = await runGit(["apply", "--binary", "--whitespace=nowarn", patchPath], { cwd: args.toPath, timeoutMs: 120_000 });
    if (apply.exitCode !== 0) {
      throw new Error(`Couldn't copy the uncommitted changes into the new lane. ${apply.stderr.trim()}`.trim());
    }
    return fileCount;
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
