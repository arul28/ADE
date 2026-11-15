import { spawn } from "node:child_process";
import path from "node:path";
import { resolveWindowsCmdInvocation, shouldUseWindowsCmdWrapper } from "../shared/processExecution";
import { destroyChildProcessStreams, signalChildProcessTree, signalProcessGroup } from "../shared/utils";

/**
 * `ade secrets exec -- <command>`: run a command with the project's secrets in
 * its environment, without the agent that asked ever holding a value.
 *
 * The brain spawns the command itself, so the values go only into the child's
 * environment. Its output comes back to the caller with every secret value
 * masked: the exact text, and its base64, base64url and URL-encoded forms. A
 * value shorter than {@link MIN_MASKED_LENGTH} characters is not masked (it
 * would blank out ordinary words); the result names those secrets so the
 * caller can say so.
 *
 * Stated limit: masking is best effort. A command that transforms a value in
 * some other way (reverses it, splits it) prints it. ADE never puts secrets in
 * an agent CLI's own environment for that reason.
 */

export const MIN_MASKED_LENGTH = 8;
/** Output kept per stream; the tail beyond it is dropped and said so. */
export const MAX_EXEC_OUTPUT_BYTES = 1_000_000;
export const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60_000;
export const MAX_EXEC_TIMEOUT_MS = 60 * 60_000;
const MASK = "[secret]";

export type SecretExecResult = {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
  /** Names injected into the command's environment. */
  injected: string[];
  /** Injected names whose values are too short to mask in output. */
  unmasked: string[];
};

/** Every form of a value the output is searched for, longest first. */
function maskForms(value: string): string[] {
  const forms = new Set<string>([value]);
  const bytes = Buffer.from(value, "utf8");
  forms.add(bytes.toString("base64"));
  forms.add(bytes.toString("base64").replace(/=+$/, ""));
  forms.add(bytes.toString("base64url"));
  forms.add(encodeURIComponent(value));
  return [...forms].filter((form) => form.length >= MIN_MASKED_LENGTH).sort((a, b) => b.length - a.length);
}

/** The text with every secret value (and its encoded forms) replaced by `[secret]`. */
export function maskSecretValues(text: string, values: readonly string[]): string {
  let out = text;
  const forms = [...new Set(values.flatMap((value) => (value.length >= MIN_MASKED_LENGTH ? maskForms(value) : [])))]
    .sort((a, b) => b.length - a.length);
  for (const form of forms) {
    if (out.includes(form)) out = out.split(form).join(MASK);
  }
  return out;
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function runWithSecrets(input: {
  command: string[];
  cwd: string;
  /** Folders the command may run in: the project and its lanes. */
  allowedRoots: readonly string[];
  secrets: Record<string, string>;
  timeoutMs?: number;
  baseEnv?: NodeJS.ProcessEnv;
}): Promise<SecretExecResult> {
  const [file, ...args] = input.command;
  if (!file) throw new Error("Give the command to run after `--`, e.g. `ade secrets exec -- npm run deploy`.");
  const cwd = path.resolve(input.cwd);
  if (!input.allowedRoots.some((root) => isInside(cwd, path.resolve(root)))) {
    throw new Error("`ade secrets exec` runs only inside this project or one of its lanes.");
  }
  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS, 1_000), MAX_EXEC_TIMEOUT_MS);
  const names = Object.keys(input.secrets).sort();
  const values = names.map((name) => input.secrets[name]!).filter(Boolean);
  const env: NodeJS.ProcessEnv = { ...(input.baseEnv ?? process.env), ...input.secrets };
  const invocation = shouldUseWindowsCmdWrapper(file)
    ? resolveWindowsCmdInvocation(file, args, env)
    : { command: file, args, windowsVerbatimArguments: false };

  return await new Promise<SecretExecResult>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group off Windows, so a timeout reaches everything it
      // started (each of which holds the secrets in its environment).
      detached: process.platform !== "win32",
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const sizes = { stdout: 0, stderr: 0 };
    let truncated = false;
    let timedOut = false;
    const take = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      const room = MAX_EXEC_OUTPUT_BYTES - sizes[stream];
      if (room <= 0) {
        truncated = true;
        return;
      }
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (kept.length < chunk.length) truncated = true;
      chunks[stream].push(kept);
      sizes[stream] += kept.length;
    };
    child.stdout?.on("data", take("stdout"));
    child.stderr?.on("data", take("stderr"));
    const timer = setTimeout(() => {
      timedOut = true;
      signalChildProcessTree(child, "SIGTERM");
      setTimeout(() => {
        if (process.platform === "win32") {
          signalChildProcessTree(child, "SIGKILL");
          return;
        }
        // The whole group, even when the command itself already exited: a
        // process it started may have ignored SIGTERM, still holding the secrets.
        try {
          if (child.pid) signalProcessGroup(child.pid, "SIGKILL");
        } catch {
          // ESRCH: the group is already gone.
        }
      }, 5_000).unref();
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      // The spawn error names the command, never a value.
      reject(new Error(`Could not start ${file}: ${error.message}`));
    });
    let settled = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    // A grandchild that keeps the pipes open would hold back "close" forever;
    // after the command itself exits, its output gets two seconds more.
    child.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      setTimeout(() => finish(code, signal), 2_000).unref();
    });
    child.on("close", (code, signal) => finish(code ?? exitCode, signal ?? exitSignal));
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Whatever still holds the pipes gets no more of our memory.
      destroyChildProcessStreams(child);
      // Masked on the whole text, so a value split across two chunks is still
      // found. A stream cut at the limit also loses its last few characters:
      // a value cut in half there would not match any form.
      const longest = Math.max(0, ...values.flatMap((value) => maskForms(value).map((form) => form.length)));
      const text = (stream: "stdout" | "stderr") => {
        const raw = Buffer.concat(chunks[stream]).toString("utf8");
        return sizes[stream] >= MAX_EXEC_OUTPUT_BYTES ? raw.slice(0, Math.max(0, raw.length - longest)) : raw;
      };
      const stdout = maskSecretValues(text("stdout"), values);
      const stderr = maskSecretValues(text("stderr"), values);
      resolve({
        exitCode: code,
        signal: signal ?? null,
        timedOut,
        stdout,
        stderr,
        truncated,
        injected: names,
        unmasked: names.filter((name) => (input.secrets[name] ?? "").length < MIN_MASKED_LENGTH),
      });
    };
  });
}
