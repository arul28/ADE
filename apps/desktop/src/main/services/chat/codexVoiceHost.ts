// ---------------------------------------------------------------------------
// Codex voice host — a private `codex app-server` that carries a voice session
// for a chat that is not itself a Codex chat (Claude, Cursor, OpenCode, …).
//
// Voice always runs on Codex with the user's ChatGPT sign-in. A Codex chat
// hosts its voice session on its own thread; any other chat gets one of these:
// a separate app-server process with one ephemeral "relay" thread. The voice
// session hands requests to that thread, ADE routes the spoken words to the
// real chat, and the relay thread's own reply is never shown or spoken.
//
// The process starts with MCP servers switched off: it only relays, so it has
// no use for the user's tools, and starting them costs time and can fail.
// ---------------------------------------------------------------------------

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { resolveCliSpawnInvocation } from "../shared/processExecution";
import { terminateChildProcessTree } from "../shared/utils";
import type { Logger } from "../logging/logger";

const REQUEST_TIMEOUT_MS = 30_000;

/** What the relay thread is told. Its replies are discarded, so keep them tiny. */
const RELAY_INSTRUCTIONS = [
  "You are a relay for a voice conversation. Another agent does the real work in a separate chat.",
  "For every message, reply with exactly: [RELAYED]",
  "Never run commands, never call tools, never read files, and never add any other text.",
].join("\n");

export type CodexVoiceHostNotification = { method: string; params: Record<string, unknown> };

export type CodexVoiceHost = {
  threadId: string;
  /** ChatGPT plan type from `account/read`, when the sign-in reports one. */
  planType: string | null;
  request: <T = unknown>(method: string, params: unknown) => Promise<T>;
  close: () => void;
};

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/** Plans that include Codex voice, per OpenAI's Codex pricing page. */
export function codexPlanIncludesVoice(planType: string | null): boolean {
  if (!planType) return true;
  const plan = planType.trim().toLowerCase();
  return plan !== "free" && plan !== "go" && plan !== "free_workspace";
}

export async function startCodexVoiceHost(args: {
  executable: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  logger: Logger;
  sessionId: string;
  onNotification: (notification: CodexVoiceHostNotification) => void;
  onExit: (reason: string) => void;
}): Promise<CodexVoiceHost> {
  const { logger, sessionId } = args;
  const appServerArgs = ["-c", "mcp_servers={}", "app-server"];
  const invocation = resolveCliSpawnInvocation(args.executable, appServerArgs, args.env);
  const proc: ChildProcessWithoutNullStreams = spawn(invocation.command, invocation.args, {
    cwd: args.cwd,
    env: args.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    windowsHide: true,
  });
  const reader = readline.createInterface({ input: proc.stdout });
  const pending = new Map<string, Pending>();
  let nextId = 1;
  let closed = false;
  let killTimer: NodeJS.Timeout | null = null;

  const failAll = (reason: string) => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    pending.clear();
  };

  const write = (message: Record<string, unknown>) => {
    if (closed || !proc.stdin.writable) return;
    proc.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const request = <T = unknown>(method: string, params: unknown): Promise<T> => {
    if (closed) return Promise.reject(new Error("The voice host has stopped."));
    const id = `voice-${nextId++}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex did not answer ${method} in time.`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
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
    const method = typeof message.method === "string" ? message.method : null;
    if (id != null && method) {
      // A server request (an approval, a question). The relay thread must not
      // act, so every request is declined.
      write({ id, result: { decision: "decline" } });
      return;
    }
    if (id != null) {
      const entry = pending.get(String(id));
      if (!entry) return;
      pending.delete(String(id));
      clearTimeout(entry.timer);
      const error = message.error as { message?: unknown } | undefined;
      if (error) entry.reject(new Error(typeof error.message === "string" ? error.message : "Codex request failed."));
      else entry.resolve(message.result);
      return;
    }
    if (method) {
      const params = message.params && typeof message.params === "object"
        ? message.params as Record<string, unknown>
        : {};
      args.onNotification({ method, params });
    }
  });

  proc.stderr.on("data", () => {
    // Codex logs to stderr constantly; the host has nothing to report from it.
  });
  // A write racing the process exit raises EPIPE here; the exit handler reports it.
  proc.stdin.on("error", () => {});

  const close = () => {
    if (closed) return;
    closed = true;
    failAll("The voice host has stopped.");
    reader.close();
    try {
      killTimer = terminateChildProcessTree(proc, killTimer);
    } catch {
      // Already gone.
    }
  };

  proc.on("exit", (code, signal) => {
    const wasClosed = closed;
    closed = true;
    failAll("The voice host exited.");
    if (killTimer) clearTimeout(killTimer);
    if (!wasClosed) {
      logger.warn("agent_chat.codex_voice_host_exited", { sessionId, code, signal });
      args.onExit(`Codex voice host exited (${signal ?? code ?? "unknown"}).`);
    }
  });
  proc.on("error", (error) => {
    logger.warn("agent_chat.codex_voice_host_error", { sessionId, error: error.message });
    close();
    args.onExit(`Could not start Codex for voice: ${error.message}`);
  });

  try {
    await request("initialize", {
      clientInfo: { name: "ade-voice", title: "ADE voice", version: "1" },
      capabilities: { experimentalApi: true },
    });
    write({ method: "initialized", params: {} });
    const account = await request<{ account?: { type?: unknown; planType?: unknown } | null }>("account/read", {})
      .catch(() => null);
    const accountType = typeof account?.account?.type === "string" ? account.account.type.toLowerCase() : null;
    if (accountType && accountType !== "chatgpt") {
      throw new Error("Voice needs Codex signed in with ChatGPT. An API key cannot run voice.");
    }
    if (!account?.account) {
      throw new Error("Voice needs Codex signed in with ChatGPT. Sign in to Codex and try again.");
    }
    const planType = typeof account.account.planType === "string" ? account.account.planType : null;
    if (!codexPlanIncludesVoice(planType)) {
      throw new Error(`Your ChatGPT plan (${planType}) does not include Codex voice.`);
    }
    const started = await request<{ thread?: { id?: unknown } }>("thread/start", {
      model: "gpt-6-luna",
      cwd: args.cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      developerInstructions: RELAY_INSTRUCTIONS,
      config: { model_reasoning_effort: "low" },
    });
    const threadId = typeof started?.thread?.id === "string" ? started.thread.id : "";
    if (!threadId) throw new Error("Codex did not start a voice thread.");
    logger.info("agent_chat.codex_voice_host_ready", { sessionId, threadId, planType });
    return { threadId, planType, request, close };
  } catch (error) {
    close();
    throw error;
  }
}
