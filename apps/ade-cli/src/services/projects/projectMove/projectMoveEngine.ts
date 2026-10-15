import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type {
  ProjectMoveProgress,
  ProjectMoveRecord,
  ProjectMoveStepId,
} from "../../../../../desktop/src/shared/types/projectMove";
import { listAppleDeviceMarkers, writeAppleDeviceMarker } from "../../../../../desktop/src/main/services/ios/appleDeviceMarker";
import { PROJECT_MOVED_MARKER, ProjectRegistry } from "../projectRegistry";
import { applyAgentHistoryRenames, planAgentHistoryRenames } from "./moveAgentHistory";
import { copyProjectTree, countCopiedEntries } from "./moveCopy";
import {
  projectDatabasePath,
  readProjectDatabaseSummary,
  rewriteJsonPaths,
  rewriteProjectDatabasePaths,
  snapshotProjectDatabase,
  verifyProjectDatabase,
} from "./moveDatabase";
import {
  enableRelativeWorktrees,
  listWorktreeLinks,
  pointOutsideLaneAt,
  relinkAbsoluteSymlinks,
  rewriteAbsoluteGitConfig,
  rewriteWorktreeLinksInCopy,
  rootSpellings,
  type WorktreeLink,
} from "./moveGitLinks";
import { listMoveRecords, ownsLeftoverCopy, writeMoveRecord } from "./moveJournal";
import { copyLocation } from "./projectMovePreflight";
import { readMoveVolume } from "./moveVolumes";

const execFileAsync = promisify(execFile);

/** Written into the parked original so ADE refuses to open it by mistake (`assertProjectNotMovedAway`). */
export const MOVED_MARKER_FILE = path.basename(PROJECT_MOVED_MARKER);

export type ProjectMoveHooks = {
  /** Close the project in every window and in the background service. */
  closeProject: (root: string) => Promise<void>;
  onProgress: (progress: ProjectMoveProgress) => void;
};

class MoveStepError extends Error {
  constructor(readonly step: ProjectMoveStepId, message: string) {
    super(message);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: 5 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
    // Never take git's optional locks in the original while it is compared.
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return stdout;
}

/** Processes that have a file open, from `lsof`. Empty when none (or `lsof` is unavailable). */
async function processesHolding(file: string): Promise<number[]> {
  if (!fs.existsSync(file)) return [];
  try {
    const { stdout } = await execFileAsync("/usr/sbin/lsof", ["-t", "--", file], { timeout: 15_000 });
    return stdout.split("\n").map((line) => Number.parseInt(line, 10)).filter((pid) => Number.isFinite(pid));
  } catch (error) {
    // lsof exits 1 when nothing has the file open.
    const stdout = (error as { stdout?: string }).stdout ?? "";
    return stdout.split("\n").map((line) => Number.parseInt(line, 10)).filter((pid) => Number.isFinite(pid));
  }
}

async function processName(pid: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-o", "comm=", "-p", String(pid)], { timeout: 5_000 });
    const name = path.basename(stdout.trim());
    return name ? `${name} (process ${pid})` : `Process ${pid}`;
  } catch {
    return `Process ${pid}`;
  }
}

async function waitUntilReleased(dbPath: string, timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const holders = await processesHolding(dbPath);
    if (!holders.length || Date.now() > deadline) return holders;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function statusLines(output: string): string[] {
  return output
    .split("\0")
    .filter(Boolean)
    // Dependency folders are left out of the copy on purpose.
    .filter((line) => !/(^|\/)node_modules(\/|$)/u.test(line.slice(3)))
    .sort();
}

function uniqueParkedPath(sourceRoot: string, volumeName: string): string {
  const base = `${sourceRoot} (moved to ${volumeName.replace(/[/:]/gu, "-")})`;
  let candidate = base;
  for (let index = 2; fs.existsSync(candidate); index += 1) candidate = `${base} ${index}`;
  return candidate;
}

/** Rewrites path values in small JSON files ADE keeps under `.ade`. */
function rewriteAdeJsonFiles(copyRoot: string, oldSpellings: string[], finalRoot: string): number {
  const files: string[] = [path.join(copyRoot, ".ade", "leftover-worktrees.json")];
  const cache = path.join(copyRoot, ".ade", "cache");
  for (const dir of ["mac-desktop-observations", "app-control-observations", "browser-observations"]) {
    const root = path.join(cache, dir);
    const walk = (current: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".json")) files.push(full);
      }
    };
    walk(root);
  }
  let changed = 0;
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!oldSpellings.some((spelling) => text.includes(spelling))) continue;
    const next = rewriteJsonPaths(text, oldSpellings, finalRoot, ["path", "filePath", "worktreePath", "absolutePath"]);
    if (next === text) continue;
    fs.writeFileSync(file, next);
    changed += 1;
  }
  return changed;
}

/** Simulators ADE created for this project's lanes record the project root. */
function rewriteSimulatorMarkers(oldSpellings: string[], finalRoot: string): number {
  const dataRoot = path.join(process.env.HOME ?? "", "Library", "Developer", "CoreSimulator", "Devices");
  let changed = 0;
  for (const { udid, marker } of listAppleDeviceMarkers(dataRoot)) {
    if (!oldSpellings.includes(marker.projectRoot)) continue;
    if (writeAppleDeviceMarker(dataRoot, udid, { ...marker, projectRoot: finalRoot })) changed += 1;
  }
  return changed;
}

/**
 * Runs a move. The original is not changed until the switch-over, and the
 * copy is built at `<destination>.ade-moving`, a name nothing opens. Any
 * failure before the switch-over deletes that partial copy and leaves the
 * project exactly as it was.
 */
export async function runProjectMove(args: {
  sourceRoot: string;
  destinationRoot: string;
  moveAgentHistory: boolean;
  hooks: ProjectMoveHooks;
}): Promise<ProjectMoveRecord> {
  const sourceRoot = path.resolve(args.sourceRoot);
  const finalRoot = path.resolve(args.destinationRoot);
  const copyRoot = copyLocation(finalRoot);
  const oldSpellings = rootSpellings(sourceRoot);
  const [destinationVolume, sourceVolume] = await Promise.all([readMoveVolume(finalRoot), readMoveVolume(sourceRoot)]);
  // A partial copy from an earlier failed attempt into the same place is
  // ADE's own; anything else at that name is not, and is never removed.
  const leftoverIsOurs = fs.existsSync(copyRoot) && ownsLeftoverCopy(finalRoot);
  const record: ProjectMoveRecord = {
    moveId: `move_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
    projectName: path.basename(sourceRoot),
    sourceRoot,
    destinationRoot: finalRoot,
    originalParkedAt: null,
    originalBytes: 0,
    destinationVolumeUuid: destinationVolume?.uuid ?? null,
    destinationVolumeName: destinationVolume?.name ?? null,
    sourceVolumeName: sourceVolume?.name ?? null,
    startedAt: Date.now(),
    finishedAt: null,
    state: "running",
    cleanup: { choice: "pending" },
    followUps: [],
    pid: process.pid,
  };
  writeMoveRecord(record);
  let step: ProjectMoveStepId = "prepare";
  const progress = (message: string, extra: Partial<ProjectMoveProgress> = {}) =>
    args.hooks.onProgress({ moveId: record.moveId, step, message, ...extra });
  const enter = (next: ProjectMoveStepId, message: string) => {
    step = next;
    progress(message);
  };

  const assertSameDrive = async () => {
    if (!record.destinationVolumeUuid) return;
    const now = await readMoveVolume(finalRoot);
    if (now?.uuid !== record.destinationVolumeUuid) {
      throw new MoveStepError(step, `${record.destinationVolumeName ?? "The drive"} was disconnected or replaced during the move.`);
    }
  };

  let switched = false;
  try {
    // 1. Close the project everywhere and make sure nothing still has its data open.
    enter("prepare", "Closing the project");
    const dbPath = projectDatabasePath(sourceRoot);
    const before = readProjectDatabaseSummary(dbPath);
    if (before.projectCount !== 1 || !before.projectId) throw new MoveStepError("prepare", "ADE's data for this project needs a repair first.");
    await args.hooks.closeProject(sourceRoot);
    const holders = await waitUntilReleased(dbPath, 20_000);
    if (holders.length) {
      const names = await Promise.all(holders.map(processName));
      throw new MoveStepError(
        "prepare",
        `${[...new Set(names)].join(", ")} still has the project's data open. Quit it (or other copies of ADE), then try again.`,
      );
    }
    const originalLinks = listWorktreeLinks(sourceRoot, oldSpellings);
    record.resume = {
      sourceSpellings: oldSpellings,
      knownPaths: [sourceRoot, ...before.lanes.map((lane) => lane.worktreePath).filter(Boolean)],
      moveAgentHistory: args.moveAgentHistory,
      outsideLanes: originalLinks
        .filter((link) => link.relativePath === null && link.exists)
        .map((link) => ({ name: link.name, lanePath: link.lanePath })),
    };
    writeMoveRecord(record);

    // 2. Copy.
    enter("copy", "Copying files");
    await assertSameDrive();
    if (fs.existsSync(copyRoot)) {
      if (!leftoverIsOurs) throw new MoveStepError("copy", `Something is already at ${copyRoot}. Move it away, then try again.`);
      progress("Removing the partial copy from an earlier attempt");
      await fs.promises.rm(copyRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(finalRoot), { recursive: true });
    const { totalFiles } = await copyProjectTree({
      sourceRoot,
      copyRoot,
      onProgress: (copiedFiles, total) =>
        progress(`Copying files (${copiedFiles.toLocaleString()} of ${total.toLocaleString()})`, {
          copiedFiles,
          totalFiles: total,
          fraction: total ? copiedFiles / total : undefined,
        }),
    }).catch(async (error) => {
      const now = await readMoveVolume(finalRoot);
      if (record.destinationVolumeUuid && now?.uuid !== record.destinationVolumeUuid) {
        throw new MoveStepError(
          "copy",
          `${record.destinationVolumeName ?? "The drive"} was disconnected during the copy. Your project wasn't changed. Reconnect the drive and try again; ADE removes the partial copy then.`,
        );
      }
      throw new MoveStepError("copy", errorText(error));
    });
    progress("Copying ADE's project data");
    await snapshotProjectDatabase(dbPath, projectDatabasePath(copyRoot)).catch((error) => {
      throw new MoveStepError("copy", `Copying ADE's project data failed: ${errorText(error)}`);
    });

    // 3. Git links.
    enter("git", "Updating git links");
    const links = rewriteWorktreeLinksInCopy({ copyRoot, finalRoot, oldSpellings });
    await enableRelativeWorktrees(copyRoot);
    const configKeys = await rewriteAbsoluteGitConfig({ copyRoot, finalRoot, oldSpellings });
    const relinked = await relinkAbsoluteSymlinks({ copyRoot, finalRoot, oldSpellings });
    progress(`Updated ${links.inside.length} lane link${links.inside.length === 1 ? "" : "s"}, ${configKeys.length} git setting${configKeys.length === 1 ? "" : "s"}, ${relinked} symlink${relinked === 1 ? "" : "s"}`);

    // 4. ADE's data.
    enter("data", "Updating ADE's project data");
    const rewrite = rewriteProjectDatabasePaths({ dbPath: projectDatabasePath(copyRoot), oldSpellings, finalRoot });
    if (rewrite.projectId !== before.projectId) throw new MoveStepError("data", "The copied project data has a different project id.");
    rewriteAdeJsonFiles(copyRoot, oldSpellings, finalRoot);

    // 5. Verify.
    enter("verify", "Checking the copy");
    const copied = await countCopiedEntries(copyRoot);
    if (copied !== totalFiles) {
      throw new MoveStepError("verify", `The copy has ${copied.toLocaleString()} items but the project has ${totalFiles.toLocaleString()}.`);
    }
    const dbProblems = verifyProjectDatabase({
      dbPath: projectDatabasePath(copyRoot),
      oldSpellings,
      finalRoot,
      outsideLanePaths: originalLinks
        .filter((link) => link.relativePath === null)
        .flatMap((link) => rootSpellings(link.lanePath)),
      expectedProjectId: before.projectId,
      expectedLaneIds: before.lanes.map((lane) => lane.id),
    });
    if (dbProblems.length) throw new MoveStepError("verify", dbProblems.join(" "));
    await verifyGit({ sourceRoot, copyRoot, insideLanes: links.inside, progress });

    // 6. Switch over.
    enter("switch", "Switching to the new location");
    await assertSameDrive();
    const parked = uniqueParkedPath(sourceRoot, record.destinationVolumeName ?? "new drive");
    fs.renameSync(sourceRoot, parked);
    record.originalParkedAt = parked;
    writeMoveRecord(record);
    try {
      fs.renameSync(copyRoot, finalRoot);
    } catch (error) {
      fs.renameSync(parked, sourceRoot);
      record.originalParkedAt = null;
      throw new MoveStepError("switch", `Couldn't put the copy in place: ${errorText(error)}`);
    }
    switched = true;
    writeMoveRecord(record);
    finishSwitch(record);
    record.originalBytes = await folderBytes(parked);
    record.state = "done";
    record.finishedAt = Date.now();
    writeMoveRecord(record);
    return record;
  } catch (error) {
    const failedStep = error instanceof MoveStepError ? error.step : step;
    if (!switched) {
      try {
        fs.rmSync(copyRoot, { recursive: true, force: true });
      } catch {
        record.followUps.push(`ADE couldn't remove the partial copy at ${copyRoot}. You can delete it.`);
      }
    }
    record.state = "failed";
    record.failedStep = failedStep;
    record.error = errorText(error);
    record.finishedAt = Date.now();
    writeMoveRecord(record);
    return record;
  }
}

/**
 * Everything after the copy is in place: link outside lanes, mark the parked
 * original, re-key the registry, and point simulators and agent history at the
 * new location. Each part can run again, so a restart finishes a switch-over
 * that was interrupted.
 */
function finishSwitch(record: ProjectMoveRecord): void {
  const resume = record.resume;
  const parked = record.originalParkedAt;
  if (!resume || !parked) return;
  const finalRoot = record.destinationRoot;
  for (const lane of resume.outsideLanes) {
    try {
      if (fs.existsSync(lane.lanePath)) pointOutsideLaneAt({ ...lane, relativePath: null, exists: true }, finalRoot);
    } catch (error) {
      record.followUps.push(`The lane at ${lane.lanePath} couldn't be linked to the moved project: ${errorText(error)}`);
    }
  }
  fs.mkdirSync(path.join(parked, ".ade"), { recursive: true });
  fs.writeFileSync(
    path.join(parked, ".ade", MOVED_MARKER_FILE),
    `${JSON.stringify({ movedTo: finalRoot, moveId: record.moveId, movedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  new ProjectRegistry().relocate(resume.sourceSpellings, finalRoot);
  const simulators = rewriteSimulatorMarkers(resume.sourceSpellings, finalRoot);
  if (simulators) record.followUps.push(`${simulators} lane simulator${simulators === 1 ? "" : "s"} now point at the new location.`);
  const plans = planAgentHistoryRenames({
    oldSpellings: resume.sourceSpellings,
    newRoot: finalRoot,
    knownPaths: resume.knownPaths,
  }).filter((plan) => plan.adeOwned || resume.moveAgentHistory);
  const history = applyAgentHistoryRenames(plans);
  if (history.moved) record.followUps.push(`Moved ${history.moved} chat history folder${history.moved === 1 ? "" : "s"} to the new location.`);
  record.followUps.push(...history.problems);
}

/** Reverses `finishSwitch` for an original that was put back, in case part of it ran. */
function undoFinishSwitch(record: ProjectMoveRecord): void {
  const marker = path.join(record.sourceRoot, ".ade", MOVED_MARKER_FILE);
  try {
    const moveId = (JSON.parse(fs.readFileSync(marker, "utf8")) as { moveId?: string }).moveId;
    if (moveId === record.moveId) fs.rmSync(marker, { force: true });
  } catch {
    // no marker
  }
  for (const lane of record.resume?.outsideLanes ?? []) {
    if (fs.existsSync(lane.lanePath)) pointOutsideLaneAt({ ...lane, relativePath: null, exists: true }, record.sourceRoot);
  }
  const registry = new ProjectRegistry();
  if (registry.findByRootPath(record.destinationRoot)) registry.relocate([record.destinationRoot], record.sourceRoot);
}

function processAlive(pid: number | undefined): boolean {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Settles moves a crash or quit left "running". Before the switch-over the
 * original was never touched: the partial copy is removed. Halfway through
 * the switch-over the original is put back. After it, the remaining
 * bookkeeping is finished. Called once when ADE starts.
 */
export async function recoverInterruptedMoves(): Promise<ProjectMoveRecord[]> {
  const settled: ProjectMoveRecord[] = [];
  for (const record of listMoveRecords()) {
    if (record.state !== "running" || processAlive(record.pid)) continue;
    const copyRoot = copyLocation(record.destinationRoot);
    try {
      if (record.originalParkedAt && fs.existsSync(record.destinationRoot)) {
        finishSwitch(record);
        record.state = "done";
        record.originalBytes = await folderBytes(record.originalParkedAt);
        record.followUps.push("ADE stopped during the switch-over and finished it when it started again.");
      } else {
        if (record.originalParkedAt && !fs.existsSync(record.sourceRoot) && fs.existsSync(record.originalParkedAt)) {
          fs.renameSync(record.originalParkedAt, record.sourceRoot);
          record.originalParkedAt = null;
          undoFinishSwitch(record);
        }
        if (fs.existsSync(copyRoot)) await fs.promises.rm(copyRoot, { recursive: true, force: true });
        record.state = "failed";
        record.error = "ADE stopped during the move. Your project wasn't changed.";
      }
    } catch (error) {
      record.state = "failed";
      record.error = `ADE stopped during the move and couldn't tidy up: ${errorText(error)}`;
    }
    record.finishedAt = Date.now();
    writeMoveRecord(record);
    settled.push(record);
  }
  return settled;
}

async function verifyGit(args: {
  sourceRoot: string;
  copyRoot: string;
  insideLanes: WorktreeLink[];
  progress: (message: string, extra?: Partial<ProjectMoveProgress>) => void;
}): Promise<void> {
  const copyGitDir = fs.realpathSync(path.join(args.copyRoot, ".git"));
  const checkouts = [
    { label: path.basename(args.sourceRoot), relative: "" },
    ...args.insideLanes.map((lane) => ({ label: path.basename(lane.relativePath ?? ""), relative: lane.relativePath ?? "" })),
  ];
  let index = 0;
  for (const checkout of checkouts) {
    index += 1;
    args.progress(`Checking ${checkout.label}`, { fraction: index / checkouts.length });
    const inCopy = path.join(args.copyRoot, checkout.relative);
    const common = (await git(inCopy, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
    if (fs.realpathSync(common) !== copyGitDir) {
      throw new MoveStepError("verify", `${checkout.label} in the copy still uses the original's git data.`);
    }
    const [original, copy] = await Promise.all([
      git(path.join(args.sourceRoot, checkout.relative), ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      git(inCopy, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    ]);
    const a = statusLines(original);
    const b = statusLines(copy);
    if (a.length !== b.length || a.some((line, i) => line !== b[i])) {
      throw new MoveStepError("verify", `${checkout.label} looks different in the copy than in the original.`);
    }
  }
  const listed = (await git(args.copyRoot, ["worktree", "list", "--porcelain"]))
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
  const copyReal = fs.realpathSync(args.copyRoot);
  for (const lane of args.insideLanes) {
    const expected = path.join(copyReal, lane.relativePath ?? "");
    if (!listed.some((entry) => entry === expected || entry === path.join(args.copyRoot, lane.relativePath ?? ""))) {
      throw new MoveStepError("verify", `Git in the copy doesn't list the lane ${path.basename(lane.relativePath ?? "")}.`);
    }
  }
}

async function folderBytes(root: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/du", ["-sk", root], { timeout: 10 * 60_000 });
    return (Number.parseInt(stdout.trim().split(/\s+/u)[0] ?? "0", 10) || 0) * 1024;
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout ?? "";
    return (Number.parseInt(stdout.trim().split(/\s+/u)[0] ?? "0", 10) || 0) * 1024;
  }
}

/**
 * Deletes the parked original once the person confirms. Only the exact path
 * the move recorded, and only while it still carries the moved marker.
 */
export async function deleteParkedOriginal(record: ProjectMoveRecord): Promise<void> {
  const parked = record.originalParkedAt;
  if (!parked) throw new Error("ADE has no record of where the original was kept.");
  const marker = path.join(parked, ".ade", MOVED_MARKER_FILE);
  let markerMove: string | null = null;
  try {
    markerMove = (JSON.parse(fs.readFileSync(marker, "utf8")) as { moveId?: string }).moveId ?? null;
  } catch {
    markerMove = null;
  }
  if (markerMove !== record.moveId) {
    throw new Error(`The folder at ${parked} isn't the original ADE kept, so ADE won't delete it.`);
  }
  if (!fs.existsSync(record.destinationRoot)) {
    throw new Error("The moved project isn't at its new location right now, so ADE won't delete the original.");
  }
  await fs.promises.rm(parked, { recursive: true, force: false, maxRetries: 2 });
}
