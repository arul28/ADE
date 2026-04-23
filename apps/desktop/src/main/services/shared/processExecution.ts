import { spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";

export type SpawnInvocation = {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
};

export type ProcessTreeFailureDetail = {
  pid: number;
  status: number | null;
  stdout: string;
  stderr: string;
  error: unknown;
};

export function processOutputToString(value: Buffer | string | null | undefined): string {
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");
}

export function quoteWindowsCmdArg(value: string): string {
  return `"${value.replace(/"/g, "\"\"").replace(/%/g, "%%")}"`;
}

export function shouldUseWindowsCmdWrapper(command: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32") return false;
  const ext = path.win32.extname(command).toLowerCase();
  return ext === "" || ext === ".cmd" || ext === ".bat";
}

export function resolveWindowsCmdInvocation(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): SpawnInvocation {
  const comSpec = env.ComSpec?.trim() || "cmd.exe";
  const cmdLine = [command, ...args].map(quoteWindowsCmdArg).join(" ");
  return {
    command: comSpec,
    args: ["/d", "/s", "/c", cmdLine],
    windowsVerbatimArguments: true,
  };
}

export function resolveCliSpawnInvocation(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): SpawnInvocation {
  if (shouldUseWindowsCmdWrapper(command, platform)) {
    return resolveWindowsCmdInvocation(command, args, env);
  }
  return {
    command,
    args,
    windowsVerbatimArguments: false,
  };
}

export function killWindowsProcessTree(
  pid: number,
  onFailure?: (detail: ProcessTreeFailureDetail) => void,
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    const out = spawnSync("taskkill.exe", ["/T", "/F", "/PID", String(pid)], { windowsHide: true });
    if (!out.error && out.status === 0) return true;
    onFailure?.({
      pid,
      status: out.status,
      stdout: processOutputToString(out.stdout),
      stderr: processOutputToString(out.stderr),
      error: out.error ?? null,
    });
  } catch (error) {
    onFailure?.({
      pid,
      status: null,
      stdout: "",
      stderr: "",
      error,
    });
  }
  return false;
}

export function terminateProcessTree(
  child: Pick<ChildProcess, "kill" | "pid" | "exitCode" | "signalCode">,
  signal: NodeJS.Signals = "SIGTERM",
  onWindowsTaskkillFailure?: (detail: ProcessTreeFailureDetail) => void,
): boolean {
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    if (typeof child.pid === "number" && killWindowsProcessTree(child.pid, onWindowsTaskkillFailure)) {
      return true;
    }
  }
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}
