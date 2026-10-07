import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The "Updating ADE" window on Windows, and the guard that keeps a hand-launched
 * ADE from starting in the middle of an install.
 *
 * A Windows update is a silent NSIS install, so ADE vanishes for the whole of
 * it. People reopened ADE, the installer force-killed every ADE.exe under the
 * install folder, and that read as "ADE crashes on launch". The window
 * (`scripts/windows-update-progress.ps1`) runs from %TEMP% under powershell.exe:
 * the installer renames the install folder away and kills every process whose
 * image lives inside it, so neither the script nor its host may live there.
 */

const HEARTBEAT_FRESH_MS = 5_000;
/** Plenty for one update's lifecycle lines; a corrupt or runaway log is cut. */
const MAX_REPORT_LINES = 40;

type Heartbeat = {
  pid?: unknown;
  targetVersion?: unknown;
  phase?: unknown;
  updatedAt?: unknown;
};

export function windowsInstallProgressDir(channel: string | null): string {
  return path.join(os.tmpdir(), `ade-update-${channel ?? "stable"}`);
}

function heartbeatPath(dir: string): string {
  return path.join(dir, "progress.json");
}

function progressLogPath(dir: string): string {
  return path.join(dir, "progress.log");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * True when an install is running for a version other than this one: this ADE
 * is the old copy, opened by hand mid-install, and would be killed by the
 * installer seconds into starting. It asks the update window to come forward
 * instead. The ADE the installer opens is the target version, so it never
 * defers; nor does any launch after the window reported a failure or stopped
 * beating.
 */
export function deferToRunningWindowsInstall(args: {
  channel: string | null;
  appVersion: string;
  nowMs?: number;
}): boolean {
  const dir = windowsInstallProgressDir(args.channel);
  let heartbeat: Heartbeat;
  try {
    heartbeat = JSON.parse(fs.readFileSync(heartbeatPath(dir), "utf8")) as Heartbeat;
  } catch {
    return false;
  }
  const pid = typeof heartbeat.pid === "number" ? heartbeat.pid : Number.NaN;
  const updatedAtMs = typeof heartbeat.updatedAt === "string" ? Date.parse(heartbeat.updatedAt) : Number.NaN;
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(updatedAtMs)) return false;
  if (heartbeat.phase === "failed") return false;
  if (heartbeat.targetVersion === args.appVersion) return false;
  if ((args.nowMs ?? Date.now()) - updatedAtMs > HEARTBEAT_FRESH_MS) return false;
  if (!processAlive(pid)) return false;
  try {
    fs.writeFileSync(`${heartbeatPath(dir)}.focus`, String(process.pid));
  } catch {
    // The window is still up and still says what is happening.
  }
  return true;
}

/**
 * Starts the update window just before the installer takes over. ADE does not
 * wait for it: waiting held the old window on screen, blank, for seconds, and
 * the window owns its own lifecycle anyway. Whether it showed, and what it saw,
 * reaches the update log on the next launch through
 * `takeWindowsInstallProgressReport`. Returns null when it could not be
 * started; the install goes ahead either way.
 */
export function startWindowsInstallProgress(args: {
  channel: string | null;
  productName: string;
  currentVersion: string;
  targetVersion: string;
  appExe: string;
  installerPath: string | null;
  resourcesPath: string;
  adeHome: string;
  log: (event: string, data?: Record<string, unknown>) => void;
}): { cancel: () => void } | null {
  const sourceScript = path.join(args.resourcesPath, "ade-cli", "windows-update-progress.ps1");
  const dir = windowsInstallProgressDir(args.channel);
  const script = path.join(dir, "windows-update-progress.ps1");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(sourceScript, script);
  } catch (error) {
    args.log("autoUpdate.install_progress_unavailable", {
      reason: "script_copy_failed",
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  const config = {
    targetVersion: args.targetVersion,
    currentVersion: args.currentVersion,
    productName: args.productName,
    appExe: args.appExe,
    heartbeatPath: heartbeatPath(dir),
    stepsLogPath: path.join(args.adeHome, "runtime", "install-steps.log"),
    parentPid: process.pid,
    logPath: progressLogPath(dir),
    installerPath: args.installerPath ?? "",
  };
  try {
    fs.writeFileSync(path.join(dir, "progress-args.json"), JSON.stringify(config));
    fs.rmSync(heartbeatPath(dir), { force: true });
    fs.rmSync(`${heartbeatPath(dir)}.cancel`, { force: true });
    fs.rmSync(progressLogPath(dir), { force: true });
  } catch (error) {
    args.log("autoUpdate.install_progress_unavailable", {
      reason: "config_write_failed",
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const cmd = path.join(systemRoot, "System32", "cmd.exe");
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // Through `cmd /c start`, the one launch measured to work: from Electron, a
  // powershell.exe spawned `detached` exits within half a second without
  // running anything (with or without windowsHide, -WindowStyle Hidden, or a
  // headless conhost), and one spawned attached dies with ADE, because libuv
  // puts attached children in a kill-on-close job. `start` gives PowerShell its
  // own console outside that job. The paths ride in the environment and expand
  // with `!` (delayed expansion), after cmd has parsed the line, so a user path
  // holding `&` or `%` stays data; the script reads everything else from
  // progress-args.json beside it.
  const commandLine = '/d /v:on /s /c "start "" /min "!ADE_UPDATE_PS!" -NoProfile -NonInteractive -STA'
    + ' -WindowStyle Hidden -ExecutionPolicy Bypass -File "!ADE_UPDATE_SCRIPT!""';
  try {
    const child = spawn(cmd, [commandLine], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      windowsVerbatimArguments: true,
      env: { ...process.env, ADE_UPDATE_PS: powershell, ADE_UPDATE_SCRIPT: script },
    });
    child.on("error", (error) => {
      args.log("autoUpdate.install_progress_unavailable", { reason: "spawn_failed", message: error.message });
    });
    child.unref();
  } catch (error) {
    args.log("autoUpdate.install_progress_unavailable", {
      reason: "spawn_failed",
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  args.log("autoUpdate.install_progress_started", { targetVersion: args.targetVersion });
  // The window watches for this file and closes itself: ADE is staying open
  // because the install unwound. It also gives up on its own if ADE never
  // quits, so a cancel that cannot be written still ends it.
  const cancel = () => {
    try {
      fs.writeFileSync(`${heartbeatPath(dir)}.cancel`, String(process.pid));
    } catch {
      // See above.
    }
  };
  return { cancel };
}

/**
 * The update window's own log from the last install, read once and removed. The
 * window runs while ADE is gone, so this is the only way its account (shown or
 * not, which steps it saw, how it ended) reaches ADE's update log.
 */
export function takeWindowsInstallProgressReport(channel: string | null): string[] | null {
  const file = progressLogPath(windowsInstallProgressDir(channel));
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Read once is enough; a leftover is replaced by the next install.
  }
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.slice(-MAX_REPORT_LINES);
}
