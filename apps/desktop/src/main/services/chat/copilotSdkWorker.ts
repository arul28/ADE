import { randomUUID } from "node:crypto";
import type * as CopilotSdk from "@github/copilot-sdk";
import type {
  CopilotSdkSessionConfig,
  CopilotSdkWorkerInit,
  CopilotSdkWorkerRequest,
  CopilotSdkWorkerResponse,
} from "./copilotSdkProtocol";
import { loadCopilotSdk } from "../ai/copilotSdkLoader";

type Client = InstanceType<typeof CopilotSdk.CopilotClient>;
type Session = Awaited<ReturnType<Client["createSession"]>>;
type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
type UserInputResponse = { answer: string; wasFreeform: boolean };
type McpAuthResult = { kind: "cancelled" } | { kind: "token"; accessToken: string; expiresIn: number };
let client: Client | null = null;
const sessions = new Map<string, Session>();
const waiters = new Map<string, { chatId: string; type: "permission_request" | "user_input_request" | "mcp_auth_request" | "exit_plan_request"; resolve: (value: unknown) => void }>();
let disposed = false;
/** A title or summary call; the SDK default (60 s) is too tight for a cold runtime. */
const UTILITY_TIMEOUT_MS = 120_000;

function post(message: CopilotSdkWorkerResponse): void {
  if (process.send) process.send(message);
}

function postLog(level: "debug" | "info" | "warn" | "error", message: string, detail?: unknown): void {
  post({ type: "log", level, message, ...(detail === undefined ? {} : { detail }) });
}

function settleWaiters(chatId?: string): void {
  for (const [waiterId, waiter] of waiters) {
    if (chatId && waiter.chatId !== chatId) continue;
    const fallback = waiter.type === "exit_plan_request" ? { approved: false, feedback: "The Copilot chat was interrupted." }
      : waiter.type === "permission_request" ? { kind: "reject" }
      : waiter.type === "mcp_auth_request" ? { kind: "cancelled" }
        : { answer: "", wasFreeform: true };
    waiter.resolve(fallback);
    waiters.delete(waiterId);
  }
}

function waitFor<T>(type: "permission_request" | "user_input_request" | "mcp_auth_request" | "exit_plan_request", chatId: string, request: unknown): Promise<T> {
  const waiterId = randomUUID();
  return new Promise<T>((resolve) => {
    waiters.set(waiterId, { chatId, type, resolve: resolve as (value: unknown) => void });
    post({ type, chatId, waiterId, request } as CopilotSdkWorkerResponse);
  });
}

function sessionConfig(config: CopilotSdkSessionConfig): CopilotSdk.SessionConfig {
  return {
    sessionId: config.sessionId,
    workingDirectory: config.cwd,
    model: config.model && config.model !== "auto" ? config.model : undefined,
    reasoningEffort: config.reasoningEffort as ReasoningEffort | undefined,
    streaming: true,
    systemMessage: config.systemMessage ? { mode: "append", content: config.systemMessage } : undefined,
    skillDirectories: config.skillDirectories,
    mcpServers: config.mcpServers as CopilotSdk.SessionConfig["mcpServers"],
    disabledMcpServers: config.disabledMcpServers,
    contextTier: config.contextTier,
    capi: config.autoTier ? { autoTier: config.autoTier } : undefined,
    // Interactive chats inherit workspace `.mcp.json` like the Copilot CLI.
    // Utility sessions must remain isolated from user/workspace/plugin MCP.
    enableConfigDiscovery: !config.utility,
    // Rewind needs Copilot to snapshot file changes per turn.
    enableFileChangeTracking: !config.utility,
    infiniteSessions: { enabled: !config.utility },
    availableTools: config.utility ? [] : undefined,
    skipCustomInstructions: config.utility,
    onPermissionRequest: config.utility
      ? () => ({ kind: "reject" as const })
      : (request) => waitFor<CopilotSdk.PermissionRequestResult>("permission_request", config.chatId, request),
    onUserInputRequest: config.utility
      ? undefined
      : (request) => waitFor<UserInputResponse>("user_input_request", config.chatId, request),
    onMcpAuthRequest: config.utility
      ? async () => ({ kind: "cancelled" as const })
      : (request) => waitFor<McpAuthResult>("mcp_auth_request", config.chatId, request),
    onExitPlanModeRequest: config.utility ? undefined : (request) => waitFor("exit_plan_request", config.chatId, request),
    // Plan mode is applied after open through the experimental session mode RPC.
  } as CopilotSdk.SessionConfig;
}

function watchSession(chatId: string, session: Session): void {
  session.on((event) => {
    if (event.type === "session.task_complete") {
      postLog("info", "Copilot task completion event", {
        chatId,
        success: event.data.success,
        hasSummary: typeof event.data.summary === "string" && event.data.summary.length > 0,
      });
    }
    post({ type: "event", chatId, event });
    if (event.type === "session.todos_changed") {
      void session.rpc.plan.readSqlTodos().then((todos) => post({ type: "event", chatId, event: { type: "ade.todos", data: todos } }))
        .catch((error) => postLog("warn", "Could not read Copilot todos", { error: error instanceof Error ? error.message : String(error) }));
    }
  });
}

async function initialize(payload: CopilotSdkWorkerInit): Promise<unknown> {
  const sdk = await loadCopilotSdk();
  client = new sdk.CopilotClient({
    connection: sdk.RuntimeConnection.forStdio({
      path: payload.cliPath,
      env: Object.fromEntries(Object.entries(payload.baseEnv).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    }),
    baseDirectory: payload.baseDirectory,
    useLoggedInUser: true,
    logLevel: "error",
  });
  await client.start();
  const status = await client.getStatus();
  if (status.protocolVersion < 3) throw new Error(`Copilot CLI protocol ${status.protocolVersion} is unsupported. Update Copilot CLI with copilot update.`);
  disposed = false;
  return status;
}

async function dispatch(req: CopilotSdkWorkerRequest): Promise<unknown> {
  if (req.type === "respond_permission" || req.type === "respond_user_input" || req.type === "respond_mcp_auth" || req.type === "respond_exit_plan") {
    const waiter = waiters.get(req.payload.waiterId);
    if (waiter) {
      const result = req.type === "respond_permission" || req.type === "respond_mcp_auth" || req.type === "respond_exit_plan" ? req.payload.result : req.payload.response;
      waiter.resolve(result);
      waiters.delete(req.payload.waiterId);
    }
    return {};
  }
  if (req.type === "init") return initialize(req.payload);
  if (req.type === "dispose") {
    disposed = true;
    settleWaiters();
    for (const session of sessions.values()) await session.disconnect().catch(() => undefined);
    sessions.clear();
    await client?.stop().catch(() => undefined);
    client = null;
    if (process.connected) process.disconnect();
    return {};
  }
  if (!client || disposed) throw new Error("Copilot SDK worker is not initialized.");
  if (req.type === "auth") return client.getAuthStatus();
  if (req.type === "models") return client.listModels();
  if (req.type === "account_quota") return client.rpc.account.getQuota(req.payload?.gitHubToken ? { gitHubToken: req.payload.gitHubToken } : {});
  if (req.type === "create" || req.type === "resume") {
    const config = sessionConfig(req.payload);
    const session = req.type === "resume" && req.payload.sessionId
      ? await client.resumeSession(req.payload.sessionId, { ...config, continuePendingWork: false })
      : await client.createSession(config);
    let permissionMode: string | null = null;
    let permissionError: string | null = null;
    if (req.payload.permissionMode === "plan") await session.rpc.mode.set({ mode: "plan" });
    else {
      const requestedMode = req.payload.permissionMode === "assisted" ? "assisted"
        : req.payload.permissionMode === "full-auto" ? "allow-all" : "manual";
      try {
        const applied = await session.rpc.permissions.setMode({ mode: requestedMode });
        postLog("info", "Copilot permission mode set result", { chatId: req.payload.chatId, requested: requestedMode, applied: applied.mode });
      } catch (error) {
        if (requestedMode !== "assisted") throw error;
        permissionError = error instanceof Error ? error.message : String(error);
        const fallback = await session.rpc.permissions.setMode({ mode: "manual" });
        postLog("warn", "Copilot Assisted mode rejected; using Ask", {
          chatId: req.payload.chatId,
          sdkError: permissionError,
          fallback: fallback.mode,
        });
      }
    }
    sessions.set(req.payload.chatId, session);
    watchSession(req.payload.chatId, session);
    postLog("debug", "Copilot session options applied", {
      chatId: req.payload.chatId,
      contextTier: req.payload.contextTier ?? "default",
      autoTier: req.payload.autoTier ?? null,
      resumed: req.type === "resume",
    });
    permissionMode = (await session.rpc.permissions.getMode()).mode;
    postLog("info", "Copilot permission mode verified after open", { chatId: req.payload.chatId, permissionMode });
    return { sessionId: session.sessionId, events: await session.getEvents(), permissionMode, permissionError };
  }
  if (req.type === "send") {
    const session = sessions.get(req.payload.chatId);
    if (!session) throw new Error("Copilot session is not open.");
    return { result: await session.send({ prompt: req.payload.prompt, attachments: req.payload.attachments, mode: req.payload.mode, ...(req.payload.agentMode ? { agentMode: req.payload.agentMode } : {}) }) };
  }
  if (req.type === "set_model") {
    const session = sessions.get(req.payload.chatId);
    if (!session) throw new Error("Copilot session is not open.");
    await session.setModel(req.payload.model, {
      ...(req.payload.reasoningEffort ? { reasoningEffort: req.payload.reasoningEffort as ReasoningEffort } : {}),
      ...(req.payload.contextTier ? { contextTier: req.payload.contextTier } : {}),
      ...(req.payload.autoTier !== undefined ? { autoTier: req.payload.autoTier } : {}),
    });
    postLog("debug", "Copilot model options applied", {
      chatId: req.payload.chatId,
      model: req.payload.model,
      contextTier: req.payload.contextTier ?? "default",
      autoTier: req.payload.autoTier ?? null,
    });
    return {};
  }
  if (req.type === "set_auto_tier") {
    const session = sessions.get(req.payload.chatId);
    if (!session) throw new Error("Copilot session is not open.");
    const result = await session.setAutoTier(req.payload.autoTier);
    postLog("debug", "Copilot Auto tier selection", { chatId: req.payload.chatId, requested: req.payload.autoTier, status: result.status });
    return result;
  }
  if (req.type === "set_permission_mode") {
    const session = sessions.get(req.payload.chatId);
    if (!session) throw new Error("Copilot session is not open.");
    if (req.payload.permissionMode === "plan") {
      await session.rpc.mode.set({ mode: "plan" });
      return { mode: (await session.rpc.permissions.getMode()).mode, error: null };
    }
    // Plan is a session mode, not a permission mode: leaving it must restore
    // the interactive session or Copilot keeps planning under the new level.
    await session.rpc.mode.set({ mode: "interactive" });
    const mode = req.payload.permissionMode === "assisted" ? "assisted"
      : req.payload.permissionMode === "full-auto" ? "allow-all" : "manual";
    try {
      const result = await session.rpc.permissions.setMode({ mode });
      const current = (await session.rpc.permissions.getMode()).mode;
      postLog("info", "Copilot permission mode updated", { chatId: req.payload.chatId, requested: mode, applied: result.mode, current });
      return { mode: current, error: null };
    } catch (error) {
      if (mode !== "assisted") throw error;
      const sdkError = error instanceof Error ? error.message : String(error);
      const fallback = await session.rpc.permissions.setMode({ mode: "manual" });
      const current = (await session.rpc.permissions.getMode()).mode;
      postLog("warn", "Copilot Assisted mode rejected; using Ask", { chatId: req.payload.chatId, sdkError, fallback: current });
      return { mode: current, error: sdkError };
    }
  }
  if (req.type === "fork_session") {
    const session = sessions.get(req.payload.chatId);
    if (!session) throw new Error("Copilot session is not open.");
    let toEventId: string | undefined;
    if (req.payload.throughMessageText !== undefined) {
      const events = await session.getEvents() as Array<{ id?: string; type?: string; agentId?: string; data?: { content?: string } }>;
      const roots = events.flatMap((event, index) => event.type === "user.message" && !event.agentId && typeof event.data?.content === "string"
        ? [{ index, id: event.id, text: event.data.content }]
        : []);
      const matches = roots.filter((event) => event.text.trim() === req.payload.throughMessageText?.trim());
      const selected = matches[req.payload.throughMessageOrdinal ?? 0];
      if (!selected?.id) throw new Error("Could not map the selected ADE turn to a Copilot user event; fork the full chat instead.");
      const nextRoot = roots.find((event) => event.index > selected.index);
      toEventId = events[(nextRoot?.index ?? events.length) - 1]?.id;
      if (!toEventId) throw new Error("Copilot history did not expose an event boundary for the selected turn.");
    }
    const result = await (client.rpc as unknown as { sessions: { fork: (args: { sessionId: string; toEventId?: string }) => Promise<{ sessionId?: string }> } }).sessions.fork({ sessionId: req.payload.sessionId, ...(toEventId ? { toEventId } : {}) });
    const forkedId = result.sessionId?.trim();
    if (!forkedId) throw new Error("Copilot fork did not return a new session id.");
    return forkedId;
  }
  if (req.type === "rewind") {
    const session = sessions.get(req.payload.chatId);
    if (!session) throw new Error("Copilot session is not open.");
    if (req.payload.action === "list") return session.rpc.history.listRewindPoints();
    if (!req.payload.eventId) throw new Error("Copilot rewind requires an event id.");
    if (req.payload.action === "preview") return session.rpc.history.previewRewind({ eventId: req.payload.eventId });
    return session.rpc.history.rewind({ eventId: req.payload.eventId, mode: "conversation-and-files" });
  }
  if (req.type === "usage_metrics") {
    const session = sessions.get(req.payload.chatId);
    if (!session) throw new Error("Copilot session is not open.");
    return session.rpc.usage.getMetrics();
  }
  if (req.type === "abort") { settleWaiters(req.payload.chatId); await sessions.get(req.payload.chatId)?.abort().catch(() => undefined); return {}; }
  if (req.type === "disconnect") { settleWaiters(req.payload.chatId); await sessions.get(req.payload.chatId)?.disconnect().catch(() => undefined); sessions.delete(req.payload.chatId); return {}; }
  if (req.type === "utility") {
    const id = `ade-utility-${randomUUID()}`;
    // Config discovery is not sufficient isolation: the CLI still materializes
    // servers from COPILOT_HOME/mcp-config.json when discovery is disabled.
    // Read the server-level config before creating a session and explicitly
    // disable every user-configured server. If the read fails, fail closed.
    const userMcpConfig = await client.rpc.mcp.config.list();
    const configuredServers = userMcpConfig?.servers;
    if (!configuredServers || typeof configuredServers !== "object" || Array.isArray(configuredServers)) {
      throw new Error("Could not safely enumerate Copilot user MCP servers for a utility session.");
    }
    const configuredNames = Object.keys(configuredServers);
    const session = await client.createSession(sessionConfig({
      chatId: id,
      sessionId: id,
      cwd: req.payload.cwd,
      model: req.payload.model,
      systemMessage: req.payload.systemMessage,
      disabledMcpServers: configuredNames,
      utility: true,
    }));
    try {
      const materialized = await session.rpc.mcp.list();
      postLog("debug", "Copilot utility MCP isolation", {
        configuredNames,
        serverStates: (materialized.servers ?? []).map((server) => ({ name: server.name, status: server.status })),
      });
      return await session.sendAndWait(req.payload.prompt, UTILITY_TIMEOUT_MS);
    } finally {
      await client.deleteSession(session.sessionId).catch(() => undefined);
    }
  }
  throw new Error(`Unsupported Copilot SDK worker request: ${(req as { type: string }).type}`);
}

process.on("message", (raw: unknown) => {
  const req = raw as CopilotSdkWorkerRequest;
  if (!req || typeof req !== "object" || typeof req.requestId !== "string") return;
  void dispatch(req).then(
    (result) => post({ type: "response", requestId: req.requestId, ok: true, result }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      postLog("error", "Copilot SDK worker request failed", { type: req.type, error: message });
      post({ type: "response", requestId: req.requestId, ok: false, error: message });
    },
  );
});

process.once("disconnect", () => { settleWaiters(); void dispatch({ type: "dispose", requestId: "disconnect" }); });
process.on("unhandledRejection", (reason) => { postLog("error", "Unhandled rejection in Copilot SDK worker", { error: reason instanceof Error ? reason.message : String(reason) }); process.exit(1); });
process.on("uncaughtException", (error) => { postLog("error", "Uncaught exception in Copilot SDK worker", { error: error.message, stack: error.stack }); process.exit(1); });

