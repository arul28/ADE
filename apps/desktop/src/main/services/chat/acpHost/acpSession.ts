/**
 * One ADE chat, on one ACP session.
 *
 * This is the seam W4 wires into. It owns the order of operations that the
 * dialects and the spec demand, so no caller has to remember them:
 *
 *   acquire connection (pool)
 *     -> initialize                     (done by the pool)
 *     -> attach update, permission, and ignored-notification handlers
 *     -> session/new | session/resume | session/load
 *     -> post-session-new notifications (Grok's auto-mode neutralizer)
 *     -> prompt / cancel / prompt ...
 *     -> close (session/close, or process kill)
 *
 * ## Cancel accounting
 *
 * ADE records that it cancelled and reports the turn as interrupted, whatever
 * `stopReason` the agent returns. Copilot has a known bug that reports a
 * cancelled turn as `end_turn`, and Grok only accepts cancel as a notification,
 * so there is no reply to read. The client-side flag is the only honest source.
 *
 * ## Replay suppression
 *
 * `session/load` makes the agent replay the whole conversation as
 * `session/update` notifications. ADE already holds that transcript. Replaying
 * it would duplicate every row. So updates are dropped while the load call is
 * in flight, and only then.
 *
 * ## Supervision
 *
 * The host also decides, per turn, whether the approval cards it renders are
 * real. See `acpSupervisionGuard.ts`: writes with no `session/request_permission`
 * in an ask-style mode mean the agent gated itself, and the user is told once.
 */

import { randomUUID } from "node:crypto";
import type { AgentChatEvent } from "../../../../shared/types";
import type { Logger } from "../../logging/logger";
import {
  AcpRpcError,
  type AcpConnection,
} from "./acpConnection";
import {
  behaviorOf,
  type AcpDialect,
  type AcpSlashCommand,
  type AcpUsageSample,
} from "./acpHostTypes";
import { createAcpEventTranslator, usageSampleToEvents, type AcpEventTranslator } from "./acpEventTranslator";
import {
  createAcpPermissionBridge,
  type AcpPendingPermission,
  type AcpPermissionBridge,
} from "./acpPermissionBridge";
import {
  createAcpSupervisionGuard,
  type AcpSupervisionGuard,
} from "./acpSupervisionGuard";
import {
  ACP_METHOD,
  normalizeAcpConfigOptions,
  type AcpContentBlock,
  type AcpMcpServer,
  type AcpNewSessionResponse,
  type AcpPromptResponse,
  type AcpSessionConfigOption,
  type AcpStopReason,
} from "./acpProtocolTypes";
import { acpSessionPool, type AcpPooledConnection, type AcpSessionPool } from "./acpSessionPool";

/** A turn is bounded by the user, not by a timer. Cancel is the way out. */
const ACP_PROMPT_NO_TIMEOUT = 0;

export type AcpSessionEntryMode = "new" | "resume" | "load";

export type AcpSessionEntryPlan = {
  mode: AcpSessionEntryMode;
  /** True when the host must drop the updates the entry call produces. */
  suppressReplay: boolean;
  /** Why this mode was chosen. Diagnostics and tests. */
  reason: string;
};

/**
 * Decide how to enter a session.
 *
 * Prefer `session/resume` when the dialect advertises it. Fall back to
 * `session/load`, and suppress its replay when ADE already holds a transcript.
 * Start fresh when there is no id, or when the dialect cannot rejoin at all.
 */
export function resolveAcpSessionEntry(args: {
  dialect: AcpDialect;
  existingSessionId: string | null;
  adeHasTranscript: boolean;
}): AcpSessionEntryPlan {
  if (!args.existingSessionId) {
    return { mode: "new", suppressReplay: false, reason: "no stored session id" };
  }
  if (args.dialect.loadPolicy === "never") {
    return { mode: "new", suppressReplay: false, reason: "dialect cannot rejoin a session" };
  }
  if (args.dialect.loadPolicy === "resume_preferred" && args.dialect.resumeSession.declared) {
    return { mode: "resume", suppressReplay: false, reason: "agent advertises session/resume" };
  }
  return {
    mode: "load",
    suppressReplay: args.adeHasTranscript,
    reason: args.adeHasTranscript
      ? "session/load replays history ADE already holds"
      : "session/load is the only rejoin method",
  };
}

export type AcpTurnOutcome = {
  stopReason: AcpStopReason | null;
  /** True when ADE cancelled, or when the agent reported a cancel. */
  interrupted: boolean;
  usage: AcpUsageSample | null;
  /** Events derived from the prompt result. Publish them after the stream. */
  events: AgentChatEvent[];
};

export type AcpSessionCallbacks = {
  /** Publish these chat events, in order. Never batches across a turn. */
  onEvents: (events: AgentChatEvent[]) => void;
  /** Raise a permission card. Answer through `pending.select` or `.cancel`. */
  onPermissionRequested: (pending: AcpPendingPermission) => void;
  /** The permission request settled. Drop the card. */
  onPermissionSettled: (requestId: string, outcome: "selected" | "cancelled" | "closed") => void;
  /** The advertised slash command list changed. */
  onSlashCommands?: (commands: AcpSlashCommand[]) => void;
  /** The agent reported session config options or a mode change. */
  onConfigOptions?: (snapshot: { options: AcpSessionConfigOption[]; currentModeId: string | null }) => void;
  /** The agent reported its own session title. */
  onSessionInfo?: (info: { title: string | null; updatedAt: string | null }) => void;
  /** The agent process went away. The session is dead. */
  onProcessExit?: (detail: { code: number | null; signal: string | null; stderrTail: string }) => void;
};

export type AcpSession = {
  readonly providerId: AcpDialect["providerId"];
  readonly dialect: AcpDialect;
  /** The agent's session id. Persist it; it is how a chat is resumed. */
  readonly sessionId: string;
  readonly entryPlan: AcpSessionEntryPlan;
  readonly connection: AcpConnection;
  /** Session modes and config options the entry call reported. */
  readonly initialConfigOptions: AcpSessionConfigOption[];
  readonly initialModeId: string | null;
  /**
   * True once ADE has published the "this agent gates itself" notice. The
   * caller persists it so a runtime restart does not repeat the line.
   */
  readonly unsupervised: boolean;

  /** Run one turn. Resolves when the agent stops. */
  prompt(args: { turnId: string; blocks: AcpContentBlock[] }): Promise<AcpTurnOutcome>;
  /** Stop the running turn. Answers every open permission request first. */
  cancel(reason: string): Promise<void>;
  /** Set one session config option, when the dialect supports it. */
  setConfigOption(args: { configId: string; value: string | boolean }): Promise<void>;
  /** End the session and release the pooled connection. Idempotent. */
  close(reason: string): Promise<void>;
};

export type OpenAcpSessionArgs = {
  dialect: AcpDialect;
  /** Lane worktree. Becomes the session cwd. */
  cwd: string;
  /** Already built by `dialect.buildSpawnPlan`. */
  spawnPlan: Parameters<AcpSessionPool["acquire"]>[0]["spawnPlan"];
  /** Unique per ADE chat. Drives the private pool key for Kimi. */
  sessionToken: string;
  /** Provider session id ADE stored for this chat, when it has one. */
  existingSessionId?: string | null;
  /**
   * Abstract ACP permission mode this session opened with. The supervision
   * guard needs it to know whether the user was promised a prompt at all.
   */
  permissionMode?: string | null;
  /**
   * Verdict of a provider-specific pre-session gate, when one applies.
   * `ok: false` means ADE could not confirm the agent will ask before it
   * writes; the session still runs, and the guard says so out loud.
   */
  supervisionPreflight?: { ok: boolean; detail?: string } | null;
  /**
   * True when this chat already showed the unsupervised notice in an earlier
   * run. Keeps the once-per-session promise across a runtime restart.
   */
  supervisionAlreadyNotified?: boolean;
  /** True when ADE can already render this chat's history. */
  adeHasTranscript?: boolean;
  /** MCP servers to offer. The caller already removed anything unsafe. */
  mcpServers?: AcpMcpServer[];
  callbacks: AcpSessionCallbacks;
  logger?: Logger;
  pool?: AcpSessionPool;
  /** Test seam, forwarded to the pool and then to the connection. */
  spawnOverride?: Parameters<AcpSessionPool["acquire"]>[0]["spawnOverride"];
  handshakeTimeoutMs?: number;
  idleTtlMs?: number;
};

export async function openAcpSession(args: OpenAcpSessionArgs): Promise<AcpSession> {
  const { dialect, callbacks } = args;
  const pool = args.pool ?? acpSessionPool;

  const leased: AcpPooledConnection = await pool.acquire({
    dialect,
    spawnPlan: args.spawnPlan,
    poolEnvKeys: dialect.poolEnvKeys,
    sessionToken: args.sessionToken,
    ...(args.logger ? { logger: args.logger } : {}),
    ...(args.idleTtlMs !== undefined ? { idleTtlMs: args.idleTtlMs } : {}),
    ...(args.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: args.handshakeTimeoutMs } : {}),
    ...(args.spawnOverride ? { spawnOverride: args.spawnOverride } : {}),
  });
  const connection = leased.connection;
  const agentCapabilities = connection.initializeResult?.agentCapabilities ?? {};
  const effectiveMcpServers = filterMcpServers(dialect, args.mcpServers ?? [], agentCapabilities.mcpCapabilities ?? null);

  let sessionId = "";
  let suppressUpdates = false;
  let closed = false;
  let cancelRequested = false;
  const unsubscribers: Array<() => void> = [];

  const translator: AcpEventTranslator = createAcpEventTranslator({
    readUsage: dialect.usageSource === "usage_update" ? (update) => {
      const behavior = behaviorOf(dialect.usage);
      return behavior ? behavior({ usageUpdate: update }) : null;
    } : null,
    includeSlashCommand: dialect.includeSlashCommand,
    callbacks: {
      ...(callbacks.onSlashCommands ? { onSlashCommands: callbacks.onSlashCommands } : {}),
      ...(callbacks.onConfigOptions ? { onConfigOptions: callbacks.onConfigOptions } : {}),
      ...(callbacks.onSessionInfo ? { onSessionInfo: callbacks.onSessionInfo } : {}),
    },
  });

  const supervision: AcpSupervisionGuard = createAcpSupervisionGuard({
    providerLabel: dialect.displayName,
    permissionMode: args.permissionMode ?? null,
    ...(args.supervisionPreflight && !args.supervisionPreflight.ok
      ? { preflightUnverified: true }
      : {}),
    ...(args.supervisionAlreadyNotified ? { alreadyNotified: true } : {}),
  });

  /** Publish any supervision notice the guard produced. At most one, ever. */
  const publishSupervision = (events: AgentChatEvent[]): void => {
    if (events.length) callbacks.onEvents(events);
  };

  const permissionBridge: AcpPermissionBridge = createAcpPermissionBridge({
    callbacks: {
      onPermissionRequested: (pending) => {
        // Counted before the card is raised. Whether the user answers is the
        // user's business; what matters is that the agent asked at all.
        supervision.notePermissionRequest();
        callbacks.onPermissionRequested(pending);
      },
      onPermissionSettled: callbacks.onPermissionSettled,
    },
  });

  unsubscribers.push(
    connection.onSessionUpdate((notification) => {
      if (suppressUpdates) return;
      if (sessionId && notification.sessionId && notification.sessionId !== sessionId) return;
      const update = notification.update;
      if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        supervision.noteToolCall(update.kind);
      }
      const events = translator.translate(update);
      if (events.length) callbacks.onEvents(events);
    }),
  );

  unsubscribers.push(
    connection.onRequest(
      ACP_METHOD.sessionRequestPermission,
      (params) => permissionBridge.handleRequest(params),
      {
        // A pooled ACP process can own several protocol sessions. Reverse
        // requests carry their session id, so never let chat B's permission
        // bridge answer a request that belongs to chat A.
        matches: (params) => {
          if (!params || typeof params !== "object" || Array.isArray(params)) return false;
          const requestSessionId = (params as { sessionId?: unknown }).sessionId;
          return typeof requestSessionId === "string" && requestSessionId === sessionId;
        },
      },
    ),
  );

  for (const method of dialect.ignoredNotificationMethods) {
    // Receive and drop. Registering the handler keeps the method out of the
    // "unhandled notification" path and documents that the silence is meant.
    unsubscribers.push(connection.onNotification(method, () => undefined));
  }

  unsubscribers.push(
    connection.onExit((exit) => {
      permissionBridge.rejectAll("the agent process exited");
      callbacks.onProcessExit?.({ code: exit.code, signal: exit.signal, stderrTail: exit.stderrTail });
    }),
  );

  const entryPlan = resolveAcpSessionEntry({
    dialect,
    existingSessionId: args.existingSessionId ?? null,
    adeHasTranscript: args.adeHasTranscript ?? false,
  });

  let initialConfigOptions: AcpSessionConfigOption[] = [];
  let initialModeId: string | null = null;

  try {
    if (entryPlan.mode === "new") {
      const response = await connection.request<AcpNewSessionResponse>(ACP_METHOD.sessionNew, {
        cwd: args.cwd,
        mcpServers: effectiveMcpServers,
      });
      sessionId = response.sessionId;
      initialConfigOptions = normalizeAcpConfigOptions(response.configOptions ?? []);
      initialModeId = response.modes?.currentModeId ?? null;
      for (const notification of dialect.postSessionNewNotifications({ sessionId })) {
        connection.notify(notification.method, { sessionId, ...notification.params });
      }
    } else {
      const storedId = args.existingSessionId as string;
      const behavior =
        entryPlan.mode === "resume"
          ? behaviorOf(dialect.resumeSession)
          : behaviorOf(dialect.loadSession);
      if (!behavior) {
        throw new Error(`${dialect.displayName} declares ${entryPlan.mode} but supplies no behavior.`);
      }
      const call = behavior({ sessionId: storedId, cwd: args.cwd, mcpServers: effectiveMcpServers });
      suppressUpdates = entryPlan.suppressReplay;
      try {
        const response = await connection.request<AcpNewSessionResponse>(call.method, call.params);
        sessionId = response.sessionId ?? storedId;
        initialConfigOptions = normalizeAcpConfigOptions(response.configOptions ?? []);
        initialModeId = response.modes?.currentModeId ?? null;
      } finally {
        suppressUpdates = false;
      }
    }
  } catch (error) {
    for (const unsubscribe of unsubscribers) unsubscribe();
    permissionBridge.rejectAll("the session could not be opened");
    leased.release();
    throw error;
  }

  const detach = () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    unsubscribers.length = 0;
  };

  const session: AcpSession = {
    providerId: dialect.providerId,
    dialect,
    sessionId,
    entryPlan,
    connection,
    initialConfigOptions,
    initialModeId,
    get unsupervised() {
      return supervision.unsupervised;
    },

    prompt: async ({ turnId, blocks }) => {
      cancelRequested = false;
      translator.beginTurn(turnId);
      permissionBridge.setTurnId(turnId);
      // A preflight verdict was reached before the caller owned this runtime,
      // so its notice waits for the first turn to have a live event path.
      publishSupervision(supervision.drainQueued(turnId));
      let response: AcpPromptResponse | null = null;
      try {
        response = await connection.request<AcpPromptResponse>(
          ACP_METHOD.sessionPrompt,
          { sessionId, prompt: blocks },
          { timeoutMs: ACP_PROMPT_NO_TIMEOUT },
        );
      } finally {
        // Every open permission request belongs to the turn that just ended.
        permissionBridge.cancelAll("the turn ended");
        permissionBridge.setTurnId(null);
        // A failed or cancelled turn can still have written files, so the
        // verdict is taken on every exit, not just the happy one.
        publishSupervision(supervision.endTurn(turnId));
      }

      const usage = readPromptUsage(dialect, response);
      const events = usage ? usageSampleToEvents(usage, turnId) : [];
      translator.endTurn();
      return {
        stopReason: response?.stopReason ?? null,
        // Client-side accounting. Copilot can report `end_turn` for a turn ADE
        // cancelled, so the agent's word is not the deciding one.
        interrupted: cancelRequested || response?.stopReason === "cancelled",
        usage,
        events,
      };
    },

    cancel: async (reason: string) => {
      cancelRequested = true;
      // Answer the open cards first. A permission request that outlives its
      // turn blocks the agent even after the cancel lands.
      permissionBridge.cancelAll(reason);
      if (dialect.cancelStyle === "notification") {
        connection.notify(ACP_METHOD.sessionCancel, { sessionId });
        return;
      }
      try {
        await connection.request(ACP_METHOD.sessionCancel, { sessionId }, { timeoutMs: 10_000 });
      } catch (error) {
        // An agent that does not implement the request form still stops when it
        // sees the notification. Fall back rather than fail the cancel.
        if (error instanceof AcpRpcError && error.isMethodNotFound) {
          connection.notify(ACP_METHOD.sessionCancel, { sessionId });
          return;
        }
        args.logger?.warn("agent_chat.acp_cancel_failed", {
          provider: dialect.providerId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    setConfigOption: async ({ configId, value }) => {
      const behavior = behaviorOf(dialect.sessionConfig);
      if (!behavior) {
        throw new Error(`${dialect.displayName} does not accept session config options.`);
      }
      const call = behavior({ sessionId, configId, value });
      await connection.request(call.method, call.params);
    },

    close: async (reason: string) => {
      if (closed) return;
      closed = true;
      permissionBridge.cancelAll(reason);
      const closeBehavior = behaviorOf(dialect.closeSession);
      if (closeBehavior) {
        const call = closeBehavior({ sessionId });
        try {
          await connection.request(call.method, call.params, { timeoutMs: 10_000 });
        } catch (error) {
          args.logger?.warn("agent_chat.acp_close_failed", {
            provider: dialect.providerId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        detach();
        leased.release();
        return;
      }
      // No `session/close` on this agent. The process IS the session, and the
      // pool gave this session a private process, so ending it is safe.
      detach();
      leased.evict(reason);
    },
  };

  return session;
}

function filterMcpServers(
  dialect: AcpDialect,
  servers: AcpMcpServer[],
  mcpCapabilities: { http?: boolean; sse?: boolean } | null,
): AcpMcpServer[] {
  const behavior = behaviorOf(dialect.mcpInjection);
  // No MCP injection capability means inject nothing. Silence is the safe
  // default: an agent that receives a server it cannot reach fails the session.
  if (!behavior) return [];
  return behavior({
    servers,
    agentSupportsHttp: mcpCapabilities?.http === true,
    agentSupportsSse: mcpCapabilities?.sse === true,
  });
}

function readPromptUsage(dialect: AcpDialect, response: AcpPromptResponse | null): AcpUsageSample | null {
  if (!response) return null;
  const behavior = behaviorOf(dialect.usage);
  if (!behavior) return null;
  return behavior({ promptResponse: response, promptUsage: response.usage ?? null });
}

/** Build a plain text prompt block. The common case. */
export function textPromptBlock(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

/** Mint a turn id when the caller has none. */
export function newAcpTurnId(): string {
  return randomUUID();
}
