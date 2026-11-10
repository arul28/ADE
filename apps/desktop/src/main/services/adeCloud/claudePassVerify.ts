/**
 * Which Claude account a new cloud pass belongs to.
 *
 * `claude setup-token` approves in the browser, and the browser can be signed
 * in to another Claude account than the one the person pressed "Sign in" for.
 * After the token is read, ADE starts Claude Code once with only that token
 * and asks it who it is (`accountInfo()`, the initialize request). No prompt
 * is sent, so no usage is spent.
 *
 * It runs only after the person's approve, one time, with a 15 s limit. Any
 * failure (no email, a timeout, no Claude Code here) answers "unchecked" and
 * never waits longer: the person already checked the name on Claude's page.
 *
 * Nothing stays behind. Claude Code runs in a new private folder
 * (`CLAUDE_CONFIG_DIR`) that is deleted on every exit path, also when the
 * brain stops. The token goes to the process environment only, never to a
 * file, a log line or an error message.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query as claudeQuery, type SDKUserMessage, type SpawnOptions, type SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { ensurePrivateDirectory } from "../../../../../ade-cli/src/lib/trustedWindowsTools";
import { providerSelfUpdateEnv } from "../../../shared/pinnedToolSpawnEnv";
import { resolveClaudeCodeExecutable } from "../ai/claudeCodeExecutable";
import { killWindowsProcessTreeAsync, resolveCliSpawnInvocation } from "../shared/processExecution";
import { userProcessEnv } from "../shared/hostRuntimeEnv";

export const CLAUDE_PASS_VERIFY_TIMEOUT_MS = 15_000;
/** How long ADE waits for Claude Code to exit before it kills it and deletes the folder. */
const EXIT_WAIT_MS = 5_000;
const DIR_PREFIX = "ade-claude-pass-";

export type ClaudePassVerifyUncheckedReason =
  | "no_email"
  | "timeout"
  | "cli_missing"
  | "start_failed"
  | "cancelled";

export type ClaudePassVerifyResult =
  | { kind: "email"; email: string }
  | { kind: "unchecked"; reason: ClaudePassVerifyUncheckedReason };

type Logger = {
  info?(event: string, meta?: Record<string, unknown>): void;
  warn?(event: string, meta?: Record<string, unknown>): void;
} | null | undefined;

/**
 * Variables that would make Claude Code use another credential or endpoint
 * than the pass. `ANTHROPIC_API_KEY` is set blank instead of removed, as a
 * custom route does (harnessRouteLaunch.ts).
 */
const CREDENTIAL_ENV_NAMES = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

/**
 * `base` without the names above, compared without case: on Windows
 * `Anthropic_Api_Key` and `ANTHROPIC_API_KEY` are one variable.
 */
function withoutEnvNames(base: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  const drop = new Set(names.map((name) => name.toUpperCase()));
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!drop.has(key.toUpperCase())) next[key] = value;
  }
  return next;
}

/** The environment of the check: the person's env, no other credential, the pass, the private folder. */
export function claudePassVerifyEnv(base: NodeJS.ProcessEnv, token: string, configDir: string): NodeJS.ProcessEnv {
  return {
    ...withoutEnvNames(base, CREDENTIAL_ENV_NAMES),
    ...providerSelfUpdateEnv("claude"),
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_OAUTH_TOKEN: token,
  };
}

/** Folders of checks still open; the brain's exit deletes them (sync, it can't wait). */
const liveDirs = new Set<string>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const dir of liveDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // The process is ending; nothing else can run.
      }
    }
    liveDirs.clear();
  });
}

async function removeDir(dir: string, logger: Logger): Promise<void> {
  try {
    // Windows can hold a file of a process that just exited for a moment.
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    liveDirs.delete(dir);
  } catch (error) {
    // Kept in `liveDirs`, so the brain's exit tries again.
    logger?.warn?.("claude_pass.verify_dir_left", { reason: error instanceof Error ? error.name : "unknown" });
  }
}

/** Waits for the exit, then kills what is left (the whole tree on Windows). */
async function endProcess(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const timer = new Promise<"late">((resolve) => setTimeout(() => resolve("late"), EXIT_WAIT_MS).unref?.());
  if (await Promise.race([exited.then(() => "exited" as const), timer]) === "exited") return;
  if (process.platform === "win32" && child.pid) {
    await killWindowsProcessTreeAsync(child.pid).catch(() => undefined);
  } else {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 1_000).unref?.())]);
}

export type ClaudePassVerifyDeps = {
  /** Injectable for a scratch check; production uses the SDK. */
  query?: typeof claudeQuery;
  resolveExecutable?: () => { path: string; source: string };
  baseEnv?: () => NodeJS.ProcessEnv;
  spawnProcess?: typeof spawn;
  tmpRoot?: () => string;
  timeoutMs?: number;
  logger?: Logger;
};

/**
 * Asks Claude Code which account `token` belongs to. Never throws, and never
 * returns or logs the token.
 */
export async function verifyClaudePass(
  token: string,
  options: { signal?: AbortSignal } & ClaudePassVerifyDeps = {},
): Promise<ClaudePassVerifyResult> {
  const logger = options.logger;
  const startedAt = Date.now();
  const done = (result: ClaudePassVerifyResult): ClaudePassVerifyResult => {
    logger?.info?.("claude_pass.verify", {
      result: result.kind === "email" ? "email" : result.reason,
      ms: Date.now() - startedAt,
    });
    return result;
  };
  if (options.signal?.aborted) return done({ kind: "unchecked", reason: "cancelled" });

  const executable = (options.resolveExecutable ?? (() => resolveClaudeCodeExecutable()))();
  // No pinned Claude Code here (it should be, the sign-in just ran it).
  if (executable.source === "fallback-command") return done({ kind: "unchecked", reason: "cli_missing" });

  let dir: string;
  try {
    dir = await fs.promises.mkdtemp(path.join((options.tmpRoot ?? os.tmpdir)(), DIR_PREFIX));
    liveDirs.add(dir);
    installExitHook();
    // POSIX: 0700 (mkdtemp already is). Windows: an owner-only ACL.
    ensurePrivateDirectory(dir);
  } catch (error) {
    logger?.warn?.("claude_pass.verify_dir_failed", { reason: error instanceof Error ? error.name : "unknown" });
    return done({ kind: "unchecked", reason: "start_failed" });
  }

  const abort = new AbortController();
  const onOuterAbort = () => abort.abort();
  options.signal?.addEventListener("abort", onOuterAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, options.timeoutMs ?? CLAUDE_PASS_VERIFY_TIMEOUT_MS);
  timer.unref?.();
  const aborted = new Promise<null>((resolve) => {
    if (abort.signal.aborted) resolve(null);
    else abort.signal.addEventListener("abort", () => resolve(null), { once: true });
  });

  // A prompt that never yields: Claude Code starts and answers control
  // requests, and no turn is ever sent.
  async function* noPrompt(): AsyncGenerator<SDKUserMessage> {
    await aborted;
  }

  let child: ChildProcess | null = null;
  const spawnProcess = options.spawnProcess ?? spawn;
  const spawnClaudeCodeProcess = (spawnOptions: SpawnOptions): SpawnedProcess => {
    const invocation = resolveCliSpawnInvocation(spawnOptions.command, spawnOptions.args, spawnOptions.env);
    const created = spawnProcess(invocation.command, invocation.args, {
      cwd: spawnOptions.cwd,
      env: spawnOptions.env,
      signal: spawnOptions.signal,
      stdio: ["pipe", "pipe", "ignore"],
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      windowsHide: true,
    });
    // The abort signal makes Node emit an AbortError on the child; with no
    // listener left (the SDK closed) that would be an uncaught error in the brain.
    created.on("error", () => undefined);
    child = created;
    return created as unknown as SpawnedProcess;
  };

  let stream: ReturnType<typeof claudeQuery> | null = null;
  try {
    stream = (options.query ?? claudeQuery)({
      prompt: noPrompt(),
      options: {
        cwd: dir,
        env: claudePassVerifyEnv((options.baseEnv ?? userProcessEnv)(), token, dir),
        pathToClaudeCodeExecutable: executable.path,
        abortController: abort,
        spawnClaudeCodeProcess,
        permissionMode: "plan",
        tools: [],
        // Only "who is this": no settings files, MCP servers or session file.
        settingSources: [],
        mcpServers: {},
        strictMcpConfig: true,
        persistSession: false,
      },
    });
    // Read the stream so the SDK's message pump runs; it carries no turn.
    void (async () => {
      try {
        for await (const _message of stream) { /* nothing to read */ }
      } catch {
        // The answer below decides; an ended stream is expected.
      }
    })();
    const info = await Promise.race([stream.accountInfo(), aborted]);
    if (info === null) return done({ kind: "unchecked", reason: timedOut ? "timeout" : "cancelled" });
    const email = typeof info.email === "string" ? info.email.trim() : "";
    return done(email.includes("@") ? { kind: "email", email } : { kind: "unchecked", reason: "no_email" });
  } catch (error) {
    // The SDK's message can quote the command line; the name only.
    logger?.warn?.("claude_pass.verify_failed", { reason: error instanceof Error ? error.name : "unknown" });
    if (timedOut) return done({ kind: "unchecked", reason: "timeout" });
    return done({ kind: "unchecked", reason: abort.signal.aborted ? "cancelled" : "start_failed" });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onOuterAbort);
    abort.abort();
    try {
      stream?.close();
    } catch {
      // Best effort; the process is ended below.
    }
    await endProcess(child);
    await removeDir(dir, logger);
  }
}
