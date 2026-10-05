// ---------------------------------------------------------------------------
// Codex fork in a private, short-lived `codex app-server`.
//
// Codex holds a per-thread writer lock (`<CODEX_HOME>/thread-writer-locks`)
// for as long as an app-server process has a thread loaded, and refuses any
// other process with "thread <id> already has an active writer". `thread/fork`
// loads the new thread into the process that ran it and subscribes that
// connection, so a fork run on the source chat's own app-server leaves the
// fork locked by the source chat. The forked chat starts its own app-server,
// its `thread/resume` is refused, and the chat lands in continuity recovery.
// Unsubscribing does not help in time: Codex unloads an unsubscribed thread
// only after `thread_unload_delay_secs` (60 s by default).
//
// So the fork runs here instead: a process that exists only for this one
// request and has exited — lock released — before the caller hands the new
// thread to the forked chat. Forking does not need the source thread's lock,
// so the source chat keeps its own thread and can keep working.
//
// The process starts with MCP servers switched off: forking starts no turn,
// and MCP startup costs time and can fail. The forked thread does not keep
// this override; it loads the chat's real MCP config when it is resumed.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import readline from "node:readline";
import { resolveCliSpawnInvocation } from "../shared/processExecution";
import { terminateChildProcessTree } from "../shared/utils";
import type { Logger } from "../logging/logger";

/** How long a clean exit (stdin closed) may take before the process is killed. */
const EXIT_GRACE_MS = 5_000;
/** How long a killed process may take to report its exit before the fork gives up waiting. */
const KILL_WAIT_MS = 5_000;

/**
 * Forks a Codex thread and returns the new thread's id ("" when Codex named
 * none). Resolves only after the forking process has exited.
 */
export async function forkCodexThreadInEphemeralAppServer(args: {
  executable: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  forkParams: Record<string, unknown>;
  timeoutMs: number;
  logger: Logger;
  sessionId: string;
}): Promise<string> {
  const invocation = resolveCliSpawnInvocation(args.executable, ["-c", "mcp_servers={}", "app-server"], args.env);
  const proc = spawn(invocation.command, invocation.args, {
    cwd: args.cwd,
    env: args.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    windowsHide: true,
  });
  const exited = new Promise<void>((resolve) => {
    proc.once("exit", () => resolve());
    // A spawn that never started (no pid) raises `error` and never `exit`.
    proc.once("error", () => {
      if (proc.pid == null) resolve();
    });
  });
  const reader = readline.createInterface({ input: proc.stdout });
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 1;
  let failure: Error | null = null;

  const failAll = (error: Error) => {
    failure ??= error;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  const write = (message: Record<string, unknown>) => {
    if (proc.stdin.writable) proc.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const request = (method: string, params: unknown): Promise<unknown> => {
    if (failure) return Promise.reject(failure);
    const id = `fork-${nextId++}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      write({ id, method, params });
    });
  };

  reader.on("line", (line) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = message.id;
    if (id == null) return;
    if (typeof message.method === "string") {
      // A server request. Forking raises none; refuse anything that arrives.
      write({ id, result: { decision: "decline" } });
      return;
    }
    const entry = pending.get(String(id));
    if (!entry) return;
    pending.delete(String(id));
    const error = message.error as { message?: unknown } | undefined;
    if (error) entry.reject(new Error(typeof error.message === "string" ? error.message : "Codex request failed."));
    else entry.resolve(message.result);
  });
  proc.stderr.on("data", () => {
    // Codex logs to stderr constantly; nothing here is the fork's answer.
  });
  // A write racing the process exit raises EPIPE here; the exit handler reports it.
  proc.stdin.on("error", () => {});
  proc.on("error", (error) => failAll(new Error(`Could not start Codex to fork this chat: ${error.message}`)));
  proc.on("exit", (code, signal) => failAll(new Error(`Codex exited before the fork finished (${signal ?? code ?? "unknown"}).`)));

  const fork = (async () => {
    await request("initialize", {
      clientInfo: { name: "ade_desktop_fork", title: "ADE Desktop", version: "1" },
      capabilities: { experimentalApi: true },
    });
    write({ method: "initialized", params: {} });
    const result = await request("thread/fork", args.forkParams) as { thread?: { id?: unknown } } | null;
    return typeof result?.thread?.id === "string" ? result.thread.id.trim() : "";
  })();
  // When the deadline wins, the process exit below still rejects `fork`.
  fork.catch(() => {});
  let timer: NodeJS.Timeout | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Codex did not finish the fork in time.")), args.timeoutMs);
  });
  try {
    return await Promise.race([fork, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    reader.close();
    // The caller resumes the new thread in another process next, so the lock
    // must be gone before this returns: wait for the exit, not just the signal.
    proc.stdin.end();
    let graceTimer: NodeJS.Timeout | null = null;
    const exitedCleanly = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => { graceTimer = setTimeout(() => resolve(false), EXIT_GRACE_MS); }),
    ]);
    if (graceTimer) clearTimeout(graceTimer);
    if (!exitedCleanly) {
      let killTimer: NodeJS.Timeout | null = null;
      try {
        killTimer = terminateChildProcessTree(proc, null);
      } catch {
        // Already gone.
      }
      let killWaitTimer: NodeJS.Timeout | null = null;
      const exitedAfterKill = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => { killWaitTimer = setTimeout(() => resolve(false), KILL_WAIT_MS); }),
      ]);
      if (killWaitTimer) clearTimeout(killWaitTimer);
      if (exitedAfterKill && killTimer) clearTimeout(killTimer);
      args.logger.warn("agent_chat.codex_fork_host_killed", { sessionId: args.sessionId, exited: exitedAfterKill });
    }
  }
}
