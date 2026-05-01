import { fork, type ChildProcess } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../logging/logger";
import type {
  CursorSdkCloudArtifactDescriptor,
  CursorSdkHookDecision,
  CursorSdkHookRequest,
  CursorSdkPermissionPolicy,
  CursorSdkRuntime,
  CursorSdkSendPrompt,
  CursorSdkWorkerInit,
  CursorSdkWorkerRequest,
  CursorSdkWorkerResponse,
} from "./cursorSdkProtocol";

type PendingRpc = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  type: CursorSdkWorkerRequest["type"];
};

export type CursorSdkRuntimeMeta = {
  runtime: CursorSdkRuntime;
  runId?: string;
  agentId?: string;
  requestId?: string;
};

export type CursorSdkBridge = {
  onEvent: ((event: unknown, meta?: CursorSdkRuntimeMeta) => void) | null;
  onRunStarted:
    | ((
        event: { agentId: string; runId: string; modelSdkId?: string | null },
        meta?: CursorSdkRuntimeMeta,
      ) => void)
    | null;
  onRunResult: ((result: unknown, meta?: CursorSdkRuntimeMeta) => void) | null;
  onRunStatus:
    | ((
        event: { agentId: string; runId: string; status: string },
        meta?: CursorSdkRuntimeMeta,
      ) => void)
    | null;
  onCloudArtifact:
    | ((
        artifact: CursorSdkCloudArtifactDescriptor,
        meta?: CursorSdkRuntimeMeta,
      ) => void)
    | null;
  onHookRequest: ((request: CursorSdkHookRequest) => Promise<CursorSdkHookDecision>) | null;
};

export type CursorSdkPooled = {
  process: ChildProcess;
  bridge: CursorSdkBridge;
  agentId: string | null;
  runId: string | null;
  request: <T = unknown>(type: CursorSdkWorkerRequest["type"], payload?: unknown) => Promise<T>;
  sendPrompt: (payload: CursorSdkSendPrompt) => Promise<unknown>;
  updatePolicy: (policy: CursorSdkPermissionPolicy) => Promise<void>;
  cancel: () => Promise<void>;
  dispose: () => void;
};

let cursorSdkGenCounter = 0;
const pools = new Map<string, {
  ref: number;
  generation: number;
  pooled: CursorSdkPooled;
  stateRoot: string;
  cleanupStateRoot: boolean;
}>();
const pendingInits = new Map<string, Promise<CursorSdkPooled>>();

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function resolveWorkerPath(): string {
  const candidates = [
    path.join(__dirname, "cursorSdkWorker.cjs"),
    path.join(process.cwd(), "dist", "main", "cursorSdkWorker.cjs"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
}

function socketPathFor(poolKey: string): string {
  const name = hashKey(poolKey);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\ade-cursor-sdk-${name}`;
  }
  const userPart = typeof process.getuid === "function" ? String(process.getuid()) : hashKey(os.homedir());
  return path.join(os.tmpdir(), `ade-cursor-sdk-${userPart}`, name, "hook.sock");
}

function sanitizeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.CURSOR_API_KEY;
  delete env.CURSOR_AUTH_TOKEN;
  return env;
}

function ensurePrivateDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let fd: number | null = null;
  try {
    // Older Node/platform pairs can omit these open flags; fstat below still
    // verifies the directory shape when the constants are unavailable.
    fd = fs.openSync(
      dir,
      fs.constants.O_RDONLY
        | (fs.constants.O_DIRECTORY ?? 0)
        | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const stat = fs.fstatSync(fd);
    if (!stat.isDirectory()) {
      throw new Error(`Cursor SDK socket directory is not a private directory: ${dir}`);
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(`Cursor SDK socket directory is not owned by the current user: ${dir}`);
    }
    fs.fchmodSync(fd, 0o700);
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function ensurePrivateSocketPath(socketPath: string): void {
  if (process.platform === "win32") return;
  const rootDir = path.dirname(path.dirname(socketPath));
  const socketDir = path.dirname(socketPath);
  ensurePrivateDirectory(rootDir);
  ensurePrivateDirectory(socketDir);
}

export function resolveCursorSdkUserHome(env: NodeJS.ProcessEnv = process.env): string {
  const preferred = process.platform === "win32"
    ? env.USERPROFILE?.trim() || env.HOME?.trim()
    : env.HOME?.trim() || env.USERPROFILE?.trim();
  return preferred || os.homedir();
}

export function buildCursorSdkPaths(args: {
  projectRoot: string;
  poolKey: string;
  userHomeDir?: string;
}): { userHomeDir: string; cacheRoot: string; stateRoot: string; socketPath: string } {
  const keyHash = hashKey(args.poolKey);
  const cacheRoot = path.join(args.projectRoot, ".ade", "cache", "cursor-sdk", keyHash);
  return {
    userHomeDir: args.userHomeDir?.trim() || resolveCursorSdkUserHome(),
    cacheRoot,
    stateRoot: path.join(cacheRoot, "state"),
    socketPath: socketPathFor(args.poolKey),
  };
}

export function buildCursorSdkWorkerEnv(args: {
  baseEnv?: NodeJS.ProcessEnv;
  userHomeDir: string;
  stateRoot: string;
  socketPath: string;
  workspacePath: string;
  sessionId: string;
}): NodeJS.ProcessEnv {
  return {
    ...sanitizeEnv(args.baseEnv ?? process.env),
    HOME: args.userHomeDir,
    USERPROFILE: args.userHomeDir,
    ADE_CURSOR_SDK_SOCKET: args.socketPath,
    ADE_CURSOR_SDK_LANE_ROOT: args.workspacePath,
    ADE_CURSOR_SDK_SESSION_ID: args.sessionId,
    ADE_CURSOR_SDK_STATE_ROOT: args.stateRoot,
  };
}

export async function acquireCursorSdkConnection(args: {
  poolKey: string;
  projectRoot: string;
  workspacePath: string;
  modelSdkId: string;
  apiKey?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  sessionId: string;
  policy: CursorSdkPermissionPolicy;
  cleanupStateRoot?: boolean;
  logger?: Logger;
}): Promise<{ pooled: CursorSdkPooled; generation: number }> {
  const existing = pools.get(args.poolKey);
  if (existing && existing.pooled.process.exitCode == null && !existing.pooled.process.killed) {
    existing.ref += 1;
    return { pooled: existing.pooled, generation: existing.generation };
  }
  if (existing) {
    pools.delete(args.poolKey);
    cleanupCursorSdkStateRoot(existing);
  }

  let initOwner = false;
  let init = pendingInits.get(args.poolKey);
  if (!init) {
    initOwner = true;
    init = createCursorSdkConnection(args).finally(() => {
      pendingInits.delete(args.poolKey);
    });
    pendingInits.set(args.poolKey, init);
  }

  const pooled = await init;
  if (!initOwner) {
    const live = pools.get(args.poolKey);
    if (live?.pooled === pooled) {
      live.ref += 1;
    }
  }
  const entry = pools.get(args.poolKey);
  return { pooled, generation: entry?.generation ?? 0 };
}

async function createCursorSdkConnection(args: Parameters<typeof acquireCursorSdkConnection>[0]): Promise<CursorSdkPooled> {
  const workerPath = resolveWorkerPath();
  const paths = buildCursorSdkPaths({ projectRoot: args.projectRoot, poolKey: args.poolKey });
  fs.mkdirSync(paths.stateRoot, { recursive: true });
  ensurePrivateSocketPath(paths.socketPath);

  const child = fork(workerPath, [], {
    cwd: args.workspacePath,
    env: buildCursorSdkWorkerEnv({
      userHomeDir: paths.userHomeDir,
      stateRoot: paths.stateRoot,
      socketPath: paths.socketPath,
      workspacePath: args.workspacePath,
      sessionId: args.sessionId,
    }),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    execArgv: [],
  });
  const pending = new Map<string, PendingRpc>();
  const bridge: CursorSdkBridge = {
    onEvent: null,
    onRunStarted: null,
    onRunResult: null,
    onRunStatus: null,
    onCloudArtifact: null,
    onHookRequest: null,
  };

  child.stdout?.on("data", (chunk) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (text.trim()) args.logger?.debug("agent_chat.cursor_sdk_worker_stdout", { text: text.trim() });
  });
  child.stderr?.on("data", (chunk) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (text.trim()) args.logger?.warn("agent_chat.cursor_sdk_worker_stderr", { text: text.trim() });
  });

  const pooled: CursorSdkPooled = {
    process: child,
    bridge,
    agentId: null,
    runId: null,
    request: <T = unknown>(type: CursorSdkWorkerRequest["type"], payload?: unknown) => {
      const requestId = randomUUID();
      return new Promise<T>((resolve, reject) => {
        pending.set(requestId, {
          resolve: (value) => resolve(value as T),
          reject,
          type,
        });
        child.send?.({ type, requestId, payload } as CursorSdkWorkerRequest);
      });
    },
    sendPrompt: (payload) => pooled.request("send", payload),
    updatePolicy: (policy) => pooled.request("policy_update", policy),
    cancel: () => pooled.request("cancel"),
    dispose: () => {
      for (const [, waiter] of pending) waiter.reject(new Error("Cursor SDK worker disposed."));
      pending.clear();
      try {
        child.send?.({ type: "dispose", requestId: randomUUID() } as CursorSdkWorkerRequest);
      } catch {
        // ignore
      }
      setTimeout(() => {
        if (child.exitCode == null && !child.killed) child.kill("SIGTERM");
      }, 800).unref();
    },
  };

  child.on("message", (raw: unknown) => {
    const message = raw as CursorSdkWorkerResponse;
    if (!message || typeof message !== "object" || !("type" in message)) return;
    if (message.type === "response") {
      const waiter = pending.get(message.requestId);
      if (!waiter) return;
      pending.delete(message.requestId);
      if (message.ok) waiter.resolve(message.result);
      else waiter.reject(new Error(`Cursor SDK ${waiter.type} failed: ${message.error || "unknown error"}`));
      return;
    }
    if (message.type === "ready") {
      pooled.agentId = message.agentId;
      return;
    }
    if (message.type === "run_started") {
      const runtime: CursorSdkRuntime = message.runtime ?? "local";
      if (runtime === "local") {
        pooled.agentId = message.agentId;
        pooled.runId = message.runId;
      }
      bridge.onRunStarted?.(
        {
          agentId: message.agentId,
          runId: message.runId,
          modelSdkId: message.modelSdkId,
        },
        {
          runtime,
          runId: message.runId,
          agentId: message.agentId,
          requestId: message.requestId,
        },
      );
      return;
    }
    if (message.type === "sdk_event") {
      const runtime: CursorSdkRuntime = message.runtime ?? "local";
      bridge.onEvent?.(message.event, {
        runtime,
        runId: message.runId,
        agentId: message.agentId,
        requestId: message.requestId,
      });
      return;
    }
    if (message.type === "run_result") {
      const runtime: CursorSdkRuntime = message.runtime ?? "local";
      bridge.onRunResult?.(message.result, {
        runtime,
        runId: message.runId,
        agentId: message.agentId,
        requestId: message.requestId,
      });
      return;
    }
    if (message.type === "run_status") {
      bridge.onRunStatus?.(
        { agentId: message.agentId, runId: message.runId, status: message.status },
        {
          runtime: message.runtime,
          runId: message.runId,
          agentId: message.agentId,
          requestId: message.requestId,
        },
      );
      return;
    }
    if (message.type === "hook_request") {
      void (async () => {
        let decision;
        try {
          decision = bridge.onHookRequest
            ? await bridge.onHookRequest(message.request)
            : {
              permission: "deny" as const,
              user_message: "ADE is not ready to approve Cursor tool calls.",
              agent_message: "ADE is not ready to approve Cursor tool calls.",
            };
        } catch (err) {
          args.logger?.error?.("agent_chat.cursor_sdk_hook_error", {
            error: err instanceof Error ? err.message : String(err),
          });
          decision = {
            permission: "deny" as const,
            user_message: "Hook evaluation failed.",
            agent_message: "Hook evaluation failed due to an internal error.",
          };
        }
        child.send?.({
          type: "hook_response",
          requestId: message.requestId,
          payload: decision,
        } as CursorSdkWorkerRequest);
      })();
      return;
    }
    if (message.type === "log") {
      const level = message.level === "error" ? "warn" : message.level;
      args.logger?.[level]?.("agent_chat.cursor_sdk_worker_log", {
        message: message.message,
        detail: message.detail,
      });
    }
  });

  child.on("exit", (code, signal) => {
    for (const [, waiter] of pending) {
      waiter.reject(new Error(`Cursor SDK worker exited (${code ?? signal ?? "unknown"}).`));
    }
    pending.clear();
    for (const [poolKey, entry] of pools) {
      if (entry.pooled === pooled) {
        pools.delete(poolKey);
        cleanupCursorSdkStateRoot(entry);
      }
    }
  });

  const initPayload: CursorSdkWorkerInit = {
    sessionId: args.sessionId,
    laneRoot: args.workspacePath,
    userHomeDir: paths.userHomeDir,
    stateRoot: paths.stateRoot,
    socketPath: paths.socketPath,
    modelSdkId: args.modelSdkId,
    apiKey: args.apiKey ?? null,
    agentId: args.agentId ?? null,
    agentName: args.agentName ?? null,
    policy: args.policy,
  };
  let result: { agentId: string };
  try {
    result = await pooled.request<{ agentId: string }>("init", initPayload);
  } catch (error) {
    // If init fails, the worker child is still alive — dispose it so we don't
    // leak a fork()'d process per failed connection attempt.
    pooled.dispose();
    if (args.cleanupStateRoot) {
      cleanupCursorSdkStateRoot({ stateRoot: paths.stateRoot, cleanupStateRoot: true });
    }
    throw error;
  }
  pooled.agentId = result.agentId;
  const generation = ++cursorSdkGenCounter;
  pools.set(args.poolKey, {
    ref: 1,
    generation,
    pooled,
    stateRoot: paths.stateRoot,
    cleanupStateRoot: args.cleanupStateRoot === true,
  });
  return pooled;
}

function cleanupCursorSdkStateRoot(entry: { stateRoot: string; cleanupStateRoot: boolean }): void {
  if (!entry.cleanupStateRoot) return;
  try {
    fs.rmSync(entry.stateRoot, { recursive: true, force: true });
  } catch {
    // Best effort: stale one-shot SDK state should never break request cleanup.
  }
}

export function releaseCursorSdkConnection(poolKey: string, generation?: number): void {
  const entry = pools.get(poolKey);
  if (!entry) return;
  if (generation !== undefined && entry.generation !== generation) return;
  entry.ref -= 1;
  if (entry.ref < 0) entry.ref = 0;
  if (entry.ref <= 0) {
    entry.pooled.dispose();
    pools.delete(poolKey);
    cleanupCursorSdkStateRoot(entry);
  }
}

export async function runCursorSdkCatalogRequest<T = unknown>(
  args: {
    projectRoot: string;
    workspacePath: string;
    apiKey?: string | null;
    type: "catalog.models" | "catalog.repositories";
    logger?: Logger;
  },
): Promise<T> {
  const poolKey = `catalog:${args.type}:${args.workspacePath}:${Date.now()}:${Math.random()}`;
  const { pooled, generation } = await acquireCursorSdkConnection({
    poolKey,
    projectRoot: args.projectRoot,
    workspacePath: args.workspacePath,
    modelSdkId: "default",
    apiKey: args.apiKey,
    sessionId: "catalog",
    cleanupStateRoot: true,
    policy: {
      chatMode: "agent",
      approvalPolicy: "never",
      sandbox: "off",
      force: true,
      hardGuards: false,
    },
    logger: args.logger,
  });
  try {
    return await pooled.request<T>(args.type, { apiKey: args.apiKey ?? null });
  } finally {
    releaseCursorSdkConnection(poolKey, generation);
  }
}

type CursorSdkCloudOneShotType = Extract<
  CursorSdkWorkerRequest,
  {
    type:
      | "cloud.agent.get"
      | "cloud.agents.list"
      | "cloud.runs.list"
      | "cloud.run.get"
      | "cloud.run.cancel"
      | "cloud.run.conversation"
      | "cloud.artifacts.list"
      | "cloud.artifacts.download";
  }
>["type"];

export async function runCursorSdkCloudRequest<T = unknown>(
  args: {
    projectRoot: string;
    workspacePath: string;
    apiKey?: string | null;
    type: CursorSdkCloudOneShotType;
    payload: Record<string, unknown>;
    logger?: Logger;
  },
): Promise<T> {
  const poolKey = `cloud:${args.type}:${args.workspacePath}:${Date.now()}:${Math.random()}`;
  const { pooled, generation } = await acquireCursorSdkConnection({
    poolKey,
    projectRoot: args.projectRoot,
    workspacePath: args.workspacePath,
    modelSdkId: "default",
    apiKey: args.apiKey,
    sessionId: "cloud-oneshot",
    cleanupStateRoot: true,
    policy: {
      chatMode: "agent",
      approvalPolicy: "never",
      sandbox: "off",
      force: true,
      hardGuards: false,
    },
    logger: args.logger,
  });
  try {
    return await pooled.request<T>(args.type, { apiKey: args.apiKey ?? null, ...args.payload });
  } finally {
    releaseCursorSdkConnection(poolKey, generation);
  }
}
