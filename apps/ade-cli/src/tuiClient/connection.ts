import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveAdeLayout } from "../../../desktop/src/shared/adeLayout";
import { resolveMachineAdeLayout } from "../services/projects/machineLayout";
import { JsonRpcClient } from "./jsonRpcClient";
import type { AdeCodeConnection, ProjectLaunchContext, RuntimeEventGapMetadata } from "./types";
import type { AgentChatEventEnvelope } from "../../../desktop/src/shared/types/chat";
import type { BufferedEvent } from "../eventBuffer";
import { resolveAdeDefaultRole } from "../runtimeRoles";

type RpcResponseEnvelope<T> =
  | T
  | {
      ok: false;
      error: { message?: string };
    };

type AdeRpcRequest = <T>(method: string, params?: unknown) => Promise<T>;

type AdeActionHelpers = Pick<
  AdeCodeConnection,
  "tool" | "action" | "actionList"
>;

type InitializeResult = {
  runtimeInfo?: {
    multiProject?: boolean;
    version?: string | null;
    buildHash?: string | null;
    defaultRole?: string | null;
    projectRoot?: string | null;
    pid?: number | null;
  };
  capabilities?: {
    projects?: boolean;
  };
};

type AttachedRuntimeInfo = {
  buildHash: string | null;
  defaultRole: string | null;
  projectRoot: string | null;
  pid: number | null;
};

type ProjectRecord = {
  projectId: string;
};

export type ProjectCatalogRegistration = {
  catalogVisibility: "recent" | "system";
  registrationSource:
    | "desktop"
    | "mobile"
    | "cli-explicit"
    | "runtime-auto"
    | "test";
};

/**
 * Attaches performed for background or non-interactive reasons — the
 * `--print-state` smoke test, health probes — register the project as a hidden
 * "system" row so they never pollute the phone's project catalog and roster.
 */
export const AUTO_PROJECT_REGISTRATION: ProjectCatalogRegistration = {
  catalogVisibility: "system",
  registrationSource: "runtime-auto",
};

/**
 * An interactive `ade code` launch is an explicit "I'm working in this project
 * on this machine" action — the terminal equivalent of opening the project in
 * the desktop app — so the project is promoted to a "recent" catalog row and
 * shows up on the phone. The daemon's `add()` never demotes an existing recent
 * row, so it is safe to send this on every attach within a live session
 * (initial connect and reconnect probes alike).
 */
export const INTERACTIVE_PROJECT_REGISTRATION: ProjectCatalogRegistration = {
  catalogVisibility: "recent",
  registrationSource: "cli-explicit",
};

type EmbeddedRuntime = {
  dispose: () => void;
  agentChatService?: {
    subscribeToEvents?: (
      callback: (event: AgentChatEventEnvelope) => void,
    ) => () => void;
  };
  eventBuffer?: {
    drain?: (cursor: number, limit?: number) => {
      events: BufferedEvent[];
      nextCursor: number;
      hasMore: boolean;
      gap?: boolean;
      oldestCursor?: number | null;
    };
    subscribe?: (listener: (event: BufferedEvent) => void) => () => void;
  };
};

type DirectHandler = {
  (message: unknown): Promise<unknown>;
  dispose: () => void;
};

type CreateEmbeddedRuntime = (args: {
  projectRoot: string;
  workspaceRoot: string;
  chatRuntime: "agent";
  runtimeProfile: "chat";
}) => Promise<EmbeddedRuntime>;

type CreateEmbeddedRpcRequestHandler = (args: {
  runtime: EmbeddedRuntime;
  serverVersion: string;
}) => DirectHandler;

const DAEMON_CONNECT_RETRY_INITIAL_DELAY_MS = 50;
const DAEMON_CONNECT_RETRY_MAX_DELAY_MS = 200;

const MULTI_PROJECT_RUNTIME_METHODS = new Set([
  "ade/initialize",
  "ade/initialized",
  "ping",
  "shutdown",
  "exit",
  "runtime/info",
  "machineInfo.get",
  "account.call",
  "attention.call",
  "projects.list",
  "projects.add",
  "projects.setCatalogVisibility",
  "projects.remove",
  "projects.touch",
  "projects.browseDirectories",
  "projects.getDetail",
  "projects.getDefaultParentDir",
  "projects.create",
  "projects.clone",
  "projects.listMyGitHubRepos",
]);

async function importRuntimeModule<T>(specifier: string): Promise<T> {
  return (await import(specifier)) as T;
}

function resolveBuiltRuntimeModules(): {
  bootstrap: string;
  rpc: string;
} | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    {
      bootstrap: path.join(moduleDir, "bootstrap.cjs"),
      rpc: path.join(moduleDir, "adeRpcServer.cjs"),
    },
    {
      bootstrap: path.join(moduleDir, "..", "bootstrap.cjs"),
      rpc: path.join(moduleDir, "..", "adeRpcServer.cjs"),
    },
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.bootstrap) || !fs.existsSync(candidate.rpc)) {
      continue;
    }
    return {
      bootstrap: pathToFileURL(candidate.bootstrap).href,
      rpc: pathToFileURL(candidate.rpc).href,
    };
  }
  return null;
}

async function loadEmbeddedAdeCli(): Promise<{
  createAdeRuntime: (args: {
    projectRoot: string;
    workspaceRoot: string;
    chatRuntime: "agent";
    runtimeProfile: "chat";
  }) => Promise<EmbeddedRuntime>;
  createAdeRpcRequestHandler: CreateEmbeddedRpcRequestHandler;
}> {
  const builtModules = resolveBuiltRuntimeModules();
  const [bootstrap, rpc] = await Promise.all([
    importRuntimeModule<typeof import("../bootstrap")>(
      builtModules?.bootstrap ?? "../bootstrap",
    ),
    importRuntimeModule<typeof import("../adeRpcServer")>(
      builtModules?.rpc ?? "../adeRpcServer",
    ),
  ]);
  return {
    createAdeRuntime:
      bootstrap.createAdeRuntime as unknown as CreateEmbeddedRuntime,
    createAdeRpcRequestHandler:
      rpc.createAdeRpcRequestHandler as unknown as CreateEmbeddedRpcRequestHandler,
  };
}

function failedEnvelopeMessage(payload: unknown): string | null {
  if (
    !payload ||
    typeof payload !== "object" ||
    !("ok" in payload) ||
    (payload as { ok?: unknown }).ok !== false
  ) {
    return null;
  }
  const error = (payload as { error?: { message?: string } }).error;
  return typeof error?.message === "string" ? error.message : "";
}

function unwrapActionResult<T>(
  payload: RpcResponseEnvelope<unknown>,
  domain: string,
  action: string,
): T {
  const errorMessage = failedEnvelopeMessage(payload);
  if (errorMessage !== null) {
    throw new Error(errorMessage || `ADE action failed: ${domain}.${action}`);
  }
  return (payload as { result?: unknown }).result as T;
}

function createAdeActionHelpers(request: AdeRpcRequest): AdeActionHelpers {
  return {
    tool: async <T>(
      name: string,
      toolArgs?: Record<string, unknown>,
    ): Promise<T> => {
      const payload = await request<unknown>("ade/actions/call", {
        name,
        arguments: toolArgs ?? {},
      });
      const errorMessage = failedEnvelopeMessage(payload);
      if (errorMessage !== null) {
        throw new Error(errorMessage || `ADE tool failed: ${name}`);
      }
      return payload as T;
    },
    action: async <T>(
      domain: string,
      action: string,
      actionArgs?: Record<string, unknown>,
    ): Promise<T> => {
      const payload = await request<unknown>("ade/actions/call", {
        name: "run_ade_action",
        arguments: { domain, action, args: actionArgs ?? {} },
      });
      return unwrapActionResult<T>(payload, domain, action);
    },
    actionList: async <T>(
      domain: string,
      action: string,
      argsList: unknown[],
    ): Promise<T> => {
      const payload = await request<unknown>("ade/actions/call", {
        name: "run_ade_action",
        arguments: { domain, action, argsList },
      });
      return unwrapActionResult<T>(payload, domain, action);
    },
  };
}

function isBufferedEvent(value: unknown): value is BufferedEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<BufferedEvent>;
  return (
    typeof event.id === "number" &&
    typeof event.timestamp === "string" &&
    typeof event.category === "string" &&
    Boolean(event.payload) &&
    typeof event.payload === "object" &&
    !Array.isArray(event.payload)
  );
}

type RuntimeEventNotification = {
  subscriptionId?: string;
  event?: unknown;
};

type PendingRuntimeEvent = {
  subscriptionId?: string;
  event: BufferedEvent;
};

function runtimeEventGapMetadata(
  value: unknown,
  subscriptionId?: string | null,
): RuntimeEventGapMetadata | null {
  if (!value || typeof value !== "object" || (value as { gap?: unknown }).gap !== true) return null;
  const source = value as {
    oldestCursor?: unknown;
    nextCursor?: unknown;
    subscriptionId?: unknown;
  };
  return {
    gap: true,
    oldestCursor: typeof source.oldestCursor === "number" && Number.isFinite(source.oldestCursor)
      ? Math.max(0, Math.floor(source.oldestCursor))
      : null,
    nextCursor: typeof source.nextCursor === "number" && Number.isFinite(source.nextCursor)
      ? Math.max(0, Math.floor(source.nextCursor))
      : null,
    subscriptionId: typeof source.subscriptionId === "string"
      ? source.subscriptionId
      : subscriptionId ?? null,
  };
}

async function initialize(request: AdeRpcRequest): Promise<InitializeResult> {
  const result = await request<InitializeResult>("ade/initialize", {
    protocolVersion: "2025-06-18",
    clientName: "ade-code",
    identity: {
      role: "cto",
      callerId: `ade-code:${process.pid}`,
    },
  });
  await request("ade/initialized");
  return result;
}

async function initializeEmbeddedCto(request: AdeRpcRequest): Promise<InitializeResult> {
  const previousRole = process.env.ADE_DEFAULT_ROLE;
  const shouldInjectTrustedRole = previousRole?.trim() !== "cto";
  if (shouldInjectTrustedRole) {
    process.env.ADE_DEFAULT_ROLE = "cto";
  }
  try {
    return await initialize(request);
  } finally {
    if (shouldInjectTrustedRole) {
      if (previousRole === undefined) delete process.env.ADE_DEFAULT_ROLE;
      else process.env.ADE_DEFAULT_ROLE = previousRole;
    }
  }
}

async function withAdeDefaultRole<T>(
  role: "cto",
  run: () => Promise<T> | T,
): Promise<T> {
  const previousRole = process.env.ADE_DEFAULT_ROLE;
  process.env.ADE_DEFAULT_ROLE = role;
  try {
    return await run();
  } finally {
    if (previousRole === undefined) delete process.env.ADE_DEFAULT_ROLE;
    else process.env.ADE_DEFAULT_ROLE = previousRole;
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMultiProjectRuntime(result: InitializeResult): boolean {
  return (
    result.runtimeInfo?.multiProject === true ||
    result.capabilities?.projects === true
  );
}

function isAgentChatEventEnvelope(value: unknown): value is AgentChatEventEnvelope {
  if (!isRecord(value)) return false;
  if (typeof value.sessionId !== "string" || typeof value.timestamp !== "string") {
    return false;
  }
  const event = value.event;
  return isRecord(event) && typeof event.type === "string";
}

function runtimeChatEnvelope(event: BufferedEvent): AgentChatEventEnvelope | null {
  if (event.category !== "runtime") return null;
  return isAgentChatEventEnvelope(event.payload) ? event.payload : null;
}

function withProjectId(
  method: string,
  params: unknown,
  projectId: string,
): unknown {
  if (MULTI_PROJECT_RUNTIME_METHODS.has(method)) return params;
  if (isRecord(params)) {
    const existing =
      typeof params.projectId === "string" && params.projectId.trim().length > 0
        ? params.projectId.trim()
        : null;
    return existing ? params : { ...params, projectId };
  }
  return { projectId };
}

function isLikelyAdeCliEntrypoint(candidate: string): boolean {
  const basename = path.basename(candidate).toLowerCase();
  return basename === "ade"
    || basename === "ade-cli"
    || basename === "cli.ts"
    || basename === "cli.js"
    || basename === "cli.cjs"
    || basename === "cli.mjs";
}

function resolveCliEntrypoint(): string | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(moduleDir, "..", "cli.cjs"),
    path.join(moduleDir, "..", "cli.js"),
    path.join(moduleDir, "..", "cli.mjs"),
    process.argv[1],
  ].filter(
    (candidate): candidate is string =>
      typeof candidate === "string" &&
      candidate.trim().length > 0 &&
      (candidate !== process.argv[1] || isLikelyAdeCliEntrypoint(candidate)),
  );
  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(candidate);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile())
        return resolved;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

class StaleAdeSocketError extends Error {
  readonly pid: number | null;

  constructor(message: string, pid: number | null) {
    super(message);
    this.name = "StaleAdeSocketError";
    this.pid = pid;
  }
}

function trimmedStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function readAttachedRuntimeInfo(result: InitializeResult): AttachedRuntimeInfo {
  const runtimeInfo = result.runtimeInfo;
  const pid = runtimeInfo?.pid;
  const projectRoot = trimmedStringOrNull(runtimeInfo?.projectRoot);
  return {
    buildHash: trimmedStringOrNull(runtimeInfo?.buildHash),
    defaultRole: trimmedStringOrNull(runtimeInfo?.defaultRole),
    projectRoot: projectRoot ? path.resolve(projectRoot) : null,
    pid:
      typeof pid === "number" && Number.isFinite(pid) && pid > 0
        ? Math.floor(pid)
        : null,
  };
}

function computeCliEntrypointBuildHash(): string | null {
  const entrypoint = resolveCliEntrypoint();
  if (!entrypoint) return null;
  try {
    return createHash("sha256").update(fs.readFileSync(entrypoint)).digest("hex");
  } catch {
    return null;
  }
}

function attachedRuntimeMismatchReason(
  result: InitializeResult,
  project: ProjectLaunchContext,
  options: { skipBuildHash?: boolean; skipProjectRoot?: boolean } = {},
): { reason: string; pid: number | null } | null {
  const info = readAttachedRuntimeInfo(result);
  if (info.defaultRole !== "cto") {
    return {
      reason: `default role ${info.defaultRole ?? "missing"} is not cto`,
      pid: info.pid,
    };
  }

  const expectedBuildHash = computeCliEntrypointBuildHash();
  if (!options.skipBuildHash && expectedBuildHash && info.buildHash !== expectedBuildHash) {
    return {
      reason: info.buildHash ? "build hash changed" : "build hash missing",
      pid: info.pid,
    };
  }

  if (!options.skipProjectRoot && !isMultiProjectRuntime(result)) {
    const expectedProjectRoot = path.resolve(project.projectRoot);
    if (info.projectRoot !== expectedProjectRoot) {
      return {
        reason: `project root ${info.projectRoot ?? "missing"} does not match ${expectedProjectRoot}`,
        pid: info.pid,
      };
    }
  }

  return null;
}

function spawnDaemon(socketPath: string): boolean {
  const cliEntrypoint = resolveCliEntrypoint();
  const buildHash = computeCliEntrypointBuildHash();
  const nodeArgs =
    cliEntrypoint && path.extname(cliEntrypoint) === ".ts"
      ? process.execArgv.filter((arg) => !arg.startsWith("--inspect"))
      : [];
  const daemonArgs = cliEntrypoint
    ? [...nodeArgs, cliEntrypoint, "serve", "--socket", socketPath]
    : ["serve", "--socket", socketPath];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ADE_DEFAULT_ROLE: "cto",
    ADE_RPC_SOCKET_PATH: socketPath,
  };
  if (buildHash) env.ADE_RUNTIME_BUILD_HASH = buildHash;
  else delete env.ADE_RUNTIME_BUILD_HASH;
  const child = spawn(
    process.execPath,
    daemonArgs,
    {
      detached: true,
      stdio: "ignore",
      env,
    },
  );
  child.unref();
  return true;
}

type SocketSpawnLockOwner = {
  id: string | null;
  pid: number | null;
};

function createSocketSpawnLockOwner(): SocketSpawnLockOwner {
  return {
    id: `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    pid: process.pid,
  };
}

function serializeSocketSpawnLockOwner(owner: SocketSpawnLockOwner): string {
  return JSON.stringify({
    id: owner.id,
    pid: owner.pid,
    createdAt: new Date().toISOString(),
  });
}

function readSocketSpawnLockOwner(lockPath: string): SocketSpawnLockOwner {
  const raw = fs.readFileSync(lockPath, "utf8");
  try {
    const parsed = JSON.parse(raw) as { id?: unknown; pid?: unknown };
    return {
      id: typeof parsed.id === "string" ? parsed.id : null,
      pid: typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0
        ? parsed.pid
        : null,
    };
  } catch {
    const [pidLine] = raw.split(/\r?\n/u);
    const pid = Number.parseInt(pidLine ?? "", 10);
    return {
      id: null,
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    };
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function unlinkSocketSpawnLockIfStale(lockPath: string): boolean {
  try {
    const stat = fs.statSync(lockPath);
    const owner = readSocketSpawnLockOwner(lockPath);
    if (owner.pid != null && processExists(owner.pid)) return false;
    if (owner.pid == null && Date.now() - stat.mtimeMs <= 30_000) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function unlinkSocketSpawnLockIfOwner(lockPath: string, ownerId: string | null): void {
  if (!ownerId) return;
  try {
    const owner = readSocketSpawnLockOwner(lockPath);
    if (owner.id !== ownerId) return;
    fs.unlinkSync(lockPath);
  } catch {
    // ignore cleanup races
  }
}

async function probeLocalSocketLiveness(socketPath: string): Promise<"live" | "stale" | "unknown"> {
  if (socketPath.startsWith("tcp://")) return "unknown";
  return await new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: "live" | "stale" | "unknown") => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    timer = setTimeout(() => finish("unknown"), 500);
    timer.unref?.();
    socket.once("connect", () => finish("live"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
        finish("stale");
        return;
      }
      finish("unknown");
    });
  });
}

async function unlinkStaleLocalSocket(socketPath: string): Promise<boolean> {
  if (socketPath.startsWith("tcp://")) return false;
  try {
    const stat = fs.lstatSync(socketPath);
    if (!stat.isSocket() && !stat.isFile()) return false;
    if (stat.isSocket() && await probeLocalSocketLiveness(socketPath) !== "stale") return false;
    fs.unlinkSync(socketPath);
    return true;
  } catch {
    return false;
  }
}

async function withSocketSpawnLock<T>(socketPath: string, task: () => Promise<T>): Promise<T> {
  if (socketPath.startsWith("tcp://")) return await task();
  const lockPath = path.join(path.dirname(socketPath), `${path.basename(socketPath)}.spawn.lock`);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 10_000;
  const owner = createSocketSpawnLockOwner();
  let fd: number | null = null;
  while (fd == null) {
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(fd, serializeSocketSpawnLockOwner(owner), "utf8");
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      if (unlinkSocketSpawnLockIfStale(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ADE socket spawn lock at ${lockPath}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  try {
    return await task();
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    unlinkSocketSpawnLockIfOwner(lockPath, owner.id);
  }
}

async function connectAttachedSocket(args: {
  socketPath: string;
  project: ProjectLaunchContext;
  shutdownOnStale?: boolean;
  skipRuntimeCompatibilityCheck?: boolean;
  projectRegistration?: ProjectCatalogRegistration;
}): Promise<AdeCodeConnection> {
  let client: JsonRpcClient | null = await JsonRpcClient.connect(
    args.socketPath,
  );
  try {
    const connectedClient = client;
    const rawRequest: AdeRpcRequest = <T>(method: string, params?: unknown) =>
      connectedClient.request<T>(method, params);
    const initializeResult = await withTimeout(
      initialize(rawRequest),
      3000,
      "ADE RPC socket did not finish initialization.",
    );
    const runtimeMismatch = attachedRuntimeMismatchReason(initializeResult, args.project, {
      skipBuildHash: args.skipRuntimeCompatibilityCheck,
      skipProjectRoot: args.skipRuntimeCompatibilityCheck,
    });
    if (runtimeMismatch) {
      if (args.shutdownOnStale) {
        await connectedClient.request("shutdown").catch(() => null);
      }
      throw new StaleAdeSocketError(
        `ADE RPC socket is stale (${runtimeMismatch.reason}).`,
        runtimeMismatch.pid,
      );
    }
    let request = rawRequest;
    const multiProjectRuntime = isMultiProjectRuntime(initializeResult);
    if (multiProjectRuntime) {
      const registration = args.projectRegistration ?? AUTO_PROJECT_REGISTRATION;
      const project = await rawRequest<ProjectRecord>("projects.add", {
        rootPath: args.project.projectRoot,
        catalogVisibility: registration.catalogVisibility,
        registrationSource: registration.registrationSource,
      });
      const projectId =
        typeof project.projectId === "string" &&
        project.projectId.trim().length > 0
          ? project.projectId.trim()
          : null;
      if (!projectId) {
        throw new Error(
          "ADE daemon did not return a projectId for this project.",
        );
      }
      request = <T>(method: string, params?: unknown) =>
        rawRequest<T>(method, withProjectId(method, params, projectId));
    }
    const attachedClient = connectedClient;
    client = null;
    return {
      mode: "attached",
      projectRoot: args.project.projectRoot,
      workspaceRoot: args.project.workspaceRoot,
      socketPath: args.socketPath,
      request,
      ...createAdeActionHelpers(request),
      onConnectionClose: (handler: () => void) => attachedClient.onClose(handler),
      onChatEvent: (callback: (event: AgentChatEventEnvelope) => void) => {
        const stopChatNotification = attachedClient.onNotification("chat/event", (params) =>
          callback(params as AgentChatEventEnvelope),
        );
        if (!multiProjectRuntime) return stopChatNotification;

        let disposed = false;
        let subscriptionId: string | null = null;
        const pending: RuntimeEventNotification[] = [];
        const stopRuntimeNotification = attachedClient.onNotification("runtime/event", (params) => {
          const payload = params as RuntimeEventNotification;
          if (!isBufferedEvent(payload.event)) return;
          if (!subscriptionId) {
            pending.push(payload);
            return;
          }
          if (payload.subscriptionId !== subscriptionId) return;
          const envelope = runtimeChatEnvelope(payload.event);
          if (envelope) callback(envelope);
        });
        request<{ subscriptionId: string }>("runtimeEvents.subscribe", {
          category: "runtime",
          cursor: 0,
          limit: 100,
          replay: false,
        }).then((response) => {
          if (disposed) {
            request("runtimeEvents.unsubscribe", { subscriptionId: response.subscriptionId }).catch(() => {});
            return;
          }
          subscriptionId = response.subscriptionId;
          for (const payload of pending.splice(0)) {
            if (payload.subscriptionId !== subscriptionId || !isBufferedEvent(payload.event)) continue;
            const envelope = runtimeChatEnvelope(payload.event);
            if (envelope) callback(envelope);
          }
        }).catch(() => {
          stopRuntimeNotification();
        });
        return () => {
          disposed = true;
          stopChatNotification();
          stopRuntimeNotification();
          if (subscriptionId) {
            request("runtimeEvents.unsubscribe", { subscriptionId }).catch(() => {});
          }
        };
      },
      subscribeRuntimeEvents: async (subscriptionArgs, callback) => {
        let subscriptionId: string | null = null;
        const pending: PendingRuntimeEvent[] = [];
        const stopNotification = attachedClient.onNotification("runtime/event", (params) => {
          const payload = params as RuntimeEventNotification;
          if (!isBufferedEvent(payload.event)) return;
          if (!subscriptionId) {
            pending.push({ subscriptionId: payload.subscriptionId, event: payload.event });
            return;
          }
          if (payload.subscriptionId === subscriptionId) callback(payload.event);
        });
        try {
          const response = await request<{ subscriptionId: string }>("runtimeEvents.subscribe", {
            category: subscriptionArgs.category ?? "runtime",
            cursor: subscriptionArgs.cursor ?? 0,
            limit: subscriptionArgs.limit ?? 100,
            replay: subscriptionArgs.replay,
          });
          const gap = runtimeEventGapMetadata(response, response.subscriptionId);
          if (gap) {
            pending.length = 0;
            subscriptionArgs.onGap?.(gap);
          }
          subscriptionId = response.subscriptionId;
          for (const payload of pending) {
            if (payload.subscriptionId === subscriptionId) {
              callback(payload.event);
            }
          }
          pending.length = 0;
          return () => {
            stopNotification();
            if (subscriptionId) {
              request("runtimeEvents.unsubscribe", { subscriptionId }).catch(() => {});
            }
          };
        } catch (error) {
          stopNotification();
          throw error;
        }
      },
      close: async () => attachedClient.close(),
    };
  } catch (error) {
    client?.close();
    throw error;
  }
}

async function connectAttachedSocketWithRetry(args: {
  socketPath: string;
  project: ProjectLaunchContext;
  attempts: number;
  delayMs: number;
  shutdownOnStale?: boolean;
  skipRuntimeCompatibilityCheck?: boolean;
  projectRegistration?: ProjectCatalogRegistration;
}): Promise<AdeCodeConnection> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < Math.max(1, args.attempts); attempt += 1) {
    try {
      return await connectAttachedSocket({
        socketPath: args.socketPath,
        project: args.project,
        shutdownOnStale: args.shutdownOnStale,
        skipRuntimeCompatibilityCheck: args.skipRuntimeCompatibilityCheck,
        projectRegistration: args.projectRegistration,
      });
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= args.attempts) break;
      const delayMs = retryDelayMs(args.delayMs, attempt);
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function retryDelayMs(initialDelayMs: number, attempt: number): number {
  if (initialDelayMs <= 0) return 0;
  return Math.min(
    DAEMON_CONNECT_RETRY_MAX_DELAY_MS,
    Math.max(0, Math.floor(initialDelayMs * 2 ** attempt)),
  );
}

export function remoteSocketFailureDetail(
  message: string,
  socketPath: string,
): string {
  if (/\bEPIPE\b/i.test(message)) {
    return "the local bridge lost its upstream runtime connection (write EPIPE)";
  }
  if (/\bENOENT\b/i.test(message)) {
    return "the local bridge is not ready yet";
  }
  if (/\bECONNREFUSED\b/i.test(message)) {
    return "the local bridge refused the connection";
  }
  return message.split(socketPath).join("the local bridge socket");
}

export async function connectToAde(args: {
  project: ProjectLaunchContext;
  forceEmbedded?: boolean;
  requireSocket?: boolean;
  socketPath?: string | null;
  preferServiceRepair?: boolean;
  remote?: boolean;
  /**
   * How to register this project in the machine catalog when attaching to a
   * multi-project daemon. Defaults to the hidden "system" row; interactive
   * `ade code` launches pass INTERACTIVE_PROJECT_REGISTRATION so the project
   * surfaces on the phone. Ignored for embedded runtimes (no catalog).
   */
  projectRegistration?: ProjectCatalogRegistration;
}): Promise<AdeCodeConnection> {
  const projectRegistration =
    args.projectRegistration ?? AUTO_PROJECT_REGISTRATION;
  const layout = resolveAdeLayout(args.project.projectRoot);
  const explicitSocketPath =
    args.socketPath?.trim() || process.env.ADE_RPC_SOCKET_PATH?.trim() || null;
  const machineSocketPath = resolveMachineAdeLayout().socketPath;
  const socketPath = explicitSocketPath ?? machineSocketPath;
  const preferServiceRepair =
    args.preferServiceRepair === true
    && !explicitSocketPath
    && process.env.ADE_DISABLE_RUNTIME_SERVICE_INSTALL !== "1";

  if (args.forceEmbedded && args.requireSocket) {
    throw new Error("Cannot use embedded mode when an ADE socket is required.");
  }

  if (!args.forceEmbedded && explicitSocketPath) {
    try {
      return await connectAttachedSocketWithRetry({
        socketPath: explicitSocketPath,
        project: args.project,
        attempts: 1,
        delayMs: 0,
        skipRuntimeCompatibilityCheck: args.remote === true,
        projectRegistration,
      });
    } catch (error) {
      const message = errorMessage(error);
      if (args.requireSocket) {
        if (args.remote) {
          const remoteLabel = args.project.remoteLabel?.trim() || "the remote Mac";
          throw new Error(
            `Remote ADE connection to ${remoteLabel} was interrupted while ADE Code was starting: ` +
              `${remoteSocketFailureDetail(message, explicitSocketPath)}. ` +
              "The bridge will retry the saved connection paths automatically.",
          );
        }
        throw new Error(
          `ADE RPC socket is required but unavailable at ${explicitSocketPath}: ${message}`,
        );
      }
      throw new Error(
        `ADE RPC socket is unavailable at ${explicitSocketPath}: ${message}. ` +
          "Start ade serve or run ade code --embedded to use the legacy embedded fallback.",
      );
    }
  }

  let attachError: unknown = null;
  if (!args.forceEmbedded && !explicitSocketPath) {
    const tryDaemon = async (attempts: number): Promise<AdeCodeConnection> =>
      connectAttachedSocketWithRetry({
        socketPath: machineSocketPath,
        project: args.project,
        attempts,
        delayMs: DAEMON_CONNECT_RETRY_INITIAL_DELAY_MS,
        shutdownOnStale: true,
        projectRegistration,
      });
    const repairService = async (): Promise<AdeCodeConnection | null> => {
      if (!preferServiceRepair) return null;
      try {
        const { installRuntimeService } = await import("../serviceManager");
        const result = await withAdeDefaultRole("cto", () => installRuntimeService());
        if (!result.ok) return null;
        return await tryDaemon(25);
      } catch {
        return null;
      }
    };
    try {
      if (!fs.existsSync(machineSocketPath)) {
        return await withSocketSpawnLock(machineSocketPath, async () => {
          if (fs.existsSync(machineSocketPath)) return await tryDaemon(25);
          const repaired = await repairService();
          if (repaired) return repaired;
          const spawned = spawnDaemon(machineSocketPath);
          return await tryDaemon(spawned ? 25 : 1);
        });
      }
      return await tryDaemon(1);
    } catch (firstError) {
      if (firstError instanceof StaleAdeSocketError) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      const repaired = await repairService();
      if (repaired) return repaired;
      try {
        const spawned = await withSocketSpawnLock(machineSocketPath, async () => {
          if (fs.existsSync(machineSocketPath) && !(await unlinkStaleLocalSocket(machineSocketPath))) return false;
          return spawnDaemon(machineSocketPath);
        });
        if (spawned) return await tryDaemon(25);
        return await tryDaemon(25);
      } catch (error) {
        attachError = error;
      }
      const projectSocketPath = layout.socketPath;
      if (
        projectSocketPath &&
        (args.requireSocket || fs.existsSync(projectSocketPath))
      ) {
        try {
          return await connectAttachedSocketWithRetry({
            socketPath: projectSocketPath,
            project: args.project,
            attempts: 1,
            delayMs: 0,
            projectRegistration,
          });
        } catch (projectError) {
          if (args.requireSocket) {
            throw new Error(
              `ADE RPC socket is required but unavailable at ${projectSocketPath}: ${errorMessage(projectError)}`,
            );
          }
          attachError = projectError;
        }
      }
      if (args.requireSocket) {
        throw new Error(
          `ADE RPC socket is required but unavailable at ${machineSocketPath}: ${errorMessage(firstError)}`,
        );
      }
      attachError ??= firstError;
    }
  }

  if (!args.forceEmbedded) {
    const message =
      attachError instanceof Error ? ` Last error: ${attachError.message}` : "";
    throw new Error(
      `Unable to attach to the ADE service at ${socketPath}.${message} ` +
        "Start ade serve or run ade code --embedded to use the legacy embedded fallback.",
    );
  }

  const { createAdeRuntime, createAdeRpcRequestHandler } =
    await loadEmbeddedAdeCli();
  const runtime = await createAdeRuntime({
    projectRoot: args.project.projectRoot,
    workspaceRoot: args.project.workspaceRoot,
    chatRuntime: "agent",
    runtimeProfile: "chat",
  });
  const handler: DirectHandler = createAdeRpcRequestHandler({
    runtime,
    serverVersion: "ade-code",
  });
  let nextRequestId = 1;
  const request: AdeRpcRequest = async <T>(
    method: string,
    params?: unknown,
  ): Promise<T> => {
    return (await handler({
      jsonrpc: "2.0",
      id: nextRequestId++,
      method,
      params,
    })) as T;
  };
  await initializeEmbeddedCto(request);
  const chatEvents =
    typeof runtime.agentChatService?.subscribeToEvents === "function"
      ? runtime.agentChatService.subscribeToEvents.bind(
          runtime.agentChatService,
        )
      : () => () => {};

  return {
    mode: "embedded",
    projectRoot: args.project.projectRoot,
    workspaceRoot: args.project.workspaceRoot,
    socketPath: null,
    request,
    ...createAdeActionHelpers(request),
    // Embedded runtimes live in-process and never "drop" — no-op listener.
    onConnectionClose: () => () => {},
    onChatEvent: (callback) => chatEvents(callback),
    subscribeRuntimeEvents: async (subscriptionArgs, callback) => {
      const category = subscriptionArgs.category ?? "runtime";
      const eventBuffer = runtime.eventBuffer;
      if (!eventBuffer) return () => {};
      const shouldForward = (event: BufferedEvent) => !category || event.category === category;
	      const replay = subscriptionArgs.replay !== false && typeof eventBuffer.drain === "function"
	        ? eventBuffer.drain(subscriptionArgs.cursor ?? 0, subscriptionArgs.limit ?? 100)
	        : { events: [] };
	      const gap = runtimeEventGapMetadata(replay);
	      if (gap) subscriptionArgs.onGap?.(gap);
	      for (const event of replay.events) {
        if (shouldForward(event)) callback(event);
      }
      if (typeof eventBuffer.subscribe !== "function") return () => {};
      return eventBuffer.subscribe((event) => {
        if (shouldForward(event)) callback(event);
      });
    },
    close: async () => {
      handler.dispose();
      runtime.dispose();
    },
  };
}
