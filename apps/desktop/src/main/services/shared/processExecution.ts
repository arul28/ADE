import { spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { resolveTrustedWindowsTool } from "../../../../../ade-cli/src/lib/trustedWindowsTools";

/**
 * Resolve `taskkill` through the kernel's SystemRoot alias rather than `PATH`.
 *
 * A bare `"taskkill.exe"` is PATH-relative, so any writable directory earlier on
 * PATH than System32 gets to supply the binary the Electron main process runs
 * to kill process trees. `windows-quirks.md` names `trustedWindowsTools` as the
 * answer for exactly this.
 *
 * Falls back to the PATH spelling if resolution throws, deliberately: refusing
 * to kill leaks whole process trees, which is the worse of the two failures.
 * Non-win32 keeps the plain name so cross-platform tests stay deterministic.
 */
export function windowsTaskkillCommand(): string {
  if (process.platform !== "win32") return "taskkill.exe";
  try {
    return resolveTrustedWindowsTool("taskkill");
  } catch {
    return "taskkill.exe";
  }
}

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
 * SAFETY: this function neutralizes `\r\n` (line breaks) but does NOT escape
 * cmd metacharacters such as `|`, `&`, `<`, `>`, `!`, `^`. Those characters are
 * inert only because the resulting string is embedded inside a correctly
 * delimited `cmd.exe /s /c "…"` command line, usually through
 * {@link resolveWindowsCmdInvocation} or {@link resolveWindowsCmdLineInvocation}.
 * Do NOT reuse this helper as a general-purpose escaping primitive.
 *
 * `%` IS NOT ESCAPED, AND CANNOT BE. Doubling to `%%` is a batch-file rule; on a
 * command line `%%` survives literally, so the doubling only ever corrupted the
 * argument without preventing anything. Measured through a real `.cmd` shim:
 *
 *   input           doubling `%%`          leaving `%` alone
 *   "100% done"  -> "100%% done"           "100% done"
 *   "%USERPROFILE%" -> "%C:\Users\me%"     "C:\Users\me"
 *
 * Caret escaping does not help either: inside a quoted argument `^` is inert,
 * so `%^VAR%` arrives verbatim as `%^VAR%` — expansion blocked, text corrupted
 * a different way. There is no correct quoting for `%` here, so leave it alone
 * and let literal percent signs round-trip. Callers that must carry text
 * containing `%VAR%` past cmd.exe have to keep it off the command line
 * entirely — pipe it over stdin, or use the guard at ptyService.ts:4482.
 *
 * POSIX has no equivalent hazard: `%` is not special to `sh`.
 */
export function quoteWindowsCmdArg(value: string): string {
  let quoted = "\"";
  let backslashes = 0;
  for (const char of value.replace(/[\r\n]/g, " ")) {
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

/**
 * Pick the launchable path for a Windows CLI, preferring a native `.exe`.
 *
 * Two installs routinely coexist and PATH order decides which a plain lookup
 * returns: the vendor installer's real binary (Claude Code's Windows installer
 * writes `%USERPROFILE%\.local\bin\claude.exe`, Droid's writes `droid.exe`) and
 * a leftover `npm i -g` shim in `%APPDATA%\npm`. They are not interchangeable.
 * A `.cmd`/`.bat` cannot be spawned at all since CVE-2024-27980 — Node refuses
 * bare shim spawns with `EINVAL` (errno -4071) — and reaching one through
 * `cmd.exe` re-parses the command line: measured, `%USERPROFILE%` expands,
 * newlines flatten to spaces, and an 8501-character line dies with "The command
 * line is too long." A `.exe` has none of those hazards, so it wins whenever one
 * exists anywhere in the candidate list, not just in the first directory.
 *
 * Off Windows every candidate is equally spawnable, so the caller's own
 * precedence order is returned untouched.
 */
export function preferNativeExecutablePath(
  candidatePaths: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string | null {
  const first = candidatePaths[0] ?? null;
  if (platform !== "win32") return first;
  const native = candidatePaths.find((candidate) => {
    const ext = path.win32.extname(candidate).toLowerCase();
    return ext === ".exe" || ext === ".com";
  });
  return native ?? first;
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
    command: windowsTaskkillCommand(),
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
    // `?? null` for the same reason as `signalChildProcessTree`: an absent
    // field means "not tracked", and reading it as "already exited" refuses the
    // kill and leaks the tree.
    if ((child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null) return false;
    // `taskkill` exiting 0 means the kill was dispatched, not that every
    // descendant is gone, so it cannot stand in for signaling the child we
    // actually hold. Run both: the tree kill reaches grandchildren that
    // `child.kill()` (a `TerminateProcess` on the leader) never would, and the
    // direct kill covers a `taskkill` that reported success without acting.
    const treeKilled = typeof child.pid === "number"
      && killWindowsProcessTree(child.pid, onWindowsTaskkillFailure);
    let childKilled = false;
    try {
      childKilled = child.kill(signal);
    } catch {
      childKilled = false;
    }
    return treeKilled || childKilled;
  }
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}
