import { createHash, randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../logging/logger";
import { captureWorkerFailure } from "../../sentry/workerFailures";
import { resolveCopilotSdkRuntime } from "../ai/acpExecutables";
import { pinnedToolNotReadyError } from "../ai/pinnedProviderTools";
import { copilotVersionRejectionMessage, detectCopilotVersionRejection } from "../ai/providerVersionRejection";
import { getPinnedToolStatus } from "../../../../../ade-cli/src/services/tools/pinnedTool";
import { pinnedToolSelfUpdateEnv } from "../../../shared/pinnedToolSpawnEnv";
import { terminateChildProcessTree } from "../shared/utils";
import { cursorSdkOwnerPidArg } from "./cursorSdkWorkerGuards";
import { startSdkWorker } from "./sdkWorkerProcess";
import type {
  AgentChatCopilotAutoTier,
  AgentChatCopilotContextTier,
} from "../../../shared/types/chat";
import type {
  CopilotSdkAgentMode,
  CopilotSlashCommandInfo,
  CopilotSlashCommandResult,
  CopilotSdkSessionConfig,
  CopilotSdkAttachment,
  CopilotSdkWorkerInit,
  CopilotSdkWorkerRequest,
  CopilotSdkWorkerResponse,
} from "./copilotSdkProtocol";
import { COPILOT_SDK_WAITERS, type CopilotSdkWaiterType } from "./copilotSdkProtocol";

type Waiter = { resolve: (value: unknown) => void; reject: (error: Error) => void; type: string };
export type CopilotSdkBridge = {
  onEvent: ((chatId: string, event: unknown) => void) | null;
  onWorkerExit: ((chatId: string, error: Error) => void) | null;
  onPermissionRequest: ((chatId: string, waiterId: string, request: unknown) => Promise<unknown>) | null;
  onExitPlanRequest: ((chatId: string, waiterId: string, request: unknown) => Promise<unknown>) | null;
  onUserInputRequest: ((chatId: string, waiterId: string, request: unknown) => Promise<unknown>) | null;
  onMcpAuthRequest: ((chatId: string, waiterId: string, request: unknown) => Promise<unknown>) | null;
  onAutoModeSwitchRequest: ((chatId: string, waiterId: string, request: unknown) => Promise<unknown>) | null;
  onElicitationRequest: ((chatId: string, waiterId: string, request: unknown) => Promise<unknown>) | null;
};
/** The bridge handler that answers each kind of worker request. */
const WAITER_HANDLERS = {
  permission_request: "onPermissionRequest",
  exit_plan_request: "onExitPlanRequest",
  user_input_request: "onUserInputRequest",
  mcp_auth_request: "onMcpAuthRequest",
  auto_mode_switch_request: "onAutoModeSwitchRequest",
  elicitation_request: "onElicitationRequest",
} as const satisfies Record<CopilotSdkWaiterType, keyof CopilotSdkBridge>;

export type CopilotSdkPooled = {
  process: ChildProcess;
  bridge: CopilotSdkBridge;
  request<T = unknown>(type: CopilotSdkWorkerRequest["type"], payload?: unknown): Promise<T>;
  openSession(config: CopilotSdkSessionConfig, resume: boolean): Promise<{ sessionId: string; events: unknown[]; permissionMode?: string; permissionError?: string | null }>;
  send(chatId: string, prompt: string, attachments?: CopilotSdkAttachment[], mode?: "enqueue" | "immediate", agentMode?: CopilotSdkAgentMode, displayPrompt?: string): Promise<unknown>;
  listCommands(chatId: string): Promise<CopilotSlashCommandInfo[]>;
  invokeCommand(chatId: string, name: string, input?: string): Promise<CopilotSlashCommandResult>;
  setModel(chatId: string, model: string, reasoningEffort?: string | null, options?: { contextTier?: AgentChatCopilotContextTier; autoTier?: AgentChatCopilotAutoTier | null }): Promise<void>;
  setAutoTier(chatId: string, autoTier: AgentChatCopilotAutoTier | null): Promise<{ status: "unchanged" | "pending"; [key: string]: unknown }>;
  setPermissionMode(chatId: string, permissionMode: string): Promise<{ mode: string; error?: string | null }>;
  forkSession(chatId: string, sessionId: string, options?: { throughEventId?: string; throughMessageText?: string; throughMessageOrdinal?: number }): Promise<string>;
  abort(chatId: string): Promise<void>;
  disconnect(chatId: string): Promise<void>;
  utility(args: { cwd: string; prompt: string; model?: string; systemMessage?: string }): Promise<unknown>;
  accountQuota(gitHubToken?: string): Promise<unknown>;
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

/**
 * Copilot refusing to run because the organisation's managed settings require
 * a newer client, in the precise words (required and pinned versions, and that
 * only an ADE update helps); null for every other text. ADE never moves
 * Copilot past its pin: the runtime is paired with @github/copilot-sdk.
 */
export function copilotUpdateRequiredMessage(text: unknown, logger?: Logger): string | null {
  const rejection = detectCopilotVersionRejection(text);
  if (!rejection) return null;
  const pinned = getPinnedToolStatus("copilot");
  logger?.warn("agent_chat.copilot_client_update_required", {
    requiredVersion: rejection.requiredVersion,
    reportedVersion: rejection.reportedVersion,
    pinnedVersion: pinned.version,
  });
  return copilotVersionRejectionMessage(rejection, pinned.runningVersion ?? pinned.version);
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
  const child = startSdkWorker({
    worker: "copilot",
    workerPath: resolveWorkerPath,
    argv: [cursorSdkOwnerPidArg(process.pid)],
    cwd: process.cwd(),
    env: { ...init.baseEnv },
  });
  const waiters = new Map<string, Waiter>();
  const errorClosed = () => new Error("Copilot SDK worker IPC channel is closed.");
  const send = (message: CopilotSdkWorkerRequest): void => {
    if (child.exitCode != null || child.killed || child.connected === false) throw errorClosed();
    child.send(message);
  };
  const bridge: CopilotSdkBridge = { onEvent: null, onWorkerExit: null, onPermissionRequest: null, onExitPlanRequest: null, onUserInputRequest: null, onMcpAuthRequest: null, onAutoModeSwitchRequest: null, onElicitationRequest: null };
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
    send: (chatId, prompt, attachments, mode, agentMode, displayPrompt) => pooled.request("send", { chatId, prompt, attachments, mode, agentMode, displayPrompt }),
    listCommands: async (chatId) => (await pooled.request<{ commands?: CopilotSlashCommandInfo[] }>("commands", { chatId }))?.commands ?? [],
    invokeCommand: (chatId, name, input) => pooled.request("command", { chatId, name, ...(input ? { input } : {}) }),
    setModel: async (chatId, model, reasoningEffort, options = {}) => { await pooled.request("set_model", { chatId, model, reasoningEffort, ...options }); },
    setAutoTier: (chatId, autoTier) => pooled.request("set_auto_tier", { chatId, autoTier }),
    setPermissionMode: (chatId, permissionMode) => pooled.request("set_permission_mode", { chatId, permissionMode }),
    forkSession: async (chatId, sessionId, options = {}) => pooled.request("fork_session", { chatId, sessionId, ...options }),
    abort: async (chatId) => { await pooled.request("abort", { chatId }); },
    disconnect: async (chatId) => { await pooled.request("disconnect", { chatId }); },
    utility: (args) => pooled.request("utility", args),
    accountQuota: (gitHubToken) => pooled.request("account_quota", gitHubToken ? { gitHubToken } : {}),
    dispose: () => {
      for (const waiter of waiters.values()) waiter.reject(new Error("Copilot SDK worker disposed."));
      waiters.clear();
      try { send({ type: "dispose", requestId: randomUUID() }); } catch { /* worker already gone */ }
      const timer = setTimeout(() => {
        // Still running: exited on its own neither by code nor by signal.
        if (child.exitCode == null && child.signalCode == null) terminateChildProcessTree(child, null, 1_500).unref();
      }, DISPOSE_GRACE_MS);
      timer.unref();
    },
  };
  child.stdout?.on("data", (chunk) => { const text = String(chunk).trim(); if (text) logger?.debug("agent_chat.copilot_sdk_worker_stdout", { text }); });
  child.stderr?.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (!text) return;
    logger?.warn("agent_chat.copilot_sdk_worker_stderr", { text });
    copilotUpdateRequiredMessage(text, logger);
  });
  const rejectAll = (error: Error) => { for (const waiter of waiters.values()) waiter.reject(error); waiters.clear(); };
  child.on("message", (raw: unknown) => {
    const message = raw as CopilotSdkWorkerResponse;
    if (!message || typeof message !== "object" || !message.type) return;
    if (message.type === "response") {
      const waiter = waiters.get(message.requestId);
      if (!waiter) return;
      waiters.delete(message.requestId);
      if (message.ok) waiter.resolve(message.result);
      else waiter.reject(new Error(copilotUpdateRequiredMessage(message.error, logger) ?? `Copilot SDK ${waiter.type} failed: ${message.error}`));
      return;
    }
    if (message.type === "event") { bridge.onEvent?.(message.chatId, message.event); return; }
    if (message.type === "log") {
      logger?.[message.level === "error" ? "warn" : message.level]?.(`agent_chat.copilot_sdk_worker_${message.level}`, { message: message.message, detail: message.detail });
      // The worker has no Sentry SDK; its unhandled failures become issues here.
      captureWorkerFailure("copilot", message);
      return;
    }
    const waiter = COPILOT_SDK_WAITERS[message.type];
    const callback = bridge[WAITER_HANDLERS[message.type]];
    const respond = (answer: unknown) => {
      pooled.request(waiter.respondType, { waiterId: message.waiterId, [waiter.payloadKey]: answer }).catch((error) => logger?.warn("agent_chat.copilot_sdk_callback_failed", { error: error instanceof Error ? error.message : String(error) }));
    };
    void Promise.resolve(callback ? callback(message.chatId, message.waiterId, message.request) : waiter.fallback)
      .then(respond, (error) => {
        // Copilot waits on every request until it gets an answer, so a failed
        // handler still answers, with the fallback that never approves.
        logger?.warn("agent_chat.copilot_sdk_handler_failed", { type: message.type, error: error instanceof Error ? error.message : String(error) });
        respond(waiter.fallback);
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

/** Read quota through the SDK's server-level account RPC, without opening a chat session. */
export async function readCopilotAccountQuota(args: {
  env: NodeJS.ProcessEnv;
  baseDirectory: string;
  gitHubToken?: string;
  logger?: Logger;
}): Promise<unknown> {
  const executable = resolveCopilotSdkRuntime({ env: args.env });
  if (executable.source === "fallback-command") throw pinnedToolNotReadyError("copilot", "the Copilot runtime");
  const acquired = await acquireCopilotSdkConnection({
    cliPath: executable.path,
    baseDirectory: args.baseDirectory,
    baseEnv: args.env,
    logger: args.logger,
  });
  try {
    return await acquired.pooled.accountQuota(args.gitHubToken);
  } finally {
    releaseCopilotSdkConnection(acquired.poolKey, acquired.generation);
  }
}

/**
 * A worker can still be used. A child killed by a signal keeps `exitCode`
 * null, so the exit code alone reads a dead worker as live.
 */
export function isCopilotSdkWorkerLive(child: ChildProcess): boolean {
  // `killed` is set as soon as ADE sends a signal, before the child has exited.
  return child.exitCode == null && child.signalCode == null && !child.killed && child.connected;
}

export async function acquireCopilotSdkConnection(args: {
  cliPath: string;
  baseDirectory: string;
  baseEnv: NodeJS.ProcessEnv;
  logger?: Logger;
}): Promise<{ pooled: CopilotSdkPooled; generation: number; poolKey: string }> {
  // The runtime gets this env; ADE's pinned copy must not update itself.
  const init = { cliPath: args.cliPath, baseDirectory: args.baseDirectory, baseEnv: { ...args.baseEnv, ...pinnedToolSelfUpdateEnv("copilot") } };
  const key = poolKey(init);
  for (let staleInitRetries = 0; ; staleInitRetries += 1) {
    const active = pools.get(key);
    if (active && isCopilotSdkWorkerLive(active.pooled.process)) {
      active.refs += 1;
      return { pooled: active.pooled, generation: active.generation, poolKey: key };
    }
    if (active) {
      // Not usable, but its process may still be running (an IPC channel can
      // close first), so release it rather than orphan it and its CLI.
      pools.delete(key);
      active.pooled.dispose();
    }
    let promise = pending.get(key);
    if (!promise) {
      promise = create(init, args.logger).finally(() => pending.delete(key));
      pending.set(key, promise);
    }
    const pooled = await promise;
    let entry = pools.get(key);
    const live = isCopilotSdkWorkerLive(pooled.process);
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

