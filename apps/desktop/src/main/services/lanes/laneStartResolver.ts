import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGit } from "../git/git";
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

  if (start.bring === "pushed") {
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
    throw new Error(`Branch ${sourceBranch} wasn't found on the remote or locally.`);
  }

  let startRef = laneStartRefLabel(start, sourceBranch);
  let startSha = await verifyCommit(`refs/heads/${sourceBranch}`, projectRoot);
  if (!startSha) {
    startSha = await verifyCommit(`refs/remotes/${remoteRef}`, projectRoot);
    if (!startSha) throw new Error(`Branch ${sourceBranch} wasn't found locally or on the remote.`);
    startRef = remoteRef;
    notes.push(`There's no local ${sourceBranch}; started from ${remoteRef}.`);
  }

  let copyFrom: LaneStartFolder | null = null;
  if (start.bring === "uncommitted") {
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
    const add = await runGit(["add", "-A"], { cwd: args.fromPath, timeoutMs: 120_000, env });
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
