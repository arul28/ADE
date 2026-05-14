import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveAdeLayout } from "../../../desktop/src/shared/adeLayout";
import { resolveMachineAdeLayout } from "../services/projects/machineLayout";
import { JsonRpcClient } from "./jsonRpcClient";
import type { AdeCodeConnection, ProjectLaunchContext } from "./types";
import type { AgentChatEventEnvelope } from "../../../desktop/src/shared/types/chat";
import type { BufferedEvent } from "../eventBuffer";

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
  };
  capabilities?: {
    projects?: boolean;
  };
};

type ProjectRecord = {
  projectId: string;
};

type EmbeddedRuntime = {
  dispose: () => void;
  agentChatService?: {
    subscribeToEvents?: (
      callback: (event: AgentChatEventEnvelope) => void,
    ) => () => void;
  };
  eventBuffer?: {
    drain?: (cursor: number, limit?: number) => { events: BufferedEvent[]; nextCursor: number; hasMore: boolean };
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

const MULTI_PROJECT_RUNTIME_METHODS = new Set([
  "ade/initialize",
  "ade/initialized",
  "ping",
  "shutdown",
  "exit",
  "runtime/info",
  "machineInfo.get",
  "projects.list",
  "projects.add",
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

function resolveCliEntrypoint(): string | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(moduleDir, "..", "cli.cjs"),
    path.join(moduleDir, "..", "cli.js"),
    path.join(moduleDir, "..", "cli.mjs"),
    process.argv[1],
  ].filter(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.trim().length > 0,
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

function spawnDaemon(socketPath: string): boolean {
  const cliEntrypoint = resolveCliEntrypoint();
  const daemonArgs = cliEntrypoint
    ? [cliEntrypoint, "serve", "--socket", socketPath]
    : ["serve", "--socket", socketPath];
  const child = spawn(
    process.execPath,
    daemonArgs,
    {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        ADE_RPC_SOCKET_PATH: socketPath,
      },
    },
  );
  child.unref();
  return true;
}

async function connectAttachedSocket(args: {
  socketPath: string;
  project: ProjectLaunchContext;
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
    let request = rawRequest;
    if (isMultiProjectRuntime(initializeResult)) {
      const project = await rawRequest<ProjectRecord>("projects.add", {
        rootPath: args.project.projectRoot,
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
      onChatEvent: (callback: (event: AgentChatEventEnvelope) => void) =>
        attachedClient.onNotification("chat/event", (params) =>
          callback(params as AgentChatEventEnvelope),
        ),
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
          });
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
}): Promise<AdeCodeConnection> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < Math.max(1, args.attempts); attempt += 1) {
    try {
      return await connectAttachedSocket({
        socketPath: args.socketPath,
        project: args.project,
      });
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= args.attempts) break;
      await new Promise((resolve) => setTimeout(resolve, args.delayMs));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function connectToAde(args: {
  project: ProjectLaunchContext;
  forceEmbedded?: boolean;
  requireSocket?: boolean;
  socketPath?: string | null;
}): Promise<AdeCodeConnection> {
  const layout = resolveAdeLayout(args.project.projectRoot);
  const explicitSocketPath =
    args.socketPath?.trim() || process.env.ADE_RPC_SOCKET_PATH?.trim() || null;
  const machineSocketPath = resolveMachineAdeLayout().socketPath;
  const socketPath = explicitSocketPath ?? machineSocketPath;

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
      });
    } catch (error) {
      const message = errorMessage(error);
      if (args.requireSocket) {
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
        delayMs: 200,
      });
    try {
      if (!fs.existsSync(machineSocketPath)) {
        const spawned = spawnDaemon(machineSocketPath);
        return await tryDaemon(spawned ? 25 : 1);
      }
      return await tryDaemon(1);
    } catch (firstError) {
      try {
        const spawned = spawnDaemon(machineSocketPath);
        if (spawned) return await tryDaemon(25);
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
  await initialize(request);
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
    onChatEvent: (callback) => chatEvents(callback),
    subscribeRuntimeEvents: async (subscriptionArgs, callback) => {
      const category = subscriptionArgs.category ?? "runtime";
      const eventBuffer = runtime.eventBuffer;
      if (!eventBuffer) return () => {};
      const shouldForward = (event: BufferedEvent) => !category || event.category === category;
      const replay = typeof eventBuffer.drain === "function"
        ? eventBuffer.drain(subscriptionArgs.cursor ?? 0, subscriptionArgs.limit ?? 100)
        : { events: [] };
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
