import { execFile, spawn } from "node:child_process";

function execFileAsync(
  binary: string,
  args: string[],
  options: { timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, options, (err, stdout, stderr) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

export type CodexResumeFlagForm =
  | { kind: "subcommand"; argv: (threadId: string) => string[] }
  | { kind: "long-flag"; argv: (threadId: string) => string[] }
  | { kind: "interactive"; argv: () => string[] };

export type CodexResumeStrategy = {
  /** Path to the codex binary (typically bundled). */
  binary: string;
  /** How to launch a resume. `interactive` means launch codex without args and rely on the user's Ctrl+R picker. */
  flagForm: CodexResumeFlagForm;
  /** True when we could not detect a `resume` subcommand or `--thread` flag; the caller should copy the threadId to clipboard. */
  copyThreadIdToClipboard: boolean;
};

/**
 * Probe `codex --help` and decide which flag form to use to resume a specific thread.
 * Returns a strategy that tells the caller how to spawn codex (and whether to also
 * copy the threadId to the clipboard as a fallback when no direct flag exists).
 */
export async function detectCodexResumeStrategy(binary: string): Promise<CodexResumeStrategy> {
  let helpText = "";
  try {
    const { stdout, stderr } = await execFileAsync(binary, ["--help"], { timeout: 5000 });
    helpText = `${stdout}\n${stderr}`;
  } catch (probeError) {
    // If we can't read --help, fall back to interactive launch with clipboard.
    return {
      binary,
      flagForm: { kind: "interactive", argv: () => [] },
      copyThreadIdToClipboard: true,
    };
  }

  const lower = helpText.toLowerCase();
  // Prefer the explicit `resume` subcommand (post-0.130 form). Look for it in
  // a subcommand-list context (e.g. "  resume   Resume a thread" or "Commands:
  // resume ...") rather than as any English word in the help text.
  const subcommandPatterns = [
    /(^|\n)\s+resume(\s|$)/,           // indented list item
    /commands:[\s\S]*?\bresume\b/,     // anywhere in a "Commands:" section
    /subcommands:[\s\S]*?\bresume\b/,
  ];
  if (subcommandPatterns.some((re) => re.test(lower))) {
    return {
      binary,
      flagForm: { kind: "subcommand", argv: (id) => ["resume", id] },
      copyThreadIdToClipboard: false,
    };
  }
  if (/--thread\b/.test(lower)) {
    return {
      binary,
      flagForm: { kind: "long-flag", argv: (id) => ["--thread", id] },
      copyThreadIdToClipboard: false,
    };
  }
  return {
    binary,
    flagForm: { kind: "interactive", argv: () => [] },
    copyThreadIdToClipboard: true,
  };
}

export function buildResumeArgv(strategy: CodexResumeStrategy, threadId: string): string[] {
  if (strategy.flagForm.kind === "interactive") return strategy.flagForm.argv();
  return strategy.flagForm.argv(threadId);
}

/** Quote a single arg for an interactive shell command. Wraps in double-quotes
 *  and escapes embedded backslashes/double-quotes. Suitable for `cmd /K` on
 *  Windows and POSIX shells alike. */
export function shellQuote(arg: string): string {
  return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

export type SpawnNewTerminalOptions = {
  binary: string;
  argv: string[];
  cwd: string;
  platform?: NodeJS.Platform;
};

/**
 * Launch the user's default terminal with `codex <argv>` running inside, cd'd
 * to `cwd`. Returns once the launcher process has been spawned (detached).
 */
export function spawnInNewTerminalWindow(options: SpawnNewTerminalOptions): void {
  const platform = options.platform ?? process.platform;
  const command = [options.binary, ...options.argv].map(shellQuote).join(" ");
  const cdCommand = `cd ${shellQuote(options.cwd)}`;

  if (platform === "darwin") {
    // Use osascript so we can set cwd cleanly and `do script` runs an interactive shell.
    const script = `tell application "Terminal" to do script "${cdCommand.replace(/"/g, "\\\"")} && ${command.replace(/"/g, "\\\"")}"`;
    const child = spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" });
    child.unref();
    return;
  }

  if (platform === "win32") {
    // `start cmd /K "<cd> && <command>"` opens a new console window that stays open after the command exits.
    const inner = `${cdCommand} && ${command}`;
    const child = spawn("cmd.exe", ["/C", "start", "cmd", "/K", inner], { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
    return;
  }

  // Linux/BSD: try a list of terminals; use the first one that's on PATH.
  const candidates: Array<{ bin: string; argv: (script: string) => string[] }> = [
    { bin: "gnome-terminal", argv: (s) => ["--", "bash", "-c", s] },
    { bin: "konsole", argv: (s) => ["-e", "bash", "-c", s] },
    { bin: "xfce4-terminal", argv: (s) => ["-e", `bash -c ${shellQuote(s)}`] },
    { bin: "xterm", argv: (s) => ["-e", "bash", "-c", s] },
  ];
  const innerScript = `${cdCommand} && ${command}; exec bash`;
  for (const candidate of candidates) {
    try {
      const child = spawn(candidate.bin, candidate.argv(innerScript), { detached: true, stdio: "ignore" });
      child.unref();
      return;
    } catch {
      // try next
    }
  }
  // Last resort: xdg-terminal (often a shim on modern desktops).
  const child = spawn("xdg-terminal", [`${cdCommand} && ${command}`], { detached: true, stdio: "ignore" });
  child.unref();
}
