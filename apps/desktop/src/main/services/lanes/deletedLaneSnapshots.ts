import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { GitTimeoutError, runGit, runGitOrThrow } from "../git/git";
import type { DeletedLaneSnapshot } from "../../../shared/types/lanes";

/**
 * Work a lane delete would destroy, kept as a git ref instead.
 *
 * A forced delete removes the worktree with its uncommitted files, and
 * deleting the branch drops commits no other branch or remote holds. Before
 * either happens the delete writes one commit holding everything (the branch
 * tip as its parent, the working tree, staged or not, untracked included, as
 * its tree) under `refs/ade/deleted-lanes/<epochMs>-<laneId>`. Git keeps the
 * commits alive through that ref; Recently deleted lists it and restores it
 * as a new lane. Refs older than DELETED_LANE_KEEP_DAYS are pruned.
 */
export const DELETED_LANE_REF_PREFIX = "refs/ade/deleted-lanes/";
export const DELETED_LANE_KEEP_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_TIMEOUT_MS = 120_000;
const READ_TIMEOUT_MS = 15_000;

/** Commits are written as ADE, so a machine with no git identity can still save. */
const SNAPSHOT_IDENTITY_ENV: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: "ADE",
  GIT_AUTHOR_EMAIL: "ade@localhost",
  GIT_COMMITTER_NAME: "ADE",
  GIT_COMMITTER_EMAIL: "ade@localhost",
};

const TRAILER = {
  laneId: "ADE-Lane-Id",
  laneName: "ADE-Lane-Name",
  branch: "ADE-Branch",
  uncommitted: "ADE-Uncommitted",
  deletedAt: "ADE-Deleted-At",
  kind: "ADE-Kind",
} as const;

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function branchNameOf(branchRef: string | null | undefined): string | null {
  const trimmed = (branchRef ?? "").trim();
  if (!trimmed) return null;
  return trimmed.startsWith("refs/heads/") ? trimmed.slice("refs/heads/".length) : trimmed;
}

async function revParse(cwd: string, rev: string): Promise<string | null> {
  const result = await runGit(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { cwd, timeoutMs: READ_TIMEOUT_MS });
  const sha = result.stdout.trim();
  return result.exitCode === 0 && sha ? sha : null;
}

/**
 * True when `tip` holds a commit that no ref outside this lane reaches, so
 * removing the lane would drop it. With `branchGoes`, the lane's own branch
 * no longer counts as keeping it.
 */
async function hasCommitsOnlyThisLaneHolds(args: {
  projectRoot: string;
  tip: string;
  branchName: string | null;
  branchGoes: boolean;
  remoteGoes: string | null;
}): Promise<boolean> {
  // Git matches `--exclude` without the refs/heads/ or refs/remotes/ prefix,
  // and only against the one ref set named right after it.
  const result = await runGit(
    [
      "rev-list", "-n", "1", args.tip, "--not",
      ...(args.branchGoes && args.branchName ? [`--exclude=${args.branchName}`] : []), "--branches",
      ...(args.remoteGoes && args.branchName ? [`--exclude=${args.remoteGoes}/${args.branchName}`] : []), "--remotes",
      "--tags",
    ],
    { cwd: args.projectRoot, timeoutMs: READ_TIMEOUT_MS },
  );
  // Unknown counts as at risk: saving a ref that turns out redundant costs nothing.
  if (result.exitCode !== 0) return true;
  return result.stdout.trim().length > 0;
}

async function hasUncommittedFiles(worktreePath: string): Promise<boolean> {
  const result = await runGit(
    ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"],
    { cwd: worktreePath, timeoutMs: READ_TIMEOUT_MS },
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim().split(/\r?\n/, 1)[0] || `git status exited ${result.exitCode}`);
  }
  return result.stdout.trim().length > 0;
}

/**
 * Work inside the worktree's submodules that removing it would lose: their
 * uncommitted files, and commits no remote or tag of theirs holds. A save
 * holds the parent repository only (a submodule is one commit id in it), so
 * the caller refuses instead of discarding these. Null when there are none.
 */
async function submoduleWorkAtRisk(worktreePath: string): Promise<string | null> {
  if (!fs.existsSync(path.join(worktreePath, ".gitmodules"))) return null;
  const status = await runGit(["submodule", "status", "--recursive"], { cwd: worktreePath, timeoutMs: READ_TIMEOUT_MS });
  // Unknown counts as at risk, the same as the commit check.
  if (status.exitCode !== 0) return "ADE could not read its submodules";
  for (const line of status.stdout.split(/\r?\n/)) {
    // ` <sha> <path> (<describe>)`; a leading `-` is a submodule never checked out.
    const match = line.match(/^([ +U-])[0-9a-f]+ (.+?)(?: \(.*\))?$/);
    if (!match || match[1] === "-") continue;
    const subPath = match[2]!;
    const cwd = path.join(worktreePath, subPath);
    const dirty = await runGit(
      ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=all"],
      { cwd, timeoutMs: READ_TIMEOUT_MS },
    );
    if (dirty.exitCode !== 0 || dirty.stdout.trim()) return `submodule ${subPath} has uncommitted changes`;
    const unpushed = await runGit(["rev-list", "-n", "1", "HEAD", "--not", "--remotes", "--tags"], { cwd, timeoutMs: READ_TIMEOUT_MS });
    if (unpushed.exitCode !== 0 || unpushed.stdout.trim()) return `submodule ${subPath} has commits that are not pushed`;
  }
  return null;
}

/**
 * The tree of everything in the worktree right now, written through a copy
 * of its index so the lane's own staging area is left as it was. Ignored
 * files (node_modules, build output) stay out, as they would in a commit.
 */
async function writeWorkingTree(worktreePath: string): Promise<string> {
  const tempIndex = path.join(os.tmpdir(), `ade-deleted-lane-${randomUUID()}.index`);
  try {
    const indexPathRes = await runGit(["rev-parse", "--git-path", "index"], { cwd: worktreePath, timeoutMs: READ_TIMEOUT_MS });
    const indexPath = indexPathRes.stdout.trim();
    if (indexPathRes.exitCode === 0 && indexPath) {
      const absolute = path.isAbsolute(indexPath) ? indexPath : path.join(worktreePath, indexPath);
      // A copy keeps git's stat cache, so only changed files are hashed again.
      try {
        await fs.promises.copyFile(absolute, tempIndex);
      } catch {
        // No index yet (a fresh checkout): `add -A` builds one from scratch.
      }
    }
    const env = { GIT_INDEX_FILE: tempIndex };
    await runGitOrThrow(["add", "-A", "--", "."], { cwd: worktreePath, timeoutMs: SNAPSHOT_TIMEOUT_MS, env });
    return (await runGitOrThrow(["write-tree"], { cwd: worktreePath, timeoutMs: SNAPSHOT_TIMEOUT_MS, env })).trim();
  } finally {
    await fs.promises.rm(tempIndex, { force: true }).catch(() => undefined);
  }
}

/**
 * Saves what deleting this lane would lose, or returns null when nothing
 * would be lost (a clean worktree whose commits another branch or a remote
 * already holds). Throws when there is work to save and saving failed: the
 * caller must not delete then.
 */
export async function saveDeletedLaneSnapshot(args: {
  projectRoot: string;
  laneId: string;
  laneName: string;
  branchRef: string | null;
  /** The lane's checkout, only when it is a git worktree root that is about to be removed. */
  worktreePath: string | null;
  /** The local branch is about to be deleted too. */
  branchGoes: boolean;
  /** The remote the branch is about to be deleted from, if any. */
  remoteGoes?: string | null;
  /** "freed": the lane stays (archived, folder gone); only its files were at stake. */
  kind?: DeletedLaneSnapshot["kind"];
  now?: Date;
}): Promise<DeletedLaneSnapshot | null> {
  const branchName = branchNameOf(args.branchRef);
  const tip = args.worktreePath
    ? await revParse(args.worktreePath, "HEAD")
    : branchName
      ? await revParse(args.projectRoot, `refs/heads/${branchName}`)
      : null;
  const remoteGoes = args.remoteGoes?.trim() || null;
  // Deleting the remote branch drops commits only it holds (pushed from
  // another machine, say), so its last-fetched tip is kept too.
  const remoteTip = remoteGoes && branchName
    ? await revParse(args.projectRoot, `refs/remotes/${remoteGoes}/${branchName}`)
    : null;
  const uncommitted = args.worktreePath ? await hasUncommittedFiles(args.worktreePath) : false;
  const submoduleRisk = args.worktreePath ? await submoduleWorkAtRisk(args.worktreePath) : null;
  if (submoduleRisk) {
    throw new Error(`${submoduleRisk}, and ADE cannot keep work inside submodules. Commit and push it in the submodule first.`);
  }
  const atRisk = async (commit: string) => hasCommitsOnlyThisLaneHolds({
    projectRoot: args.projectRoot,
    tip: commit,
    branchName,
    // A worktree on a detached HEAD loses its commits with the folder even
    // when the branch stays; the branch only protects what it points at.
    branchGoes: args.branchGoes || (args.worktreePath != null && branchName != null
      && (await revParse(args.projectRoot, `refs/heads/${branchName}`)) !== commit),
    remoteGoes,
  });
  const tipAtRisk = tip ? await atRisk(tip) : false;
  const remoteTipAtRisk = remoteTip && remoteTip !== tip ? await atRisk(remoteTip) : false;
  if (!uncommitted && !tipAtRisk && !remoteTipAtRisk) return null;

  const tree = uncommitted && args.worktreePath
    ? await writeWorkingTree(args.worktreePath).catch((error: unknown) => {
      if (!(error instanceof GitTimeoutError)) throw error;
      throw new Error(
        "saving its files took longer than 2 minutes, likely very large files. Commit them, add them to .gitignore, or move them out of the lane first.",
      );
    })
    : tip
      ? (await runGitOrThrow(["rev-parse", `${tip}^{tree}`], { cwd: args.projectRoot, timeoutMs: READ_TIMEOUT_MS })).trim()
      : null;
  if (!tree) return null;

  const now = args.now ?? new Date();
  const deletedAt = now.toISOString();
  const kind = args.kind ?? "deleted";
  const message = [
    kind === "freed"
      ? `ADE saved lane "${oneLine(args.laneName)}" before freeing up its space`
      : `ADE saved lane "${oneLine(args.laneName)}" before deleting it`,
    "",
    `${TRAILER.laneId}: ${args.laneId}`,
    `${TRAILER.laneName}: ${oneLine(args.laneName)}`,
    `${TRAILER.branch}: ${branchName ?? ""}`,
    `${TRAILER.uncommitted}: ${uncommitted ? "yes" : "no"}`,
    `${TRAILER.deletedAt}: ${deletedAt}`,
    `${TRAILER.kind}: ${kind}`,
    "",
  ].join("\n");
  const commit = (await runGitOrThrow(
    // The first parent is the lane's HEAD (restore checks it out); a second
    // keeps the remote's commits reachable.
    ["commit-tree", tree, ...(tip ? ["-p", tip] : []), ...(remoteTipAtRisk && remoteTip ? ["-p", remoteTip] : []), "-F", "-"],
    { cwd: args.projectRoot, timeoutMs: READ_TIMEOUT_MS, env: SNAPSHOT_IDENTITY_ENV, stdin: message },
  )).trim();
  const id = `${now.getTime()}-${args.laneId}`;
  const ref = `${DELETED_LANE_REF_PREFIX}${id}`;
  await runGitOrThrow(["update-ref", ref, commit], { cwd: args.projectRoot, timeoutMs: READ_TIMEOUT_MS });
  return {
    id,
    laneId: args.laneId,
    laneName: args.laneName,
    branchName,
    commit,
    baseCommit: tip,
    uncommitted,
    kind,
    deletedAt,
    expiresAt: new Date(now.getTime() + DELETED_LANE_KEEP_DAYS * DAY_MS).toISOString(),
  };
}

function readTrailer(body: string, key: string): string | null {
  const match = body.match(new RegExp(`^${key}: ?(.*)$`, "m"));
  return match ? match[1]!.trim() : null;
}

/** Every saved lane, newest first. Refs ADE did not write are skipped. */
export async function listDeletedLaneSnapshots(projectRoot: string): Promise<DeletedLaneSnapshot[]> {
  const result = await runGit(
    ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(parent)%00%(contents)%1e", DELETED_LANE_REF_PREFIX],
    { cwd: projectRoot, timeoutMs: READ_TIMEOUT_MS },
  );
  if (result.exitCode !== 0) return [];
  const snapshots: DeletedLaneSnapshot[] = [];
  for (const record of result.stdout.split("\x1e")) {
    const [refname, commit, parent, body] = record.replace(/^\s+/, "").split("\0");
    if (!refname?.startsWith(DELETED_LANE_REF_PREFIX) || !commit || body == null) continue;
    const id = refname.slice(DELETED_LANE_REF_PREFIX.length);
    const laneId = readTrailer(body, TRAILER.laneId);
    const deletedAt = readTrailer(body, TRAILER.deletedAt);
    const deletedMs = deletedAt ? Date.parse(deletedAt) : Number.NaN;
    if (!laneId || !Number.isFinite(deletedMs)) continue;
    snapshots.push({
      id,
      laneId,
      laneName: readTrailer(body, TRAILER.laneName) || "Deleted lane",
      branchName: readTrailer(body, TRAILER.branch) || null,
      commit: commit.trim(),
      baseCommit: parent?.trim().split(/\s+/)[0] || null,
      uncommitted: readTrailer(body, TRAILER.uncommitted) === "yes",
      kind: readTrailer(body, TRAILER.kind) === "freed" ? "freed" : "deleted",
      deletedAt: new Date(deletedMs).toISOString(),
      expiresAt: new Date(deletedMs + DELETED_LANE_KEEP_DAYS * DAY_MS).toISOString(),
    });
  }
  return snapshots.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

export async function findDeletedLaneSnapshot(projectRoot: string, id: string): Promise<DeletedLaneSnapshot | null> {
  const wanted = id.trim();
  if (!wanted || wanted.includes("/") || wanted.includes("..")) return null;
  return (await listDeletedLaneSnapshots(projectRoot)).find((snapshot) => snapshot.id === wanted) ?? null;
}

export async function removeDeletedLaneSnapshot(projectRoot: string, id: string): Promise<boolean> {
  const snapshot = await findDeletedLaneSnapshot(projectRoot, id);
  if (!snapshot) return false;
  await runGitOrThrow(["update-ref", "-d", `${DELETED_LANE_REF_PREFIX}${snapshot.id}`], { cwd: projectRoot, timeoutMs: READ_TIMEOUT_MS });
  return true;
}

/** Drops saved lanes past their keep window; returns how many went. */
export async function pruneDeletedLaneSnapshots(projectRoot: string, now: Date = new Date()): Promise<number> {
  let removed = 0;
  for (const snapshot of await listDeletedLaneSnapshots(projectRoot)) {
    if (Date.parse(snapshot.expiresAt) > now.getTime()) continue;
    const result = await runGit(["update-ref", "-d", `${DELETED_LANE_REF_PREFIX}${snapshot.id}`], { cwd: projectRoot, timeoutMs: READ_TIMEOUT_MS });
    if (result.exitCode === 0) removed += 1;
  }
  return removed;
}
