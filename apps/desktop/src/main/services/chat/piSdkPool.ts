import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../logging/logger";
import { terminateChildProcessTree } from "../shared/utils";
import {
  PI_SDK_PROTOCOL_VERSION,
  parsePiSdkWorkerResponse,
  parsePiSdkWorkerRequest,
  validatePiSdkWorkerRequest,
  validatePiSdkWorkerResult,
  type JsonValue,
  type PiSdkCompactPayload,
  type PiSdkModelRef,
  type PiSdkPackageLocation,
  type PiSdkPromptPayload,
  type PiSdkImage,
  type PiSdkReady,
  type PiSdkWorkerInit,
  type PiSdkWorkerRequest,
} from "./piSdkProtocol";
import { buildPiWorkerEnvironment } from "./piSdkEnvironment";

export type PiSdkBridge = {
  onEvent: ((event: JsonValue) => void) | null;
  onLifecycle: ((event: string, requestId?: string, detail?: JsonValue) => void) | null;
  onError: ((error: Error, operation?: string, requestId?: string) => void) | null;
  onReady: ((ready: PiSdkReady) => void) | null;
};

type PiSdkRequestType = PiSdkWorkerRequest["type"];
type PiSdkRequestPayload<K extends PiSdkRequestType> =
  Extract<PiSdkWorkerRequest, { type: K }> extends { payload?: infer P } ? P : never;
type PiSdkRequestArgs<K extends PiSdkRequestType> = K extends
  | "init"
  | "send"
  | "steer"
  | "follow_up"
  | "set_model"
  | "set_thinking"
  ? [payload: PiSdkRequestPayload<K>]
  : K extends "compact"
    ? [payload?: PiSdkRequestPayload<K>]
    : [];
type PiSdkRequestResult<K extends PiSdkRequestType> = K extends "init" | "set_model" | "set_thinking"
  ? PiSdkReady
  : K extends "models"
    ? JsonValue[]
    : K extends "auth"
      ? JsonValue
    : JsonValue | undefined;

export type PiSdkPooled = {
  process: ChildProcess;
  bridge: PiSdkBridge;
  ready: PiSdkReady | null;
  sessionFile: string | null;
  sessionId: string | null;
  currentModel: JsonValue | null;
  version: string | null;
  availableModels: JsonValue[];
  request: <K extends PiSdkRequestType>(type: K, ...args: PiSdkRequestArgs<K>) => Promise<PiSdkRequestResult<K>>;
  sendPrompt: (payload: PiSdkPromptPayload) => Promise<unknown>;
  steer: (prompt: string, images?: PiSdkImage[]) => Promise<unknown>;
  followUp: (prompt: string, images?: PiSdkImage[]) => Promise<unknown>;
  abort: () => Promise<void>;
  setModel: (modelRef: PiSdkModelRef) => Promise<PiSdkReady>;
  setThinking: (thinkingLevel: string) => Promise<PiSdkReady>;
  compact: (payload?: PiSdkCompactPayload) => Promise<unknown>;
  requestModels: () => Promise<JsonValue[]>;
  requestAuth: () => Promise<JsonValue>;
  dispose: () => void;
  /** Resolves only after the worker process has actually exited. */
  waitForExit: () => Promise<void>;
};

export type AcquirePiSdkConnectionArgs = PiSdkPackageLocation & {
  /** Stable for the lifetime of the ADE chat session. */
  poolKey: string;
  cwd: string;
  agentDir: string;
  sessionDir?: string | null;
  modelRef?: PiSdkModelRef | null;
  thinkingLevel?: string | null;
  systemPrompt?: string | null;
  skillsEnv?: Record<string, string>;
  inventoryOnly?: boolean;
  session?: PiSdkWorkerInit["session"];
  tools?: string[];
  noTools?: PiSdkWorkerInit["noTools"];
  /** Usually process.env; never put auth.json or API keys in this payload. */
  baseEnv?: NodeJS.ProcessEnv;
  logger?: Logger;
};

type PendingRpc = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  type: PiSdkWorkerRequest["type"];
  timer: NodeJS.Timeout | null;
};

type PoolEntry = { ref: number; generation: number; pooled: PiSdkPooled };

let generationCounter = 0;
const pools = new Map<string, PoolEntry>();
const pendingInits = new Map<string, Promise<PiSdkPooled>>();
const STALE_INIT_RETRY_LIMIT = 2;
const DISPOSE_GRACE_MS = 1_500;
const REQUEST_TIMEOUT_MS: Partial<Record<PiSdkRequestType, number>> = {
  init: 30_000,
  models: 30_000,
  auth: 15_000,
  set_model: 30_000,
  set_thinking: 15_000,
  abort: 10_000,
};
const moduleDir = typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));

function resolveWorkerPath(): string {
  const candidates = [
    path.join(moduleDir, "piSdkWorker.cjs"),
    path.join(process.cwd(), "dist", "main", "piSdkWorker.cjs"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}

function isAlive(pooled: PiSdkPooled): boolean {
  return pooled.process.exitCode == null && !pooled.process.killed && pooled.process.connected !== false;
}

export function isPiSdkPooledAlive(pooled: PiSdkPooled): boolean {
  return isAlive(pooled);
}

function workerError(operation: string, message: string, detail?: JsonValue): Error {
  const error = new Error(`Pi SDK ${operation} failed: ${message || "unknown error"}`) as Error & { piSdkDetail?: JsonValue };
  if (detail !== undefined) error.piSdkDetail = detail;
  return error;
}

function applyReady(pooled: PiSdkPooled, value: PiSdkReady): void {
  pooled.ready = value;
  pooled.sessionFile = value.sessionFile;
  pooled.sessionId = value.sessionId;
  pooled.currentModel = value.currentModel;
  pooled.version = value.version;
  pooled.availableModels = value.availableModels;
}

export async function acquirePiSdkConnection(
  args: AcquirePiSdkConnectionArgs,
): Promise<{ pooled: PiSdkPooled; generation: number }> {
  if (!args.poolKey.trim()) throw new Error("Pi SDK poolKey must be non-empty.");
  for (let retries = 0; ; retries += 1) {
    const existing = pools.get(args.poolKey);
    if (existing && isAlive(existing.pooled)) {
      existing.ref += 1;
      return { pooled: existing.pooled, generation: existing.generation };
    }
    if (existing) {
      pools.delete(args.poolKey);
      existing.pooled.dispose();
    }

    let owner = false;
    let init = pendingInits.get(args.poolKey);
    if (!init) {
      owner = true;
      init = createPiSdkConnection(args).finally(() => pendingInits.delete(args.poolKey));
      pendingInits.set(args.poolKey, init);
    }
    const pooled = await init;
    const entry = pools.get(args.poolKey);
    if (!entry || entry.pooled !== pooled || !isAlive(pooled)) {
      if (owner) throw new Error("Pi SDK worker was disposed during initialization.");
      if (retries >= STALE_INIT_RETRY_LIMIT) throw new Error("Pi SDK worker initialization did not settle after retries.");
      continue;
    }
    if (!owner) entry.ref += 1;
    return { pooled: entry.pooled, generation: entry.generation };
  }
}

export const acquirePiSdkWorker = acquirePiSdkConnection;

function createPiSdkConnection(args: AcquirePiSdkConnectionArgs): Promise<PiSdkPooled> {
  const initPayload: PiSdkWorkerInit = {
    protocolVersion: PI_SDK_PROTOCOL_VERSION,
    ...(args.packageDir ? { packageDir: args.packageDir } : {}),
    ...(args.packageRoot ? { packageRoot: args.packageRoot } : {}),
    ...(args.packageEntry ? { packageEntry: args.packageEntry } : {}),
    cwd: args.cwd,
    agentDir: args.agentDir,
    sessionDir: args.sessionDir ?? null,
    modelRef: args.modelRef ?? null,
    thinkingLevel: args.thinkingLevel ?? null,
    systemPrompt: args.systemPrompt ?? null,
    ...(args.skillsEnv ? { skillsEnv: args.skillsEnv } : {}),
    ...(args.inventoryOnly ? { inventoryOnly: true } : {}),
    ...(args.session ? { session: args.session } : {}),
    ...(args.tools ? { tools: args.tools } : {}),
    ...(args.noTools ? { noTools: args.noTools } : {}),
  };
  const initMessage: PiSdkWorkerRequest = { protocolVersion: PI_SDK_PROTOCOL_VERSION, type: "init", requestId: randomUUID(), payload: initPayload };
  const validationError = validatePiSdkWorkerRequest(initMessage);
  if (validationError) return Promise.reject(new Error(validationError));

  // fork() forwards windowsHide to spawn(), although the older @types/node
  // bundled by ADE does not include it in ForkOptions.
  const child = fork(resolveWorkerPath(), [], {
    cwd: args.cwd,
    // Environment inheritance preserves Pi's normal provider credential
    // resolution. Credentials themselves never cross the ADE IPC payload.
    // Enforce the Pi environment boundary at the process boundary as well as
    // at production call sites. Tests and future inventory callers cannot
    // accidentally inherit ADE capability/session variables.
    env: buildPiWorkerEnvironment(args.baseEnv ?? process.env, args.agentDir),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    execArgv: [],
    windowsHide: true,
  } as ForkOptions & { windowsHide: boolean });
  const pending = new Map<string, PendingRpc>();
  let disposeTimer: NodeJS.Timeout | null = null;
  let killTimer: NodeJS.Timeout | null = null;
  let disposing = false;
  let lastStderr = "";
  let resolveExit!: () => void;
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const bridge: PiSdkBridge = { onEvent: null, onLifecycle: null, onError: null, onReady: null };
  let terminalFailure: ((error: Error) => void) | null = null;

  const ipcClosed = (): Error => new Error("Pi SDK worker IPC channel is closed.");
  const normalizeError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));
  const rememberStderr = (chunk: unknown): void => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (text.trim()) lastStderr = `${lastStderr}\n${text.trim()}`.slice(-4_000);
  };
  const exitedError = (code: number | null, signal: NodeJS.Signals | null): Error => {
    const detail = lastStderr.trim().replace(/\s+/g, " ");
    return new Error(`Pi SDK worker exited (${code ?? signal ?? "unknown"}).${detail ? ` ${detail}` : ""}`);
  };
  const send = (message: PiSdkWorkerRequest, onError?: (error: Error) => void): boolean => {
    if (child.exitCode != null || child.killed || child.connected === false) {
      onError?.(ipcClosed());
      return false;
    }
    try {
      child.send(message, (error) => { if (error) onError?.(normalizeError(error)); });
      return true;
    } catch (error) {
      onError?.(normalizeError(error));
      return false;
    }
  };
  const clearPendingTimer = (waiter: PendingRpc): void => {
    if (!waiter.timer) return;
    clearTimeout(waiter.timer);
    waiter.timer = null;
  };
  const rejectPending = (error: Error): void => {
    for (const waiter of pending.values()) {
      clearPendingTimer(waiter);
      waiter.reject(error);
    }
    pending.clear();
  };
  const removeFromPools = (): void => {
    for (const [key, entry] of pools) if (entry.pooled === pooled) pools.delete(key);
  };
  const worker: PiSdkPooled = {
    process: child,
    bridge,
    ready: null,
    sessionFile: null,
    sessionId: null,
    currentModel: null,
    version: null,
    availableModels: [],
    request: <K extends PiSdkRequestType>(type: K, ...args: PiSdkRequestArgs<K>) => {
      const requestId = randomUUID();
      const payload = args[0];
      return new Promise<PiSdkRequestResult<K>>((resolve, reject) => {
        const waiter: PendingRpc = {
          resolve: (value) => resolve(value as PiSdkRequestResult<K>),
          reject,
          type,
          timer: null,
        };
        pending.set(requestId, waiter);
        const timeoutMs = REQUEST_TIMEOUT_MS[type];
        if (timeoutMs) {
          waiter.timer = setTimeout(() => {
            if (pending.get(requestId) !== waiter) return;
            pending.delete(requestId);
            const error = new Error(`Pi SDK ${type} request timed out after ${timeoutMs}ms.`);
            clearPendingTimer(waiter);
            waiter.reject(error);
            terminalFailure?.(error);
          }, timeoutMs);
          waiter.timer.unref();
        }
        const message = { protocolVersion: PI_SDK_PROTOCOL_VERSION, type, requestId, ...(payload === undefined ? {} : { payload }) } as PiSdkWorkerRequest;
        const sent = send(message, (error) => {
          const waiter = pending.get(requestId);
          if (!waiter) return;
          pending.delete(requestId);
          clearPendingTimer(waiter);
          waiter.reject(error);
        });
        if (!sent && pending.delete(requestId)) {
          clearPendingTimer(waiter);
          reject(ipcClosed());
        }
      });
    },
    sendPrompt: (payload) => worker.request("send", payload),
    steer: (prompt, images) => worker.request("steer", { prompt, ...(images?.length ? { images } : {}) }),
    followUp: (prompt, images) => worker.request("follow_up", { prompt, ...(images?.length ? { images } : {}) }),
    abort: () => worker.request("abort").then(() => undefined),
    setModel: async (modelRef) => {
      const value = await worker.request("set_model", { modelRef });
      applyReady(worker, value);
      return value;
    },
    setThinking: async (thinkingLevel) => {
      const value = await worker.request("set_thinking", { thinkingLevel });
      applyReady(worker, value);
      return value;
    },
    compact: (payload) => worker.request("compact", payload),
    requestModels: async () => {
      const value = await worker.request("models");
      worker.availableModels = value;
      if (worker.ready) worker.ready = { ...worker.ready, availableModels: value };
      return value;
    },
    requestAuth: () => worker.request("auth"),
    waitForExit: () => exitPromise,
    dispose: () => {
      disposing = true;
      if (disposeTimer) clearTimeout(disposeTimer);
      if (killTimer) clearTimeout(killTimer);
      for (const waiter of pending.values()) {
        clearPendingTimer(waiter);
        waiter.reject(new Error("Pi SDK worker disposed."));
      }
      pending.clear();
      const escalate = (): void => {
        if (child.exitCode != null || child.killed) return;
        killTimer = terminateChildProcessTree(child, killTimer);
      };
      if (!send({ protocolVersion: PI_SDK_PROTOCOL_VERSION, type: "dispose", requestId: randomUUID() })) {
        escalate();
        return;
      }
      disposeTimer = setTimeout(escalate, DISPOSE_GRACE_MS);
      disposeTimer.unref();
    },
  };

  child.stdout?.on("data", (chunk) => args.logger?.debug("agent_chat.pi_sdk_worker_stdout", { text: String(chunk).trim() }));
  child.stderr?.on("data", (chunk) => {
    rememberStderr(chunk);
    args.logger?.warn("agent_chat.pi_sdk_worker_stderr", { text: String(chunk).trim() });
  });
  child.on("message", (raw: unknown) => {
    const message = parsePiSdkWorkerResponse(raw);
    if (!message) {
      args.logger?.warn("agent_chat.pi_sdk_worker_invalid_message", { message: "Rejected malformed worker response." });
      terminalFailure?.(new Error("Pi SDK worker sent a malformed response."));
      return;
    }
    if (message.type === "response") {
      const waiter = pending.get(message.requestId);
      if (!waiter) return;
      pending.delete(message.requestId);
      clearPendingTimer(waiter);
      if (message.ok) {
        const resultError = validatePiSdkWorkerResult(waiter.type, message.result);
        if (resultError) {
          const error = workerError(waiter.type, resultError);
          waiter.reject(error);
          terminalFailure?.(error);
        } else {
          waiter.resolve(message.result);
        }
      } else {
        const error = workerError(waiter.type, message.error, message.detail);
        waiter.reject(error);
        // A provider/request error is recoverable; the worker remains usable
        // for auth failures and model changes. Only malformed protocol data
        // or a timeout invalidates the process.
      }
      return;
    }
    if (message.type === "ready") {
      const initPending = [...pending.values()].some((waiter) => waiter.type === "init");
      if (worker.ready !== null || !initPending) {
        terminalFailure?.(new Error("Pi SDK worker sent an unsolicited ready message."));
        return;
      }
      applyReady(worker, message.ready);
      bridge.onReady?.(message.ready);
      return;
    }
    if (message.type === "sdk_event") {
      bridge.onEvent?.(message.event);
      return;
    }
    if (message.type === "lifecycle") {
      bridge.onLifecycle?.(message.event, message.requestId, message.detail);
      return;
    }
    if (message.type === "error") {
      bridge.onError?.(workerError(message.operation, message.error, message.detail), message.operation, message.requestId);
      return;
    }
    if (message.type === "log") {
      const level = message.level === "error" ? "warn" : message.level;
      args.logger?.[level]?.("agent_chat.pi_sdk_worker_log", { message: message.message, detail: message.detail });
    }
  });
  child.on("error", (error) => {
    rejectPending(normalizeError(error));
    removeFromPools();
  });
  child.on("exit", (code, signal) => {
    resolveExit();
    if (disposeTimer) clearTimeout(disposeTimer);
    if (killTimer) clearTimeout(killTimer);
    disposeTimer = null;
    killTimer = null;
    const error = exitedError(code, signal);
    rejectPending(error);
    removeFromPools();
    if (!disposing) bridge.onError?.(error, "worker");
  });

  const pooled = worker;
  let failed = false;
  terminalFailure = (error: Error): void => {
    if (failed || disposing) return;
    failed = true;
    disposing = true;
    rejectPending(error);
    removeFromPools();
    bridge.onError?.(error, "worker");
    killTimer = terminateChildProcessTree(child, killTimer);
  };
  return (async () => {
    try {
      const result = await pooled.request("init", initPayload);
      applyReady(pooled, result);
      const generation = ++generationCounter;
      pools.set(args.poolKey, { ref: 1, generation, pooled });
      return pooled;
    } catch (error) {
      pooled.dispose();
      await pooled.waitForExit();
      throw error;
    }
  })();
}

export function releasePiSdkConnection(poolKey: string, generation?: number, onDisposed?: () => void): void {
  const entry = pools.get(poolKey);
  if (!entry) {
    onDisposed?.();
    return;
  }
  if (generation !== undefined && generation !== entry.generation) return;
  entry.ref = Math.max(0, entry.ref - 1);
  if (entry.ref === 0) {
    pools.delete(poolKey);
    entry.pooled.dispose();
    void entry.pooled.waitForExit().finally(() => onDisposed?.());
  }
}

export const releasePiSdkWorker = releasePiSdkConnection;

/** Useful to callers that need to validate an IPC-shaped request in tests. */
export { parsePiSdkWorkerRequest };
