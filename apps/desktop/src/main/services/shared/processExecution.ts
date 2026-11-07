import { execFile, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { resolveTrustedWindowsTool } from "../../../../../ade-cli/src/lib/trustedWindowsTools";

/**
 * True inside the standalone `ade` runtime: one Node SEA executable, where
 * `process.execPath` is ADE itself, no script sits beside it, and `fork()` of a
 * file re-enters the CLI. Older runtimes without `node:sea` are never SEA builds.
 */
export function isEmbeddedAdeRuntime(): boolean {
  try {
    const sea = process.getBuiltinModule?.("node:sea") as { isSea?: () => boolean } | undefined;
    return sea?.isSea?.() === true;
  } catch {
    return false;
  }
}

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

/**
 * True when a `cmd.exe /d /s /c` wrapper reports that the command it was asked
 * to run does not exist. cmd.exe itself always starts, so a missing CLI comes
 * back as exit 1 with "'x' is not recognized as an internal or external
 * command" on stderr rather than as an ENOENT spawn error. Only the English
 * message is matched; a localized Windows still reads as a plain failure.
 */
export function isWindowsCmdCommandNotFound(
  status: number | null,
  stderr: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32"
    && status === 1
    && /is not recognized as an internal or external command/i.test(stderr);
}

export function isWindowsPowerShellScript(command: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && path.win32.extname(command).toLowerCase() === ".ps1";
}

/**
 * Resolve `powershell.exe` through the kernel's SystemRoot alias rather than
 * `PATH`, for the same reason as {@link windowsTaskkillCommand}: a bare
 * `"powershell.exe"` is PATH-relative, and a lane worktree is a repo the user
 * did not necessarily write — a `powershell.exe` dropped at the repo root wins
 * resolution when that root is the spawn cwd. `windows-quirks.md` §3 names
 * trusted-tool resolution as the answer.
 *
 * Falls back to the PATH spelling if resolution throws, so a non-standard
 * Windows install still runs its scripts.
 *
 * `platform` is a parameter, like every sibling in this module, so a
 * cross-platform test can pin the trusted-path behavior instead of only ever
 * exercising the non-Windows branch on CI. Note it is NOT forwarded to
 * `resolveTrustedWindowsTool`: that resolver consults the real host, and
 * telling it "win32" from macOS would send it probing a GLOBALROOT path that
 * cannot exist there. Off Windows it already returns the deterministic kernel
 * path, which is what the test asserts on.
 */
export function windowsPowerShellCommand(platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return "powershell.exe";
  try {
    return resolveTrustedWindowsTool("powershell");
  } catch {
    return "powershell.exe";
  }
}

/**
 * `.ps1` shims (npm writes one next to every `.cmd`) cannot be launched by
 * cmd.exe or by `spawn` directly — PowerShell has to interpret them. `-File`
 * keeps the remaining arguments literal rather than re-parsing them as script.
 */
export function resolveWindowsPowerShellInvocation(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): SpawnInvocation {
  return {
    command: windowsPowerShellCommand(platform),
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
    return resolveWindowsPowerShellInvocation(command, args, platform);
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

/** Windows' limit on one process's command line, in UTF-16 characters (CreateProcessW). */
const WINDOWS_COMMAND_LINE_MAX_CHARS = 32_767;

/**
 * The length of the command line Windows gets for `file` and `args`, built
 * the way node-pty builds it (`argsToCommandLine`: MSVCRT quoting, so quotes
 * and the backslashes before them are escaped). A string `args` is used as
 * written (verbatim arguments).
 */
function windowsCommandLineLength(file: string, args: readonly string[] | string): number {
  const quotedLength = (arg: string): number => {
    const enclosed = arg.length > 1 && arg.startsWith('"') && arg.endsWith('"');
    const quote = arg === "" || (/[ \t]/.test(arg) && !enclosed);
    let length = quote ? 2 : 0;
    let backslashes = 0;
    for (const char of arg) {
      if (char === "\\") {
        backslashes += 1;
      } else if (char === '"') {
        length += backslashes * 2 + 2;
        backslashes = 0;
      } else {
        length += backslashes + char.length;
        backslashes = 0;
      }
    }
    return length + (quote ? backslashes * 2 : backslashes);
  };
  if (typeof args === "string") return quotedLength(file) + (args.length ? 1 + args.length : 0);
  return [file, ...args].reduce((total, arg, index) => total + (index > 0 ? 1 : 0) + quotedLength(arg), 0);
}

/**
 * Why Windows cannot start this command line, or null when it fits. A bare
 * program name leaves room for the full path the spawn resolves it to.
 * Checked before spawning: an over-long line never errors there, it hangs.
 */
export function windowsCommandLineOverLimitMessage(file: string, args: readonly string[] | string): string | null {
  const length = windowsCommandLineLength(file, args) + (path.win32.isAbsolute(file) ? 0 : 260);
  if (length <= WINDOWS_COMMAND_LINE_MAX_CHARS) return null;
  return `This command is about ${length.toLocaleString("en-US")} characters as Windows builds its command line, `
    + `over Windows' limit of ${WINDOWS_COMMAND_LINE_MAX_CHARS.toLocaleString("en-US")}. A PowerShell command run once is sent `
    + "as -EncodedCommand, which takes about 2.7 times the script's length. Put the script in a file in the work copy "
    + "and run that file (for example `powershell -NoProfile -File script.ps1`), or pipe it to the command on stdin.";
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

const WINDOWS_TASKKILL_TIMEOUT_MS = 15_000;

/**
 * {@link killWindowsProcessTree} without blocking the event loop.
 *
 * Same trusted `taskkill /T /F` invocation and `windowsHide`. A synchronous
 * `taskkill` held the brain for up to 10.8 s per kill on Windows (61 of them in
 * three days of one PC's logs), so the brain's kills wait here instead.
 * Resolves true when `taskkill` exits 0.
 *
 * `execFile`, not the off-thread spawner, on purpose: `execFile` starts the
 * process before it returns, so a kill issued as the brain shuts down still
 * runs to the end after the brain exits. The spawner would start it on a
 * later turn of the event loop that an exiting process never reaches.
 */
export function killWindowsProcessTreeAsync(
  pid: number,
  onFailure?: (detail: ProcessTreeFailureDetail) => void,
  /**
   * `force: false` sends `taskkill /T` without `/F`: Windows asks the tree to
   * close (a window gets WM_CLOSE) before a caller escalates. Default forced.
   */
  options: { force?: boolean } = {},
): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const fail = (detail: Omit<ProcessTreeFailureDetail, "pid">): void => {
      onFailure?.({ pid, ...detail });
      resolve(false);
    };
    try {
      const invocation = windowsTaskkillInvocation(pid, { force: options.force !== false });
      execFile(
        invocation.command,
        invocation.args,
        { encoding: "utf8", windowsHide: true, timeout: WINDOWS_TASKKILL_TIMEOUT_MS },
        (error, stdout, stderr) => {
          if (!error) {
            resolve(true);
            return;
          }
          fail({
            status: typeof error.code === "number" ? error.code : null,
            stdout: processOutputToString(stdout),
            stderr: processOutputToString(stderr),
            error,
          });
        },
      );
    } catch (error) {
      fail({ status: null, stdout: "", stderr: "", error });
    }
  });
}

function killChildDirectly(child: Pick<ChildProcess, "kill">, signal: NodeJS.Signals): boolean {
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
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
    if (typeof child.pid !== "number") return killChildDirectly(child, signal);
    // `taskkill` exiting 0 means the kill was dispatched, not that every
    // descendant is gone, so it cannot stand in for signaling the child we
    // actually hold. Run both: the tree kill reaches grandchildren that
    // `child.kill()` (a `TerminateProcess` on the leader) never would, and the
    // direct kill covers a `taskkill` that reported success without acting.
    //
    // In that order, and the direct kill only once `taskkill` is done: once the
    // leader is gone, `taskkill /T` can no longer find its descendants. The
    // wait is asynchronous (it used to be a `spawnSync` that held the event
    // loop for up to 10.8 s), so the answer is "the kill is under way": true
    // for a live child, as `child.kill()` answered before for one.
    void terminateProcessTreeAsync(child, signal, onWindowsTaskkillFailure);
    return true;
  }
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

/**
 * {@link terminateProcessTree} for a caller that must not move on until both
 * kills ran, such as a process about to exit (an exit before the direct kill
 * would skip it). Resolves to whether either kill reported success; on POSIX
 * it is the same single `child.kill()`.
 */
export async function terminateProcessTreeAsync(
  child: Pick<ChildProcess, "kill" | "pid" | "exitCode" | "signalCode">,
  signal: NodeJS.Signals = "SIGTERM",
  onWindowsTaskkillFailure?: (detail: ProcessTreeFailureDetail) => void,
): Promise<boolean> {
  if (process.platform !== "win32" || typeof child.pid !== "number") {
    return terminateProcessTree(child, signal, onWindowsTaskkillFailure);
  }
  if ((child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null) return false;
  const treeKilled = await killWindowsProcessTreeAsync(child.pid, onWindowsTaskkillFailure);
  return killChildDirectly(child, signal) || treeKilled;
}
