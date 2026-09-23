/**
 * One ADE chat, on one ACP session.
 *
 * This is the seam W4 wires into. It owns the order of operations that the
 * dialects and the spec demand, so no caller has to remember them:
 *
 *   acquire connection (pool)
 *     -> initialize                     (done by the pool)
 *     -> attach update, permission, and extension-notification handlers
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
 * The verdict is taken once, when the `session/prompt` result arrives. The
 * telemetry reads after it can take up to half a second; a Stop pressed during
 * them meets an agent that has already finished, so it neither marks the turn
 * interrupted nor sends `session/cancel` to the idle agent. `turnAnswered`
 * tells the caller it is in that window, so its own Stop can leave the
 * finished turn alone too.
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
 *
 * ## Telemetry
 *
 * Context samples, the dialect's extension notifications, and the provider's
 * local usage ledger feed one `AcpTurnTelemetry` per session
 * (`acpTurnTelemetry.ts`). A turn's `outcome.done` is the set of `done` fields
 * ADE stamps on the turn: totals, context occupancy, request count, provider
 * cost, the served model, the paying account, plan units, and helper agents'
 * usage. The local ledger read and the wait for a post-turn `usage_update` are
 * each bounded to a quarter second, and neither can fail the turn.
 */

import { randomUUID } from "node:crypto";
import type { AgentChatEvent } from "../../../../shared/types";
import type { Logger } from "../../logging/logger";
import { getErrorMessage, settleWithin } from "../../shared/utils";
import {
  AcpRpcError,
  type AcpConnection,
} from "./acpConnection";
import {
  behaviorOf,
  type AcpDialect,
  type AcpLocalUsageReader,
  type AcpSlashCommand,
  type AcpUsageSample,
} from "./acpHostTypes";
import { createAcpEventTranslator, usageSampleToEvents, type AcpEventTranslator } from "./acpEventTranslator";
import { createAcpTurnTelemetry, type AcpDoneTelemetry } from "./acpTurnTelemetry";
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
  hasAcpLoadSessionCapability,
  hasAcpSessionCapability,
  normalizeAcpConfigOptions,
  type AcpAgentCapabilities,
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

/** Longest the turn end waits for a post-turn `usage_update` (Kimi). */
export const ACP_SETTLED_USAGE_WAIT_MS = 250;

/** Longest the turn end waits for the provider's local usage ledger. */
export const ACP_LOCAL_USAGE_DEADLINE_MS = 250;

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
  /** Handshake capabilities. Omit only for dialect-only planning tests. */
  agentCapabilities?: AcpAgentCapabilities | null;
}): AcpSessionEntryPlan {
  if (!args.existingSessionId) {
    return { mode: "new", suppressReplay: false, reason: "no stored session id" };
  }
  if (args.dialect.loadPolicy === "never") {
    return { mode: "new", suppressReplay: false, reason: "dialect cannot rejoin a session" };
  }
  const agentSupportsResume = args.agentCapabilities === undefined
    ? args.dialect.resumeSession.declared
    : hasAcpSessionCapability(args.agentCapabilities, "resume");
  const agentSupportsLoad = args.agentCapabilities === undefined
    ? args.dialect.loadSession.declared
    : hasAcpLoadSessionCapability(args.agentCapabilities);
  if (
    args.dialect.loadPolicy === "resume_preferred"
    && args.dialect.resumeSession.declared
    && agentSupportsResume
  ) {
    return { mode: "resume", suppressReplay: false, reason: "agent advertises session/resume" };
  }
  if (!args.dialect.loadSession.declared || !agentSupportsLoad) {
    return {
      mode: "new",
      suppressReplay: false,
      reason: "agent does not advertise a supported session rejoin method",
    };
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
  /**
   * True when ADE cancelled, the agent reported a cancel, or the caller's
   * `isInterrupted` answered true, all read when the prompt result arrived.
   */
  interrupted: boolean;
  usage: AcpUsageSample | null;
  /** Events derived from the prompt result. Publish them after the stream. */
  events: AgentChatEvent[];
  /**
   * The `done` fields the host owns: usage totals and context, provider cost,
   * served model, account, plan units, and confidence. Spread into `done`.
   */
  done: AcpDoneTelemetry;
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
  /**
   * True from the moment the running turn's `session/prompt` result arrives
   * until `prompt()` returns or throws; false otherwise, including while the
   * agent is still working and after a prompt that failed before any answer.
   * In that window the agent is idle and the turn's verdict is taken, so a
   * Stop has nothing to stop.
   */
  readonly turnAnswered: boolean;

  /** Run one turn. Resolves when the agent stops and the turn's telemetry is read. */
  prompt(args: AcpPromptArgs): Promise<AcpTurnOutcome>;
  /**
   * Stop the running turn. Answers every open permission request first. Once
   * the agent has answered the prompt it is idle: no `session/cancel` is sent,
   * and the turn's `interrupted` verdict is already taken.
   */
  cancel(reason: string): Promise<void>;
  /**
   * Set one session config option, when the dialect supports it. Resolves with
   * the option set the agent reported back, or `[]` when it reported none.
   */
  setConfigOption(args: { configId: string; value: string | boolean }): Promise<AcpSessionConfigOption[]>;
  /**
   * Record the model that ADE put on the session, for an agent that accepted
   * the change without reporting its option set (Copilot's `session/set_model`,
   * Kimi's `session/set_config_option`). A turn whose provider names no served
   * model then falls back to this model, not to the one the entry call
   * reported.
   */
  noteCurrentModel(modelId: string): void;
  /** End the session and release the pooled connection. Idempotent. */
  close(reason: string): Promise<void>;
};

export type AcpPromptArgs = {
  turnId: string;
  blocks: AcpContentBlock[];
  /**
   * The caller's own stop flag, read once, synchronously, when the prompt
   * result arrives, and folded into `outcome.interrupted`. A stop the caller
   * records after that moment does not change the outcome. A pure read: the
   * session may skip it, and `turnAnswered` is how the caller learns the
   * agent answered.
   */
  isInterrupted?: () => boolean;
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
  /**
   * The provider-native model token ADE launched the agent with, when the user
   * picked one. It is the requested model the turn's `servedModel` is compared
   * against, so a turn served by the model it asked for reports none.
   */
  requestedModelId?: string | null;
  /** MCP servers to offer. The caller already removed anything unsafe. */
  mcpServers?: AcpMcpServer[];
  callbacks: AcpSessionCallbacks;
  logger?: Logger;
  pool?: AcpSessionPool;
  /** Test seam, forwarded to the pool and then to the connection. */
  spawnOverride?: Parameters<AcpSessionPool["acquire"]>[0]["spawnOverride"];
  handshakeTimeoutMs?: number;
  idleTtlMs?: number;
  /** Test seam. How long to wait for a post-turn `usage_update`. */
  settledUsageWaitMs?: number;
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
  /**
   * Where the running turn is. `prompting`: from the `session/prompt` send
   * until its result or failure arrives. `answered`: from the result until
   * `prompt()` exits. `idle` otherwise, including after a failed prompt.
   */
  let turnPhase: "idle" | "prompting" | "answered" = "idle";
  const unsubscribers: Array<() => void> = [];

  const publish = (events: AgentChatEvent[]): void => {
    if (events.length) callbacks.onEvents(events);
  };

  const requestedModelToken = args.requestedModelId?.trim() || null;
  const plainModelId = (raw: string): string => dialect.modelIdFromAgent ? dialect.modelIdFromAgent(raw) : raw;
  const telemetry = createAcpTurnTelemetry({
    providerId: dialect.providerId,
    inferCompaction: dialect.inferCompaction,
    requestedModelId: requestedModelToken ? plainModelId(requestedModelToken) : null,
    modelIdFromAgent: plainModelId,
    providerLabel: dialect.displayName,
    ...(dialect.servedModelMismatchNote ? { servedModelMismatchNote: dialect.servedModelMismatchNote } : {}),
    hasLocalUsage: dialect.localUsage.declared,
    readAccount: () => dialect.readAccount({ env: args.spawnPlan.env }),
    ...(args.logger ? { logger: args.logger } : {}),
  });

  /** The agent's `model` config option is the model it reports running. */
  const noteAgentConfigOptions = (options: AcpSessionConfigOption[]): void => {
    const model = options.find((option) => option.id === "model");
    if (typeof model?.value !== "string" || !model.value.length) return;
    telemetry.noteSignal({ kind: "current_model", modelId: plainModelId(model.value) });
  };

  // Kimi sends its `usage_update` after the prompt result. `prompt` parks a
  // resolver here while it waits for that one sample.
  let settledUsageWaiter: (() => void) | null = null;
  let settledUsageSeen = false;
  let settledUsageMissed = false;

  const translator: AcpEventTranslator = createAcpEventTranslator({
    readUsage: (update) => dialect.usage.behavior({ usageUpdate: update }),
    includeSlashCommand: dialect.includeSlashCommand,
    callbacks: {
      ...(callbacks.onSlashCommands ? { onSlashCommands: callbacks.onSlashCommands } : {}),
      onConfigOptions: (snapshot) => {
        noteAgentConfigOptions(snapshot.options);
        callbacks.onConfigOptions?.(snapshot);
      },
      ...(callbacks.onSessionInfo ? { onSessionInfo: callbacks.onSessionInfo } : {}),
      onUsage: (sample) => {
        if (sample.contextUsedTokens === undefined || !sample.contextWindowTokens) return;
        // An inferred compaction publishes before the sample that revealed it.
        publish(telemetry.noteContextSample({ used: sample.contextUsedTokens, size: sample.contextWindowTokens }));
        settledUsageSeen = true;
        settledUsageWaiter?.();
      },
      onTelemetry: (signal) => telemetry.noteSignal(signal),
    },
  });

  const supervisionPermissionMode = dialect.supervisionPermissionMode
    ? dialect.supervisionPermissionMode(args.permissionMode)
    : args.permissionMode;
  const supervision: AcpSupervisionGuard = createAcpSupervisionGuard({
    providerLabel: dialect.displayName,
    permissionMode: supervisionPermissionMode ?? null,
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

  for (const [method, read] of Object.entries(dialect.extensionNotifications)) {
    unsubscribers.push(
      connection.onNotification(method, (params) => {
        if (suppressUpdates) return;
        const { sessionId: target, signals } = read(params);
        // A pooled process carries other chats' sessions. A payload that names
        // a session belongs to that session only; a nameless one is
        // process-wide (Grok's model catalog).
        if (target && target !== sessionId) return;
        for (const signal of signals) publish(telemetry.noteSignal(signal));
      }),
    );
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
    agentCapabilities,
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

  noteAgentConfigOptions(initialConfigOptions);
  const localUsageBehavior = behaviorOf(dialect.localUsage);
  const localUsage: AcpLocalUsageReader | null = localUsageBehavior
    ? localUsageBehavior({ sessionId, env: args.spawnPlan.env })
    : null;

  const settledUsageWaitMs = args.settledUsageWaitMs ?? ACP_SETTLED_USAGE_WAIT_MS;
  /**
   * Wait for the one `usage_update` an agent sends after the turn settles.
   * Once a wait times out (Kimi skips a model outside its catalog), later
   * turns stop waiting until a `usage_update` shows up again.
   */
  const waitForSettledUsage = async (): Promise<void> => {
    if (!dialect.usageUpdateAfterTurn || telemetry.turnHasContextSample) return;
    if (settledUsageMissed && !settledUsageSeen) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        settledUsageWaiter = null;
        settledUsageMissed = true;
        settledUsageSeen = false;
        resolve();
      }, settledUsageWaitMs);
      settledUsageWaiter = () => {
        clearTimeout(timer);
        settledUsageWaiter = null;
        resolve();
      };
    });
  };

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
    get turnAnswered() {
      return turnPhase === "answered";
    },

    prompt: async ({ turnId, blocks, isInterrupted }) => {
      cancelRequested = false;
      translator.beginTurn(turnId);
      telemetry.beginTurn(turnId);
      try {
        try {
          localUsage?.beginTurn();
        } catch (error) {
          args.logger?.warn("agent_chat.acp_local_usage_mark_failed", {
            provider: dialect.providerId,
            error: getErrorMessage(error),
          });
        }
        permissionBridge.setTurnId(turnId);
        // A preflight verdict was reached before the caller owned this runtime,
        // so its notice waits for the first turn to have a live event path.
        publishSupervision(supervision.drainQueued(turnId));
        let response: AcpPromptResponse | null = null;
        let interrupted = false;
        turnPhase = "prompting";
        try {
          response = await connection.request<AcpPromptResponse>(
            ACP_METHOD.sessionPrompt,
            { sessionId, prompt: blocks },
            { timeoutMs: ACP_PROMPT_NO_TIMEOUT },
          );
          turnPhase = "answered";
          // The verdict, taken once, the moment the agent answered. Client-side
          // accounting: Copilot can report `end_turn` for a turn ADE cancelled,
          // so the agent's word is not the deciding one. A Stop pressed during
          // the telemetry reads below found a finished turn and changes nothing.
          interrupted = cancelRequested || response?.stopReason === "cancelled" || isInterrupted?.() === true;
        } finally {
          if (turnPhase === "prompting") turnPhase = "idle";
          // Every open permission request belongs to the turn that just ended.
          permissionBridge.cancelAll("the turn ended");
          permissionBridge.setTurnId(null);
          // A failed or cancelled turn can still have written files, so the
          // supervision verdict is taken on every exit, not just the happy one.
          publishSupervision(supervision.endTurn(turnId));
        }

        await waitForSettledUsage();
        const usage = readPromptUsage(dialect, response);
        const local = localUsage
          ? await settleWithin(
            // A later tick, so the deadline is armed before a reader that does
            // work in its synchronous prefix starts it.
            Promise.resolve().then(() => localUsage.finishTurn()),
            ACP_LOCAL_USAGE_DEADLINE_MS,
            null,
          )
          : null;
        const turnTelemetry = telemetry.finishTurn({ promptUsage: usage, local });
        // The prompt result's `tokens` row is the fallback meter. A turn that
        // produced an exact context sample keeps that sample on the meter.
        const events = [
          ...(usage && !telemetry.turnHasContextSample ? usageSampleToEvents(usage, turnId) : []),
          ...turnTelemetry.events,
        ];
        return {
          stopReason: response?.stopReason ?? null,
          interrupted,
          usage,
          events,
          done: turnTelemetry.done,
        };
      } finally {
        // On every exit, a failed prompt included: nothing that arrives
        // between turns may carry this turn's id.
        if (turnPhase === "answered") turnPhase = "idle";
        translator.endTurn();
        telemetry.endTurn();
      }
    },

    cancel: async (reason: string) => {
      // Answer the open cards first. A permission request that outlives its
      // turn blocks the agent even after the cancel lands.
      permissionBridge.cancelAll(reason);
      // An agent that already answered the prompt is idle. The turn's verdict
      // is taken, and a cancel would reach an agent with nothing to stop.
      if (turnPhase !== "prompting") return;
      cancelRequested = true;
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
          error: getErrorMessage(error),
        });
      }
    },

    setConfigOption: async ({ configId, value }) => {
      const behavior = behaviorOf(dialect.sessionConfig);
      if (!behavior) {
        throw new Error(`${dialect.displayName} does not accept session config options.`);
      }
      const call = behavior({ sessionId, configId, value });
      const response = await connection.request<{ configOptions?: unknown } | null>(call.method, call.params);
      // Grok, Qwen, Copilot, and Kimi answer with the whole option set as it
      // stands after the change.
      const options = normalizeAcpConfigOptions(response?.configOptions ?? []);
      noteAgentConfigOptions(options);
      return options;
    },

    noteCurrentModel: (modelId: string) => {
      const model = modelId.trim();
      if (model) telemetry.noteSignal({ kind: "current_model", modelId: plainModelId(model) });
    },

    close: async (reason: string) => {
      if (closed) return;
      closed = true;
      permissionBridge.cancelAll(reason);
      const closeBehavior = hasAcpSessionCapability(agentCapabilities, "close")
        ? behaviorOf(dialect.closeSession)
        : null;
      if (closeBehavior) {
        const call = closeBehavior({ sessionId });
        try {
          await connection.request(call.method, call.params, { timeoutMs: 10_000 });
        } catch (error) {
          args.logger?.warn("agent_chat.acp_close_failed", {
            provider: dialect.providerId,
            error: getErrorMessage(error),
          });
        }
        detach();
        leased.release();
        return;
      }
      // No `session/close` was advertised by this agent. A shared process must
      // stay alive for its other sessions; only a private process is safe to
      // evict here.
      detach();
      if (dialect.oneProcessPerSession) leased.evict(reason);
      else leased.release();
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
  return dialect.usage.behavior({ promptResponse: response, promptUsage: response.usage ?? null });
}

/** Build a plain text prompt block. The common case. */
export function textPromptBlock(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

/** Mint a turn id when the caller has none. */
export function newAcpTurnId(): string {
  return randomUUID();
}
