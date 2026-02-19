import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import type {
  CodexAccountState,
  CodexApprovalDecision,
  CodexConnectionState,
  CodexEventPayload,
  CodexLaneThreadBinding,
  CodexLoginAccountArgs,
  CodexLoginAccountResult,
  CodexModel,
  CodexPendingApprovalRequest,
  CodexRateLimits,
  CodexThread,
  CodexThreadListArgs,
  CodexThreadListResult,
  CodexThreadReadArgs,
  CodexThreadResumeArgs,
  CodexThreadStartArgs,
  CodexTurn,
  CodexTurnInterruptArgs,
  CodexTurnStartArgs
} from "../../../shared/types";
import type { createLaneService } from "../lanes/laneService";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import { createCodexLaneThreadStore } from "./laneThreadStore";
import { JsonRpcLineParser, encodeJsonRpcLine, type JsonRpcId, type JsonRpcMessage } from "./jsonRpcLineParser";

type SpawnCodexProcess = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio & { stdio: ["pipe", "pipe", "pipe"] }
) => ChildProcessWithoutNullStreams;

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout> | null;
};

type PendingApproval = {
  rawId: JsonRpcId;
  request: CodexPendingApprovalRequest;
};

function nowIso(): string {
  return new Date().toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isThreadNotMaterializedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.toLowerCase();
  return normalized.includes("is not materialized yet") || normalized.includes("includeturns is unavailable before first user message");
}

function isThreadMissingRolloutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.toLowerCase();
  return normalized.includes("no rollout found for thread") || normalized.includes("missing rollout path for thread");
}

function isConnectionStatus(value: string): CodexConnectionState["status"] {
  if (
    value === "starting" ||
    value === "ready" ||
    value === "restarting" ||
    value === "missing-binary" ||
    value === "error" ||
    value === "stopped"
  ) {
    return value;
  }
  return "error";
}

export function createCodexAppServerService({
  db,
  logger,
  laneService,
  clientVersion,
  onEvent,
  spawnProcess = spawn
}: {
  db: AdeDb;
  logger: Logger;
  laneService: ReturnType<typeof createLaneService>;
  clientVersion: string;
  onEvent?: (event: CodexEventPayload) => void;
  spawnProcess?: SpawnCodexProcess;
}) {
  const laneThreadStore = createCodexLaneThreadStore({ db });
  const parser = new JsonRpcLineParser();

  let child: ChildProcessWithoutNullStreams | null = null;
  let startPromise: Promise<void> | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let restartAttempt = 0;
  let intentionallyStopped = false;
  let nextRequestId = 1;
  let authMode: CodexAccountState["authMode"] = null;

  const pendingRequests = new Map<string, PendingRequest>();
  const pendingApprovals = new Map<string, PendingApproval>();
  const threadLaneMemory = new Map<string, string>();
  const missingRolloutThreadIdsLogged = new Set<string>();

  let connectionState: CodexConnectionState = {
    status: "stopped",
    detail: null,
    restartAttempt: 0,
    updatedAt: nowIso()
  };

  const emit = (event: CodexEventPayload) => {
    try {
      onEvent?.(event);
    } catch {
      // ignore renderer delivery issues
    }
  };

  const setConnectionState = (statusRaw: string, detail: string | null) => {
    connectionState = {
      status: isConnectionStatus(statusRaw),
      detail,
      restartAttempt,
      updatedAt: nowIso()
    };
    emit({ type: "connection", state: connectionState });
  };

  const requestKey = (id: JsonRpcId): string => String(id);

  const clearRestartTimer = () => {
    if (!restartTimer) return;
    clearTimeout(restartTimer);
    restartTimer = null;
  };

  const rejectAllPendingRequests = (message: string) => {
    for (const [id, pending] of pendingRequests.entries()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(new Error(`${message} (method=${pending.method}, id=${id})`));
    }
    pendingRequests.clear();
  };

  const clearPendingApprovals = () => {
    pendingApprovals.clear();
  };

  const writeMessage = (payload: Record<string, unknown>) => {
    if (!child || !child.stdin.writable || child.stdin.destroyed) {
      throw new Error("Codex app-server stdin is not writable.");
    }
    child.stdin.write(encodeJsonRpcLine(payload));
  };

  const sendNotification = (method: string, params?: unknown) => {
    const payload: Record<string, unknown> = { method };
    if (params !== undefined) payload.params = params;
    writeMessage(payload);
  };

  const sendErrorResponse = (rawId: JsonRpcId, code: number, message: string, data?: unknown) => {
    const errorPayload: Record<string, unknown> = {
      code,
      message
    };
    if (data !== undefined) errorPayload.data = data;
    try {
      writeMessage({
        id: rawId,
        error: errorPayload
      });
    } catch (error) {
      logger.warn("codex.app_server.write_error_response_failed", {
        id: rawId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const scheduleRestart = (reason: string) => {
    if (intentionallyStopped) return;
    if (restartTimer) return;

    const waitMs = Math.min(10_000, 1_000 * Math.max(1, restartAttempt + 1));
    restartAttempt += 1;
    setConnectionState("restarting", `${reason}. Retrying in ${waitMs}ms.`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      void start().catch(() => {
        // next restart is scheduled by start()/process handlers
      });
    }, waitMs);
  };

  const handleProcessGone = (reason: string, shouldRestart: boolean) => {
    child = null;
    rejectAllPendingRequests(`Codex app-server unavailable: ${reason}`);
    clearPendingApprovals();
    if (shouldRestart) {
      scheduleRestart(reason);
      return;
    }
    setConnectionState("stopped", reason);
  };

  const handleServerRequest = (message: JsonRpcMessage & { method: string; id: JsonRpcId; params?: unknown }) => {
    const method = message.method;
    const params = asRecord(message.params) ?? {};
    const requestId = requestKey(message.id);

    if (method !== "item/commandExecution/requestApproval" && method !== "item/fileChange/requestApproval") {
      sendErrorResponse(message.id, -32601, `Unsupported server request method: ${method}`);
      emit({
        type: "transport-error",
        message: `Unsupported server request method: ${method}`,
        at: nowIso()
      });
      return;
    }

    const request: CodexPendingApprovalRequest = {
      requestId,
      method,
      threadId: asString(params.threadId) ?? "",
      turnId: asString(params.turnId) ?? "",
      itemId: asString(params.itemId) ?? "",
      reason: asString(params.reason),
      command: asString(params.command),
      cwd: asString(params.cwd),
      grantRoot: asString(params.grantRoot),
      requestedAt: nowIso()
    };
    pendingApprovals.set(requestId, { rawId: message.id, request });
    emit({
      type: "server-request",
      request,
      receivedAt: nowIso()
    });
  };

  const handleResponse = (message: JsonRpcMessage & { id: JsonRpcId; result?: unknown; error?: unknown }) => {
    const key = requestKey(message.id);
    const pending = pendingRequests.get(key);
    if (!pending) return;

    pendingRequests.delete(key);
    if (pending.timeout) clearTimeout(pending.timeout);

    const errorRecord = asRecord(message.error);
    if (errorRecord && typeof errorRecord.code === "number" && typeof errorRecord.message === "string") {
      const err = new Error(`JSON-RPC error ${errorRecord.code}: ${errorRecord.message}`);
      pending.reject(err);
      return;
    }
    pending.resolve(message.result);
  };

  const handleNotification = (message: JsonRpcMessage & { method: string; params?: unknown }) => {
    const paramsRecord = asRecord(message.params);
    if (message.method === "account/updated") {
      const mode = asString(paramsRecord?.authMode);
      if (mode === "apikey" || mode === "chatgpt" || mode === "chatgptAuthTokens") {
        authMode = mode;
      } else {
        authMode = null;
      }
    }
    emit({
      type: "notification",
      method: message.method,
      params: message.params ?? null,
      receivedAt: nowIso()
    });
  };

  const handleStdoutChunk = (chunk: Buffer | string) => {
    const { messages, parseErrors } = parser.push(chunk);
    for (const parseError of parseErrors) {
      logger.warn("codex.app_server.json_parse_error", { error: parseError });
      emit({
        type: "transport-error",
        message: `Failed to parse app-server output: ${parseError}`,
        at: nowIso()
      });
    }

    for (const message of messages) {
      if ("method" in message && "id" in message) {
        handleServerRequest(message);
        continue;
      }
      if ("method" in message) {
        handleNotification(message);
        continue;
      }
      if ("id" in message) {
        handleResponse(message);
      }
    }
  };

  const sendRequest = async <T>(method: string, params?: unknown, opts?: { timeoutMs?: number; requireReady?: boolean }): Promise<T> => {
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const requireReady = opts?.requireReady ?? true;
    if (requireReady) {
      await ensureReady();
    } else if (!child) {
      await start();
    }

    if (!child) {
      throw new Error("Codex app-server process is not running.");
    }

    const id = nextRequestId++;
    const key = requestKey(id);

    const promise = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(key);
        reject(new Error(`JSON-RPC request timed out: ${method}`));
      }, timeoutMs);
      pendingRequests.set(key, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timeout
      });
    });

    const payload: Record<string, unknown> = { id, method };
    if (params !== undefined) payload.params = params;
    try {
      writeMessage(payload);
    } catch (error) {
      const pending = pendingRequests.get(key);
      if (pending?.timeout) clearTimeout(pending.timeout);
      pendingRequests.delete(key);
      throw error;
    }

    return await promise;
  };

  const attachProcessListeners = (proc: ChildProcessWithoutNullStreams) => {
    proc.stdout.on("data", (chunk: Buffer | string) => {
      handleStdoutChunk(chunk);
    });
    proc.stderr.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const rolloutMatch = text.match(/missing rollout path for thread ([0-9a-f-]+)/i);
      if (rolloutMatch?.[1]) {
        const threadId = rolloutMatch[1];
        if (!missingRolloutThreadIdsLogged.has(threadId)) {
          missingRolloutThreadIdsLogged.add(threadId);
          logger.debug("codex.app_server.stderr.rollout_path_missing", { threadId });
        }
        return;
      }
      logger.warn("codex.app_server.stderr", { text: text.trim() });
    });
    proc.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      const code = (error as NodeJS.ErrnoException | null)?.code ?? null;
      logger.error("codex.app_server.process_error", { message, code });
      if (code === "ENOENT") {
        setConnectionState(
          "missing-binary",
          "Codex CLI was not found in PATH. Install Codex CLI and retry. Example: npm i -g @openai/codex"
        );
        handleProcessGone("codex binary missing", false);
        return;
      }
      setConnectionState("error", message);
      handleProcessGone(message, true);
    });
    proc.on("exit", (code, signal) => {
      const reason = `app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
      logger.warn("codex.app_server.exited", { code, signal });
      setConnectionState("error", reason);
      handleProcessGone(reason, !intentionallyStopped);
    });
  };

  const start = async () => {
    if (startPromise) return await startPromise;
    clearRestartTimer();

    startPromise = (async () => {
      setConnectionState("starting", null);
      const proc = spawnProcess("codex", ["app-server", "--listen", "stdio://"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env
      });
      child = proc;
      attachProcessListeners(proc);

      try {
        await sendRequest<{ userAgent: string }>(
          "initialize",
          {
            clientInfo: {
              name: "ade_desktop",
              title: "ADE Desktop",
              version: clientVersion
            }
          },
          { timeoutMs: 15_000, requireReady: false }
        );
        sendNotification("initialized", {});
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setConnectionState("error", `Handshake failed: ${message}`);
        handleProcessGone(`initialize failed: ${message}`, true);
        throw error;
      }

      restartAttempt = 0;
      setConnectionState("ready", null);
    })();

    try {
      await startPromise;
    } finally {
      startPromise = null;
    }
  };

  const ensureReady = async () => {
    if (connectionState.status === "ready" && child) return;
    await start();
    if (connectionState.status !== "ready") {
      throw new Error(connectionState.detail ?? "Codex app-server is not ready.");
    }
  };

  const resolveLaneCwd = (laneId: string): string => {
    const normalized = laneId.trim();
    if (!normalized) throw new Error("laneId is required.");
    return laneService.getLaneWorktreePath(normalized);
  };

  const rememberLaneThread = (laneId: string, threadId: string, setDefault: boolean) => {
    const normalizedLaneId = laneId.trim();
    const normalizedThreadId = threadId.trim();
    if (!normalizedLaneId || !normalizedThreadId) return;
    threadLaneMemory.set(normalizedThreadId, normalizedLaneId);
    laneThreadStore.rememberThread(normalizedLaneId, normalizedThreadId, { setDefault });
  };

  const coerceThreadFromResponse = (raw: unknown): CodexThread => {
    const record = asRecord(raw);
    if (!record || typeof record.id !== "string") {
      throw new Error("Invalid thread response from Codex app-server.");
    }
    return record as unknown as CodexThread;
  };

  const coerceTurnFromResponse = (raw: unknown): CodexTurn => {
    const record = asRecord(raw);
    if (!record || typeof record.id !== "string") {
      throw new Error("Invalid turn response from Codex app-server.");
    }
    return record as unknown as CodexTurn;
  };

  return {
    getConnectionState(): CodexConnectionState {
      return connectionState;
    },

    async retryConnection(): Promise<CodexConnectionState> {
      restartAttempt = 0;
      clearRestartTimer();
      intentionallyStopped = false;
      if (child) {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
      child = null;
      await ensureReady();
      return connectionState;
    },

    getLaneBinding(laneId: string): CodexLaneThreadBinding {
      return laneThreadStore.getLaneBinding(laneId);
    },

    setLaneDefaultThread(laneId: string, threadId: string | null): CodexLaneThreadBinding {
      laneThreadStore.setDefaultThread(laneId, threadId);
      return laneThreadStore.getLaneBinding(laneId);
    },

    async threadStart(args: CodexThreadStartArgs): Promise<CodexThread> {
      const cwd = resolveLaneCwd(args.laneId);
      const result = await sendRequest<{ thread: unknown }>("thread/start", {
        model: args.model ?? undefined,
        cwd,
        approvalPolicy: args.approvalPolicy ?? "on-request",
        sandbox: args.sandbox ?? "workspace-write",
        experimentalRawEvents: false
      });
      const thread = coerceThreadFromResponse(result.thread);
      rememberLaneThread(args.laneId, thread.id, true);
      return thread;
    },

    async threadResume(args: CodexThreadResumeArgs): Promise<CodexThread> {
      const cwd = resolveLaneCwd(args.laneId);
      try {
        const result = await sendRequest<{ thread: unknown }>("thread/resume", {
          threadId: args.threadId,
          model: args.model ?? undefined,
          cwd,
          approvalPolicy: args.approvalPolicy ?? "on-request",
          sandbox: args.sandbox ?? "workspace-write"
        });
        const thread = coerceThreadFromResponse(result.thread);
        rememberLaneThread(args.laneId, thread.id, true);
        return thread;
      } catch (error) {
        if (isThreadMissingRolloutError(error)) {
          laneThreadStore.forgetThread(args.laneId, args.threadId);
        }
        throw error;
      }
    },

    async threadList(args: CodexThreadListArgs = {}): Promise<CodexThreadListResult> {
      const result = await sendRequest<CodexThreadListResult>("thread/list", {
        cursor: args.cursor ?? null,
        limit: args.limit ?? 50,
        sortKey: args.sortKey ?? "updated_at",
        modelProviders: args.modelProviders ?? null
      });
      return result;
    },

    async threadRead(args: CodexThreadReadArgs): Promise<CodexThread> {
      const includeTurns = args.includeTurns ?? true;
      try {
        const result = await sendRequest<{ thread: unknown }>("thread/read", {
          threadId: args.threadId,
          includeTurns
        });
        return coerceThreadFromResponse(result.thread);
      } catch (error) {
        if (!includeTurns || !isThreadNotMaterializedError(error)) {
          throw error;
        }
        const fallback = await sendRequest<{ thread: unknown }>("thread/read", {
          threadId: args.threadId,
          includeTurns: false
        });
        return coerceThreadFromResponse(fallback.thread);
      }
    },

    async turnStart(args: CodexTurnStartArgs): Promise<CodexTurn> {
      const prompt = args.prompt.trim();
      if (!prompt.length) {
        throw new Error("Prompt cannot be empty.");
      }

      const params: Record<string, unknown> = {
        threadId: args.threadId,
        input: [
          {
            type: "text",
            text: prompt,
            text_elements: []
          }
        ],
        model: args.model ?? undefined
      };
      if (args.approvalPolicy) params.approvalPolicy = args.approvalPolicy;
      if (args.effort) params.effort = args.effort;
      if (args.laneId && args.laneId.trim().length) {
        params.cwd = resolveLaneCwd(args.laneId);
        rememberLaneThread(args.laneId, args.threadId, false);
      }

      const result = await sendRequest<{ turn: unknown }>("turn/start", params);
      return coerceTurnFromResponse(result.turn);
    },

    async turnInterrupt(args: CodexTurnInterruptArgs): Promise<void> {
      await sendRequest<Record<string, never>>("turn/interrupt", {
        threadId: args.threadId,
        turnId: args.turnId
      });
    },

    async accountRead(refreshToken = false): Promise<CodexAccountState> {
      const result = await sendRequest<{ account: CodexAccountState["account"]; requiresOpenaiAuth: boolean }>(
        "account/read",
        { refreshToken }
      );
      return {
        account: result.account ?? null,
        requiresOpenaiAuth: Boolean(result.requiresOpenaiAuth),
        authMode
      };
    },

    async accountLoginStart(args: CodexLoginAccountArgs): Promise<CodexLoginAccountResult> {
      const result = await sendRequest<CodexLoginAccountResult>("account/login/start", args);
      return result;
    },

    async accountLoginCancel(loginId: string): Promise<void> {
      await sendRequest<Record<string, never>>("account/login/cancel", {
        loginId
      });
    },

    async accountLogout(): Promise<void> {
      await sendRequest<Record<string, never>>("account/logout");
    },

    async accountRateLimitsRead(): Promise<CodexRateLimits> {
      const result = await sendRequest<CodexRateLimits>("account/rateLimits/read");
      return result;
    },

    async modelList(limit = 100): Promise<{ data: CodexModel[]; nextCursor: string | null }> {
      return await sendRequest<{ data: CodexModel[]; nextCursor: string | null }>("model/list", {
        cursor: null,
        limit
      });
    },

    listPendingApprovals(threadId?: string): CodexPendingApprovalRequest[] {
      const normalizedThreadId = threadId?.trim() ?? "";
      const rows = Array.from(pendingApprovals.values()).map((entry) => entry.request);
      if (!normalizedThreadId) return rows;
      return rows.filter((entry) => entry.threadId === normalizedThreadId);
    },

    async respondToApprovalRequest(requestId: string, decision: CodexApprovalDecision): Promise<void> {
      const key = requestId.trim();
      const entry = pendingApprovals.get(key);
      if (!entry) {
        throw new Error(`No pending approval request found for id '${requestId}'.`);
      }
      writeMessage({
        id: entry.rawId,
        result: {
          decision
        }
      });
      pendingApprovals.delete(key);
      emit({
        type: "server-request-resolved",
        requestId: key,
        at: nowIso()
      });
    },

    dispose(): void {
      intentionallyStopped = true;
      clearRestartTimer();
      rejectAllPendingRequests("Codex service disposed");
      clearPendingApprovals();
      if (child) {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
      child = null;
      setConnectionState("stopped", null);
    }
  };
}
