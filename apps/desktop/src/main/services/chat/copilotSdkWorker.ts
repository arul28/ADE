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
const waiters = new Map<string, (value: unknown) => void>();
let disposed = false;

function post(message: CopilotSdkWorkerResponse): void {
  if (process.send) process.send(message);
}

function postLog(level: "debug" | "info" | "warn" | "error", message: string, detail?: unknown): void {
  post({ type: "log", level, message, ...(detail === undefined ? {} : { detail }) });
}

function waitFor<T>(type: "permission_request" | "user_input_request" | "mcp_auth_request", chatId: string, request: unknown): Promise<T> {
  const waiterId = randomUUID();
  return new Promise<T>((resolve) => {
    waiters.set(waiterId, resolve as (value: unknown) => void);
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
    enableConfigDiscovery: true,
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
    onExitPlanModeRequest: config.utility ? undefined : () => waitFor("permission_request", config.chatId, { kind: "exit_plan_mode" }),
    // Plan mode is applied after open through the experimental session mode RPC.
  } as CopilotSdk.SessionConfig;
}

function watchSession(chatId: string, session: Session): void {
  session.on((event) => post({ type: "event", chatId, event }));
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

async function configuredMcpNames(): Promise<string[]> {
  if (!client) throw new Error("Copilot SDK is not initialized; utility task was not started.");
  const result = await (client.rpc as unknown as { mcp: { listConfigured(): Promise<unknown> } }).mcp.listConfigured();
  const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const rows = Array.isArray(result) ? result : Array.isArray(record.servers) ? record.servers : null;
  if (!rows) throw new Error("Could not enumerate configured Copilot MCP servers; utility task was not started.");
  return rows.flatMap((row) => {
    const name = row && typeof row === "object" ? (row as Record<string, unknown>).name : null;
    return typeof name === "string" && name.trim() ? [name.trim()] : [];
  });
}

async function dispatch(req: CopilotSdkWorkerRequest): Promise<unknown> {
  if (req.type === "respond_permission") { waiters.get(req.payload.waiterId)?.(req.payload.result); waiters.delete(req.payload.waiterId); return {}; }
  if (req.type === "respond_user_input") { waiters.get(req.payload.waiterId)?.(req.payload.response); waiters.delete(req.payload.waiterId); return {}; }
  if (req.type === "respond_mcp_auth") { waiters.get(req.payload.waiterId)?.(req.payload.result); waiters.delete(req.payload.waiterId); return {}; }
  if (req.type === "init") return initialize(req.payload);
  if (req.type === "dispose") {
    disposed = true;
    for (const session of sessions.values()) await session.disconnect().catch(() => undefined);
    sessions.clear();
    await client?.stop().catch(() => undefined);
    client = null;
    return {};
  }
  if (!client || disposed) throw new Error("Copilot SDK worker is not initialized.");
  if (req.type === "auth") return client.getAuthStatus();
  if (req.type === "models") return client.listModels();
  if (req.type === "create" || req.type === "resume") {
    const config = sessionConfig(req.payload);
    const session = req.type === "resume" && req.payload.sessionId
      ? await client.resumeSession(req.payload.sessionId, { ...config, continuePendingWork: false })
      : await client.createSession(config);
    if (req.payload.permissionMode === "plan") {
      await session.rpc.mode.set({ mode: "plan" });
    }
    sessions.set(req.payload.chatId, session);
    watchSession(req.payload.chatId, session);
    return { sessionId: session.sessionId, events: await session.getEvents() };
  }
  if (req.type === "send") {
    const session = sessions.get(req.payload.chatId);
    if (!session) throw new Error("Copilot session is not open.");
    return session.sendAndWait({ prompt: req.payload.prompt, attachments: req.payload.attachments, mode: req.payload.mode });
  }
  if (req.type === "set_model") {
    const session = sessions.get(req.payload.chatId);
    if (!session) throw new Error("Copilot session is not open.");
    await session.setModel(req.payload.model, req.payload.reasoningEffort ? { reasoningEffort: req.payload.reasoningEffort as ReasoningEffort } : undefined);
    return {};
  }
  if (req.type === "abort") { await sessions.get(req.payload.chatId)?.abort().catch(() => undefined); return {}; }
  if (req.type === "disconnect") { await sessions.get(req.payload.chatId)?.disconnect().catch(() => undefined); sessions.delete(req.payload.chatId); return {}; }
  if (req.type === "utility") {
    const disabledMcpServers = await configuredMcpNames();
    const id = `ade-utility-${randomUUID()}`;
    const session = await client.createSession(sessionConfig({
      chatId: id,
      sessionId: id,
      cwd: req.payload.cwd,
      model: req.payload.model,
      systemMessage: req.payload.systemMessage,
      disabledMcpServers,
      utility: true,
    }));
    try {
      return await session.sendAndWait(req.payload.prompt);
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

process.once("disconnect", () => { void dispatch({ type: "dispose", requestId: "disconnect" }); });

