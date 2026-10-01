import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import type {
  MachineResetOptions,
  MachineResetPlan,
  MachineResetReceipt,
} from "../../../shared/types/machineReset";
import {
  buildLocalRuntimeNodeEnv,
  resolveCliScriptPath,
} from "../localRuntime/localRuntimeConnectionPool";

/**
 * The desktop's half of the hard reset. The work itself is the CLI's
 * (`ade reset --all`): this process cannot remove its own data folder while it
 * runs, so it asks the engine for the plan, then starts the engine detached,
 * tells it to wait for this process to exit, and quits.
 */

const PLAN_TIMEOUT_MS = 120_000;

function resetEnv(appVersion: string): NodeJS.ProcessEnv {
  return {
    ...buildLocalRuntimeNodeEnv(appVersion),
    ADE_DESKTOP_USER_DATA_PATH: app.getPath("userData"),
  };
}

/** `/Applications/ADE.app` for a packaged macOS build, the executable elsewhere; null in development. */
function relaunchTarget(): string | null {
  if (!app.isPackaged) return null;
  if (process.platform === "darwin") {
    const bundle = path.resolve(process.execPath, "..", "..", "..");
    return bundle.endsWith(".app") ? bundle : null;
  }
  // An AppImage runs from a mount that disappears when the app quits; the
  // file to reopen is the AppImage itself.
  if (process.platform === "linux" && process.env.APPIMAGE?.trim()) return process.env.APPIMAGE.trim();
  return process.execPath;
}

/**
 * Outside every folder the reset removes, so the log survives it: support
 * needs it most when a reset went wrong.
 */
function resetLogPath(now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const dir = process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Logs", "ADE Reset")
    : path.join(os.tmpdir(), "ADE Reset");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `reset-${stamp}.log`);
}

/** The rescue folder sits inside something the reset removes. */
function rescueDirIsRemovedByReset(rescueDir: string): boolean {
  const target = path.resolve(rescueDir);
  if (target.split(path.sep).some((segment) => /^\.ade(-beta|-alpha)?$/i.test(segment))) return true;
  const inside = (root: string) => {
    const relative = path.relative(path.resolve(root), target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  return [app.getPath("userData"), os.tmpdir()].some(inside);
}

export async function planMachineResetFromDesktop(appVersion: string): Promise<MachineResetPlan> {
  const cliPath = resolveCliScriptPath();
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "reset", "--all", "--dry-run", "--json"], {
      env: resetEnv(appVersion),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
      reject(new Error("ADE took too long to list what a reset would remove."));
    }, PLAN_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { err += chunk.toString("utf8"); });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim().split("\n").pop() || `The reset plan failed (exit ${code}).`));
    });
  });
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The reset plan came back empty.");
  return JSON.parse(stdout.slice(start, end + 1)) as MachineResetPlan;
}

/**
 * Starts the engine detached and returns once it is running. The caller quits
 * the app right after: the engine waits for this pid to exit before it
 * removes anything.
 */
export function startMachineResetFromDesktop(
  options: MachineResetOptions,
  appVersion: string,
): { started: boolean; error?: string; logPath?: string } {
  if (options.rescue === "move" && !options.rescueDir) {
    return { started: false, error: "Choose a folder to move the lanes to." };
  }
  if (options.rescue === "move" && options.rescueDir && rescueDirIsRemovedByReset(options.rescueDir)) {
    // Checked here as well as in the engine: the engine runs after this app
    // has quit, where its refusal reaches nobody.
    return { started: false, error: "That folder is one the reset removes. Choose a folder outside ADE's folders, for example in Documents." };
  }
  const args = [
    resolveCliScriptPath(),
    "reset",
    "--all",
    "--yes",
    "--text",
    "--rescue",
    options.rescue,
    ...(options.rescue === "move" && options.rescueDir ? ["--rescue-dir", options.rescueDir] : []),
    "--wait-pid",
    String(process.pid),
  ];
  const relaunch = relaunchTarget();
  if (relaunch) args.push("--relaunch", relaunch);
  let logPath: string;
  let logFd: number;
  try {
    logPath = resetLogPath(new Date());
    logFd = fs.openSync(logPath, "a");
  } catch (error) {
    return { started: false, error: error instanceof Error ? error.message : String(error) };
  }
  try {
    const child = spawn(process.execPath, args, {
      env: resetEnv(appVersion),
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    });
    child.unref();
    return { started: true, logPath };
  } catch (error) {
    return { started: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    try { fs.closeSync(logFd); } catch { /* the child holds its own copy */ }
  }
}

/**
 * What the last reset did, read once on the first launch after it and then
 * removed, so the app can say where rescued lanes went.
 */
export function takeMachineResetReceipt(adeHome: string): MachineResetReceipt | null {
  const receiptPath = path.join(adeHome, "reset-receipt.json");
  let receipt: MachineResetReceipt | null = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as MachineResetReceipt;
    if (parsed && parsed.version === 1) receipt = parsed;
  } catch {
    return null;
  }
  try {
    fs.rmSync(receiptPath, { force: true });
  } catch {
    // shown once more next launch; harmless
  }
  return receipt;
}
