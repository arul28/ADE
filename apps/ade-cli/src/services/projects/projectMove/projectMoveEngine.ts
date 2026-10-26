import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type {
  ProjectMoveNote,
  ProjectMoveProgress,
  ProjectMoveRecord,
  ProjectMoveStepId,
} from "../../../../../desktop/src/shared/types/projectMove";
import { nonAsarFs } from "../../../../../desktop/src/main/services/shared/nonAsarFs";
import { removeTreeOffProcess } from "../../../../../desktop/src/main/services/shared/removeTreeOffProcess";
import { listAppleDeviceMarkers, writeAppleDeviceMarker } from "../../../../../desktop/src/main/services/ios/appleDeviceMarker";
import { ProjectRegistry } from "../projectRegistry";
import { readGitDirPointer } from "../projectRoots";
import { applyAgentHistoryRenames, carryClaudeProjectSettings, carryCodexTrust, carryCopilotTrust, planAgentHistoryRenames } from "./moveAgentHistory";
import { copyProjectTree, countCopiedEntries, diskUsageBytes, onSameVolume, trackedDependencyDirs } from "./moveCopy";
import {
  projectDatabasePath,
  readProjectDatabaseSummary,
  rewriteJsonPaths,
  rewriteProjectDatabasePaths,
  snapshotProjectDatabase,
  verifyProjectDatabase,
  type DatabaseSummary,
} from "./moveDatabase";
import {
  enableRelativeWorktrees,
  listWorktreeLinks,
  pointOutsideLaneAt,
  relativeToRoot,
  relinkAbsoluteSymlinks,
  rewriteAbsoluteGitConfig,
  rewriteWorktreeLinksInCopy,
  rootSpellings,
  type WorktreeLink,
} from "./moveGitLinks";
import {
  currentBootMinute,
  isMoveProcessAlive,
  listMoveRecords,
  markMoveActive,
  movedMarkerPath,
  ownsLeftoverCopy,
  recordOriginalBytes,
  readMovedMarker,
  writeMovedMarker,
  writeMoveRecord,
} from "./moveJournal";
import { copyLocation } from "./projectMovePreflight";
import { readMoveVolume } from "./moveVolumes";

const execFileAsync = promisify(execFile);

export type ProjectMoveHooks = {
  /** Close the project in every window and in the background service. */
  closeProject: (root: string) => Promise<void>;
  onProgress: (progress: ProjectMoveProgress) => void;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
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
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("/usr/sbin/lsof", ["-t", "--", file], { timeout: 15_000 }));
  } catch (error) {
    // lsof exits 1 when nothing has the file open.
    stdout = (error as { stdout?: string }).stdout ?? "";
  }
  return stdout.split("\n").map((line) => Number.parseInt(line, 10)).filter((pid) => Number.isFinite(pid));
}

async function processName(pid: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-o", "comm=", "-p", String(pid)], { timeout: 5_000 });
    const name = path.basename(stdout.trim());
    return name ? `${name} (process ${pid})` : `Process ${pid}`;
  } catch {
    return `Process ${pid}`; // the process exited meanwhile; its pid still names it
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

/** JSON files ADE keeps under `.ade` that name paths inside the project. */
function adeJsonFilesWithPaths(copyRoot: string): string[] {
  const files: string[] = [path.join(copyRoot, ".ade", "leftover-worktrees.json")];
  const walk = (current: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return; // the folder does not exist in this project
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".json")) files.push(full);
    }
  };
  for (const dir of ["mac-desktop-observations", "app-control-observations", "browser-observations"]) {
    walk(path.join(copyRoot, ".ade", "cache", dir));
  }
  return files;
}

/** Rewrites path values in small JSON files ADE keeps under `.ade`. */
export function rewriteAdeJsonFiles(copyRoot: string, oldSpellings: string[], finalRoot: string): void {
  for (const file of adeJsonFilesWithPaths(copyRoot)) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    if (!oldSpellings.some((spelling) => text.includes(spelling))) continue;
    const next = rewriteJsonPaths(text, oldSpellings, finalRoot, ["path", "filePath", "worktreePath", "absolutePath"]);
    if (next !== text) fs.writeFileSync(file, next);
  }
}

/** Simulators ADE created for this project's lanes record the project root. */
export function rewriteSimulatorMarkers(oldSpellings: string[], finalRoot: string): number {
  const dataRoot = path.join(process.env.HOME ?? "", "Library", "Developer", "CoreSimulator", "Devices");
  let changed = 0;
  for (const { udid, marker } of listAppleDeviceMarkers(dataRoot)) {
    if (!oldSpellings.includes(marker.projectRoot)) continue;
    if (writeAppleDeviceMarker(dataRoot, udid, { ...marker, projectRoot: finalRoot })) changed += 1;
  }
  return changed;
}

type MoveRun = {
  record: ProjectMoveRecord;
  sourceRoot: string;
  finalRoot: string;
  copyRoot: string;
  destinationFileSystem: string | null;
  oldSpellings: string[];
  hooks: ProjectMoveHooks;
  step: ProjectMoveStepId;
  progress: (message: string, extra?: Partial<ProjectMoveProgress>) => void;
};

function enter(run: MoveRun, step: ProjectMoveStepId, message: string): void {
  run.step = step;
  run.progress(message);
}

async function assertSameDrive(run: MoveRun, message: string): Promise<void> {
  const { record } = run;
  if (!record.destinationVolumeUuid) return;
  const now = await readMoveVolume(run.finalRoot);
  if (now?.uuid !== record.destinationVolumeUuid) throw new Error(`${record.destinationVolumeName ?? "The drive"} ${message}`);
}

/** 1. Close the project everywhere and wait until nothing has its data open. */
async function prepare(run: MoveRun): Promise<WorktreeLink[]> {
  enter(run, "prepare", "Closing the project");
  const dbPath = projectDatabasePath(run.sourceRoot);
  await run.hooks.closeProject(run.sourceRoot);
  const holders = await waitUntilReleased(dbPath, 20_000);
  if (holders.length) {
    const names = await Promise.all(holders.map(processName));
    throw new Error(`${[...new Set(names)].join(", ")} still has the project's data open. Quit it (or other copies of ADE), then try again.`);
  }
  return listWorktreeLinks(run.sourceRoot, run.oldSpellings);
}

/** 2. Copy the files, then the database through SQLite. Returns what the database held. */
async function copy(run: MoveRun, links: WorktreeLink[], leftoverIsOurs: boolean): Promise<{ totalFiles: number; keep: string[]; before: DatabaseSummary }> {
  const { record, copyRoot } = run;
  enter(run, "copy", "Copying files");
  await assertSameDrive(run, "was disconnected or replaced.");
  if (fs.existsSync(copyRoot)) {
    // Only ever a partial copy an earlier attempt of ADE's left behind.
    if (!leftoverIsOurs) throw new Error(`Something is already at ${copyRoot}. Move it away, then try again.`);
    run.progress("Removing the partial copy from an earlier attempt");
    await fs.promises.rm(copyRoot, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(run.finalRoot), { recursive: true });
  const keep = await trackedDependencyDirs(
    run.sourceRoot,
    links.flatMap((link) => (link.relativePath !== null && link.exists ? [link.relativePath] : [])),
  );
  record.copyCreated = true;
  writeMoveRecord(record);
  const clone = onSameVolume(run.sourceRoot, path.dirname(run.finalRoot)) && run.destinationFileSystem === "apfs";
  if (clone) {
    // Clones share the original's blocks, so dependencies come along for free
    // and nothing needs reinstalling.
    record.copiedDependencies = true;
    writeMoveRecord(record);
    run.progress("Same drive: copying by cloning, which takes almost no time or space");
  }
  const includeDependencies = record.copiedDependencies === true;
  const { totalFiles } = await copyProjectTree({
    sourceRoot: run.sourceRoot,
    copyRoot,
    keepDependencyDirs: keep,
    includeDependencies,
    clone,
    onProgress: (copied, total) =>
      run.progress(`Copying files (${copied.toLocaleString()} of ${total.toLocaleString()})`, {
        fraction: total ? copied / total : undefined,
      }),
  }).catch(async (error) => {
    await assertSameDrive(run, "was disconnected during the copy. Your project wasn't changed. Reconnect the drive and try again.");
    throw error;
  });
  run.progress("Copying ADE's project data");
  const copiedDb = projectDatabasePath(copyRoot);
  await snapshotProjectDatabase(projectDatabasePath(run.sourceRoot), copiedDb).catch((error) => {
    throw new Error(`Copying ADE's project data failed: ${errorText(error)}`);
  });
  // Read from the snapshot: it holds everything the write-ahead log held.
  const before = readProjectDatabaseSummary(copiedDb);
  if (before.projectCount !== 1 || !before.projectId) throw new Error("ADE's data for this project needs a repair first.");
  record.resume = {
    sourceSpellings: run.oldSpellings,
    knownPaths: [run.sourceRoot, ...before.lanes.map((lane) => lane.worktreePath).filter(Boolean)],
    moveAgentHistory: record.resume?.moveAgentHistory ?? false,
    outsideLanes: links
      .filter((link) => link.relativePath === null && link.exists)
      .map((link) => ({ name: link.name, lanePath: link.lanePath })),
  };
  writeMoveRecord(record);
  return { totalFiles, keep, before };
}

/** 3–4. Point git and ADE's data in the copy at the final location. */
async function rewrite(run: MoveRun): Promise<WorktreeLink[]> {
  const { copyRoot, finalRoot, oldSpellings } = run;
  enter(run, "git", "Updating git links");
  const links = rewriteWorktreeLinksInCopy({ copyRoot, finalRoot, oldSpellings });
  await enableRelativeWorktrees(copyRoot);
  const configKeys = await rewriteAbsoluteGitConfig({ copyRoot, finalRoot, oldSpellings });
  const relinked = await relinkAbsoluteSymlinks({ copyRoot, finalRoot, oldSpellings, includeDependencies: run.record.copiedDependencies === true });
  run.progress(`Updated ${plural(links.inside.length, "lane link")}, ${plural(configKeys.length, "git setting")}, ${plural(relinked, "symlink")}`);

  enter(run, "data", "Updating ADE's project data");
  rewriteProjectDatabasePaths({ dbPath: projectDatabasePath(copyRoot), oldSpellings, finalRoot });
  rewriteAdeJsonFiles(copyRoot, oldSpellings, finalRoot);
  return links.inside;
}

/** 5. Prove the copy matches the original and points only at itself. */
async function verify(run: MoveRun, args: { totalFiles: number; keep: string[]; before: DatabaseSummary; insideLanes: WorktreeLink[]; links: WorktreeLink[] }): Promise<void> {
  enter(run, "verify", "Checking the copy");
  const copied = await countCopiedEntries(run.copyRoot, args.keep, run.record.copiedDependencies === true);
  if (copied !== args.totalFiles) {
    throw new Error(`The copy has ${copied.toLocaleString()} items but the project has ${args.totalFiles.toLocaleString()}.`);
  }
  const dbProblems = verifyProjectDatabase({
    dbPath: projectDatabasePath(run.copyRoot),
    oldSpellings: run.oldSpellings,
    finalRoot: run.finalRoot,
    outsideLanePaths: args.links.filter((link) => link.relativePath === null).flatMap((link) => rootSpellings(link.lanePath)),
    expectedProjectId: args.before.projectId ?? "",
    expectedLaneIds: args.before.lanes.map((lane) => lane.id),
  });
  if (dbProblems.length) throw new Error(dbProblems.join(" "));
  await verifyGit({ sourceRoot: run.sourceRoot, copyRoot: run.copyRoot, insideLanes: args.insideLanes, progress: run.progress });
}

/**
 * 6. Park the original under a new name and put the copy in its place. The
 * parked name is journaled before the rename, so a crash between the two
 * renames can always be put back.
 */
async function switchOver(run: MoveRun): Promise<string> {
  const { record } = run;
  enter(run, "switch", "Switching to the new location");
  await assertSameDrive(run, "was disconnected or replaced.");
  const parked = uniqueParkedPath(run.sourceRoot, record.destinationInternal ? "This Mac" : record.destinationVolumeName ?? "new drive");
  record.parkingAt = parked;
  writeMoveRecord(record);
  fs.renameSync(run.sourceRoot, parked);
  record.originalParkedAt = parked;
  writeMoveRecord(record);
  try {
    fs.renameSync(run.copyRoot, run.finalRoot);
  } catch (error) {
    try {
      fs.renameSync(parked, run.sourceRoot);
    } catch (restoreError) {
      // Keep the verified copy: with the original stuck at its parked name it
      // may be the only working one.
      record.copyCreated = false;
      throw new Error(
        `Couldn't put the copy in place (${errorText(error)}), nor the original back (${errorText(restoreError)}). `
        + `The original is at ${parked} and the checked copy at ${run.copyRoot}.`,
      );
    }
    record.originalParkedAt = null;
    record.parkingAt = null;
    throw new Error(`Couldn't put the copy in place: ${errorText(error)}`);
  }
  record.switched = true;
  try {
    writeMoveRecord(record);
  } catch (error) {
    // The copy is in place: recovery recognises that from the folders alone
    // (parked original, destination present, no partial copy).
    record.problems.push(`ADE couldn't save the move's progress: ${errorText(error)}`);
  }
  return parked;
}

/**
 * Runs a move. The original is not changed until the switch-over, and the
 * copy is built at `<destination>.ade-moving`, a name nothing opens. Any
 * failure before the switch-over removes that partial copy (only if this move
 * created it) and leaves the project exactly as it was.
 */
export async function runProjectMove(args: {
  sourceRoot: string;
  destinationRoot: string;
  moveAgentHistory: boolean;
  /** Copy `node_modules` too, so nothing needs reinstalling. Off: they are left out and reinstalled. */
  copyDependencies?: boolean;
  /** The preflight's notes, kept on the record for the check agent. */
  notes?: ProjectMoveNote[];
  hooks: ProjectMoveHooks;
}): Promise<ProjectMoveRecord> {
  const sourceRoot = path.resolve(args.sourceRoot);
  const finalRoot = path.resolve(args.destinationRoot);
  const copyRoot = copyLocation(finalRoot);
  const destinationVolume = await readMoveVolume(finalRoot);
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
    destinationInternal: destinationVolume?.internal ?? false,
    startedAt: Date.now(),
    finishedAt: null,
    state: "running",
    cleanup: { choice: "pending" },
    copiedDependencies: args.copyDependencies === true,
    notes: args.notes ?? [],
    followUps: [],
    problems: [],
    pid: process.pid,
    bootMinute: currentBootMinute(),
    resume: { sourceSpellings: rootSpellings(sourceRoot), knownPaths: [sourceRoot], moveAgentHistory: args.moveAgentHistory, outsideLanes: [] },
  };
  writeMoveRecord(record);
  markMoveActive(record.moveId, true);
  try {
    return await executeMove(record, sourceRoot, finalRoot, copyRoot, leftoverIsOurs, destinationVolume?.fileSystem ?? null, args.hooks);
  } finally {
    markMoveActive(record.moveId, false);
  }
}

async function executeMove(
  record: ProjectMoveRecord,
  sourceRoot: string,
  finalRoot: string,
  copyRoot: string,
  leftoverIsOurs: boolean,
  destinationFileSystem: string | null,
  hooks: ProjectMoveHooks,
): Promise<ProjectMoveRecord> {
  const run: MoveRun = {
    record,
    sourceRoot,
    finalRoot,
    copyRoot,
    destinationFileSystem,
    oldSpellings: rootSpellings(sourceRoot),
    hooks,
    step: "prepare",
    progress: (message, extra = {}) => hooks.onProgress({ moveId: record.moveId, step: run.step, message, ...extra }),
  };

  let parked: string;
  try {
    const links = await prepare(run);
    const copied = await copy(run, links, leftoverIsOurs);
    const insideLanes = await rewrite(run);
    await verify(run, { ...copied, insideLanes, links });
    parked = await switchOver(run);
  } catch (error) {
    if (record.copyCreated) {
      try {
        fs.rmSync(copyRoot, { recursive: true, force: true });
      } catch (cleanupError) {
        record.problems.push(`ADE couldn't remove the partial copy at ${copyRoot} (${errorText(cleanupError)}). You can delete it.`);
      }
    }
    record.state = "failed";
    record.failedStep = run.step;
    record.error = errorText(error);
    record.finishedAt = Date.now();
    writeMoveRecord(record);
    return record;
  }
  // The project now lives at the new location: whatever follows can only add
  // problems to report, never turn the move back into a failure.
  finishSwitch(record);
  record.state = "done";
  record.finishedAt = Date.now();
  try {
    writeMoveRecord(record);
  } catch (error) {
    record.problems.push(`ADE couldn't save the move's record: ${errorText(error)}`);
  }
  record.originalBytes = await diskUsageBytes(parked);
  recordOriginalBytes(record.moveId, record.originalBytes);
  return record;
}

/**
 * Everything after the copy is in place: link outside lanes, mark the parked
 * original, re-key the registry, and point simulators and agent history at the
 * new location. Each part runs on its own and can run again, so one failing
 * part is reported without undoing the others, and a restart finishes a
 * switch-over that was interrupted.
 */
function finishSwitch(record: ProjectMoveRecord): void {
  const resume = record.resume;
  const parked = record.originalParkedAt;
  if (!resume || !parked) return;
  const finalRoot = record.destinationRoot;
  const attempt = (what: string, work: () => void) => {
    try {
      work();
    } catch (error) {
      record.problems.push(`${what}: ${errorText(error)}`);
    }
  };
  attempt("ADE couldn't mark the old copy so it isn't opened by mistake", () =>
    writeMovedMarker(parked, { movedTo: finalRoot, moveId: record.moveId }));
  for (const lane of resume.outsideLanes) {
    attempt(`The lane at ${lane.lanePath} couldn't be linked to the moved project`, () => {
      if (fs.existsSync(lane.lanePath)) pointOutsideLaneAt({ ...lane, relativePath: null, exists: true }, finalRoot);
    });
  }
  attempt("ADE couldn't update its project list", () => new ProjectRegistry().relocate(resume.sourceSpellings, finalRoot));
  attempt("ADE couldn't update the lane simulators", () => {
    const simulators = rewriteSimulatorMarkers(resume.sourceSpellings, finalRoot);
    if (simulators) record.followUps.push(`${plural(simulators, "lane simulator")} now point at the new location.`);
  });
  attempt("ADE couldn't move the chat history", () => {
    const plans = planAgentHistoryRenames({
      oldSpellings: resume.sourceSpellings,
      newRoot: finalRoot,
      knownPaths: resume.knownPaths,
    }).filter((plan) => plan.adeOwned || resume.moveAgentHistory);
    const history = applyAgentHistoryRenames(plans);
    if (history.moved) record.followUps.push(`Moved ${plural(history.moved, "chat history folder")} to the new location.`);
    record.problems.push(...history.problems);
  });
  attempt("ADE couldn't carry Codex's folder trust over", () => {
    if (carryCodexTrust({ oldSpellings: resume.sourceSpellings, newRoot: finalRoot })) {
      record.followUps.push("Codex trusts the new location, as it did the old one.");
    }
  });
  attempt("ADE couldn't carry Claude's folder settings over", () => {
    if (carryClaudeProjectSettings({ oldSpellings: resume.sourceSpellings, newRoot: finalRoot })) {
      record.followUps.push("Claude trusts the new location and keeps its allowed tools and MCP approvals.");
    }
  });
  attempt("ADE couldn't carry Copilot's folder trust over", () => {
    if (carryCopilotTrust({ oldSpellings: resume.sourceSpellings, newRoot: finalRoot })) {
      record.followUps.push("Copilot trusts the new location, as it did the old one.");
    }
  });
}

/**
 * Settles moves a crash or quit left "running". Once the copy was put in place
 * the move only ever finishes (when its drive is connected; otherwise it waits
 * for the next start). Before that, the original is put back if it was parked.
 * Returns the settled moves at once; `tidyUp` does the slow disk work (sizing
 * the kept original, removing a partial copy) afterwards, so ADE does not wait
 * on it to open. Called once when ADE starts, before it reopens the last project.
 */
export async function recoverInterruptedMoves(): Promise<{ settled: ProjectMoveRecord[]; tidyUp: Promise<void> }> {
  const settled: ProjectMoveRecord[] = [];
  const slowWork: Array<() => Promise<void>> = [];
  for (const record of listMoveRecords()) {
    if (record.state !== "running") continue;
    if (isMoveProcessAlive(record)) continue;
    record.problems ??= [];
    const copyRoot = copyLocation(record.destinationRoot);
    const placed = Boolean(record.switched)
      || (Boolean(record.originalParkedAt) && fs.existsSync(record.destinationRoot) && !fs.existsSync(copyRoot));
    try {
      if (placed) {
        // The drive is not connected yet: finish at a later start, never undo.
        if (!fs.existsSync(record.destinationRoot)) continue;
        record.switched = true;
        finishSwitch(record);
        record.state = "done";
        record.followUps.push("ADE stopped during the switch-over and finished it when it started again.");
        const parked = record.originalParkedAt;
        if (parked) slowWork.push(async () => recordOriginalBytes(record.moveId, await diskUsageBytes(parked)));
      } else {
        const parked = record.originalParkedAt ?? record.parkingAt;
        if (parked && !fs.existsSync(record.sourceRoot) && fs.existsSync(parked)) fs.renameSync(parked, record.sourceRoot);
        record.originalParkedAt = null;
        record.parkingAt = null;
        if (record.copyCreated && fs.existsSync(copyRoot)) {
          // Out of the way at once, so a new move into the same place never
          // meets it; the slow removal happens after ADE opens.
          const removing = `${copyRoot}.removing-${record.moveId}`;
          fs.renameSync(copyRoot, removing);
          slowWork.push(() => removeTreeOffProcess(removing));
        }
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
  // A removal an earlier start began and did not finish.
  for (const record of listMoveRecords()) {
    if (record.state !== "failed" || !record.copyCreated) continue;
    const removing = `${copyLocation(record.destinationRoot)}.removing-${record.moveId}`;
    if (fs.existsSync(removing)) slowWork.push(() => removeTreeOffProcess(removing));
  }
  const tidyUp = (async () => {
    for (const work of slowWork) await work();
  })();
  return { settled, tidyUp };
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
      throw new Error(`${checkout.label} in the copy still uses the original's git data.`);
    }
    const [original, copied] = await Promise.all([
      git(path.join(args.sourceRoot, checkout.relative), ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      git(inCopy, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    ]);
    const a = statusLines(original);
    const b = statusLines(copied);
    if (a.length !== b.length || a.some((line, i) => line !== b[i])) {
      throw new Error(`${checkout.label} looks different in the copy than in the original.`);
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
      throw new Error(`Git in the copy doesn't list the lane ${path.basename(lane.relativePath ?? "")}.`);
    }
  }
}

/**
 * Deletes the parked original once the person confirms. Only the exact path
 * the move recorded, only while it still carries this move's marker, and never
 * while a lane outside the project still keeps its git data in it.
 */
export async function deleteParkedOriginal(record: ProjectMoveRecord): Promise<void> {
  const parked = record.originalParkedAt;
  if (!parked) throw new Error("ADE has no record of where the original was kept.");
  try {
    await nonAsarFs.promises.lstat(parked);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Gone already (removed by hand, or by an earlier delete that ADE stopped
    // waiting for). Only when its parent is there: a missing parent is a
    // drive that isn't connected, not a deleted folder.
    if (fs.existsSync(path.dirname(parked))) return;
    throw new Error(`The drive that holds ${parked} isn't connected, so ADE can't delete it now.`);
  }
  if (readMovedMarker(parked)?.moveId !== record.moveId) {
    throw new Error(`The folder at ${parked} isn't the original ADE kept, so ADE won't delete it.`);
  }
  if (!fs.existsSync(record.destinationRoot)) {
    throw new Error("The moved project isn't at its new location right now, so ADE won't delete the original.");
  }
  const parkedSpellings = rootSpellings(parked);
  for (const lane of record.resume?.outsideLanes ?? []) {
    const gitDir = readGitDirPointer(lane.lanePath);
    if (gitDir && relativeToRoot(gitDir, parkedSpellings) !== null) {
      throw new Error(`The lane at ${lane.lanePath} still keeps its git data in the old copy, so ADE won't delete it yet.`);
    }
  }
  await removeKeepingMarkerLast(parked, record.destinationRoot, record.moveId);
}

/**
 * Removes `root` with the moved marker last, so a delete that stops partway
 * still carries the marker and can be retried. Unpatched `fs`: ADE runs in
 * Electron, whose `fs` reads a lane's `default_app.asar` as a folder, and a
 * recursive remove then reports success and leaves the archive behind.
 */
async function removeKeepingMarkerLast(root: string, movedTo: string, moveId: string): Promise<void> {
  const marker = movedMarkerPath(root);
  for (const directory of [root, path.dirname(marker)]) {
    const stat = await nonAsarFs.promises.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`ADE won't delete ${root} because ${directory} isn't a directory it can safely remove.`);
    }
  }
  const keep = new Set([root, path.dirname(marker), marker]);
  const removeAllBut = async (dir: string) => {
    for (const name of await nonAsarFs.promises.readdir(dir)) {
      const entry = path.join(dir, name);
      if (keep.has(entry)) continue;
      // A project's node_modules and build output: see removeTreeOffProcess.
      await removeTreeOffProcess(entry);
    }
  };
  await removeAllBut(root);
  if (fs.existsSync(path.dirname(marker))) await removeAllBut(path.dirname(marker));
  const restoreMarkerIfNeeded = async () => {
    let rootStat: Awaited<ReturnType<typeof nonAsarFs.promises.lstat>>;
    try {
      rootStat = await nonAsarFs.promises.lstat(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(`ADE won't restore the moved marker because ${root} isn't a directory it can safely write to.`);
    }
    const adeDir = path.dirname(marker);
    try {
      const adeStat = await nonAsarFs.promises.lstat(adeDir);
      if (!adeStat.isDirectory() || adeStat.isSymbolicLink()) {
        throw new Error(`ADE won't restore the moved marker because ${adeDir} isn't a directory it can safely write to.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await nonAsarFs.promises.mkdir(adeDir);
    }
    if (readMovedMarker(root)?.moveId !== moveId) writeMovedMarker(root, { movedTo, moveId });
  };
  try {
    await nonAsarFs.promises.rm(root, { recursive: true, force: false, maxRetries: 2 });
  } catch (error) {
    try {
      await restoreMarkerIfNeeded();
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        `ADE couldn't remove everything in ${root}, and couldn't restore the moved marker. Try again, or delete what's left in Finder.`,
      );
    }
    throw error;
  }
  if (fs.existsSync(root)) {
    await restoreMarkerIfNeeded();
    throw new Error(`ADE couldn't remove everything in ${root}. Try again, or delete what's left in Finder.`);
  }
}
