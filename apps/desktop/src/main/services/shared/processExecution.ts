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

/**
 * Quote a single argument for a Windows `cmd.exe /s /c "..."` command line.
 *
 * SAFETY: this function strips `%` (variable expansion) and `\r\n` (line
 * breaks) but does NOT escape other cmd metacharacters such as `|`, `&`,
 * `<`, `>`, `!`, `^`. Those characters are inert only because the resulting
 * string is embedded inside a correctly delimited `cmd.exe /s /c "…"` command
 * line, usually through {@link resolveWindowsCmdInvocation} or
 * {@link resolveWindowsCmdLineInvocation}. Do NOT reuse this helper as a
 * general-purpose escaping primitive.
 */
export function quoteWindowsCmdArg(value: string): string {
  let quoted = "\"";
  let backslashes = 0;
  for (const char of value.replace(/%/g, "%%").replace(/[\r\n]/g, " ")) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    if (char === "\"") {
      quoted += "\\".repeat(backslashes * 2);
      quoted += "\"\"";
    } else {
      quoted += "\\".repeat(backslashes);
      quoted += char;
    }
    backslashes = 0;
  }
  quoted += "\\".repeat(backslashes * 2);
  quoted += "\"";
  return quoted;
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
  const cmdLine = [command, ...args].map(quoteWindowsCmdArg).join(" ");
  return resolveWindowsCmdLineInvocation(cmdLine, env);
}

export function resolveWindowsCmdLineInvocation(
  cmdLine: string,
  env: NodeJS.ProcessEnv = process.env,
): SpawnInvocation {
  const comSpec = env.ComSpec?.trim() || "cmd.exe";
  return {
    command: comSpec,
    args: ["/d", "/s", "/c", `"${cmdLine}"`],
    windowsVerbatimArguments: true,
  };
}

export function isWindowsPowerShellScript(command: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && path.win32.extname(command).toLowerCase() === ".ps1";
}

/**
 * `.ps1` shims (npm writes one next to every `.cmd`) cannot be launched by
 * cmd.exe or by `spawn` directly — PowerShell has to interpret them. `-File`
 * keeps the remaining arguments literal rather than re-parsing them as script.
 */
export function resolveWindowsPowerShellInvocation(command: string, args: string[]): SpawnInvocation {
  return {
    command: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", command, ...args],
    windowsVerbatimArguments: false,
  };
}

export function resolveCliSpawnInvocation(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): SpawnInvocation {
  if (isWindowsPowerShellScript(command, platform)) {
    return resolveWindowsPowerShellInvocation(command, args);
  }
  if (shouldUseWindowsCmdWrapper(command, platform)) {
    return resolveWindowsCmdInvocation(command, args, env);
  }
  return {
    command,
    args,
    windowsVerbatimArguments: false,
  };
}

export function windowsTaskkillInvocation(pid: number, options: { force?: boolean } = {}): SpawnInvocation {
  return {
    command: "taskkill.exe",
    args: ["/PID", String(pid), "/T", ...(options.force ? ["/F"] : [])],
  };
}

export function killWindowsProcessTree(
  pid: number,
  onFailure?: (detail: ProcessTreeFailureDetail) => void,
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    const invocation = windowsTaskkillInvocation(pid, { force: true });
    const out = spawnSync(invocation.command, invocation.args, { windowsHide: true });
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
