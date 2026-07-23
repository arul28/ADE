import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../logging/logger";
import type {
  DroidSdkAskUserRequest,
  DroidSdkAskUserResponse,
  DroidSdkPermissionDecision,
  DroidSdkPermissionRequest,
  DroidSdkReady,
  DroidSdkSendPrompt,
  DroidSdkSessionSettings,
  DroidSdkWorkerInit,
  DroidSdkWorkerRequest,
  DroidSdkWorkerResponse,
} from "./droidSdkProtocol";

type PendingRpc = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  type: DroidSdkWorkerRequest["type"];
};

export type DroidSdkBridge = {
  onEvent: ((event: unknown) => void) | null;
  onPermissionRequest: ((request: DroidSdkPermissionRequest) => Promise<DroidSdkPermissionDecision>) | null;
  onAskUserRequest: ((request: DroidSdkAskUserRequest) => Promise<DroidSdkAskUserResponse>) | null;
  onReady: ((ready: DroidSdkReady) => void) | null;
};

export type DroidSdkPooled = {
  process: ChildProcess;
  bridge: DroidSdkBridge;
  sdkSessionId: string | null;
  currentModelId: string | null;
  availableModels: DroidSdkReady["availableModels"];
  request: <T = unknown>(type: DroidSdkWorkerRequest["type"], payload?: unknown) => Promise<T>;
  sendPrompt: (payload: DroidSdkSendPrompt) => Promise<unknown>;
  updateSettings: (settings: DroidSdkSessionSettings) => Promise<DroidSdkReady>;
  cancel: () => Promise<void>;
  killWorker: (workerSessionId: string) => Promise<void>;
  dispose: () => void;
};

let droidSdkGenCounter = 0;
const pools = new Map<string, { ref: number; generation: number; pooled: DroidSdkPooled }>();
const pendingInits = new Map<string, Promise<DroidSdkPooled>>();
const STALE_INIT_RETRY_LIMIT = 2;
const moduleDir =
  typeof __dirname === "string"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

function resolveWorkerPath(): string {
  const candidates = [
    path.join(moduleDir, "droidSdkWorker.cjs"),
    path.join(process.cwd(), "dist", "main", "droidSdkWorker.cjs"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
}

function sanitizeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base };
}

export async function acquireDroidSdkConnection(args: {
  poolKey: string;
  droidPath: string;
  workspacePath: string;
  sessionId: string;
  resumeSessionId?: string | null;
  settings: DroidSdkSessionSettings;
  mcpServers?: unknown[];
  baseEnv?: NodeJS.ProcessEnv;
  logger?: Logger;
}): Promise<{ pooled: DroidSdkPooled; generation: number }> {
  for (let staleInitRetries = 0; ; staleInitRetries += 1) {
    const existing = pools.get(args.poolKey);
    if (existing && existing.pooled.process.exitCode == null && !existing.pooled.process.killed) {
      existing.ref += 1;
      return { pooled: existing.pooled, generation: existing.generation };
    }
    if (existing) pools.delete(args.poolKey);

    let initOwner = false;
    let init = pendingInits.get(args.poolKey);
    if (!init) {
      initOwner = true;
      init = createDroidSdkConnection(args).finally(() => pendingInits.delete(args.poolKey));
      pendingInits.set(args.poolKey, init);
    }

    const pooled = await init;
    const entry = pools.get(args.poolKey);
    const live = entry?.pooled === pooled
      && pooled.process.exitCode == null
      && !pooled.process.killed;
    if (!entry || !live) {
      if (initOwner) {
        throw new Error("Droid SDK worker was disposed during initialization.");
      }
      if (staleInitRetries >= STALE_INIT_RETRY_LIMIT) {
        throw new Error("Droid SDK worker initialization did not settle after retries.");
      }
      continue;
    }
    if (!initOwner) entry.ref += 1;
    return { pooled: entry.pooled, generation: entry.generation };
  }
}

async function createDroidSdkConnection(args: Parameters<typeof acquireDroidSdkConnection>[0]): Promise<DroidSdkPooled> {
  const child = fork(resolveWorkerPath(), [], {
    cwd: args.workspacePath,
    env: sanitizeEnv(args.baseEnv ?? process.env),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    execArgv: [],
  });
  const pending = new Map<string, PendingRpc>();
  const bridge: DroidSdkBridge = {
    onEvent: null,
    onPermissionRequest: null,
    onAskUserRequest: null,
    onReady: null,
  };
  const workerIpcClosedError = () => new Error("Droid SDK worker IPC channel is closed.");
  const normalizeIpcSendError = (error: unknown): Error => (
    error instanceof Error ? error : new Error(String(error))
  );
  const sendWorkerMessage = (
    message: DroidSdkWorkerRequest,
    onError?: (error: Error) => void,
  ): boolean => {
    if (child.exitCode != null || child.killed || child.connected === false) {
      onError?.(workerIpcClosedError());
      return false;
    }
    try {
      child.send(message, (error) => {
        if (error) onError?.(normalizeIpcSendError(error));
      });
      return true;
    } catch (error) {
      onError?.(normalizeIpcSendError(error));
      return false;
    }
  };
  const rejectPending = (error: Error) => {
    for (const [, waiter] of pending) waiter.reject(error);
    pending.clear();
  };
  const cleanupPoolEntry = (pooledRef: DroidSdkPooled) => {
    for (const [poolKey, entry] of pools) {
      if (entry.pooled === pooledRef) pools.delete(poolKey);
    }
  };

  child.stdout?.on("data", (chunk) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (text.trim()) args.logger?.debug("agent_chat.droid_sdk_worker_stdout", { text: text.trim() });
  });
  child.stderr?.on("data", (chunk) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (text.trim()) args.logger?.warn("agent_chat.droid_sdk_worker_stderr", { text: text.trim() });
  });

  const pooled: DroidSdkPooled = {
    process: child,
    bridge,
    sdkSessionId: null,
    currentModelId: null,
    availableModels: [],
    request: <T = unknown>(type: DroidSdkWorkerRequest["type"], payload?: unknown) => {
      const requestId = randomUUID();
      return new Promise<T>((resolve, reject) => {
        pending.set(requestId, {
          resolve: (value) => resolve(value as T),
          reject,
          type,
        });
        const sent = sendWorkerMessage({ type, requestId, payload } as DroidSdkWorkerRequest, (error) => {
          const waiter = pending.get(requestId);
          if (!waiter) return;
          pending.delete(requestId);
          waiter.reject(error);
        });
        if (!sent) {
          if (pending.delete(requestId)) {
            reject(workerIpcClosedError());
          }
        }
      });
    },
    sendPrompt: (payload) => pooled.request("send", payload),
    updateSettings: (settings) => pooled.request<DroidSdkReady>("settings_update", settings),
    cancel: () => pooled.request("cancel"),
    killWorker: (workerSessionId) => pooled.request("kill_worker", { workerSessionId }),
    dispose: () => {
      for (const [, waiter] of pending) waiter.reject(new Error("Droid SDK worker disposed."));
      pending.clear();
      sendWorkerMessage({ type: "dispose", requestId: randomUUID() } as DroidSdkWorkerRequest);
      setTimeout(() => {
        if (child.exitCode == null && !child.killed) child.kill("SIGTERM");
      }, 800).unref();
    },
  };

  child.on("message", (raw: unknown) => {
    const message = raw as DroidSdkWorkerResponse;
    if (!message || typeof message !== "object" || !("type" in message)) return;
    if (message.type === "response") {
      const waiter = pending.get(message.requestId);
      if (!waiter) return;
      pending.delete(message.requestId);
      if (message.ok) waiter.resolve(message.result);
      else waiter.reject(new Error(`Droid SDK ${waiter.type} failed: ${message.error || "unknown error"}`));
      return;
    }
    if (message.type === "ready") {
      pooled.sdkSessionId = message.ready.sessionId;
      pooled.currentModelId = message.ready.currentModelId;
      pooled.availableModels = message.ready.availableModels;
      bridge.onReady?.(message.ready);
      return;
    }
    if (message.type === "sdk_event") {
      bridge.onEvent?.(message.event);
      return;
    }
    if (message.type === "permission_request") {
      void (async () => {
        let decision: DroidSdkPermissionDecision;
        try {
          decision = bridge.onPermissionRequest
            ? await bridge.onPermissionRequest(message.request)
            : { selectedOption: "cancel", comment: "ADE is not ready to approve Droid tool calls." };
        } catch (error) {
          args.logger?.error("agent_chat.droid_sdk_permission_error", {
            error: error instanceof Error ? error.message : String(error),
          });
          decision = { selectedOption: "cancel", comment: "Droid permission evaluation failed." };
        }
        sendWorkerMessage({
          type: "permission_response",
          requestId: message.requestId,
          payload: decision,
        } as DroidSdkWorkerRequest, (error) => {
          args.logger?.warn?.("agent_chat.droid_sdk_permission_response_failed", {
            error: error.message,
          });
        });
      })();
      return;
    }
    if (message.type === "ask_user_request") {
      void (async () => {
        let response: DroidSdkAskUserResponse;
        try {
          response = bridge.onAskUserRequest
            ? await bridge.onAskUserRequest(message.request)
            : { cancelled: true, answers: [] };
        } catch (error) {
          args.logger?.error("agent_chat.droid_sdk_ask_user_error", {
            error: error instanceof Error ? error.message : String(error),
          });
          response = { cancelled: true, answers: [] };
        }
        sendWorkerMessage({
          type: "ask_user_response",
          requestId: message.requestId,
          payload: response,
        } as DroidSdkWorkerRequest, (error) => {
          args.logger?.warn?.("agent_chat.droid_sdk_ask_user_response_failed", {
            error: error.message,
          });
        });
      })();
      return;
    }
    if (message.type === "log") {
      const level = message.level === "error" ? "warn" : message.level;
      args.logger?.[level]?.("agent_chat.droid_sdk_worker_log", {
        message: message.message,
        detail: message.detail,
      });
    }
  });

  child.on("error", (error) => {
    rejectPending(normalizeIpcSendError(error));
    cleanupPoolEntry(pooled);
  });

  child.on("exit", (code, signal) => {
    rejectPending(new Error(`Droid SDK worker exited (${code ?? signal ?? "unknown"}).`));
    cleanupPoolEntry(pooled);
  });

  const initPayload: DroidSdkWorkerInit = {
    sessionId: args.sessionId,
    laneRoot: args.workspacePath,
    droidPath: args.droidPath,
    resumeSessionId: args.resumeSessionId ?? null,
    settings: args.settings,
    ...(args.mcpServers?.length ? { mcpServers: args.mcpServers } : {}),
  };
  let ready: DroidSdkReady;
  try {
    ready = await pooled.request<DroidSdkReady>("init", initPayload);
  } catch (error) {
    pooled.dispose();
    throw error;
  }
  pooled.sdkSessionId = ready.sessionId;
  pooled.currentModelId = ready.currentModelId;
  pooled.availableModels = ready.availableModels;
  const generation = ++droidSdkGenCounter;
  pools.set(args.poolKey, { ref: 1, generation, pooled });
  return pooled;
}

export function releaseDroidSdkConnection(poolKey: string, generation?: number): void {
  const entry = pools.get(poolKey);
  if (!entry) return;
  if (generation !== undefined && entry.generation !== generation) return;
  entry.ref -= 1;
  if (entry.ref < 0) entry.ref = 0;
  if (entry.ref <= 0) {
    entry.pooled.dispose();
    pools.delete(poolKey);
  }
}
