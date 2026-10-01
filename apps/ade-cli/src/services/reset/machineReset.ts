import fs from "node:fs";
import path from "node:path";
import { resolveTrustedWindowsTool } from "../../lib/trustedWindowsTools";
import {
  laneHasWork,
  type MachineResetFailure,
  type MachineResetLane,
  type MachineResetOptions,
  type MachineResetReceipt,
} from "../../../../desktop/src/shared/types/machineReset";
import {
  adeHomeCandidates,
  BUNDLE_IDS,
  cursorHooksWithoutAde,
  desktopDataDirCandidates,
  exists,
  gitLines,
  inventory,
  inventoryLanes,
  inventoryMachinePaths,
  inventoryProcesses,
  isAdeProcessCommand,
  isInside,
  listDir,
  realPath,
  stripAdeShellLines,
  uniquePaths,
  type Inventory,
  type MachineResetDeps,
  type ProjectTarget,
  type ServiceTarget,
} from "./machineResetInventory";

export {
  defaultMachineResetDeps,
  findAdeAncestor,
  formatMachineResetPlan,
  isAdeProcessCommand,
  planMachineReset,
  stripAdeShellLines,
  type MachineResetDeps,
  type ProcessEntry,
  type RunResult,
} from "./machineResetInventory";

/**
 * The hard reset engine: removes everything ADE put on this computer.
 *
 * Planning and doing share one inventory ({@link inventory}), so the list the
 * person confirms is exactly the list that is removed. Nothing here talks to
 * a brain — the reset is for machines where the brain is the problem — and
 * every external effect goes through {@link MachineResetDeps}, the process
 * boundary.
 *
 * Safety rails, in order of importance:
 *  1. A project's own files are never removed. Inside a project the reset
 *     touches only `<root>/.ade`, the lane worktrees git lists under it, lane
 *     branches whose every commit also lives on another branch or a remote,
 *     and ADE's line in `.git/info/exclude`. Files a project committed under
 *     `.ade/` are restored from git after the wipe.
 *  2. Lane work is rescued (committed on its branch, or moved out with git)
 *     before anything is removed, unless the person chose `none`. A rescue
 *     that fails falls back to moving the lane folder out, never to deleting it.
 *  3. Every machine path is checked against {@link assertRemovable} first.
 */

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * The last check before anything is removed: the path is absolute, is not the
 * home folder or a parent of it, and lives under the home folder, the temp
 * folder, or a project's `.ade` folder.
 */
function assertRemovable(target: string, deps: MachineResetDeps, extraRoots: string[] = []): void {
  const resolved = path.resolve(target);
  if (!path.isAbsolute(target) || resolved === path.parse(resolved).root) {
    throw new Error(`Refusing to remove ${target}: not a safe path.`);
  }
  if (resolved === path.resolve(deps.homeDir) || isInside(path.resolve(deps.homeDir), resolved)) {
    throw new Error(`Refusing to remove ${target}: it contains the home folder.`);
  }
  const allowedRoots = [deps.homeDir, deps.tmpDir, ...extraRoots].map((root) => path.resolve(root));
  if (!allowedRoots.some((root) => isInside(resolved, root))) {
    throw new Error(`Refusing to remove ${target}: outside the folders a reset may touch.`);
  }
}

/**
 * Windows lets go of a file only when its last handle closes, and an
 * antivirus scan or a process that is still exiting can hold one for seconds.
 */
function rmRetries(deps: MachineResetDeps): { maxRetries: number; retryDelay: number } {
  return deps.platform === "win32" ? { maxRetries: 40, retryDelay: 250 } : { maxRetries: 3, retryDelay: 200 };
}

function makeWritable(target: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;
  try {
    fs.chmodSync(target, stat.isDirectory() ? 0o777 : 0o666);
  } catch {
    // best effort; the retry reports what is still in the way
  }
  if (stat.isDirectory()) {
    for (const name of listDir(target)) makeWritable(path.join(target, name));
  }
}

function removePath(
  target: string,
  deps: MachineResetDeps,
  receipt: { removed: string[]; failed: MachineResetFailure[] },
  extraRoots: string[] = [],
): void {
  try {
    assertRemovable(target, deps, extraRoots);
    if (!exists(target)) return;
    try {
      fs.rmSync(target, { recursive: true, force: true, ...rmRetries(deps) });
    } catch (error) {
      // Git marks its object files read-only, and Windows refuses to delete
      // a read-only file. Make the tree writable and try once more.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EACCES") throw error;
      makeWritable(target);
      fs.rmSync(target, { recursive: true, force: true, ...rmRetries(deps) });
    }
    receipt.removed.push(target);
    deps.log(`removed ${target}`);
  } catch (error) {
    receipt.failed.push({ target, error: error instanceof Error ? error.message : String(error) });
    deps.log(`failed to remove ${target}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function waitForExit(deps: MachineResetDeps, pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = deps.now().getTime() + timeoutMs;
  while (deps.now().getTime() < deadline) {
    if (!deps.pidAlive(pid)) return true;
    await deps.sleep(200);
  }
  return !deps.pidAlive(pid);
}

function stopServices(services: ServiceTarget[], deps: MachineResetDeps, receipt: MachineResetReceipt): void {
  for (const service of services) {
    if (service.kind === "launchd") {
      const domain = deps.uid != null ? `gui/${deps.uid}` : null;
      const bootout = domain ? deps.run("launchctl", ["bootout", `${domain}/${service.label}`]) : null;
      if ((!bootout || bootout.status !== 0) && service.plistPath) {
        deps.run("launchctl", ["unload", service.plistPath]);
      }
      if (service.plistPath) removePath(service.plistPath, deps, receipt);
      else receipt.removed.push(`launchd:${service.label}`);
    } else if (service.kind === "systemd") {
      deps.run("systemctl", ["--user", "disable", "--now", service.unit]);
      removePath(service.unitPath, deps, receipt);
    } else {
      // The Windows supervisor, scheduled task and Run key belong to the
      // service manager. It reads which channel to remove from the
      // environment, so each channel gets its own run with its own names.
      const suffix = service.channel === "stable" ? "" : `.${service.channel}`;
      const env: NodeJS.ProcessEnv = {
        ...deps.env,
        ADE_PACKAGE_CHANNEL: service.channel,
        ADE_RUNTIME_SERVICE_NAME: `com.ade.runtime${suffix}`,
        ADE_HOME: path.join(deps.homeDir, service.channel === "stable" ? ".ade" : `.ade-${service.channel}`),
      };
      // A packaged CLI is a script run by the app binary; a standalone one is
      // the binary itself.
      const script = deps.cliEntry.scriptPath;
      const args = script && /\.(c?js|mjs)$/i.test(script)
        ? [script, "serve", "--uninstall-service"]
        : ["serve", "--uninstall-service"];
      const result = deps.run(deps.cliEntry.execPath, args, { timeoutMs: 60_000, env });
      if (result.status === 0) receipt.removed.push(`windows-service:${service.channel}`);
    }
  }
  if (deps.platform === "linux" && services.length) deps.run("systemctl", ["--user", "daemon-reload"]);
}

async function stopProcesses(deps: MachineResetDeps, receipt: MachineResetReceipt): Promise<void> {
  // Re-read: the services just booted out took their children with them, and
  // a pid from the plan may already belong to something else.
  const targets = inventoryProcesses(deps);
  for (const entry of targets) {
    try {
      deps.kill(entry.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && targets.some((entry) => deps.pidAlive(entry.pid))) {
    await deps.sleep(200);
  }
  for (const entry of targets) {
    if (!deps.pidAlive(entry.pid)) continue;
    try {
      deps.kill(entry.pid, "SIGKILL");
    } catch {
      // gone between the check and the kill
    }
  }
  if (targets.length) receipt.notes.push(`Stopped ${targets.length} ADE process${targets.length === 1 ? "" : "es"}.`);
}


function uniqueDestination(base: string): string {
  let candidate = base;
  for (let index = 2; exists(candidate); index += 1) candidate = `${base}-${index}`;
  return candidate;
}

function commitLaneWork(deps: MachineResetDeps, rootPath: string, lane: MachineResetLane): { ok: true; branch: string } | { ok: false; error: string } {
  let branch = lane.branch;
  if (!branch) {
    // Detached HEAD: give the work a branch to live on first. Made from the
    // main repository at the HEAD git listed, so it works when the lane
    // folder is already gone — before `worktree prune` drops the only
    // record of that HEAD.
    if (!lane.head) return { ok: false, error: "the lane's HEAD is unknown" };
    let candidate = `ade-rescue/${lane.name}`;
    for (let index = 2; deps.run("git", ["-C", rootPath, "rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`]).status === 0; index += 1) {
      candidate = `ade-rescue/${lane.name}-${index}`;
    }
    const created = deps.run("git", ["-C", rootPath, "branch", candidate, lane.head]);
    if (created.status !== 0) return { ok: false, error: created.stderr.trim() || "could not create a rescue branch" };
    branch = candidate;
    // Same commit, so switching keeps any uncommitted changes in place.
    if (exists(lane.path)) {
      const switched = deps.run("git", ["-C", lane.path, "checkout", "-q", branch]);
      if (switched.status !== 0) return { ok: false, error: switched.stderr.trim() || "could not switch to the rescue branch" };
    }
  }
  // Unknown status is committed like known changes: `git add` and `commit`
  // are the real test, and "nothing to commit" is the answer that was missing.
  if (lane.uncommittedFiles > 0 || lane.workUnknown) {
    const added = deps.run("git", ["-C", lane.path, "add", "-A"]);
    if (added.status !== 0) return { ok: false, error: added.stderr.trim() || "git add failed" };
    const message = "ADE reset: saved lane work before removing the lane";
    let committed = deps.run("git", ["-C", lane.path, "commit", "--no-verify", "-m", message]);
    if (committed.status !== 0 && /identity|user\.email|user\.name/i.test(committed.stderr)) {
      committed = deps.run("git", [
        "-C", lane.path, "-c", "user.name=ADE reset", "-c", "user.email=reset@ade.invalid",
        "commit", "--no-verify", "-m", message,
      ]);
    }
    const nothingToCommit = /nothing to commit|nothing added to commit/i.test(`${committed.stdout}\n${committed.stderr}`);
    if (committed.status !== 0 && !nothingToCommit) return { ok: false, error: committed.stderr.trim() || "git commit failed" };
  }
  return { ok: true, branch };
}

function moveLane(
  deps: MachineResetDeps,
  project: ProjectTarget,
  lane: MachineResetLane,
  rescueRoot: string,
): { ok: true; location: string } | { ok: false; error: string } {
  const destination = uniqueDestination(path.join(rescueRoot, project.displayName, lane.name));
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  // Twice: a locked worktree is only moved with --force given twice.
  const moved = deps.run("git", ["-C", project.rootPath, "worktree", "move", "--force", "--force", lane.path, destination]);
  if (moved.status !== 0) return { ok: false, error: moved.stderr.trim() || "git worktree move failed" };
  return { ok: true, location: destination };
}

/** A branch whose every commit is also on another branch, a tag or a remote: deleting it loses nothing. */
function branchIsRedundant(deps: MachineResetDeps, rootPath: string, branch: string): boolean {
  // `--exclude` patterns for `--branches` are branch names, not full refs: a
  // `refs/heads/` prefix matches nothing, the branch stays in its own `--not`
  // set, and every branch reads as redundant.
  const unique = deps.run("git", [
    "-C", rootPath, "rev-list", "--count", `refs/heads/${branch}`,
    "--not", `--exclude=${branch}`, "--branches", "--remotes", "--tags",
  ]);
  return unique.status === 0 && unique.stdout.trim() === "0";
}

function scrubExcludeRule(rootPath: string): boolean {
  let gitDir = path.join(rootPath, ".git");
  try {
    if (fs.statSync(gitDir).isFile()) {
      const pointer = fs.readFileSync(gitDir, "utf8").match(/^gitdir:\s*(.+)\s*$/im)?.[1];
      if (!pointer) return false;
      gitDir = path.resolve(rootPath, pointer);
    }
  } catch {
    return false;
  }
  const excludePath = path.join(gitDir, "info", "exclude");
  let raw: string;
  try {
    raw = fs.readFileSync(excludePath, "utf8");
  } catch {
    return false;
  }
  const isAdeRule = (line: string) => /^\/?\.ade(\/(\*\*?)?)?$/.test(line.trim());
  const kept = raw.split(/\r?\n/).filter((line) => !isAdeRule(line));
  while (kept.length && kept[kept.length - 1]?.trim() === "") kept.pop();
  const next = kept.length ? `${kept.join("\n")}\n` : "";
  if (next === raw) return false;
  fs.writeFileSync(excludePath, next, "utf8");
  return true;
}

function resetProject(
  project: ProjectTarget,
  options: MachineResetOptions,
  deps: MachineResetDeps,
  receipt: MachineResetReceipt,
): void {
  if (!project.exists) return;
  const fallbackRescueRoot = path.join(deps.homeDir, "ADE Rescued Lanes");
  const keptBranches = new Set<string>();

  if (project.isGitRepo) {
    // Fresh numbers: the brain is stopped now, so nothing changes underneath.
    const lanes = inventoryLanes(deps, project.rootPath, project.adeDir);
    for (const lane of lanes) {
      let moved = false;
      // A failed move is only a failure if nothing else saves the work; the
      // commit fallback usually does, and then it is a note.
      let moveError: string | null = null;
      if (options.rescue !== "none" && laneHasWork(lane)) {
        if (options.rescue === "move" && options.rescueDir) {
          const result = moveLane(deps, project, lane, options.rescueDir);
          if (result.ok) {
            moved = true;
            if (lane.branch) keptBranches.add(lane.branch);
            receipt.rescued.push({ projectRoot: project.rootPath, lane: lane.name, mode: "move", branch: lane.branch, location: result.location });
          } else {
            moveError = result.error;
          }
        }
        if (!moved) {
          const committed = commitLaneWork(deps, project.rootPath, lane);
          if (committed.ok) {
            keptBranches.add(committed.branch);
            receipt.rescued.push({ projectRoot: project.rootPath, lane: lane.name, mode: "commit", branch: committed.branch, location: null });
            if (moveError) {
              receipt.notes.push(`Lane ${lane.name} could not be moved (${moveError}), so its work was committed on ${committed.branch} instead.`);
            }
          } else {
            // Never delete work a rescue could not save: park the folder.
            const parked = moveLane(deps, project, lane, fallbackRescueRoot);
            if (parked.ok) {
              moved = true;
              if (lane.branch) keptBranches.add(lane.branch);
              receipt.rescued.push({ projectRoot: project.rootPath, lane: lane.name, mode: "move", branch: lane.branch, location: parked.location });
            } else {
              receipt.failed.push({
                target: lane.path,
                error: `could not save this lane's work (${moveError ? `move: ${moveError}; ` : ""}commit: ${committed.error}); left in place`,
              });
              if (lane.branch) keptBranches.add(lane.branch);
              continue;
            }
          }
        }
      }
      if (moved) continue;
      const removed = deps.run("git", ["-C", project.rootPath, "worktree", "remove", "--force", "--force", lane.path]);
      if (removed.status === 0) receipt.removed.push(lane.path);
      if (lane.branch && !keptBranches.has(lane.branch)) {
        if (branchIsRedundant(deps, project.rootPath, lane.branch)) {
          const deleted = deps.run("git", ["-C", project.rootPath, "branch", "-D", lane.branch]);
          if (deleted.status === 0) receipt.removed.push(`${project.rootPath} branch ${lane.branch}`);
        } else {
          receipt.notes.push(`Kept branch ${lane.branch} in ${project.displayName}: it has commits that are nowhere else.`);
        }
      }
    }
  }

  // Files the project committed under `.ade/` belong to the repository.
  const tracked = project.isGitRepo
    ? (gitLines(deps, project.rootPath, ["ls-files", "--", ".ade"]) ?? [])
    : [];
  // A lane the reset could not save is still inside `.ade/worktrees`.
  const unsavedLaneLeft = receipt.failed.some((failure) => isInside(realPath(failure.target), realPath(project.adeDir)));
  if (unsavedLaneLeft) {
    for (const name of listDir(project.adeDir)) {
      if (name === "worktrees") continue;
      removePath(path.join(project.adeDir, name), deps, receipt, [project.rootPath]);
    }
  } else {
    removePath(project.adeDir, deps, receipt, [project.rootPath]);
  }
  if (project.isGitRepo) {
    deps.run("git", ["-C", project.rootPath, "worktree", "prune"]);
    if (tracked.length) {
      deps.run("git", ["-C", project.rootPath, "checkout", "HEAD", "--", ".ade"]);
      receipt.notes.push(`Restored ${tracked.length} file${tracked.length === 1 ? "" : "s"} ${project.displayName} commits under .ade/.`);
    }
    if (scrubExcludeRule(project.rootPath)) receipt.removed.push(`${project.rootPath} .git/info/exclude .ade rule`);
  }
}

function clearKeychain(services: string[], deps: MachineResetDeps, receipt: MachineResetReceipt): void {
  for (const service of services) {
    let deleted = 0;
    // One item per call; stop at the first "not found". Bounded so a keychain
    // that keeps answering cannot spin forever.
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const result = deps.run("security", ["delete-generic-password", "-s", service], { timeoutMs: 10_000 });
      if (result.status !== 0) break;
      deleted += 1;
    }
    if (deleted) receipt.removed.push(`keychain:${service} (${deleted})`);
  }
}

function clearAppleState(deps: MachineResetDeps, simulators: Inventory["simulators"], receipt: MachineResetReceipt): void {
  if (deps.platform !== "darwin") return;
  for (const simulator of simulators) {
    deps.run("xcrun", ["simctl", "shutdown", simulator.udid], { timeoutMs: 60_000 });
    const deleted = deps.run("xcrun", ["simctl", "delete", simulator.udid], { timeoutMs: 120_000 });
    if (deleted.status === 0) receipt.removed.push(`simulator:${simulator.udid}`);
    else receipt.failed.push({ target: `simulator:${simulator.udid}`, error: deleted.stderr.trim() || "simctl delete failed" });
  }
  for (const bundleId of BUNDLE_IDS) {
    // cfprefsd caches preferences; deleting the plist alone can be undone by
    // its next flush.
    deps.run("defaults", ["delete", bundleId]);
    // Privacy permissions (microphone, screen recording, accessibility…).
    deps.run("tccutil", ["reset", "All", bundleId]);
  }
}

/**
 * What a Windows install registers outside its folders: the user PATH entry
 * for `%LOCALAPPDATA%\\ADE\\bin` and the `ade://` link. The NSIS uninstaller
 * removes the same two; a reset has to as well, or a fresh install inherits
 * a PATH entry to a folder that is gone.
 */
function clearWindowsRegistrations(deps: MachineResetDeps, receipt: MachineResetReceipt): void {
  if (deps.platform !== "win32") return;
  const script = [
    "$p = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "if ($p) {",
    "  $kept = ($p -split ';' | Where-Object { $_ -and ($_ -notmatch '\\\\ADE\\\\bin\\\\?$') }) -join ';'",
    "  if ($kept -ne $p) { [Environment]::SetEnvironmentVariable('Path', $kept, 'User'); 'path' }",
    "}",
    "$k = 'HKCU:\\Software\\Classes\\ade'",
    "if (Test-Path $k) { $c = (Get-ItemProperty -Path ($k + '\\shell\\open\\command') -ErrorAction SilentlyContinue).'(default)'; if ($c -match 'ADE') { Remove-Item -Path $k -Recurse -Force; 'scheme' } }",
  ].join("\n");
  const result = deps.run(resolveTrustedWindowsTool("powershell"), ["-NoProfile", "-NonInteractive", "-Command", script], { timeoutMs: 30_000 });
  if (result.stdout.includes("path")) receipt.removed.push("Windows user PATH entry for ADE");
  if (result.stdout.includes("scheme")) receipt.removed.push("ade:// link");
}

function clearConfigEntries(found: Inventory, receipt: MachineResetReceipt): void {
  for (const file of found.shellRcFiles) {
    try {
      const next = stripAdeShellLines(fs.readFileSync(file, "utf8"));
      if (next !== null) {
        fs.writeFileSync(file, next, "utf8");
        receipt.removed.push(`${file} (ADE PATH lines)`);
      }
    } catch (error) {
      receipt.failed.push({ target: file, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (found.cursorHooksJson) {
    try {
      const next = cursorHooksWithoutAde(fs.readFileSync(found.cursorHooksJson, "utf8"));
      if (next !== null) {
        fs.writeFileSync(found.cursorHooksJson, next, "utf8");
        receipt.removed.push(`${found.cursorHooksJson} (ADE hooks)`);
      }
    } catch (error) {
      receipt.failed.push({ target: found.cursorHooksJson, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

export type MachineResetRunOptions = MachineResetOptions & {
  /** Wait for this process (the desktop app) to exit before starting. */
  waitPid?: number | null;
  /** Where to write the receipt; defaults to the channel's fresh ADE home. */
  receiptPath?: string;
};

/**
 * The desktop that handed the reset off did not quit. It is this process's
 * parent, so the process sweep protects it; it has to be stopped here, by
 * pid, and only when that pid still is ADE. A desktop that survives even
 * that would write into the folders being removed, so the reset stops before
 * it changes anything.
 */
async function stopStuckDesktop(pid: number, deps: MachineResetDeps, receipt: MachineResetReceipt): Promise<void> {
  const entry = deps.listProcesses().find((candidate) => candidate.pid === pid);
  if (!entry) {
    // Alive but not listed: the process list itself failed (`ps` or
    // PowerShell broke), so nothing here can say what the pid is. Changing
    // anything while an unknown process may still be ADE is the one unsafe
    // choice.
    if (deps.pidAlive(pid)) {
      throw new Error(`ADE (process ${pid}) may still be running and the process list could not be read, so the reset stopped before changing anything. Quit ADE, then run the reset again.`);
    }
    return;
  }
  if (!isAdeProcessCommand(entry.command)) {
    receipt.notes.push(`Process ${pid} is no longer ADE; it was left alone.`);
    return;
  }
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      deps.kill(pid, signal);
    } catch {
      // gone between the check and the signal
    }
    if (await waitForExit(deps, pid, 5_000)) {
      receipt.notes.push(`ADE did not quit by itself, so the reset stopped it (${signal}).`);
      return;
    }
  }
  throw new Error(`ADE (process ${pid}) would not quit, so the reset stopped before changing anything. Quit ADE, then run the reset again.`);
}

export async function executeMachineReset(
  options: MachineResetRunOptions,
  deps: MachineResetDeps,
): Promise<MachineResetReceipt> {
  const receipt: MachineResetReceipt = {
    version: 1,
    startedAt: deps.now().toISOString(),
    finishedAt: "",
    ok: false,
    removed: [],
    rescued: [],
    failed: [],
    notes: [],
  };
  if (options.rescue === "move" && !options.rescueDir) {
    throw new Error("Moving lanes out needs a destination folder.");
  }
  if (options.waitPid && options.waitPid !== deps.selfPid) {
    deps.log(`waiting for process ${options.waitPid} to exit`);
    if (!await waitForExit(deps, options.waitPid, 30_000)) {
      await stopStuckDesktop(options.waitPid, deps, receipt);
    }
  }

  const found = inventory(deps);
  if (options.rescue === "move" && options.rescueDir) {
    // Rescued lanes must not land somewhere the reset is about to remove.
    const rescueDir = realPath(options.rescueDir);
    const doomed = [
      ...found.machinePaths,
      ...found.projects.map((project) => project.adeDir),
    ].map(realPath);
    const clash = doomed.find((target) => rescueDir === target || isInside(rescueDir, target));
    if (clash) {
      throw new Error(`The rescue folder ${options.rescueDir} is inside ${clash}, which the reset removes. Pick another folder.`);
    }
  }
  deps.log(`plan: ${found.services.length} services, ${found.processes.length} processes, ${found.projects.length} projects, ${found.machinePaths.length} machine paths`);

  // 1. Nothing may restart or write while the rest runs.
  stopServices(found.services, deps, receipt);
  await stopProcesses(deps, receipt);

  // 2. Projects: rescue lane work, then remove ADE's data inside each.
  for (const project of found.projects) {
    try {
      resetProject(project, options, deps, receipt);
    } catch (error) {
      receipt.failed.push({ target: project.rootPath, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // 3. The machine.
  clearAppleState(deps, found.simulators, receipt);
  clearKeychain(found.keychainServices, deps, receipt);
  clearConfigEntries(found, receipt);
  clearWindowsRegistrations(deps, receipt);
  // Inventory again for paths: a process stopped above may have flushed one
  // more file (a log, a state file) on its way out.
  const machinePaths = uniquePaths([
    ...found.machinePaths,
    ...inventoryMachinePaths(
      deps,
      adeHomeCandidates(deps),
      desktopDataDirCandidates(deps),
      found.projects.map((project) => project.rootPath),
    ),
  ]);
  for (const target of machinePaths) removePath(target, deps, receipt);

  receipt.notes.push(...found.notes);
  receipt.finishedAt = deps.now().toISOString();
  receipt.ok = receipt.failed.length === 0;

  const receiptPath = options.receiptPath ?? path.join(deps.env.ADE_HOME?.trim() || path.join(deps.homeDir, ".ade"), "reset-receipt.json");
  try {
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  } catch (error) {
    deps.log(`could not write the receipt: ${error instanceof Error ? error.message : String(error)}`);
  }
  return receipt;
}


export function formatMachineResetReceipt(receipt: MachineResetReceipt): string {
  const lines = [receipt.ok ? "ADE reset finished." : "ADE reset finished with problems.", ""];
  lines.push(`Removed ${receipt.removed.length} items.`);
  for (const rescued of receipt.rescued) {
    lines.push(`Saved lane ${rescued.lane}: ${rescued.mode === "move" ? `moved to ${rescued.location}` : `committed on branch ${rescued.branch}`}`);
  }
  for (const failure of receipt.failed) lines.push(`Could not remove ${failure.target}: ${failure.error}`);
  for (const note of receipt.notes) lines.push(note);
  return `${lines.join("\n")}\n`;
}
