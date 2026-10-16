import { createHash, randomUUID } from "node:crypto";
import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../logging/logger";
import { terminateChildProcessTree } from "../shared/utils";
import { cursorSdkOwnerPidArg } from "./cursorSdkWorkerGuards";
import type {
  CopilotSdkSessionConfig,
  CopilotSdkAttachment,
  CopilotSdkWorkerInit,
  CopilotSdkWorkerRequest,
  CopilotSdkWorkerResponse,
} from "./copilotSdkProtocol";

type Waiter = { resolve: (value: unknown) => void; reject: (error: Error) => void; type: string };
export type CopilotSdkBridge = {
  onEvent: ((chatId: string, event: unknown) => void) | null;
  onWorkerExit: ((chatId: string, error: Error) => void) | null;
  onPermissionRequest: ((chatId: string, waiterId: string, request: unknown) => Promise<unknown>) | null;
  onExitPlanRequest: ((chatId: string, waiterId: string, request: unknown) => Promise<unknown>) | null;
  onUserInputRequest: ((chatId: string, waiterId: string, request: unknown) => Promise<unknown>) | null;
  onMcpAuthRequest: ((chatId: string, waiterId: string, request: unknown) => Promise<unknown>) | null;
};
export type CopilotSdkPooled = {
  process: ChildProcess;
  bridge: CopilotSdkBridge;
  request<T = unknown>(type: CopilotSdkWorkerRequest["type"], payload?: unknown): Promise<T>;
  openSession(config: CopilotSdkSessionConfig, resume: boolean): Promise<{ sessionId: string; events: unknown[] }>;
  send(chatId: string, prompt: string, attachments?: CopilotSdkAttachment[], mode?: "enqueue" | "immediate"): Promise<unknown>;
  setModel(chatId: string, model: string, reasoningEffort?: string | null): Promise<void>;
  abort(chatId: string): Promise<void>;
  disconnect(chatId: string): Promise<void>;
  utility(args: { cwd: string; prompt: string; model?: string; systemMessage?: string }): Promise<unknown>;
  dispose(): void;
};

type PoolEntry = { generation: number; refs: number; pooled: CopilotSdkPooled };
const pools = new Map<string, PoolEntry>();
const pending = new Map<string, Promise<CopilotSdkPooled>>();
let generationCounter = 0;
const moduleDir = typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
const DISPOSE_GRACE_MS = 4_000;

function resolveWorkerPath(): string {
  const candidates = [
    path.join(moduleDir, "copilotSdkWorker.cjs"),
    path.join(process.cwd(), "dist", "main", "copilotSdkWorker.cjs"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}

function poolKey(init: CopilotSdkWorkerInit): string {
  const envFingerprint = createHash("sha256")
    .update(Object.entries(init.baseEnv).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value ?? ""}`).join("\0"))
    .digest("hex");
  return `${init.cliPath}\0${init.baseDirectory}\0${envFingerprint}`;
}

async function create(init: CopilotSdkWorkerInit, logger?: Logger): Promise<CopilotSdkPooled> {
  // The shared SDK orphan sweep reads this marker to distinguish a worker
  // whose owning brain died from one owned by another live ADE instance.
  const child = fork(resolveWorkerPath(), [cursorSdkOwnerPidArg(process.pid)], {
    cwd: process.cwd(),
    env: { ...init.baseEnv },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    execArgv: [],
    windowsHide: true,
  } as ForkOptions & { windowsHide: boolean });
  const waiters = new Map<string, Waiter>();
  const errorClosed = () => new Error("Copilot SDK worker IPC channel is closed.");
  const send = (message: CopilotSdkWorkerRequest): void => {
    if (child.exitCode != null || child.killed || child.connected === false) throw errorClosed();
    child.send(message);
  };
  const bridge: CopilotSdkBridge = { onEvent: null, onWorkerExit: null, onPermissionRequest: null, onExitPlanRequest: null, onUserInputRequest: null, onMcpAuthRequest: null };
  const pooled: CopilotSdkPooled = {
    process: child,
    bridge,
    request: <T>(type: CopilotSdkWorkerRequest["type"], payload?: unknown) => {
      const requestId = randomUUID();
      return new Promise<T>((resolve, reject) => {
        waiters.set(requestId, { resolve: (value) => resolve(value as T), reject, type });
        try { send({ type, requestId, payload } as CopilotSdkWorkerRequest); }
        catch (error) { waiters.delete(requestId); reject(error instanceof Error ? error : new Error(String(error))); }
      });
    },
    openSession: (config, resume) => pooled.request(resume ? "resume" : "create", config),
    send: (chatId, prompt, attachments, mode) => pooled.request("send", { chatId, prompt, attachments, mode }),
    setModel: async (chatId, model, reasoningEffort) => { await pooled.request("set_model", { chatId, model, reasoningEffort }); },
    abort: async (chatId) => { await pooled.request("abort", { chatId }); },
    disconnect: async (chatId) => { await pooled.request("disconnect", { chatId }); },
    utility: (args) => pooled.request("utility", args),
    dispose: () => {
      for (const waiter of waiters.values()) waiter.reject(new Error("Copilot SDK worker disposed."));
      waiters.clear();
      try { send({ type: "dispose", requestId: randomUUID() }); } catch { /* worker already gone */ }
      const timer = setTimeout(() => {
        if (child.exitCode == null && !child.killed) terminateChildProcessTree(child, null, 1_500).unref();
      }, DISPOSE_GRACE_MS);
      timer.unref();
    },
  };
  child.stdout?.on("data", (chunk) => { const text = String(chunk).trim(); if (text) logger?.debug("agent_chat.copilot_sdk_worker_stdout", { text }); });
  child.stderr?.on("data", (chunk) => { const text = String(chunk).trim(); if (text) logger?.warn("agent_chat.copilot_sdk_worker_stderr", { text }); });
  const rejectAll = (error: Error) => { for (const waiter of waiters.values()) waiter.reject(error); waiters.clear(); };
  child.on("message", (raw: unknown) => {
    const message = raw as CopilotSdkWorkerResponse;
    if (!message || typeof message !== "object" || !message.type) return;
    if (message.type === "response") {
      const waiter = waiters.get(message.requestId);
      if (!waiter) return;
      waiters.delete(message.requestId);
      if (message.ok) waiter.resolve(message.result);
      else waiter.reject(new Error(`Copilot SDK ${waiter.type} failed: ${message.error}`));
      return;
    }
    if (message.type === "event") { bridge.onEvent?.(message.chatId, message.event); return; }
    if (message.type === "log") { logger?.[message.level === "error" ? "warn" : message.level]?.(`agent_chat.copilot_sdk_worker_${message.level}`, { message: message.message, detail: message.detail }); return; }
    const callback = message.type === "permission_request" ? bridge.onPermissionRequest
      : message.type === "exit_plan_request" ? bridge.onExitPlanRequest
        : message.type === "user_input_request" ? bridge.onUserInputRequest : bridge.onMcpAuthRequest;
    void Promise.resolve(callback?.(message.chatId, message.waiterId, message.request) ?? (message.type === "permission_request" ? { kind: "reject" } : message.type === "exit_plan_request" ? { approved: false, feedback: "No ADE plan approval handler is available." } : message.type === "mcp_auth_request" ? { kind: "cancelled" } : { answer: "", wasFreeform: true }))
      .then((result) => {
        const response = message.type === "permission_request"
          ? { type: "respond_permission" as const, payload: { waiterId: message.waiterId, result } }
          : message.type === "exit_plan_request"
            ? { type: "respond_exit_plan" as const, payload: { waiterId: message.waiterId, result } }
          : message.type === "user_input_request"
            ? { type: "respond_user_input" as const, payload: { waiterId: message.waiterId, response: result } }
            : { type: "respond_mcp_auth" as const, payload: { waiterId: message.waiterId, result } };
        pooled.request(response.type, response.payload).catch((error) => logger?.warn("agent_chat.copilot_sdk_callback_failed", { error: error instanceof Error ? error.message : String(error) }));
      });
  });
  child.on("error", (error) => rejectAll(error));
  child.on("exit", (code, signal) => {
    const error = new Error(`Copilot SDK worker exited (${code ?? signal ?? "unknown"}).`);
    rejectAll(error);
    for (const [key, entry] of pools) if (entry.pooled === pooled) pools.delete(key);
    const chatId = typeof init.baseEnv.ADE_CHAT_SESSION_ID === "string" ? init.baseEnv.ADE_CHAT_SESSION_ID : null;
    if (chatId) bridge.onWorkerExit?.(chatId, error);
  });
  try { await pooled.request("init", init); }
  catch (error) { pooled.dispose(); throw error; }
  return pooled;
}

export async function acquireCopilotSdkConnection(args: {
  cliPath: string;
  baseDirectory: string;
  baseEnv: NodeJS.ProcessEnv;
  logger?: Logger;
}): Promise<{ pooled: CopilotSdkPooled; generation: number; poolKey: string }> {
  const init = { cliPath: args.cliPath, baseDirectory: args.baseDirectory, baseEnv: args.baseEnv };
  const key = poolKey(init);
  for (let staleInitRetries = 0; ; staleInitRetries += 1) {
    const active = pools.get(key);
    if (active && active.pooled.process.exitCode == null && !active.pooled.process.killed) {
      active.refs += 1;
      return { pooled: active.pooled, generation: active.generation, poolKey: key };
    }
    if (active) pools.delete(key);
    let promise = pending.get(key);
    if (!promise) {
      promise = create(init, args.logger).finally(() => pending.delete(key));
      pending.set(key, promise);
    }
    const pooled = await promise;
    let entry = pools.get(key);
    const live = pooled.process.exitCode == null && !pooled.process.killed;
    if (!live) {
      pooled.dispose();
      if (staleInitRetries >= 2) throw new Error("Copilot SDK worker initialization did not settle after retries.");
      continue;
    }
    if (!entry || entry.pooled !== pooled) {
      entry = { pooled, generation: ++generationCounter, refs: 0 };
      pools.set(key, entry);
    }
    entry.refs += 1;
    return { pooled: entry.pooled, generation: entry.generation, poolKey: key };
  }
}

export function releaseCopilotSdkConnection(poolKey: string, generation: number): void {
  const entry = pools.get(poolKey);
  if (!entry || entry.generation !== generation) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs === 0) { pools.delete(poolKey); entry.pooled.dispose(); }
}

