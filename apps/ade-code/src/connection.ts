import fs from "node:fs";
import { resolveAdeLayout } from "../../desktop/src/shared/adeLayout";
import { JsonRpcClient } from "./jsonRpcClient";
import type { AdeCodeConnection, ProjectLaunchContext } from "./types";
import type { AgentChatEventEnvelope } from "../../desktop/src/shared/types/chat";

type RpcResponseEnvelope<T> =
  | T
  | {
      ok: false;
      error: { message?: string };
    };

type EmbeddedRuntime = {
  dispose: () => void;
  agentChatService?: {
    subscribeToEvents?: (callback: (event: AgentChatEventEnvelope) => void) => () => void;
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

type CreateEmbeddedRpcRequestHandler = (args: { runtime: EmbeddedRuntime; serverVersion: string }) => DirectHandler;

async function loadEmbeddedAdeCli(): Promise<{
  createAdeRuntime: (args: {
    projectRoot: string;
    workspaceRoot: string;
    chatRuntime: "agent";
    runtimeProfile: "chat";
  }) => Promise<EmbeddedRuntime>;
  createAdeRpcRequestHandler: CreateEmbeddedRpcRequestHandler;
}> {
  const [bootstrap, rpc] = await Promise.all([
    import("../../ade-cli/src/bootstrap"),
    import("../../ade-cli/src/adeRpcServer"),
  ]);
  return {
    createAdeRuntime: bootstrap.createAdeRuntime as unknown as CreateEmbeddedRuntime,
    createAdeRpcRequestHandler: rpc.createAdeRpcRequestHandler as unknown as CreateEmbeddedRpcRequestHandler,
  };
}

function unwrapActionResult<T>(payload: RpcResponseEnvelope<unknown>, domain: string, action: string): T {
  if (payload && typeof payload === "object" && "ok" in payload && payload.ok === false) {
    const error = (payload as { error?: { message?: string } }).error;
    const message = typeof error?.message === "string"
      ? error.message
      : `ADE action failed: ${domain}.${action}`;
    throw new Error(message);
  }
  const record = payload as { result?: unknown };
  return record.result as T;
}

async function initialize(request: <T>(method: string, params?: unknown) => Promise<T>): Promise<void> {
  await request("ade/initialize", {
    protocolVersion: "2025-06-18",
    clientName: "ade-code",
    identity: {
      role: "cto",
      callerId: `ade-code:${process.pid}`,
    },
  });
  await request("ade/initialized");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
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

export async function connectToAde(args: {
  project: ProjectLaunchContext;
  forceEmbedded?: boolean;
  requireSocket?: boolean;
  socketPath?: string | null;
}): Promise<AdeCodeConnection> {
  const layout = resolveAdeLayout(args.project.projectRoot);
  const socketPath = args.socketPath?.trim() || process.env.ADE_RPC_SOCKET_PATH?.trim() || layout.socketPath;

  if (args.forceEmbedded && args.requireSocket) {
    throw new Error("Cannot use embedded mode when a desktop socket is required.");
  }

  if (!args.forceEmbedded && socketPath && (args.requireSocket || fs.existsSync(socketPath))) {
    let client: JsonRpcClient | null = null;
    try {
      client = await JsonRpcClient.connect(socketPath);
      const connectedClient = client;
      const request = <T>(method: string, params?: unknown) => connectedClient.request<T>(method, params);
      await withTimeout(initialize(request), 3000, "ADE RPC socket did not finish initialization.");
      return {
        mode: "attached",
        projectRoot: args.project.projectRoot,
        workspaceRoot: args.project.workspaceRoot,
        socketPath,
        request,
        tool: async <T>(name: string, toolArgs?: Record<string, unknown>): Promise<T> => {
          const payload = await request<unknown>("ade/actions/call", {
            name,
            arguments: toolArgs ?? {},
          });
          if (payload && typeof payload === "object" && "ok" in payload && payload.ok === false) {
            const error = (payload as { error?: { message?: string } }).error;
            const message = typeof error?.message === "string" ? error.message : `ADE tool failed: ${name}`;
            throw new Error(message);
          }
          return payload as T;
        },
        action: async <T>(domain: string, action: string, actionArgs?: Record<string, unknown>): Promise<T> => {
          const payload = await request<unknown>("ade/actions/call", {
            name: "run_ade_action",
            arguments: { domain, action, args: actionArgs ?? {} },
          });
          return unwrapActionResult<T>(payload, domain, action);
        },
        actionList: async <T>(domain: string, action: string, argsList: unknown[]): Promise<T> => {
          const payload = await request<unknown>("ade/actions/call", {
            name: "run_ade_action",
            arguments: { domain, action, argsList },
          });
          return unwrapActionResult<T>(payload, domain, action);
        },
        onChatEvent: (callback: (event: AgentChatEventEnvelope) => void) => (
          connectedClient.onNotification("chat/event", (params) => callback(params as AgentChatEventEnvelope))
        ),
        close: async () => connectedClient.close(),
      };
    } catch (error) {
      client?.close();
      if (args.requireSocket) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`ADE RPC socket is required but unavailable at ${socketPath}: ${message}`);
      }
      // Fall through to embedded mode; a stale socket should not strand the TUI.
    }
  }

  if (args.requireSocket) {
    throw new Error(`ADE RPC socket is required but unavailable at ${socketPath}.`);
  }

  const { createAdeRuntime, createAdeRpcRequestHandler } = await loadEmbeddedAdeCli();
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
  const request = async <T>(method: string, params?: unknown): Promise<T> => {
    return await handler({
      jsonrpc: "2.0",
      id: nextRequestId++,
      method,
      params,
    }) as T;
  };
  await initialize(request);
  const chatEvents = typeof runtime.agentChatService?.subscribeToEvents === "function"
    ? runtime.agentChatService.subscribeToEvents.bind(runtime.agentChatService)
    : (() => () => {});

  return {
    mode: "embedded",
    projectRoot: args.project.projectRoot,
    workspaceRoot: args.project.workspaceRoot,
    socketPath: null,
    request,
    tool: async <T>(name: string, toolArgs?: Record<string, unknown>): Promise<T> => {
      const payload = await request<unknown>("ade/actions/call", {
        name,
        arguments: toolArgs ?? {},
      });
      if (payload && typeof payload === "object" && "ok" in payload && payload.ok === false) {
        const error = (payload as { error?: { message?: string } }).error;
        const message = typeof error?.message === "string" ? error.message : `ADE tool failed: ${name}`;
        throw new Error(message);
      }
      return payload as T;
    },
    action: async <T>(domain: string, action: string, actionArgs?: Record<string, unknown>): Promise<T> => {
      const payload = await request<unknown>("ade/actions/call", {
        name: "run_ade_action",
        arguments: { domain, action, args: actionArgs ?? {} },
      });
      return unwrapActionResult<T>(payload, domain, action);
    },
    actionList: async <T>(domain: string, action: string, argsList: unknown[]): Promise<T> => {
      const payload = await request<unknown>("ade/actions/call", {
        name: "run_ade_action",
        arguments: { domain, action, argsList },
      });
      return unwrapActionResult<T>(payload, domain, action);
    },
    onChatEvent: (callback) => chatEvents(callback),
    close: async () => {
      handler.dispose();
      runtime.dispose();
    },
  };
}
