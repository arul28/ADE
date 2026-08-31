import path from "node:path";

/**
 * Windows `.cmd` / `.bat` invocation.
 *
 * Node refuses to spawn a batch file directly since the fix for
 * CVE-2024-27980: `child_process.spawn`/`execFile` throw EINVAL for `.cmd` and
 * `.bat` unless `shell: true`, because cmd.exe re-parses the command line and
 * arguments could inject commands. `shell: true` is the wrong remedy — it
 * reintroduces exactly that parsing.
 *
 * The correct form is to invoke `%ComSpec%` explicitly with `/d /s /c` and a
 * fully quoted command line, marked `windowsVerbatimArguments` so Node does not
 * re-quote what we already quoted. This mirrors
 * `apps/desktop/src/main/services/shared/processExecution.ts`
 * (`resolveWindowsCmdLineInvocation`); it is reimplemented rather than imported
 * because this package must build standalone.
 *
 * This matters for a real path: `findOnPath` honours PATHEXT, which includes
 * `.CMD` and `.BAT`, so an `ade` installed by a package manager as a shim is
 * exactly what gets resolved — and would then fail to spawn at all.
 */

export type SpawnInvocation = {
  command: string;
  args: string[];
  /** Only ever true on the cmd.exe path; Node re-quotes otherwise. */
  windowsVerbatimArguments: boolean;
};

/**
 * Quotes one argument for a cmd.exe command line.
 *
 * `%` IS DELIBERATELY NOT ESCAPED. Doubling to `%%` is a batch-FILE rule; on a
 * command line `%%` survives literally, so doubling corrupts the argument
 * without preventing expansion. Caret escaping is inert inside quotes. There is
 * no correct quoting for `%` here, so literal percent signs are left to
 * round-trip and callers that must carry `%VAR%` text keep it off the command
 * line entirely. (Verbatim from the desktop helper's hard-won comment — the
 * same reasoning applies identically here.)
 */
export function quoteWindowsCmdArg(value: string): string {
  let quoted = "\"";
  let backslashes = 0;
  // CR/LF would terminate the command line mid-argument.
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

/**
 * True when a command must go through cmd.exe. `.cmd`/`.bat` are the
 * CVE-2024-27980 cases; an extensionless command is included because Windows
 * cannot execute it directly either, and cmd.exe applies PATHEXT resolution.
 */
export function shouldUseWindowsCmdWrapper(
  command: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32") return false;
  const ext = path.win32.extname(command).toLowerCase();
  return ext === "" || ext === ".cmd" || ext === ".bat";
}

/**
 * Pure: how to actually spawn `command` with `args` on this platform. On
 * anything but a Windows batch target it is the identity, so callers can apply
 * it unconditionally instead of branching at every call site.
 */
export function resolveSpawnInvocation(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): SpawnInvocation {
  if (!shouldUseWindowsCmdWrapper(command, platform)) {
    return { command, args, windowsVerbatimArguments: false };
  }
  const comSpec = env.ComSpec?.trim() || "cmd.exe";
  const cmdLine = [command, ...args].map(quoteWindowsCmdArg).join(" ");
  return {
    command: comSpec,
    // /d skips AutoRun commands from the registry (a developer's AutoRun would
    // otherwise run before ours); /s fixes the quote handling for the /c string.
    // The whole command line is wrapped in one further pair of quotes, which is
    // what /s expects.
    args: ["/d", "/s", "/c", `"${cmdLine}"`],
    windowsVerbatimArguments: true,
  };
}
