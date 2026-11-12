import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitTimeoutError, runGit, runGitOrThrow } from "../git/git";
import { GIT_TREE_WRITE_TIMEOUT_MS } from "../git/gitTimeouts";
import { describeUnsavedNestedRepoWork, describeWorkInOtherRepos } from "../git/worktreeState";
import type { Logger } from "../logging/logger";
import { DELETED_LANE_KEEP_DAYS } from "../../../shared/laneCleanup";
import { laneBranchSlug } from "../../../shared/laneBranchName";
import type { DeletedLaneSnapshot, DeletedLaneTip, RestoredLaneFiles } from "../../../shared/types/lanes";

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
const DELETED_LANE_REF_PREFIX = "refs/ade/deleted-lanes/";

const DAY_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_TIMEOUT_MS = 120_000;
const READ_TIMEOUT_MS = 15_000;
const RAW_DIFF_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

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
  extraTip: "ADE-Extra-Tip",
  baseCommit: "ADE-Base-Commit",
} as const;

/** Added to a refusal: a save holds the parent repository only. */
export const NESTED_REPO_WORK_NOT_KEPT = "ADE cannot keep work inside another git repository. Commit and push it there first.";

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

async function revParse(cwd: string, rev: string): Promise<string | null> {
  const result = await runGit(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { cwd, timeoutMs: READ_TIMEOUT_MS });
  const sha = result.stdout.trim();
  return result.exitCode === 0 && sha ? sha : null;
}

/**
 * True when `tip` holds a commit that no ref outside this lane reaches, so
 * removing the lane would drop it. `branchesGoing` no longer count as keeping
 * it: this lane's branch, when it is being deleted, and branches other
 * deletes running now will remove.
 */
async function hasCommitsOnlyThisLaneHolds(args: {
  projectRoot: string;
  tip: string;
  branchName: string | null;
  branchesGoing: string[];
  remoteGoes: string | null;
}): Promise<boolean> {
  // Git matches `--exclude` without the refs/heads/ or refs/remotes/ prefix,
  // and only against the one ref set named right after it.
  const result = await runGit(
    [
      "rev-list", "-n", "1", args.tip, "--not",
      ...args.branchesGoing.map((name) => `--exclude=${name}`), "--branches",
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
 * `git add` records a repository sitting inside the worktree as one commit
 * id, without its files, so a save would report them kept and lose them.
 * Refuses when such a repository holds work no remote has.
 */
async function refuseUnsavedNestedRepos(worktreePath: string, env: NodeJS.ProcessEnv): Promise<void> {
  const added = await runGitOrThrow(
    ["diff", "--cached", "--raw", "-z", "--no-renames", "--no-abbrev", "--ignore-submodules=none", "--diff-filter=ATM"],
    { cwd: worktreePath, timeoutMs: SNAPSHOT_TIMEOUT_MS, env, maxOutputBytes: RAW_DIFF_MAX_OUTPUT_BYTES },
  );
  // `-z` alternates `:<oldMode> <newMode> <old> <new> <status>` and the path.
  const fields = added.split("\0");
  for (let index = 0; index + 1 < fields.length; index += 2) {
    if (fields[index]!.split(" ")[1] !== "160000") continue;
    const relPath = fields[index + 1]!;
    const work = await describeUnsavedNestedRepoWork(path.join(worktreePath, relPath), relPath);
    if (work) throw new Error(`${work} ${NESTED_REPO_WORK_NOT_KEPT}`);
  }
}

/** A folder only this user can read, for the lane's file contents passing through it. */
async function withPrivateTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ade-deleted-lane-"));
  try {
    return await run(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * The tree of everything in the worktree right now, written through a copy
 * of its index so the lane's own staging area is left as it was. Ignored
 * files (node_modules, build output) stay out, as they would in a commit.
 */
async function writeWorkingTree(worktreePath: string): Promise<string> {
  return withPrivateTempDir(async (dir) => {
    const tempIndex = path.join(dir, "index");
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
    await runGitOrThrow(["-c", "core.sparseCheckout=false", "add", "-A", "--", "."], { cwd: worktreePath, timeoutMs: SNAPSHOT_TIMEOUT_MS, env });
    await refuseUnsavedNestedRepos(worktreePath, env);
    return (await runGitOrThrow(["write-tree"], { cwd: worktreePath, timeoutMs: SNAPSHOT_TIMEOUT_MS, env })).trim();
  });
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
  /** The lane's branch, short name. */
  branchName: string | null;
  /** The lane's checkout, only when it is a git worktree root that is about to be removed. */
  worktreePath: string | null;
  /** The local branch is about to be deleted too. */
  branchGoes: boolean;
  /** Branches other running deletes will remove; they do not count as keeping a commit. */
  otherBranchesGoing?: string[];
  /** The remote the branch is about to be deleted from, if any. */
  remoteGoes?: string | null;
  /** "freed": the lane stays (archived, folder gone); only its files were at stake. */
  kind?: DeletedLaneSnapshot["kind"];
  now?: Date;
}): Promise<DeletedLaneSnapshot | null> {
  const { branchName } = args;
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
  const branchTip = branchName ? await revParse(args.projectRoot, `refs/heads/${branchName}`) : null;
  const uncommitted = args.worktreePath ? await hasUncommittedFiles(args.worktreePath) : false;
  const otherRepoWork = args.worktreePath ? await describeWorkInOtherRepos(args.worktreePath) : null;
  if (otherRepoWork) throw new Error(`${otherRepoWork} ${NESTED_REPO_WORK_NOT_KEPT}`);
  const atRisk = (commit: string) => hasCommitsOnlyThisLaneHolds({
    projectRoot: args.projectRoot,
    tip: commit,
    branchName,
    // A worktree on a detached HEAD or another branch loses its commits with
    // the folder even when the branch stays; the branch only protects what
    // it points at.
    branchesGoing: [
      ...(args.otherBranchesGoing ?? []),
      ...(branchName && (args.branchGoes || (args.worktreePath != null && branchTip !== commit)) ? [branchName] : []),
    ],
    remoteGoes,
  });
  const tipAtRisk = tip ? await atRisk(tip) : false;
  const extraTips: DeletedLaneTip[] = [];
  if (remoteTip && remoteTip !== tip && await atRisk(remoteTip)) extraTips.push({ label: "remote", commit: remoteTip });
  // A lane whose folder moved to another branch: the branch being deleted
  // still holds commits of its own.
  if (args.branchGoes && branchTip && branchTip !== tip && branchTip !== remoteTip && await atRisk(branchTip)) {
    extraTips.push({ label: "previous", commit: branchTip });
  }
  if (!uncommitted && !tipAtRisk && extraTips.length === 0) return null;

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
    `${TRAILER.baseCommit}: ${tip ?? ""}`,
    ...extraTips.map((entry) => `${TRAILER.extraTip}: ${entry.label} ${entry.commit}`),
    "",
  ].join("\n");
  const commit = (await runGitOrThrow(
    // The parents keep the lane's HEAD and the commits only the remote or the
    // old branch held reachable.
    ["commit-tree", tree, ...(tip ? ["-p", tip] : []), ...extraTips.flatMap((entry) => ["-p", entry.commit]), "-F", "-"],
    { cwd: args.projectRoot, timeoutMs: READ_TIMEOUT_MS, env: SNAPSHOT_IDENTITY_ENV, stdin: message },
  )).trim();
  const id = `${now.getTime()}-${args.laneId}`;
  await runGitOrThrow(["update-ref", `${DELETED_LANE_REF_PREFIX}${id}`, commit], { cwd: args.projectRoot, timeoutMs: READ_TIMEOUT_MS });
  return {
    id,
    laneId: args.laneId,
    laneName: args.laneName,
    branchName,
    commit,
    baseCommit: tip,
    uncommitted,
    kind,
    extraTips,
    deletedAt,
    expiresAt: new Date(now.getTime() + DELETED_LANE_KEEP_DAYS * DAY_MS).toISOString(),
  };
}

function readTrailer(body: string, key: string): string | null {
  const match = body.match(new RegExp(`^${key}: ?(.*)$`, "m"));
  return match ? match[1]!.trim() : null;
}

function readExtraTips(body: string): DeletedLaneTip[] {
  const tips: DeletedLaneTip[] = [];
  for (const match of body.matchAll(new RegExp(`^${TRAILER.extraTip}: (remote|previous) ([0-9a-f]+)$`, "gm"))) {
    tips.push({ label: match[1] as DeletedLaneTip["label"], commit: match[2]! });
  }
  return tips;
}

/** Every saved lane, newest first. Refs ADE did not write are skipped. */
export async function listDeletedLaneSnapshots(projectRoot: string): Promise<DeletedLaneSnapshot[]> {
  const stdout = await runGitOrThrow(
    ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(contents)%1e", DELETED_LANE_REF_PREFIX],
    { cwd: projectRoot, timeoutMs: READ_TIMEOUT_MS },
  );
  const snapshots: DeletedLaneSnapshot[] = [];
  for (const record of stdout.split("\x1e")) {
    const [refname, commit, body] = record.replace(/^\s+/, "").split("\0");
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
      baseCommit: readTrailer(body, TRAILER.baseCommit) || null,
      uncommitted: readTrailer(body, TRAILER.uncommitted) === "yes",
      kind: readTrailer(body, TRAILER.kind) === "freed" ? "freed" : "deleted",
      extraTips: readExtraTips(body),
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

/**
 * Points a save at the lane that now holds its work, so trying a restore
 * again goes into that lane instead of making another one. The id, and so
 * the ref, stays the same.
 */
export async function rebindDeletedLaneSnapshot(projectRoot: string, snapshot: DeletedLaneSnapshot, laneId: string): Promise<void> {
  const raw = await runGitOrThrow(["cat-file", "commit", snapshot.commit], { cwd: projectRoot, timeoutMs: READ_TIMEOUT_MS });
  const rebound = raw.replace(new RegExp(`^${TRAILER.laneId}: .*$`, "m"), `${TRAILER.laneId}: ${laneId}`);
  const commit = (await runGitOrThrow(
    ["hash-object", "-t", "commit", "-w", "--stdin"],
    { cwd: projectRoot, timeoutMs: READ_TIMEOUT_MS, stdin: rebound },
  )).trim();
  await runGitOrThrow(["update-ref", `${DELETED_LANE_REF_PREFIX}${snapshot.id}`, commit], { cwd: projectRoot, timeoutMs: READ_TIMEOUT_MS });
}

/**
 * Puts a saved lane's uncommitted files back into `worktreePath` as
 * uncommitted changes: the save's diff against the commit it sat on. The
 * patch goes through a file because git's output through ADE is capped and
 * decoded as UTF-8, either of which would quietly damage it. External diff
 * tools and textconv filters are off, or the patch would not apply.
 */
export async function applySavedLaneFiles(
  projectRoot: string,
  snapshot: DeletedLaneSnapshot,
  worktreePath: string | null | undefined,
): Promise<RestoredLaneFiles> {
  if (!snapshot.uncommitted) return { restored: true, warning: null };
  if (!snapshot.baseCommit || !worktreePath) {
    return { restored: false, warning: "The lane has no folder to put its files back into." };
  }
  const { baseCommit } = snapshot;
  const limits = { timeoutMs: GIT_TREE_WRITE_TIMEOUT_MS };
  return withPrivateTempDir(async (dir) => {
    const patchPath = path.join(dir, "saved.patch");
    const diff = await runGit(
      ["diff", "--binary", "--no-color", "--no-ext-diff", "--no-textconv", `--output=${patchPath}`, baseCommit, snapshot.commit],
      { cwd: projectRoot, ...limits },
    );
    if (diff.exitCode !== 0) return { restored: false, warning: diff.stderr.trim() || `git diff exited ${diff.exitCode}` };
    if ((await fs.promises.stat(patchPath)).size === 0) return { restored: true, warning: null };
    const applied = await runGit(["apply", "--whitespace=nowarn", patchPath], { cwd: worktreePath, ...limits });
    if (applied.exitCode === 0) return { restored: true, warning: null };
    // A delete that stopped after saving leaves the files where they were;
    // they are back already when the save would undo cleanly.
    const alreadyThere = await runGit(["apply", "--reverse", "--check", patchPath], { cwd: worktreePath, ...limits });
    if (alreadyThere.exitCode === 0) return { restored: true, warning: null };
    return { restored: false, warning: applied.stderr.trim() || `git apply exited ${applied.exitCode}` };
  });
}

/** Drops the save once everything came back; otherwise it stays to try again. */
export async function finishLaneRestore(
  projectRoot: string,
  logger: Pick<Logger, "info" | "warn">,
  snapshot: DeletedLaneSnapshot,
  laneId: string,
  result: RestoredLaneFiles,
): Promise<void> {
  if (result.restored) {
    await removeDeletedLaneSnapshot(projectRoot, snapshot.id).catch((error) => {
      logger.warn("lane.deleted_snapshot.remove_after_restore_failed", { id: snapshot.id, error: error instanceof Error ? error.message : String(error) });
    });
  } else {
    logger.warn("lane.deleted_snapshot.files_not_restored", { id: snapshot.id, laneId, warning: result.warning });
  }
  logger.info("lane.deleted_snapshot.restored", { id: snapshot.id, laneId, restored: result.restored });
}

/**
 * A lane whose space was freed with its uncommitted files discarded gets
 * them back when its folder is rebuilt: the newest "freed" save for it.
 */
export async function putBackFreedLaneWork(
  projectRoot: string,
  logger: Pick<Logger, "info" | "warn">,
  laneId: string,
  worktreePath: string,
): Promise<RestoredLaneFiles | null> {
  let saved: DeletedLaneSnapshot | undefined;
  try {
    saved = (await listDeletedLaneSnapshots(projectRoot)).find((entry) => entry.laneId === laneId && entry.kind === "freed");
  } catch (error) {
    logger.warn("lane.deleted_snapshot.list_failed", { laneId, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
  if (!saved) return null;
  const result = await applySavedLaneFiles(projectRoot, saved, worktreePath);
  await finishLaneRestore(projectRoot, logger, saved, laneId, result);
  return result;
}

async function branchExists(projectRoot: string, name: string): Promise<boolean> {
  return (await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], { cwd: projectRoot, timeoutMs: READ_TIMEOUT_MS })).exitCode === 0;
}

async function freeBranchName(projectRoot: string, wanted: string): Promise<string> {
  let name = wanted;
  for (let attempt = 1; await branchExists(projectRoot, name); attempt += 1) {
    if (attempt > 50) throw new Error(`No free branch name near ${wanted}.`);
    name = attempt === 1 ? `${wanted}-restored` : `${wanted}-restored-${attempt}`;
  }
  return name;
}

/**
 * Makes the local branches a restore needs, before any lane exists: the
 * lane's own at the commit it had, plus one for each other tip the save kept
 * that the lane's branch does not contain (`<branch>-remote`). Returns them
 * so a failed restore can take them back.
 */
export async function createRestoredLaneBranches(
  projectRoot: string,
  snapshot: DeletedLaneSnapshot,
): Promise<{ branchName: string; extraBranches: string[] }> {
  const startCommit = snapshot.baseCommit ?? snapshot.commit;
  const branchName = await freeBranchName(projectRoot, snapshot.branchName ?? `ade/${laneBranchSlug(snapshot.laneName) || "restored-lane"}`);
  const made: string[] = [];
  try {
    await runGitOrThrow(["branch", branchName, startCommit], { cwd: projectRoot, timeoutMs: READ_TIMEOUT_MS });
    made.push(branchName);
    for (const tip of snapshot.extraTips) {
      const contained = await runGit(["merge-base", "--is-ancestor", tip.commit, startCommit], { cwd: projectRoot, timeoutMs: READ_TIMEOUT_MS });
      if (contained.exitCode === 0) continue;
      const name = await freeBranchName(projectRoot, `${branchName}-${tip.label}`);
      await runGitOrThrow(["branch", name, tip.commit], { cwd: projectRoot, timeoutMs: READ_TIMEOUT_MS });
      made.push(name);
    }
  } catch (error) {
    await deleteRestoredLaneBranches(projectRoot, made);
    throw error;
  }
  return { branchName, extraBranches: made.slice(1) };
}

export async function deleteRestoredLaneBranches(projectRoot: string, names: string[]): Promise<void> {
  if (names.length === 0) return;
  await runGit(["branch", "-D", ...names], { cwd: projectRoot, timeoutMs: READ_TIMEOUT_MS });
}
