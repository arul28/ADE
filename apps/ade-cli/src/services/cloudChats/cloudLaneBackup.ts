/**
 * Lane backups at rest (contract: "Lane backups at rest";
 * `apps/account-directory/src/cloud/laneBackups.ts`). Before an ADE Cloud
 * computer rests, it saves each lane's work that is not on GitHub yet, so a
 * cleanup can delete the computer later with no wake and a new computer (or
 * the person) gets the work back:
 *
 * - **What:** commits on the lane that no `origin` branch has, and a
 *   snapshot commit of the uncommitted work: staged, unstaged and untracked
 *   files that git does not ignore. The snapshot is built in a private copy
 *   of the index (`readHandoffWorkingTreeSha`), so the person's staging, the
 *   branch and every ref stay as they are. Nothing is pushed.
 * - **Form:** one `git bundle` of those commits (the exact restore: commits,
 *   file modes, deletions and symlinks as git stores them), and one
 *   `git diff --binary` patch from the last commit on GitHub to the snapshot
 *   (to download on the web and the phone). A bundle is the simplest correct
 *   form: git checks its objects and its prerequisites, and the cross-machine
 *   handoff already applies one safely (`applyHandoffGitBundle`).
 * - **When:** in every rest save (`cloudRestSave.ts`): the idle step, in
 *   `prepare-stop` (so also the 0-hours stop) and in `save-for-rest`. A lane
 *   whose work is the same as its last backup (`fingerprint`: HEAD and the
 *   working tree) uploads nothing. A lane with nothing off GitHub deletes its
 *   backup.
 * - **Restore:** when a lane starts on a computer (`restoreLaneBackupIfNeeded`,
 *   from the lane launch), the newest backup of that lane from another
 *   machine is applied when the lane lacks it, and never over newer local
 *   work: a dirty lane, a lane past the backup, or a branch that went another
 *   way is left as it is, and the backup stays for the person.
 *
 * Ignored files (`.env` when it is ignored, build folders, local databases)
 * stay out, as a push leaves them out; `cloudIgnoredFiles.ts` warns about the
 * precious ones. Untracked files that git does not ignore are the person's
 * work, so they go in, sealed with the account's key on the server. Git LFS
 * files and submodule changes can't travel in a bundle: such a lane fails its
 * backup, so the computer is kept.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CLOUD_BACKUP_MAX_BYTES,
  CLOUD_BACKUP_TOO_LARGE_SENTENCE,
  type CloudBackupLaneReport,
  type CloudBackupSaveSummary,
  type CloudLaneBackup,
  type CloudLaneBackupFacts,
} from "../../../../account-directory/src/cloud/contract";
import { CloudApiError, type CloudApiClient } from "../../../../desktop/src/shared/cloudApiClient";
import { runGit } from "../../../../desktop/src/main/services/git/git";
import { runGitWithGithubAuthFallback } from "../../../../desktop/src/main/services/git/gitTransportAuth";
import {
  HANDOFF_GIT_BUNDLE_TOO_LARGE_MESSAGE,
  applyHandoffGitBundle,
  ensureBundleBase,
  precheckUntrackedSize,
  readHandoffWorkingTreeSha,
  refuseUnportablePaths,
} from "../../../../desktop/src/main/services/chat/handoffGitBundle";

type Logger = {
  info: (event: string, meta?: Record<string, unknown>) => void;
  warn: (event: string, meta?: Record<string, unknown>) => void;
};

const GIT_TIMEOUT_MS = 120_000;
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const SHA = /^[0-9a-f]{40,64}$/;
const SNAPSHOT_MESSAGE = "ADE backup of uncommitted work (never pushed)";
const SNAPSHOT_IDENTITY: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: "ADE",
  GIT_AUTHOR_EMAIL: "backup@ade.invalid",
  GIT_COMMITTER_NAME: "ADE",
  GIT_COMMITTER_EMAIL: "backup@ade.invalid",
};
/** A read takes no index lock, so it never blocks an agent's own git. */
const READ_ENV: NodeJS.ProcessEnv = { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };

/** One lane the save backs up. */
export type BackupLane = {
  laneId: string;
  laneName: string | null;
  worktreePath: string;
  /** The repository (`github.com/acme/web`), for the person's download. */
  projectKey: string | null;
};

/** What the save read of a lane: its fingerprint, and whether anything of it is off GitHub. */
export type LaneWorkRead = {
  fingerprint: string;
  clean: boolean;
  cwd: string;
  tip: string;
  workingTree: string;
  tipTree: string;
  branch: string | null;
  ahead: number;
  base: GithubBase;
};

export class LaneBackupRefused extends Error {
  constructor(message: string, readonly state: "failed" | "too_large") {
    super(message);
    this.name = "LaneBackupRefused";
  }
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv, maxOutputBytes?: number, stdin?: string): Promise<string> {
  const result = await runGit(args, { cwd, timeoutMs: GIT_TIMEOUT_MS, env: { ...READ_ENV, ...(env ?? {}) }, ...(maxOutputBytes ? { maxOutputBytes } : {}), ...(stdin != null ? { stdin } : {}) });
  if (result.exitCode !== 0 || result.timedOut) throw new Error((result.stderr || result.stdout || `git ${args[0]} failed`).trim().slice(0, 300));
  return result.stdout.trim();
}

async function resolveCommit(cwd: string, ref: string): Promise<string | null> {
  const result = await runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd, timeoutMs: 15_000, env: READ_ENV });
  const sha = result.exitCode === 0 ? result.stdout.trim() : "";
  return SHA.test(sha) ? sha : null;
}

/** True, false, or null when git can't say (an object is missing). */
async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean | null> {
  const result = await runGit(["merge-base", "--is-ancestor", ancestor, descendant], { cwd, timeoutMs: 30_000, env: READ_ENV });
  return result.exitCode === 0 ? true : result.exitCode === 1 ? false : null;
}

/** A ref name from any id: lane ids may hold characters a ref can't. */
const refKey = (id: string): string => createHash("sha256").update(id, "utf8").digest("hex").slice(0, 32);

/**
 * What GitHub has now, as the base the backup leaves out: the commits its
 * branch heads point at (`ls-remote`), those this clone holds. Local
 * `origin/*` refs are not trusted: a branch deleted on GitHub (a squash
 * merge) leaves its ref here, and a backup built on it could not be restored.
 * When GitHub can't be reached, only its default branch counts and the base
 * is not `verified`: a save then keeps every backup and reports its lanes as
 * not saved, so no cleanup deletes the computer on a guess. `key` goes into
 * the fingerprint, so a change on GitHub makes the next save upload.
 */
export type GithubBase = { shas: string[]; key: string; verified: boolean };

export async function readGithubBase(cwd: string): Promise<GithubBase> {
  const listed = await runGitWithGithubAuthFallback(["ls-remote", "--heads", "origin"], { cwd, timeoutMs: 30_000, env: READ_ENV });
  let candidates: string[];
  const verified = listed.exitCode === 0 && !listed.timedOut;
  if (verified) {
    candidates = listed.stdout.split(/\r?\n/).map((line) => line.split(/\s+/)[0] ?? "").filter((sha) => SHA.test(sha));
  } else {
    const fallback = (await resolveCommit(cwd, "refs/remotes/origin/HEAD"))
      ?? (await resolveCommit(cwd, "refs/remotes/origin/main"))
      ?? (await resolveCommit(cwd, "refs/remotes/origin/master"));
    candidates = fallback ? [fallback] : [];
  }
  const unique = [...new Set(candidates)].sort();
  let held: string[] = [];
  if (unique.length) {
    const checked = await runGit(["cat-file", "--batch-check"], { cwd, timeoutMs: 30_000, env: READ_ENV, stdin: `${unique.join("\n")}\n` });
    held = checked.stdout.split("\n").map((line) => line.split(" ")).filter((parts) => parts[1] === "commit" && SHA.test(parts[0] ?? "")).map((parts) => parts[0]!);
  }
  return { shas: held, key: createHash("sha256").update(held.join("\n")).digest("hex"), verified };
}

const STAGED_ONLY_SENTENCE = "This lane has staged changes that its files no longer hold. Commit or unstage them, then ADE saves it.";
const SUBMODULE_WORK_SENTENCE = "This lane has changes inside a submodule. Commit and push them in the submodule, then ADE saves it.";

/**
 * The backup saves the lane's files as they are. Two kinds of work are not in
 * them, so the lane is refused (and its computer kept) rather than counted as
 * saved: a staged version the files went back from, and changes inside a
 * submodule (the lane's tree records only the submodule's commit).
 */
async function refuseWorkOutsideTheFiles(cwd: string, workingTree: string, tipTree: string): Promise<void> {
  if (workingTree === tipTree) {
    // `write-tree` fails on a conflict; that lane's files are saved as they are.
    const index = await runGit(["write-tree"], { cwd, timeoutMs: 30_000, env: READ_ENV });
    if (index.exitCode === 0 && index.stdout.trim() && index.stdout.trim() !== tipTree) throw new LaneBackupRefused(STAGED_ONLY_SENTENCE, "failed");
  }
  if (!fs.existsSync(path.join(cwd, ".gitmodules"))) return;
  const status = await git(cwd, ["status", "--porcelain=v2", "--ignore-submodules=none"]);
  // Porcelain v2: `1|2|u <XY> <sub> ...`, where `<sub>` is `S<c><m><u>` for a submodule.
  const changed = status.split("\n").some((line) => {
    const sub = /^[12u] \S+ (S\S{3}) /.exec(line)?.[1];
    return sub != null && sub !== "S...";
  });
  if (changed) throw new LaneBackupRefused(SUBMODULE_WORK_SENTENCE, "failed");
}

const GITHUB_UNREACHABLE_SENTENCE = "ADE couldn't reach GitHub to check this lane's work. It checks again at the next rest.";
const MISSING_FOLDER_SENTENCE = "This lane's folder is missing on the computer, and ADE has no saved copy of its work.";

/** `head` and the exclusions, for `rev-list --stdin`. */
const revsNotOnGithub = (head: string, base: GithubBase): string => `${[head, ...base.shas.map((sha) => `^${sha}`)].join("\n")}\n`;

/**
 * The lane's state for the backup: HEAD, the tree its working tree would
 * commit as (ignored files out), and the commits GitHub has in no branch
 * (`base`, from `readGithubBase`). `clean` when nothing of it is off GitHub.
 * Throws when git can't read it.
 */
export async function readLaneWork(worktreePath: string, base?: GithubBase): Promise<LaneWorkRead> {
  const cwd = await git(worktreePath, ["rev-parse", "--show-toplevel"]);
  const githubBase = base ?? await readGithubBase(cwd);
  const tip = await resolveCommit(cwd, "HEAD");
  if (!tip) throw new LaneBackupRefused("This lane has no commit yet, so ADE can't save it. Commit once, then it saves.", "failed");
  const branchRead = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd, timeoutMs: 15_000, env: READ_ENV });
  const branch = branchRead.exitCode === 0 ? branchRead.stdout.trim() || null : null;
  const [workingTree, tipTree, aheadText] = await Promise.all([
    readHandoffWorkingTreeSha({ worktreePath: cwd }),
    git(cwd, ["rev-parse", `${tip}^{tree}`]),
    git(cwd, ["rev-list", "--count", "--stdin"], undefined, undefined, revsNotOnGithub(tip, githubBase)),
  ]);
  const ahead = Number.parseInt(aheadText, 10);
  if (!Number.isSafeInteger(ahead) || ahead < 0) throw new Error("ADE couldn't count this lane's commits.");
  await refuseWorkOutsideTheFiles(cwd, workingTree, tipTree);
  const fingerprint = createHash("sha256").update(`ade.lane-backup.v2\0${tip}\0${workingTree}\0${branch ?? ""}\0${githubBase.key}`).digest("hex");
  return { fingerprint, clean: ahead === 0 && workingTree === tipTree, cwd, tip, workingTree, tipTree, branch, ahead, base: githubBase };
}

export type LaneBackupPack = { bundle: Buffer; patch: Buffer; facts: CloudLaneBackupFacts };

/**
 * The lane's backup: the bundle and the patch. Throws `LaneBackupRefused`
 * when it can't be saved (too large, an LFS file, a submodule change).
 * Every temporary ref and file is gone when it returns.
 */
export async function packLaneBackup(lane: BackupLane, read: LaneWorkRead): Promise<LaneBackupPack> {
  const { cwd, tip } = read;
  try {
    await precheckUntrackedSize(cwd);
  } catch (error) {
    if (error instanceof Error && error.message === HANDOFF_GIT_BUNDLE_TOO_LARGE_MESSAGE) throw new LaneBackupRefused(CLOUD_BACKUP_TOO_LARGE_SENTENCE, "too_large");
    throw error;
  }
  const snapshot = read.workingTree === read.tipTree
    ? null
    : await git(cwd, ["commit-tree", read.workingTree, "-p", tip, "-m", SNAPSHOT_MESSAGE], SNAPSHOT_IDENTITY);
  let files = 0;
  try {
    files = (await refuseUnportablePaths(cwd, tip, snapshot, read.base.shas)).length;
  } catch (error) {
    throw new LaneBackupRefused(`${error instanceof Error ? error.message : String(error)} ADE can't save this lane's work until then.`, "failed");
  }
  const head = snapshot ?? tip;
  // The commits only this lane has, and the GitHub commits they build on (the bundle's prerequisites).
  const listed = (await git(cwd, ["rev-list", "--topo-order", "--reverse", "--boundary", "--stdin"], undefined, 64 * 1024 * 1024, revsNotOnGithub(head, read.base))).split("\n").filter(Boolean);
  const unpushed = listed.filter((line) => !line.startsWith("-"));
  const prerequisites = listed.filter((line) => line.startsWith("-")).map((line) => line.slice(1));
  // The patch starts at the last commit GitHub has: the parent of the oldest commit only this lane has.
  const oldest = unpushed[0];
  if (!oldest) throw new Error("ADE found nothing to save after all.");
  const baseSha = (await resolveCommit(cwd, `${oldest}^`)) ?? EMPTY_TREE_SHA;
  const ref = `refs/ade-backup/${refKey(lane.laneId)}/head`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-backup-"));
  try {
    await git(cwd, ["update-ref", ref, head]);
    const bundlePath = path.join(tempDir, "lane.bundle");
    const patchPath = path.join(tempDir, "lane.patch");
    // Leaving out what the prerequisites reach is leaving out all GitHub has: every path from the lane's work into it passes one of them.
    await git(cwd, ["bundle", "create", "--quiet", bundlePath, ref, ...(prerequisites.length ? ["--not", ...prerequisites] : [])]);
    // To a file: a text file that isn't UTF-8 must keep its bytes.
    await git(cwd, ["-c", "core.quotePath=false", "diff", "--binary", "--full-index", "--no-color", "--no-ext-diff", `--output=${patchPath}`, baseSha, head]);
    const bundleBytes = fs.statSync(bundlePath).size;
    const patchBytes = fs.existsSync(patchPath) ? fs.statSync(patchPath).size : 0;
    if (bundleBytes + patchBytes > CLOUD_BACKUP_MAX_BYTES) throw new LaneBackupRefused(CLOUD_BACKUP_TOO_LARGE_SENTENCE, "too_large");
    return {
      bundle: fs.readFileSync(bundlePath),
      patch: patchBytes ? fs.readFileSync(patchPath) : Buffer.alloc(0),
      facts: {
        branchRef: read.branch,
        laneName: lane.laneName,
        projectKey: lane.projectKey,
        headSha: tip,
        snapshotSha: snapshot,
        baseSha,
        commits: read.ahead,
        files,
      },
    };
  } finally {
    await runGit(["update-ref", "-d", ref], { cwd, timeoutMs: 15_000 });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function partsOf(bytes: Buffer, partBytes: number): Buffer[] {
  const parts: Buffer[] = [];
  for (let start = 0; start < bytes.byteLength; start += partBytes) parts.push(bytes.subarray(start, Math.min(bytes.byteLength, start + partBytes)));
  return parts;
}

/** Uploads one lane's backup; the server replaces the old one only at the commit. */
export async function uploadLaneBackup(api: CloudApiClient, args: { machineKey: string; instanceId: string; laneId: string; fingerprint: string; pack: LaneBackupPack }): Promise<CloudLaneBackup> {
  const { machineKey, instanceId, laneId, pack } = args;
  const started = await api.startLaneBackup(machineKey, laneId, {
    instanceId,
    fingerprint: args.fingerprint,
    bundleBytes: pack.bundle.byteLength,
    patchBytes: pack.patch.byteLength,
    facts: pack.facts,
  });
  const bundleParts = partsOf(pack.bundle, started.partBytes);
  const patchParts = partsOf(pack.patch, started.partBytes);
  for (const [kind, parts] of [["bundle", bundleParts], ["patch", patchParts]] as const) {
    for (let index = 0; index < parts.length; index += 1) {
      await api.putLaneBackupPart(machineKey, laneId, started.uploadId, kind, index + 1, instanceId, parts[index]!);
    }
  }
  return await api.commitLaneBackup(machineKey, laneId, started.uploadId, { instanceId, bundleParts: bundleParts.length, patchParts: patchParts.length });
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A server refusal at the caps, as the lane's state; null for any other error. */
function capRefusal(error: unknown): CloudBackupLaneReport["state"] | null {
  return error instanceof CloudApiError && error.status === 413 ? "too_large" : null;
}

export type LaneBackupRunDeps = {
  api: CloudApiClient;
  instanceId: string;
  machineKey: string;
  logger: Logger;
  /** Every lane on the computer; `complete` false when a project couldn't be read. */
  /** `missing`: lanes ADE still has whose folder isn't on disk; their backups stay. */
  lanes: () => Promise<LaneList>;
  /** False once the time is up or someone used the computer: the rest waits for the next save. */
  mayGoOn: () => boolean;
};

/**
 * One backup round over every lane, then the report. A lane the round could
 * not finish counts as not saved, so the report is current only when every
 * lane is clean or saved.
 */
type LaneList = { complete: boolean; lanes: BackupLane[]; missing?: string[] };

export async function runLaneBackups(deps: LaneBackupRunDeps): Promise<CloudBackupSaveSummary> {
  const { api, instanceId, machineKey, logger } = deps;
  const reportId = randomUUID().replace(/-/g, "");
  const summary: CloudBackupSaveSummary = { reportId: null, state: "failed", saved: 0, unchanged: 0, clean: 0, failed: 0 };
  let listed: LaneList;
  let held: CloudLaneBackup[];
  try {
    // This computer's backups and the ones it restored: the prune and the "unchanged" check need all of them.
    [listed, held] = await Promise.all([deps.lanes(), api.laneBackups(null, machineKey)]);
  } catch (error) {
    logger.warn("cloud.lane_backup_read_failed", { error: errorText(error) });
    return summary;
  }
  const own = new Map(held.filter((entry) => entry.machineKey === machineKey).map((entry) => [entry.laneId, entry]));
  const restoredHere = new Set(held.filter((entry) => entry.restoredByMachineKey === machineKey).map((entry) => entry.laneId));
  const reports: CloudBackupLaneReport[] = [];
  let complete = listed.complete;
  // One look at GitHub per repository: lanes that are worktrees of one clone share it.
  const bases = new Map<string, Promise<GithubBase>>();
  const baseOf = async (worktreePath: string): Promise<GithubBase> => {
    const common = path.resolve(worktreePath, await git(worktreePath, ["rev-parse", "--git-common-dir"]));
    let base = bases.get(common);
    if (!base) {
      base = readGithubBase(worktreePath);
      bases.set(common, base);
    }
    return await base;
  };
  for (const lane of listed.lanes) {
    const report: CloudBackupLaneReport = { laneId: lane.laneId, laneName: lane.laneName, state: "failed" };
    reports.push(report);
    if (!deps.mayGoOn()) {
      report.reason = "The save stopped before this lane; ADE saves it at the next rest.";
      complete = false;
      continue;
    }
    try {
      const read = await readLaneWork(lane.worktreePath, await baseOf(lane.worktreePath));
      // GitHub didn't answer: nothing here can say what it holds, so every backup stays and the lane is not saved.
      if (!read.base.verified) throw new LaneBackupRefused(GITHUB_UNREACHABLE_SENTENCE, "failed");
      if (read.clean) {
        // All on GitHub: its backup, and any backup of the lane it restored, go.
        if (own.has(lane.laneId) || restoredHere.has(lane.laneId)) await api.deleteLaneBackup(machineKey, lane.laneId, instanceId);
        report.state = "clean";
        summary.clean += 1;
        continue;
      }
      if (own.get(lane.laneId)?.fingerprint === read.fingerprint) {
        report.state = "unchanged";
        report.fingerprint = read.fingerprint;
        summary.unchanged += 1;
        continue;
      }
      const pack = await packLaneBackup(lane, read);
      await uploadLaneBackup(api, { machineKey, instanceId, laneId: lane.laneId, fingerprint: read.fingerprint, pack });
      report.state = "saved";
      report.fingerprint = read.fingerprint;
      summary.saved += 1;
    } catch (error) {
      if (error instanceof LaneBackupRefused) {
        report.state = error.state;
        report.reason = error.message;
      } else {
        const capped = capRefusal(error);
        report.state = capped ?? "failed";
        report.reason = capped && error instanceof Error ? error.message : `ADE couldn't save this lane's work: ${errorText(error).replace(/[.\s]+$/, "")}.`.slice(0, 300);
      }
      summary.failed += 1;
      logger.warn("cloud.lane_backup_failed", { laneId: lane.laneId, state: report.state, error: errorText(error).slice(0, 200) });
    }
  }
  // A lane whose folder is gone is saved only by the backup it has; without one, the report isn't current.
  for (const laneId of listed.missing ?? []) {
    const backup = own.get(laneId);
    reports.push(backup
      ? { laneId, state: "unchanged", fingerprint: backup.fingerprint }
      : { laneId, state: "failed", reason: MISSING_FOLDER_SENTENCE });
    if (backup) summary.unchanged += 1;
    else summary.failed += 1;
  }
  // A lane gone from a complete list was deleted on the computer: its backup goes too.
  // A lane ADE still has with its folder missing is not deleted: its backup may be the only copy.
  if (listed.complete) {
    const here = new Set([...listed.lanes.map((lane) => lane.laneId), ...(listed.missing ?? [])]);
    for (const laneId of own.keys()) {
      if (here.has(laneId)) continue;
      await api.deleteLaneBackup(machineKey, laneId, instanceId).catch((error: unknown) => {
        logger.warn("cloud.lane_backup_prune_failed", { laneId, error: errorText(error) });
      });
    }
  }
  try {
    const answer = await api.reportLaneBackups({ instanceId, reportId, complete, lanes: reports });
    if (answer) {
      summary.reportId = reportId;
      summary.state = answer.state;
    }
  } catch (error) {
    logger.warn("cloud.lane_backup_report_failed", { error: errorText(error) });
  }
  logger.info("cloud.lane_backups", { ...summary, lanes: reports.length, complete });
  return summary;
}

export type LaneRestoreOutcome =
  | "none"
  | "applied"
  | "already_here"
  | "kept_newer_local_work"
  | "kept_branch_differs"
  | "failed";

/**
 * When a lane starts on this computer: the newest backup of the same lane
 * from another machine, applied when the lane lacks its work. Never over
 * newer local work: uncommitted changes the backup doesn't hold, commits past
 * the backup, or a branch that went another way leave the lane as it is (the
 * backup stays). A backup the lane holds now is marked restored, so it goes
 * once the lane's work is on GitHub or a newer backup replaces it.
 */
export async function restoreLaneBackupIfNeeded(args: {
  api: CloudApiClient;
  instanceId: string;
  machineKey: string;
  laneId: string;
  worktreePath: string;
  projectRoot: string;
  logger: Logger;
}): Promise<LaneRestoreOutcome> {
  const { api, laneId, logger } = args;
  const backups = (await api.laneBackups(laneId)).filter((entry) => entry.laneId === laneId && entry.machineKey !== args.machineKey);
  const backup = backups.sort((a, b) => b.savedAt - a.savedAt)[0];
  if (!backup) return "none";
  const tip = backup.headSha;
  const snapshot = backup.snapshotSha;
  const head = snapshot ?? tip;
  const markRestored = async () => {
    await api.markLaneBackupRestored(backup.machineKey, laneId, args.instanceId, backup.fingerprint).catch((error: unknown) => {
      logger.warn("cloud.lane_restore_mark_failed", { laneId, error: errorText(error) });
    });
  };
  const cwd = args.worktreePath;
  const branchRead = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd, timeoutMs: 15_000, env: READ_ENV });
  const branch = branchRead.exitCode === 0 ? branchRead.stdout.trim() : "";
  if (!backup.branchRef || branch !== backup.branchRef) {
    logger.info("cloud.lane_restore_skipped", { laneId, why: "branch" });
    return "kept_branch_differs";
  }
  // Every part, checked against the size the server committed.
  const chunks: Buffer[] = [];
  for (let part = 1; part <= backup.bundleParts; part += 1) chunks.push(Buffer.from(await api.readLaneBackupPart(backup.machineKey, laneId, "bundle", part)));
  const content = Buffer.concat(chunks);
  if (content.byteLength !== backup.bundleBytes) throw new Error("This lane's saved work arrived damaged.");
  const current = await resolveCommit(cwd, "HEAD");
  if (!current) return "failed";
  const dirty = Boolean(await git(cwd, ["status", "--porcelain=v1"]));
  // The objects first, so the checks below can read them (`applyHandoffGitBundle` fetches again from the same file).
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-restore-"));
  const tempRef = `refs/ade-restore/${refKey(laneId)}/head`;
  try {
    const bundlePath = path.join(tempDir, "lane.bundle");
    fs.writeFileSync(bundlePath, content);
    if (!(await ensureBundleBase({ cwd, bundlePath, content }))) {
      throw new Error("This computer can't get the commits the lane's saved work builds on from GitHub.");
    }
    const heads = (await git(cwd, ["bundle", "list-heads", bundlePath])).split("\n").map((line) => line.trim().split(/\s+/)).filter((parts) => parts.length === 2);
    if (heads.length !== 1 || heads[0]![0] !== head) throw new Error("This lane's saved work doesn't match its record.");
    await git(cwd, ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", bundlePath, `+${heads[0]![1]}:${tempRef}`]);
    const tipInLane = current === tip || (await isAncestor(cwd, tip, current)) === true;
    if (tipInLane) {
      if (snapshot === null) {
        await markRestored();
        return "already_here";
      }
      if (current === tip) {
        const worktreeTree = await readHandoffWorkingTreeSha({ worktreePath: cwd });
        if (worktreeTree === await git(cwd, ["rev-parse", `${snapshot}^{tree}`])) {
          await markRestored();
          return "already_here";
        }
        if (dirty) return "kept_newer_local_work";
      } else {
        // The lane went on past the backup's commits: its own work is newer.
        return "kept_newer_local_work";
      }
    } else if ((await isAncestor(cwd, current, tip)) !== true) {
      logger.info("cloud.lane_restore_skipped", { laneId, why: "diverged" });
      return "kept_branch_differs";
    } else if (dirty) {
      return "kept_newer_local_work";
    }
    await applyHandoffGitBundle({
      projectRoot: args.projectRoot,
      handoffId: `lane-backup-${laneId}`,
      branchRef: branch,
      bundle: {
        contentBase64: content.toString("base64"),
        bytes: content.byteLength,
        branchHeadSha: tip,
        snapshotSha: snapshot,
        unpushedCommitCount: backup.commits,
        changedFileCount: backup.files,
      },
      target: { kind: "existing_worktree", worktreePath: cwd },
    });
    await markRestored();
    logger.info("cloud.lane_restored", { laneId, commits: backup.commits, files: backup.files });
    return "applied";
  } finally {
    await runGit(["update-ref", "-d", tempRef], { cwd, timeoutMs: 15_000 });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

type LaneListRuntime = {
  projectRoot: string;
  laneService: { list: (args: { includeArchived: boolean; includeStatus: boolean }) => Promise<Array<{ id: string; name: string; worktreePath: string }>> };
};

type LaneCache = { v: 1; projects: Record<string, Array<{ laneId: string; laneName: string | null; worktreePath: string }>> };

/**
 * The lanes of every project on the computer, for the backup. A project
 * whose runtime is open is read from it, and the list is kept in a file; a
 * project not open since the brain started is read from that file (nothing
 * in it changed through ADE), and one the file doesn't know is opened. A
 * project that can't be read makes the list incomplete, so the report is not
 * current. Only lanes whose folder is on disk count.
 */
export function createBackupLaneLister(deps: {
  cachePath: string;
  projects: () => Array<{ projectId: string; booted: () => Promise<LaneListRuntime | null>; open: () => Promise<LaneListRuntime> }>;
  projectKey: (projectRoot: string) => string | null;
  logger: Logger;
}): () => Promise<LaneList> {
  const readCache = (): LaneCache => {
    try {
      const parsed = JSON.parse(fs.readFileSync(deps.cachePath, "utf8")) as Partial<LaneCache>;
      if (parsed?.v === 1 && parsed.projects && typeof parsed.projects === "object") return { v: 1, projects: parsed.projects };
    } catch {
      // Missing or unreadable: every project is opened once.
    }
    return { v: 1, projects: {} };
  };
  const writeCache = (cache: LaneCache): void => {
    try {
      fs.mkdirSync(path.dirname(deps.cachePath), { recursive: true });
      const temp = `${deps.cachePath}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(cache), { mode: 0o600 });
      fs.renameSync(temp, deps.cachePath);
    } catch (error) {
      deps.logger.warn("cloud.lane_backup_cache_write_failed", { error: errorText(error) });
    }
  };
  return async () => {
    const cache = readCache();
    const next: LaneCache = { v: 1, projects: {} };
    const lanes: BackupLane[] = [];
    const missing: string[] = [];
    let complete = true;
    for (const project of deps.projects()) {
      try {
        let runtime = await project.booted();
        const cached = cache.projects[project.projectId];
        let rows: Array<{ laneId: string; laneName: string | null; worktreePath: string }>;
        if (!runtime && cached) {
          rows = cached;
        } else {
          runtime ??= await project.open();
          rows = (await runtime.laneService.list({ includeArchived: true, includeStatus: false }))
            .map((lane) => ({ laneId: lane.id, laneName: lane.name ?? null, worktreePath: lane.worktreePath }));
        }
        next.projects[project.projectId] = rows;
        const key = runtime ? deps.projectKey(runtime.projectRoot) : null;
        for (const row of rows) {
          if (!row.worktreePath || !fs.existsSync(row.worktreePath)) {
            missing.push(row.laneId);
            continue;
          }
          lanes.push({ laneId: row.laneId, laneName: row.laneName, worktreePath: row.worktreePath, projectKey: key ?? deps.projectKey(row.worktreePath) });
        }
      } catch (error) {
        complete = false;
        if (cache.projects[project.projectId]) next.projects[project.projectId] = cache.projects[project.projectId]!;
        deps.logger.warn("cloud.lane_backup_project_unreadable", { projectId: project.projectId, error: errorText(error) });
      }
    }
    writeCache(next);
    return { complete, lanes, missing };
  };
}

/**
 * Before an existing-branch lane is made on a new computer: a branch the
 * person never pushed is not on GitHub, so it is made here at the commit of
 * the lane's newest backup (only its commits; the uncommitted work comes with
 * `restoreLaneBackupIfNeeded`). Nothing changes when the branch is on
 * `origin` already, or when no backup names it. `created` is true also for a
 * branch here that an earlier attempt made from that backup (a retry), so the
 * caller never publishes it: the caller must not publish a branch made here.
 */
export async function prepareLaneBranchFromBackup(args: {
  api: CloudApiClient;
  machineKey: string;
  laneId: string;
  branchRef: string;
  projectRoot: string;
  logger: Logger;
}): Promise<{ created: boolean; branch?: string; note?: string }> {
  const branch = args.branchRef.replace(/^refs\/heads\//, "").replace(/^origin\//, "");
  const cwd = args.projectRoot;
  if (await resolveCommit(cwd, `refs/remotes/origin/${branch}`)) return { created: false };
  // The launch fetched origin already; one more look at GitHub itself, so a branch pushed meanwhile wins.
  const remote = await runGitWithGithubAuthFallback(["ls-remote", "--heads", "origin", branch], { cwd, timeoutMs: 30_000, env: READ_ENV });
  if (remote.exitCode === 0 && remote.stdout.trim()) return { created: false };
  const backup = (await args.api.laneBackups(args.laneId))
    .filter((entry) => entry.laneId === args.laneId && entry.machineKey !== args.machineKey && entry.branchRef === branch)
    .sort((a, b) => b.savedAt - a.savedAt)[0];
  const local = await resolveCommit(cwd, `refs/heads/${branch}`);
  if (!backup) {
    // No backup and not on GitHub: the lane had nothing GitHub lacked when its
    // computer went (a lane with no commits of its own is never pushed, and a
    // merged branch GitHub deleted counts as saved). It starts again at the
    // repository's default branch, where that work is, instead of failing.
    // A retry finds the branch it made there, so it is still not published.
    const base = await resolveCommit(cwd, "refs/remotes/origin/HEAD");
    if (!base || (local && local !== base)) return { created: false };
    if (!local) await git(cwd, ["update-ref", `refs/heads/${branch}`, base, ""]);
    const defaultName = (await runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd, timeoutMs: 15_000, env: READ_ENV }))
      .stdout.trim().replace(/^origin\//, "") || "the default branch";
    args.logger.info("cloud.lane_branch_from_default", { laneId: args.laneId });
    return { created: true, branch, note: `${branch} wasn't on GitHub, so ADE started it again from ${defaultName}.` };
  }
  // A retry: an earlier attempt made the branch from this backup, so it is still not published.
  if (local) return local === backup.headSha ? { created: true, branch } : { created: false };
  const chunks: Buffer[] = [];
  for (let part = 1; part <= backup.bundleParts; part += 1) chunks.push(Buffer.from(await args.api.readLaneBackupPart(backup.machineKey, args.laneId, "bundle", part)));
  const content = Buffer.concat(chunks);
  if (content.byteLength !== backup.bundleBytes) throw new Error("This lane's saved work arrived damaged.");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-restore-"));
  const tempRef = `refs/ade-restore/${refKey(args.laneId)}/branch`;
  try {
    const bundlePath = path.join(tempDir, "lane.bundle");
    fs.writeFileSync(bundlePath, content);
    if (!(await ensureBundleBase({ cwd, bundlePath, content }))) {
      throw new Error("This computer can't get the commits the lane's saved work builds on from GitHub.");
    }
    const heads = (await git(cwd, ["bundle", "list-heads", bundlePath])).split("\n").map((line) => line.trim().split(/\s+/)).filter((parts) => parts.length === 2);
    if (heads.length !== 1 || heads[0]![0] !== (backup.snapshotSha ?? backup.headSha)) throw new Error("This lane's saved work doesn't match its record.");
    await git(cwd, ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", bundlePath, `+${heads[0]![1]}:${tempRef}`]);
    // Create only: an empty old value never moves a branch that appeared meanwhile.
    await git(cwd, ["update-ref", `refs/heads/${branch}`, backup.headSha, ""]);
    args.logger.info("cloud.lane_branch_from_backup", { laneId: args.laneId, commits: backup.commits });
    return { created: true, branch };
  } finally {
    await runGit(["update-ref", "-d", tempRef], { cwd, timeoutMs: 15_000 });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
