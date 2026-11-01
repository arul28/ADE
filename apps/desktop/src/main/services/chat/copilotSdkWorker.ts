import { randomUUID } from "node:crypto";
import type * as CopilotSdk from "@github/copilot-sdk";
import type {
  CopilotSdkSessionConfig,
  CopilotSdkWorkerInit,
  CopilotSdkWorkerRequest,
  CopilotSdkWorkerResponse,
  CopilotSdkWaiterType,
} from "./copilotSdkProtocol";
import { COPILOT_SDK_WAITERS } from "./copilotSdkProtocol";
import { loadCopilotSdk } from "../ai/copilotSdkLoader";

type Client = InstanceType<typeof CopilotSdk.CopilotClient>;
type Session = Awaited<ReturnType<Client["createSession"]>>;
type ReasoningEffort = NonNullable<CopilotSdk.SessionConfig["reasoningEffort"]>;
const REASONING_EFFORTS: ReadonlySet<string> = new Set<ReasoningEffort>(["low", "medium", "high", "xhigh", "max"]);

function reasoningEffort(value: string | null | undefined): ReasoningEffort | undefined {
  return value && REASONING_EFFORTS.has(value) ? value as ReasoningEffort : undefined;
}
type UserInputResponse = { answer: string; wasFreeform: boolean };
type McpAuthResult = { kind: "cancelled" } | { kind: "token"; accessToken: string; expiresIn: number };
let client: Client | null = null;
/**
 * A Custom provider's endpoint for this runtime's sessions, from the
 * `COPILOT_PROVIDER_*` env its preset set (harnessRouteLaunch.ts). The Copilot
 * CLI reads those itself; the SDK runtime does not (it still asks for a GitHub
 * login), so every session it creates or resumes names the provider instead.
 */
let customProvider: CopilotSdk.SessionConfig["provider"] | undefined;

function providerFromEnv(env: Record<string, string | undefined>): CopilotSdk.SessionConfig["provider"] | undefined {
  const baseUrl = env.COPILOT_PROVIDER_BASE_URL?.trim();
  if (!baseUrl) return undefined;
  const type = env.COPILOT_PROVIDER_TYPE === "anthropic" || env.COPILOT_PROVIDER_TYPE === "azure" ? env.COPILOT_PROVIDER_TYPE : "openai";
  const maxPrompt = Number(env.COPILOT_PROVIDER_MAX_PROMPT_TOKENS);
  const maxOutput = Number(env.COPILOT_PROVIDER_MAX_OUTPUT_TOKENS);
  return {
    type,
    baseUrl,
    ...(env.COPILOT_PROVIDER_API_KEY ? { apiKey: env.COPILOT_PROVIDER_API_KEY } : {}),
    ...(type !== "anthropic" ? { wireApi: env.COPILOT_PROVIDER_WIRE_API === "responses" ? "responses" as const : "completions" as const } : {}),
    ...(Number.isFinite(maxPrompt) && maxPrompt > 0 ? { maxPromptTokens: maxPrompt } : {}),
    ...(Number.isFinite(maxOutput) && maxOutput > 0 ? { maxOutputTokens: maxOutput } : {}),
  } as CopilotSdk.SessionConfig["provider"];
}
const sessions = new Map<string, Session>();
const waiters = new Map<string, { chatId: string; type: CopilotSdkWaiterType; resolve: (value: unknown) => void }>();
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
    waiter.resolve(COPILOT_SDK_WAITERS[waiter.type].fallback);
    waiters.delete(waiterId);
  }
}

function waitFor<T>(type: CopilotSdkWaiterType, chatId: string, request: unknown): Promise<T> {
  const waiterId = randomUUID();
  return new Promise<T>((resolve) => {
    waiters.set(waiterId, { chatId, type, resolve: resolve as (value: unknown) => void });
    post({ type, chatId, waiterId, request } as CopilotSdkWorkerResponse);
  });
}

type ForkTarget = { throughEventId?: string; throughMessageText?: string; throughMessageOrdinal?: number };

/**
 * The fork boundary that keeps one user turn and everything it produced:
 * the next top-level `user.message` (the fork excludes the boundary event).
 * Undefined keeps the whole history, when the selected turn is the last one.
 * The turn is found by Copilot's event id, or for older chats by its text: the
 * prompt Copilot recorded can carry ADE's context ahead of what the user typed,
 * so it is matched by suffix, and the ordinal counts the same way.
 */
function forkBoundaryAfterTurn(events: readonly unknown[], target: ForkTarget): string | undefined {
  const roots = events.flatMap((raw, index) => {
    const event = raw as { id?: unknown; type?: unknown; agentId?: unknown; ephemeral?: unknown; data?: { content?: unknown; isAutopilotContinuation?: unknown; source?: unknown } };
    // Only prompts start a turn. Autopilot continuations, hidden injections
    // (`source`, e.g. a loaded skill) and ephemeral messages belong to the turn
    // before them; the same rule picks the turn's id in agentChatService.
    return event.type === "user.message" && !event.agentId && typeof event.id === "string"
      && event.data?.isAutopilotContinuation !== true && !event.data?.source && event.ephemeral !== true
      ? [{ index, id: event.id, text: typeof event.data?.content === "string" ? event.data.content.trim() : "" }]
      : [];
  });
  const wanted = target.throughMessageText?.trim();
  const selected = target.throughEventId
    ? roots.find((root) => root.id === target.throughEventId)
    : wanted ? roots.filter((root) => root.text.endsWith(wanted))[target.throughMessageOrdinal ?? 0] : undefined;
  if (!selected) throw new Error("Could not map the selected ADE turn to a Copilot user event; fork the full chat instead.");
  return roots.find((root) => root.index > selected.index)?.id;
}

function requireSession(chatId: string): Session {
  const session = sessions.get(chatId);
  if (!session) throw new Error("Copilot session is not open.");
  return session;
}

/**
 * Put a session at one of ADE's Copilot levels and report the permission mode
 * Copilot actually holds. Plan is a session mode, not a permission mode: it
 * also drops approvals to manual (a chat that was at Full-auto would otherwise
 * plan under allow-all and never ask), and leaving it restores the
 * interactive session. Assisted that the plan refuses falls back to manual.
 */
async function applyPermissionMode(session: Session, chatId: string, level: string | undefined): Promise<{ mode: string; error: string | null }> {
  const plan = level === "plan";
  await session.rpc.mode.set({ mode: plan ? "plan" : "interactive" });
  const requested = plan ? "manual" : level === "assisted" ? "assisted" : level === "full-auto" ? "allow-all" : "manual";
  let error: string | null = null;
  try {
    await session.rpc.permissions.setMode({ mode: requested });
  } catch (cause) {
    if (requested !== "assisted") throw cause;
    error = cause instanceof Error ? cause.message : String(cause);
    await session.rpc.permissions.setMode({ mode: "manual" });
  }
  const mode = (await session.rpc.permissions.getMode()).mode;
  postLog(error ? "warn" : "info", error ? "Copilot Assisted mode rejected; using Ask" : "Copilot permission mode applied", { chatId, requested, mode, ...(error ? { sdkError: error } : {}) });
  return { mode, error };
}

function sessionConfig(config: CopilotSdkSessionConfig): CopilotSdk.SessionConfig {
  return {
    sessionId: config.sessionId,
    // Recorded as `client_name` in the session's `workspace.yaml` (on create
    // only; a resume keeps the CLI's own name), which is how session import
    // tells ADE's chats apart from the user's CLI sessions in the shared store.
    clientName: "ade",
    workingDirectory: config.cwd,
    model: config.model && config.model !== "auto" ? config.model : undefined,
    reasoningEffort: reasoningEffort(config.reasoningEffort),
    streaming: true,
    systemMessage: config.systemMessage ? { mode: "append", content: config.systemMessage } : undefined,
    skillDirectories: config.skillDirectories,
    mcpServers: config.mcpServers,
    disabledMcpServers: config.disabledMcpServers,
    contextTier: config.contextTier,
    capi: config.autoTier ? { autoTier: config.autoTier } : undefined,
    // Interactive chats inherit workspace `.mcp.json` like the Copilot CLI.
    // Utility sessions must remain isolated from user/workspace/plugin MCP.
    enableConfigDiscovery: !config.utility,
    ...(customProvider ? { provider: customProvider } : {}),
    // Rewind needs Copilot to snapshot file changes per turn.
    enableFileChangeTracking: !config.utility,
    infiniteSessions: config.utility
      ? { enabled: false }
      : { enabled: true, ...(config.backgroundCompactionThreshold ? { backgroundCompactionThreshold: config.backgroundCompactionThreshold } : {}) },
    availableTools: config.utility ? [] : undefined,
    skipCustomInstructions: config.utility,
    onPermissionRequest: config.utility
      ? () => ({ kind: "reject" as const })
      // The safety judge's recommendation (`assistedApproval`), managed policy
      // and the session-approval data live on the invocation's `promptRequest`.
      : (request, invocation) => waitFor<CopilotSdk.PermissionRequestResult>(
        "permission_request",
        config.chatId,
        invocation.promptRequest ? { ...request, promptRequest: invocation.promptRequest } : request,
      ),
    onUserInputRequest: config.utility
      ? undefined
      : (request) => waitFor<UserInputResponse>("user_input_request", config.chatId, request),
    // An eligible rate limit asks whether to continue on Auto instead of
    // waiting for the limit to reset.
    onAutoModeSwitchRequest: config.utility
      ? undefined
      : (request) => waitFor<CopilotSdk.AutoModeSwitchResponse>("auto_mode_switch_request", config.chatId, request),
    // MCP servers can ask the user for structured input (form or URL).
    onElicitationRequest: config.utility
      ? undefined
      : (request) => waitFor<CopilotSdk.ElicitationResult>("elicitation_request", config.chatId, request),
    onMcpAuthRequest: config.utility
      ? async () => ({ kind: "cancelled" as const })
      : (request) => waitFor<McpAuthResult>("mcp_auth_request", config.chatId, request),
    onExitPlanModeRequest: config.utility ? undefined : (request) => waitFor("exit_plan_request", config.chatId, request),
    // Plan mode is applied after open through the experimental session mode RPC.
  };
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
  customProvider = providerFromEnv(payload.baseEnv);
  client = new sdk.CopilotClient({
    connection: sdk.RuntimeConnection.forStdio({
      path: payload.cliPath,
      env: Object.fromEntries(Object.entries(payload.baseEnv).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    }),
    baseDirectory: payload.baseDirectory,
    useLoggedInUser: true,
    logLevel: "error",
  });
  try {
    await client.start();
  } catch (error) {
    // ADE's pinned runtime matches its SDK; only a COPILOT_EXECUTABLE override
    // can speak another protocol, and the SDK's own message does not say so.
    const message = error instanceof Error ? error.message : String(error);
    if (/protocol version mismatch/i.test(message)) throw new Error(`${message} COPILOT_EXECUTABLE names a Copilot that does not match ADE's Copilot SDK.`);
    throw error;
  }
  const status = await client.getStatus();
  disposed = false;
  return status;
}

async function dispatch(req: CopilotSdkWorkerRequest): Promise<unknown> {
  if (req.type === "respond_permission" || req.type === "respond_user_input" || req.type === "respond_mcp_auth" || req.type === "respond_exit_plan"
    || req.type === "respond_auto_mode_switch" || req.type === "respond_elicitation") {
    const waiter = waiters.get(req.payload.waiterId);
    if (waiter) {
      const result = req.type === "respond_user_input" ? req.payload.response : req.payload.result;
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
    const { mode: permissionMode, error: permissionError } = await applyPermissionMode(session, req.payload.chatId, req.payload.permissionMode);
    sessions.set(req.payload.chatId, session);
    watchSession(req.payload.chatId, session);
    postLog("debug", "Copilot session options applied", {
      chatId: req.payload.chatId,
      contextTier: req.payload.contextTier ?? "default",
      autoTier: req.payload.autoTier ?? null,
      resumed: req.type === "resume",
    });
    return { sessionId: session.sessionId, events: await session.getEvents(), permissionMode, permissionError };
  }
  if (req.type === "send") {
    const session = requireSession(req.payload.chatId);
    return {
      result: await session.send({
        prompt: req.payload.prompt,
        attachments: req.payload.attachments,
        mode: req.payload.mode,
        ...(req.payload.agentMode ? { agentMode: req.payload.agentMode } : {}),
        ...(req.payload.displayPrompt ? { displayPrompt: req.payload.displayPrompt } : {}),
      }),
    };
  }
  if (req.type === "set_model") {
    const session = requireSession(req.payload.chatId);
    const effort = reasoningEffort(req.payload.reasoningEffort);
    await session.setModel(req.payload.model, {
      ...(effort ? { reasoningEffort: effort } : {}),
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
    const session = requireSession(req.payload.chatId);
    const result = await session.setAutoTier(req.payload.autoTier);
    postLog("debug", "Copilot Auto tier selection", { chatId: req.payload.chatId, requested: req.payload.autoTier, status: result.status });
    return result;
  }
  if (req.type === "set_permission_mode") {
    const session = requireSession(req.payload.chatId);
    return applyPermissionMode(session, req.payload.chatId, req.payload.permissionMode);
  }
  if (req.type === "fork_session") {
    const session = requireSession(req.payload.chatId);
    const throughTurn = req.payload.throughEventId || req.payload.throughMessageText !== undefined;
    const toEventId = throughTurn ? forkBoundaryAfterTurn(await session.getEvents(), req.payload) : undefined;
    const result = await client.rpc.sessions.fork({ sessionId: req.payload.sessionId, ...(toEventId ? { toEventId } : {}) });
    const forkedId = result.sessionId?.trim();
    if (!forkedId) throw new Error("Copilot fork did not return a new session id.");
    return forkedId;
  }
  if (req.type === "rewind") {
    const session = requireSession(req.payload.chatId);
    if (req.payload.action === "list") return session.rpc.history.listRewindPoints();
    if (!req.payload.eventId) throw new Error("Copilot rewind requires an event id.");
    if (req.payload.action === "preview") return session.rpc.history.previewRewind({ eventId: req.payload.eventId });
    return session.rpc.history.rewind({ eventId: req.payload.eventId, mode: "conversation-and-files" });
  }
  if (req.type === "commands") {
    // Copilot's own slash commands and the skills it loaded, as its CLI lists them.
    const session = requireSession(req.payload.chatId);
    return session.rpc.commands.list({ includeBuiltins: true, includeSkills: true, includeClientCommands: false });
  }
  if (req.type === "command") {
    const session = requireSession(req.payload.chatId);
    return session.rpc.commands.invoke({ name: req.payload.name, ...(req.payload.input ? { input: req.payload.input } : {}) });
  }
  if (req.type === "usage_metrics") {
    const session = requireSession(req.payload.chatId);
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
      // The parent gets the failure in the response and shows or handles it; only
      // crashes are errors here (they become Sentry issues in the pool).
      postLog("warn", "Copilot SDK worker request failed", { type: req.type, error: message });
      post({ type: "response", requestId: req.requestId, ok: false, error: message });
    },
  );
});

process.once("disconnect", () => { settleWaiters(); void dispatch({ type: "dispose", requestId: "disconnect" }); });
process.on("unhandledRejection", (reason) => { postLog("error", "Unhandled rejection in Copilot SDK worker", { error: reason instanceof Error ? reason.message : String(reason) }); process.exit(1); });
process.on("uncaughtException", (error) => { postLog("error", "Uncaught exception in Copilot SDK worker", { error: error.message, stack: error.stack }); process.exit(1); });

