/**
 * The private PTY a terminal-free CLI sign-in runs in, shared by the provider
 * account runner (Claude Code, Codex) and the agent CLI runner (Grok, Devin,
 * Muse, Copilot, Droid, Kimi): loading node-pty, spawning the CLI wide enough
 * that its link never wraps, stopping it (the whole tree on Windows), and
 * reading its output for the sign-in link and a device code.
 */
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { IPty } from "node-pty";
import type * as NodePty from "node-pty";
import { stripAnsi } from "../../../shared/ansiStrip";
import {
  killWindowsProcessTree,
  killWindowsProcessTreeAsync,
  resolveCliSpawnInvocation,
} from "./processExecution";

/** A sign-in nobody finishes in this long is abandoned; the CLI is stopped. */
export const LOGIN_TIMEOUT_MS = 10 * 60_000;
/** A finished login stays readable this long, so the last poll sees the result. */
export const LOGIN_FINISHED_RETENTION_MS = 2 * 60_000;
/** The output a status carries: the last few KB, enough for the link and the prompt. */
export const LOGIN_OUTPUT_LIMIT = 8_000;
/** Wide enough that the CLI never wraps the sign-in link across lines. */
const PTY_COLS = 400;
const PTY_ROWS = 40;

const URL_PATTERN = /https:\/\/[^\s"'<>`]+/g;
/** A device sign-in's one-time code, e.g. `ABCD-EFGHI`. */
const DEVICE_CODE_PATTERN_ALL = /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/g;
/** A CLI asking for a code pasted from the browser. */
export const CODE_PROMPT_PATTERN = /paste (the )?(authorization )?code|enter (the )?(authorization )?code|code here/i;

const requireFromRuntime = createRequire(
  typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url),
);

function loadPty(): typeof NodePty {
  // node-pty is native and external to both bundles; load it at first use.
  // Not the supervised PTY host: that loader belongs to one project's window,
  // and a sign-in serves the whole machine, the headless runtime included.
  return requireFromRuntime("node-pty") as typeof NodePty;
}

/**
 * Spawns a sign-in CLI in a private PTY in the home folder. Throws the
 * spawn's own error; the caller words it.
 */
export function spawnLoginPty(command: string, args: string[], env: NodeJS.ProcessEnv): IPty {
  const invocation = resolveCliSpawnInvocation(command, args, env);
  // A cmd.exe wrapper carries one pre-quoted command line; node-pty must not
  // quote it again.
  const ptyArgs = invocation.windowsVerbatimArguments ? invocation.args.join(" ") : invocation.args;
  return loadPty().spawn(invocation.command, ptyArgs, {
    name: "xterm-256color",
    cols: PTY_COLS,
    rows: PTY_ROWS,
    cwd: os.homedir(),
    env: env as Record<string, string>,
  });
}

/**
 * Stops a sign-in's CLI. On Windows, taskkill must list the tree while the
 * ConPTY leader still exists, so the PTY closes only after taskkill ends.
 * `sync` is for process exit, which cannot wait for a promise.
 */
export function stopLoginPty(pty: Pick<IPty, "pid" | "kill"> | null, options: { sync?: boolean } = {}): void {
  if (!pty) return;
  const kill = () => {
    try {
      pty.kill();
    } catch {
      // Already gone.
    }
  };
  if (process.platform !== "win32" || pty.pid <= 0) {
    kill();
  } else if (options.sync) {
    killWindowsProcessTree(pty.pid);
    kill();
  } else {
    void killWindowsProcessTreeAsync(pty.pid).finally(kill);
  }
}

/**
 * The CLI's raw output as text: no terminal escapes, a lone carriage return
 * read as a line break, and every pasted code blanked. `cursorMovesAsSpace`
 * is for full-screen TUIs that move the cursor instead of writing a space or
 * a newline, so words they draw apart do not run together.
 */
export function cleanLoginOutput(
  raw: string,
  submittedCodes: readonly string[],
  options: { cursorMovesAsSpace?: boolean } = {},
): string {
  let input = raw;
  if (options.cursorMovesAsSpace) {
    input = input
      // Cursor position (row;col H / f) starts a new drawn line.
      .replace(/\u001b\[\d*(?:;\d*)?[Hf]/g, "\n")
      // Cursor forward stands in for spaces.
      .replace(/\u001b\[\d*C/g, " ");
  }
  let text = stripAnsi(input).replace(/\r(?!\n)/g, "\n");
  for (const code of submittedCodes) text = text.split(code).join("[code]");
  return text;
}

/** The sign-in link in the CLI's output: one on `hosts` first, else the first link. */
export function findSignInUrl(text: string, hosts: readonly string[]): string | null {
  const urls = (text.match(URL_PATTERN) ?? []).map((url) => url.replace(/[).,;\]]+$/, ""));
  if (urls.length === 0) return null;
  const isAuthHost = (url: string) => {
    try {
      const host = new URL(url).hostname;
      return hosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
    } catch {
      return false;
    }
  };
  return urls.find(isAuthHost) ?? urls[0] ?? null;
}

/**
 * The last device code in the output, links removed first (a device link can
 * carry the code too). The last one: it is what a CLI prints before it waits,
 * and a redrawing TUI prints it many times.
 */
export function findDeviceCode(text: string): string | null {
  return text.replace(URL_PATTERN, " ").match(DEVICE_CODE_PATTERN_ALL)?.at(-1) ?? null;
}

/** The CLI's last non-empty output line, as a failure reason. */
export function lastOutputLine(text: string): string | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.at(-1) ?? null;
}
