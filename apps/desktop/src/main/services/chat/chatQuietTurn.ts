import type {
  AgentChatEvent,
  AgentChatRecoverCodexTurnArgs,
  AgentChatRecoverCodexTurnResult,
  AgentChatRecoverTurnArgs,
  AgentChatRecoverTurnResult,
} from "../../../shared/types";
import { CODEX_RECOVERY_ACTION_BY_TURN_ACTION } from "../../../shared/types";
import { providerDisplayLabel } from "../../../shared/pendingInputLabels";
import type { Logger } from "../logging/logger";
import { nowIso } from "../shared/utils";
import { createChatQuietWatchdog, formatQuietMinutes, type ChatQuietWatchdog, type QuietInfo } from "./chatQuietWatchdog";

/**
 * What ADE does when a chat's turn goes quiet, for every provider: the
 * "<Provider> hasn't answered in N minutes — Restart / Keep waiting" card, and
 * the card's two actions. The watchdog that notices the silence is
 * `chatQuietWatchdog.ts`; this module owns it and everything after it fires.
 *
 * ADE never restarts, resends, or starts a queue here on its own. Each action
 * on the card is the user's, and the card's client sends it with the chat's
 * pin, so it reaches the machine this chat runs on.
 */

type TurnHealthEvent = Extract<AgentChatEvent, { type: "turn_health" }>;
type CodexTurnStalledEvent = Extract<AgentChatEvent, { type: "codex_turn_stalled" }>;

export type QuietTurnReason = "no_output" | "no_progress" | "runtime_state_unknown";
export type TurnRecoveryState = "recovering" | "recovered" | "failed";

/** The part of the chat service's session this module reads. */
export type QuietTurnSession = {
  session: {
    id: string;
    provider: string;
    threadId?: string | null;
    orchestrationParentSessionId?: string | null;
  };
  deleted?: boolean;
  closed?: boolean;
  /** Running commands or tools with buffered output: work, not silence. */
  turnOpenWork?: Set<string>;
};

export type QuietTurnHandlerDeps<TManaged extends QuietTurnSession> = {
  logger: Pick<Logger, "info" | "warn">;
  /** The live session, or null once it is gone. */
  getManaged: (sessionId: string) => TManaged | null;
  /** The orchestration parent the card is mirrored into (loaded if needed). */
  resolveParent: (parentSessionId: string) => TManaged | null;
  emitChatEvent: (managed: TManaged, event: AgentChatEvent) => void;
  persistChatState: (managed: TManaged) => void;
  turnRunning: (managed: TManaged) => boolean;
  /** The user owes an answer (an approval, a question). */
  pendingInputItemId: (managed: TManaged) => string | null;
  /**
   * A provider with its own reading of the silence (Codex's app-server).
   * Returns true when it handled the silence itself.
   */
  handleProviderQuiet?: (managed: TManaged, info: QuietInfo) => boolean;
  /** Codex keeps its own restart (`recoverCodexTurn`, the legacy wire call). */
  recoverCodexTurn: (args: AgentChatRecoverCodexTurnArgs) => Promise<AgentChatRecoverCodexTurnResult>;
  /** Restart, step by step, the way Restart session does. */
  restart: {
    /** Stop the turn and set the queue aside (restorable). */
    stopTurn: (managed: TManaged) => Promise<void>;
    /** After the stop: a provider whose silent thread can be wedged rotates it (Cursor). */
    afterStop: (managed: TManaged, turnId: string) => Promise<void>;
    /** End the provider process, keeping the conversation. */
    endProviderProcess: (managed: TManaged) => void;
    /** The fresh process picks up the user's last request, in ADE's words. */
    resumeLastRequest: (managed: TManaged) => Promise<void>;
  };
};

export type QuietTurnHandler<TManaged extends QuietTurnSession> = ReturnType<typeof createQuietTurnHandler<TManaged>>;

export function createQuietTurnHandler<TManaged extends QuietTurnSession>(deps: QuietTurnHandlerDeps<TManaged>) {
  const { logger } = deps;
  /** Turns whose quiet card is up, per chat: one card per silence. */
  const cardTurnIds = new Map<string, Set<string>>();
  /** Card actions running, keyed `sessionId:turnId`, for every provider. */
  const recoveriesInFlight = new Set<string>();

  const watchdog: ChatQuietWatchdog = createChatQuietWatchdog({
    onQuiet: (info) => handleQuiet(info),
    // The agent came back after its card: a later silence in the same turn
    // gets a card of its own.
    onActivityAfterQuiet: (sessionId, turnId) => dropCard(sessionId, turnId),
  });

  const dropCard = (sessionId: string, turnId: string): void => {
    const posted = cardTurnIds.get(sessionId);
    if (!posted) return;
    posted.delete(turnId);
    if (posted.size === 0) cardTurnIds.delete(sessionId);
  };

  /** Post the quiet card (once per silence), mirrored into an orchestration parent. */
  const postCard = (
    managed: TManaged,
    args: {
      turnId: string;
      reason: QuietTurnReason;
      turnStartedAt: number;
      lastProgressAt: number;
      silentMs: number;
    },
  ): void => {
    const sessionId = managed.session.id;
    const posted = cardTurnIds.get(sessionId) ?? new Set<string>();
    if (posted.has(args.turnId)) return;
    posted.add(args.turnId);
    while (posted.size > 64) {
      const [oldest] = posted;
      if (!oldest) break;
      posted.delete(oldest);
    }
    cardTurnIds.set(sessionId, posted);
    const provider = managed.session.provider;
    const name = providerDisplayLabel(provider, "The agent");
    const message = `${name} hasn't answered in ${formatQuietMinutes(args.silentMs)}. Restart ${name}, or keep waiting.`;
    const detectedAt = nowIso();
    const turnStartedAt = new Date(args.turnStartedAt).toISOString();
    const lastProgressAt = new Date(args.lastProgressAt).toISOString();
    logger.warn("agent_chat.turn_quiet", {
      sessionId,
      provider,
      threadId: managed.session.threadId ?? null,
      turnId: args.turnId,
      reason: args.reason,
      silentMs: args.silentMs,
    });
    const health: TurnHealthEvent = {
      type: "turn_health",
      provider,
      turnId: args.turnId,
      state: "stalled",
      reason: args.reason,
      message,
      turnStartedAt,
      lastProgressAt,
      detectedAt,
      recoveryCount: 0,
      supportedActions: ["wait", "restart_resume"],
      // Kept on the wire for older clients; ADE never restarts on its own.
      automaticRecoveryAttempted: false,
      sourceSessionId: sessionId,
    };
    // Older Codex clients draw only the Codex-specific card.
    const legacyCodexStall = (parentSessionId?: string): CodexTurnStalledEvent => ({
      type: "codex_turn_stalled",
      turnId: args.turnId,
      ...(managed.session.threadId ? { threadId: managed.session.threadId } : {}),
      reason: args.reason === "runtime_state_unknown" ? "app_server_state_unknown" : args.reason,
      message,
      recoveryOptions: ["wait", "restart_resume_thread"],
      sourceSessionId: sessionId,
      ...(parentSessionId ? { parentSessionId } : {}),
      detectedAt,
      turnStartedAt,
      lastProgressAt,
      automaticRecoveryAttempted: false,
    });
    deps.emitChatEvent(managed, health);
    if (provider === "codex") deps.emitChatEvent(managed, legacyCodexStall(managed.session.orchestrationParentSessionId ?? undefined));
    const parentSessionId = managed.session.orchestrationParentSessionId;
    if (parentSessionId && parentSessionId !== sessionId) {
      try {
        const parent = deps.resolveParent(parentSessionId);
        if (parent) {
          deps.emitChatEvent(parent, health);
          if (provider === "codex") deps.emitChatEvent(parent, legacyCodexStall(parentSessionId));
          deps.persistChatState(parent);
        }
      } catch (error) {
        logger.warn("agent_chat.turn_quiet_parent_notice_failed", {
          sessionId,
          parentSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    deps.persistChatState(managed);
  };

  /**
   * The watchdog fired. A silence the chat can explain (the user owes an
   * answer, a command is still running, a provider's own reading shows the
   * turn moved on) is watched again; anything else posts the card.
   */
  const handleQuiet = (info: QuietInfo): void => {
    const managed = deps.getManaged(info.sessionId);
    if (!managed || managed.deleted || managed.closed) {
      watchdog.clear(info.sessionId);
      return;
    }
    if (deps.handleProviderQuiet?.(managed, info)) return;
    // The watch is this turn's (a terminal event clears it), so a chat that
    // is still mid-turn is still in the turn that went quiet.
    if (!deps.turnRunning(managed)) {
      watchdog.clear(info.sessionId, info.turnId);
      return;
    }
    if (deps.pendingInputItemId(managed)) {
      logger.info("agent_chat.quiet_watch_suspended", { sessionId: info.sessionId, turnId: info.turnId, reason: "waiting_on_input" });
      watchdog.keepWaiting(info.sessionId, info.turnId);
      return;
    }
    if (info.phase === "mid_turn" && (managed.turnOpenWork?.size ?? 0) > 0) {
      logger.info("agent_chat.quiet_watch_suspended", { sessionId: info.sessionId, turnId: info.turnId, reason: "open_work" });
      watchdog.keepWaiting(info.sessionId, info.turnId);
      return;
    }
    postCard(managed, {
      turnId: info.turnId,
      reason: info.phase === "first_event" ? "no_output" : "no_progress",
      turnStartedAt: info.startedAt,
      lastProgressAt: info.lastActivityAt,
      silentMs: info.silentMs,
    });
  };

  /**
   * Run one card action, one at a time per turn. The card it answers comes
   * down, so the watchdog can post a fresh one if the turn goes quiet again.
   */
  const runRecovery = async <T>(sessionId: string, turnId: string, busyMessage: string, run: () => Promise<T>): Promise<T> => {
    const key = `${sessionId}:${turnId}`;
    if (recoveriesInFlight.has(key)) throw new Error(busyMessage);
    recoveriesInFlight.add(key);
    dropCard(sessionId, turnId);
    try {
      return await run();
    } finally {
      recoveriesInFlight.delete(key);
    }
  };

  /** Keep waiting: watch the same turn again from now; if it stays silent, the card comes back. */
  const waitAgain = (managed: TManaged, turnId: string, waitingFor: string): void => {
    const sessionId = managed.session.id;
    if (!watchdog.keepWaiting(sessionId, turnId)) {
      watchdog.arm({ sessionId, provider: managed.session.provider, turnId });
    }
    deps.emitChatEvent(managed, {
      type: "system_notice",
      noticeKind: "info",
      message: `Continuing to wait for ${waitingFor}.`,
      turnId,
    });
  };

  /** A user-started restart's progress, plus the legacy Codex event older Codex clients draw. */
  const emitTurnRecovery = (
    managed: TManaged,
    args: { turnId: string; state: TurnRecoveryState; message: string; automatic: boolean },
  ): void => {
    const at = nowIso();
    deps.emitChatEvent(managed, {
      type: "turn_recovery",
      provider: managed.session.provider,
      turnId: args.turnId,
      action: "restart_resume",
      state: args.state,
      message: args.message,
      automatic: args.automatic,
      at,
      recoveryCount: 1,
    });
    if (managed.session.provider !== "codex") return;
    deps.emitChatEvent(managed, {
      type: "codex_turn_recovery",
      turnId: args.turnId,
      action: "restart_resume_thread",
      state: args.state,
      message: args.message,
      automatic: args.automatic,
      at,
    });
  };

  /**
   * Every provider but Codex restarts the way Restart session does: stop the
   * turn, end the provider process, keep the conversation. Queued follow-ups
   * are set aside as a restorable "cancelled" group, never run by the restart.
   * Then the fresh process picks up the user's last request from an
   * ADE-written message (an ADE row, not the user's bubble).
   */
  const recoverQuietTurn = async (
    managed: TManaged,
    { sessionId, turnId, action }: AgentChatRecoverTurnArgs,
  ): Promise<AgentChatRecoverTurnResult> => {
    const normalizedTurnId = turnId.trim();
    if (!normalizedTurnId) throw new Error("Turn recovery requires a turn id.");
    const name = providerDisplayLabel(managed.session.provider, "The agent");
    if (!deps.turnRunning(managed) || watchdog.get(sessionId)?.turnId !== normalizedTurnId) {
      throw new Error(`This ${name} turn is no longer running.`);
    }
    if (action !== "wait" && action !== "restart_resume") {
      throw new Error(`${name} turns offer Restart or Keep waiting.`);
    }
    return await runRecovery(sessionId, normalizedTurnId, `A recovery action is already running for this ${name} turn.`, async () => {
      if (action === "wait") {
        waitAgain(managed, normalizedTurnId, name);
        return { action, turnId: normalizedTurnId, status: "waiting" };
      }
      const emit = (state: TurnRecoveryState, message: string) =>
        emitTurnRecovery(managed, { turnId: normalizedTurnId, state, message, automatic: false });
      try {
        emit("recovering", `Restarting ${name}.`);
        watchdog.clear(sessionId, normalizedTurnId);
        // Stop and set the queue aside first, so nothing the user queued
        // starts in the gap or ahead of the resumed request.
        await deps.restart.stopTurn(managed);
        await deps.restart.afterStop(managed, normalizedTurnId);
        deps.restart.endProviderProcess(managed);
        deps.persistChatState(managed);
        await deps.restart.resumeLastRequest(managed);
        emit("recovered", `${name} restarted and picked up your last request.`);
        deps.persistChatState(managed);
        return { action, turnId: normalizedTurnId, status: "resumed" };
      } catch (error) {
        emit("failed", error instanceof Error ? error.message : String(error));
        deps.persistChatState(managed);
        throw error;
      }
    });
  };

  /** The quiet card's actions, for every provider. Codex keeps its own restart. */
  const recoverTurn = async (
    managed: TManaged,
    args: AgentChatRecoverTurnArgs,
  ): Promise<AgentChatRecoverTurnResult> => {
    if (managed.session.provider === "codex") {
      const result = await deps.recoverCodexTurn({
        sessionId: args.sessionId,
        turnId: args.turnId,
        action: CODEX_RECOVERY_ACTION_BY_TURN_ACTION[args.action],
      });
      return { action: args.action, turnId: result.turnId, status: result.status };
    }
    return await recoverQuietTurn(managed, args);
  };

  return {
    /** The shared quiet watchdog (`chatQuietWatchdog.ts`), fed from the chat's event stream. */
    watchdog,
    postCard,
    runRecovery,
    waitAgain,
    emitTurnRecovery,
    recoverTurn,
    /** The chat is gone: drop its watch and its card bookkeeping. */
    forget: (sessionId: string): void => {
      watchdog.clear(sessionId);
      cardTurnIds.delete(sessionId);
    },
    dispose: (): void => {
      watchdog.dispose();
      cardTurnIds.clear();
      recoveriesInFlight.clear();
    },
  };
}
