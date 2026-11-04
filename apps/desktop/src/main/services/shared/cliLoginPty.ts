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
const DEVICE_CODE_EXACT = /^[A-Z0-9]{4}-[A-Z0-9]{4,6}$/;
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
 * or a cursor move to a new row read as a line break, a cursor move forward
 * read as a space, and every pasted code blanked. Windows' ConPTY sends a
 * CLI's blank lines and runs of spaces as cursor moves, and full-screen TUIs
 * (Droid) draw their words apart with them, so without these a link runs into
 * the next word.
 */
export function cleanLoginOutput(raw: string, submittedCodes: readonly string[]): string {
  const input = raw
    // Cursor position (row;col H / f) starts a new line.
    .replace(/\u001b\[\d*(?:;\d*)?[Hf]/g, "\n")
    // Cursor forward stands in for spaces.
    .replace(/\u001b\[\d*C/g, " ");
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
 * and a redrawing TUI prints it many times. A CLI that prints the code only on
 * its link (Grok's and Kimi's `user_code`, Muse's `code`) gets it from there.
 */
export function findDeviceCode(text: string): string | null {
  const printed = text.replace(URL_PATTERN, " ").match(DEVICE_CODE_PATTERN_ALL)?.at(-1);
  if (printed) return printed;
  for (const url of (text.match(URL_PATTERN) ?? []).reverse()) {
    try {
      const params = new URL(url.replace(/[).,;\]]+$/, "")).searchParams;
      const code = (params.get("user_code") ?? params.get("code"))?.trim();
      if (code && DEVICE_CODE_EXACT.test(code)) return code;
    } catch {
      // Not a link the URL parser takes; the next one may be.
    }
  }
  return null;
}

/** The CLI's last non-empty output line, as a failure reason. */
export function lastOutputLine(text: string): string | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.at(-1) ?? null;
}

/** The part of a sign-in record the output reader and the code paste share. */
export type LoginOutputRecord = {
  rawOutput: string;
  /** Codes pasted into this sign-in, redacted from the output if the CLI echoes them. */
  submittedCodes: string[];
  /** Output since the last pasted code; null before one. Only it can show the code prompt again. */
  rawSinceSubmit: string | null;
  pty: { write: (data: string) => void } | null;
  status: { state: string; output: string; url: string | null; deviceCode?: string; awaitingCode: boolean };
};

/**
 * Reads one chunk of the CLI's output into the record: the cleaned output,
 * the sign-in link, the device code, and whether it asks for a pasted code
 * (`pasteCode`). Returns the whole cleaned text.
 */
export function readLoginOutput(
  record: LoginOutputRecord,
  data: string,
  options: { hosts: readonly string[]; deviceCode: boolean; pasteCode: boolean; promptTailLines: number },
): string {
  record.rawOutput = `${record.rawOutput}${data}`.slice(-LOGIN_OUTPUT_LIMIT * 2);
  const text = cleanLoginOutput(record.rawOutput, record.submittedCodes);
  record.status.output = text.slice(-LOGIN_OUTPUT_LIMIT);
  // Read again on every chunk: a link split across two reads is cut off in
  // the first one, and the next read completes it.
  record.status.url = findSignInUrl(text, options.hosts) ?? record.status.url;
  if (options.deviceCode) {
    const deviceCode = findDeviceCode(text);
    if (deviceCode) record.status.deviceCode = deviceCode;
  }
  if (record.rawSinceSubmit !== null) record.rawSinceSubmit = `${record.rawSinceSubmit}${data}`.slice(-LOGIN_OUTPUT_LIMIT);
  if (options.pasteCode) {
    // The prompt can be followed by the CLI's own "Signed in", so only the
    // latest lines decide whether it is still waiting. After a paste, the
    // prompt it answered is still there; only a new one counts.
    const promptText = record.rawSinceSubmit === null ? text : cleanLoginOutput(record.rawSinceSubmit, record.submittedCodes);
    record.status.awaitingCode = CODE_PROMPT_PATTERN.test(promptText.split("\n").slice(-options.promptTailLines).join("\n"));
  }
  return text;
}

/** Types a code pasted from the browser into the CLI, or throws why it cannot. */
export function writeLoginCode(record: LoginOutputRecord, code: unknown): void {
  const trimmed = typeof code === "string" ? code.trim() : "";
  if (!trimmed) throw new Error("Paste the code from the browser first.");
  if (!record.pty || record.status.state !== "running") {
    throw new Error("This sign-in is not waiting for a code any more.");
  }
  // A paste as short as "y" would blank every match in the output.
  if (trimmed.length >= 4) record.submittedCodes.push(trimmed);
  record.rawSinceSubmit = "";
  record.pty.write(`${trimmed}\r`);
  record.status.awaitingCode = false;
}
