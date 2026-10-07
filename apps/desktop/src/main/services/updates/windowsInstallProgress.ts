import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveTrustedWindowsTool } from "../../../../../ade-cli/src/lib/trustedWindowsTools";

/**
 * The "Updating ADE" window on Windows, and the guard that keeps a hand-launched
 * ADE from starting in the middle of an install.
 *
 * A Windows update is a silent NSIS install, so ADE vanishes for the whole of
 * it. People reopened ADE, the installer force-killed every ADE.exe under the
 * install folder, and that read as "ADE crashes on launch". The window
 * (`scripts/windows-update-progress.ps1`) runs from %LOCALAPPDATA%\ADE under
 * powershell.exe: the installer renames the install folder away and kills every
 * process whose image lives inside it, so neither the script nor its host may
 * live there. Not %TEMP%: some machines point TEMP at a folder other users can
 * write, and these files decide what runs and whether ADE starts.
 */

const HEARTBEAT_FRESH_MS = 5_000;
/** A heartbeat this far in the future is a clock change, not a live window. */
const HEARTBEAT_FUTURE_SLACK_MS = 5_000;
/** Plenty for one update's lifecycle lines; a corrupt or runaway log is cut. */
const MAX_REPORT_LINES = 40;

type Heartbeat = {
  pid?: unknown;
  targetVersion?: unknown;
  phase?: unknown;
  updatedAt?: unknown;
};

/**
 * Every file the window and ADE share, in one per-channel folder. The script
 * finds its settings beside itself (`progress-args.json`) and writes the
 * heartbeat and log at the paths given there; `.focus` and `.cancel` sit next
 * to the heartbeat.
 */
function progressFiles(channel: string | null) {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const dir = path.join(localAppData, "ADE", `update-progress-${channel ?? "stable"}`);
  const heartbeat = path.join(dir, "progress.json");
  return {
    dir,
    script: path.join(dir, "windows-update-progress.ps1"),
    args: path.join(dir, "progress-args.json"),
    heartbeat,
    focus: `${heartbeat}.focus`,
    cancel: `${heartbeat}.cancel`,
    log: path.join(dir, "progress.log"),
  };
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
}): boolean {
  const files = progressFiles(args.channel);
  let heartbeat: Heartbeat;
  try {
    heartbeat = JSON.parse(fs.readFileSync(files.heartbeat, "utf8")) as Heartbeat;
  } catch {
    return false;
  }
  const pid = typeof heartbeat.pid === "number" ? heartbeat.pid : Number.NaN;
  const updatedAtMs = typeof heartbeat.updatedAt === "string" ? Date.parse(heartbeat.updatedAt) : Number.NaN;
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(updatedAtMs)) return false;
  if (heartbeat.phase === "failed") return false;
  if (heartbeat.targetVersion === args.appVersion) return false;
  const ageMs = Date.now() - updatedAtMs;
  if (ageMs > HEARTBEAT_FRESH_MS || ageMs < -HEARTBEAT_FUTURE_SLACK_MS) return false;
  if (!processAlive(pid)) return false;
  try {
    fs.writeFileSync(files.focus, String(process.pid));
  } catch {
    // The window is still up and still says what is happening.
  }
  return true;
}

/**
 * Starts the update window just before the installer takes over and returns a
 * cancel for an install that unwinds, or null when it could not be started; the
 * install goes ahead either way. ADE does not wait for the window: waiting held
 * the old window on screen, blank, for seconds, and the window owns its own
 * lifecycle anyway. Whether it showed, and what it saw, reaches the update log
 * on the next launch through `takeWindowsInstallProgressReport`.
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
}): (() => void) | null {
  const files = progressFiles(args.channel);
  // Names this attempt in the cancel file, so a window from another attempt
  // never acts on a cancel that is not its own.
  const runId = randomUUID();
  const unavailable = (reason: string, error: unknown) => {
    args.log("autoUpdate.install_progress_unavailable", {
      reason,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  };
  try {
    fs.mkdirSync(files.dir, { recursive: true });
    fs.copyFileSync(path.join(args.resourcesPath, "ade-cli", "windows-update-progress.ps1"), files.script);
    fs.writeFileSync(files.args, JSON.stringify({
      runId,
      targetVersion: args.targetVersion,
      currentVersion: args.currentVersion,
      productName: args.productName,
      appExe: args.appExe,
      heartbeatPath: files.heartbeat,
      stepsLogPath: path.join(args.adeHome, "runtime", "install-steps.log"),
      parentPid: process.pid,
      logPath: files.log,
      installerPath: args.installerPath ?? "",
    }));
    for (const stale of [files.heartbeat, files.focus, files.cancel, files.log]) fs.rmSync(stale, { force: true });
  } catch (error) {
    return unavailable("prepare_failed", error);
  }
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
    const child = spawn(resolveTrustedWindowsTool("cmd"), [commandLine], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      windowsVerbatimArguments: true,
      env: {
        ...process.env,
        ADE_UPDATE_PS: resolveTrustedWindowsTool("powershell"),
        ADE_UPDATE_SCRIPT: files.script,
      },
    });
    child.on("error", (error) => unavailable("spawn_failed", error));
    child.unref();
  } catch (error) {
    return unavailable("spawn_failed", error);
  }
  args.log("autoUpdate.install_progress_started", { targetVersion: args.targetVersion });
  // The window watches for this file and closes itself: ADE is staying open
  // because the install unwound. It also gives up on its own if ADE never
  // quits, so a cancel that cannot be written still ends it.
  return () => {
    try {
      fs.writeFileSync(files.cancel, runId);
    } catch {
      // See above.
    }
  };
}

/**
 * The update window's own log from the last install, read once and removed. The
 * window runs while ADE is gone, so this is the only way its account (shown or
 * not, which steps it saw, how it ended) reaches ADE's update log.
 */
export function takeWindowsInstallProgressReport(channel: string | null): string[] | null {
  const file = progressFiles(channel).log;
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
