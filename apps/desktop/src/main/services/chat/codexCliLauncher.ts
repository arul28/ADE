import { execFile, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";

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
  // Prefer the explicit `resume` subcommand (post-0.130 form). Match command
  // table entries only (e.g. "  resume   Resume a thread"), not prose.
  if (/^\s{2,}resume(?:\s{2,}|\t|$)/m.test(lower)) {
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

/** Quote a single arg for an interactive shell command. */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function cmdQuote(arg: string): string {
  return `"${arg
    .replace(/(["^&|<>])/g, "^$1")
    .replace(/%/g, "%%")}"`;
}

function appleScriptStringLiteral(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")}"`;
}

function terminalShellCommandExpression(binary: string, argv: string[], cwd: string): string {
  const parts = [
    `"cd "`,
    `quoted form of ${appleScriptStringLiteral(cwd)}`,
    `" && "`,
    `quoted form of ${appleScriptStringLiteral(binary)}`,
  ];
  for (const arg of argv) {
    parts.push(`" "`, `quoted form of ${appleScriptStringLiteral(arg)}`);
  }
  return parts.join(" & ");
}

export type SpawnNewTerminalOptions = {
  binary: string;
  argv: string[];
  cwd: string;
  platform?: NodeJS.Platform;
  isExecutableOnPath?: (binary: string) => boolean;
};

function isExecutableOnPath(binary: string): boolean {
  if (binary.includes("/") || binary.includes("\\")) {
    try {
      accessSync(binary, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    try {
      accessSync(path.join(dir, binary), constants.X_OK);
      return true;
    } catch {
      // keep scanning PATH
    }
  }
  return false;
}

function spawnDetached(binary: string, args: string[], options: Parameters<typeof spawn>[2]): void {
  const child = spawn(binary, args, options);
  child.once("error", () => undefined);
  child.unref();
}

/**
 * Launch the user's default terminal with `codex <argv>` running inside, cd'd
 * to `cwd`. Returns once the launcher process has been spawned (detached).
 */
export function spawnInNewTerminalWindow(options: SpawnNewTerminalOptions): void {
  const platform = options.platform ?? process.platform;
  const quote = platform === "win32" ? cmdQuote : shellQuote;
  const command = [options.binary, ...options.argv].map(quote).join(" ");
  const cdCommand = platform === "win32" ? `cd /d ${quote(options.cwd)}` : `cd ${quote(options.cwd)}`;
  const executableAvailable = options.isExecutableOnPath ?? isExecutableOnPath;

  if (platform === "darwin") {
    // Use osascript so we can set cwd cleanly and `do script` runs an interactive shell.
    const script = `tell application "Terminal" to do script ${terminalShellCommandExpression(options.binary, options.argv, options.cwd)}`;
    spawnDetached("osascript", ["-e", script], { detached: true, stdio: "ignore" });
    return;
  }

  if (platform === "win32") {
    // `start cmd /K "<cd> && <command>"` opens a new console window that stays open after the command exits.
    const inner = `${cdCommand} && ${command}`;
    spawnDetached("cmd.exe", ["/C", "start", "cmd", "/K", inner], { detached: true, stdio: "ignore", windowsHide: false });
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
    if (!executableAvailable(candidate.bin)) continue;
    spawnDetached(candidate.bin, candidate.argv(innerScript), { detached: true, stdio: "ignore" });
    return;
  }
  // Last resort: xdg-terminal (often a shim on modern desktops).
  if (executableAvailable("xdg-terminal")) {
    spawnDetached("xdg-terminal", [`${cdCommand} && ${command}`], { detached: true, stdio: "ignore" });
    return;
  }
  throw new Error("Failed to spawn terminal: no supported terminal emulator found");
}
