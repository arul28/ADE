import { replayBudgetChars, type TranscriptReplayFit } from "./crossProviderReplayFork";

/**
 * Recovery for a Claude chat whose handoff transcript replay does not fit.
 *
 * Two shapes of the same failure:
 *
 * 1. The turn that carried the replay is rejected with "prompt is too long".
 * 2. An earlier turn accepted the oversized replay into the provider session,
 *    so every later message overflows and nothing is left in memory to shrink.
 *
 * Both are repaired the same way: rebuild a smaller replay from the source
 * chat's transcript, open a fresh provider session (the resumed one still holds
 * the prompt that did not fit), and re-send the message once.
 *
 * This is Claude-only on purpose. Codex replays are already bounded by the
 * app-server's own input limit (`CODEX_REPLAY_MAX_CHARS`), and the other
 * providers cap their replays the same way, so none of them reaches this state.
 */

/** Below this a halved replay carries nothing worth sending. */
const CLAUDE_REPLAY_OVERFLOW_MIN_BUDGET_CHARS = 2_000;

export type TranscriptReplayOrigin = {
  sourceSessionId: string;
  /** Characters the last staged replay actually occupied. */
  budgetChars: number;
  keptTurnCount: number;
  turnCount: number;
  contextWindowTokens?: number | null;
};

export function normalizeTranscriptReplayOrigin(value: unknown): TranscriptReplayOrigin | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const sourceSessionId = typeof record.sourceSessionId === "string" ? record.sourceSessionId.trim() : "";
  if (!sourceSessionId) return null;
  const toCount = (candidate: unknown): number =>
    typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
      ? Math.floor(candidate)
      : 0;
  const window = typeof record.contextWindowTokens === "number"
    && Number.isFinite(record.contextWindowTokens)
    && record.contextWindowTokens > 0
    ? Math.floor(record.contextWindowTokens)
    : null;
  return {
    sourceSessionId,
    budgetChars: toCount(record.budgetChars),
    keptTurnCount: toCount(record.keptTurnCount),
    turnCount: toCount(record.turnCount),
    ...(window ? { contextWindowTokens: window } : {}),
  };
}

/** What a forked chat's imported envelopes say about where they came from. */
export type ReplayForkProvenance = {
  sourceSessionId: string;
  /** Written since ADE started distinguishing replay forks from native forks. */
  replayFork: boolean;
  /** Provider of the source chat, for forks that predate that flag. */
  sourceProvider: string | null;
};

export type ReplayOverflowOutcome = "retry" | "stop" | null;

export type ClaudeReplayOverflowDeps<TSession, TRuntime> = {
  logger: {
    info: (event: string, meta?: Record<string, unknown>) => void;
    warn: (event: string, meta?: Record<string, unknown>) => void;
  };
  emitNotice: (
    session: TSession,
    notice: { kind: "info" | "warning"; message: string; turnId: string },
  ) => void;
  persist: (session: TSession) => void;
  describeSession: (session: TSession) => {
    id: string;
    modelLabel: string;
    contextWindowTokens: number | null;
  };
  readOrigin: (session: TSession) => TranscriptReplayOrigin | null;
  writeOrigin: (session: TSession, origin: TranscriptReplayOrigin) => void;
  /** The `handoff_fork` provenance on this chat's own imported transcript. */
  readForkProvenance: (session: TSession) => ReplayForkProvenance | null;
  stageReplay: (session: TSession, replay: string | null) => void;
  /** Re-fit the source chat's transcript to a smaller budget. */
  buildSourceReplay: (
    sourceSessionId: string,
    contextWindowTokens: number | null,
    budgetChars: number,
  ) => TranscriptReplayFit | null;
  /** Drop the provider session so the retry starts from an empty one. */
  resetProviderSession: (session: TSession, runtime: TRuntime) => Promise<void>;
  /**
   * Drop any continuity tail ADE staged while resetting the session. The replay
   * already is the conversation; a second, thinner copy of the same turns both
   * doubles the prompt and contradicts it.
   */
  clearContinuityContext: (session: TSession) => void;
  /**
   * The recovery ran out of room: one coarse product fact, no counts and no
   * transcript. Called once per give-up, including the one that follows a dead
   * retry.
   */
  onGaveUp: (session: TSession) => void;
};

type ConsumedReplayRecord = {
  turnId: string;
  replayChars: number;
  attempt: number;
};

export function createClaudeReplayOverflowRecovery<TSession extends object, TRuntime extends object>(
  deps: ClaudeReplayOverflowDeps<TSession, TRuntime>,
) {
  /**
   * Per-runtime, not per-session: the record is live turn state and must die
   * with the runtime rather than be persisted or leak across a rebind.
   */
  const consumedByRuntime = new WeakMap<TRuntime, ConsumedReplayRecord>();
  const stagedByRuntime = new WeakMap<TRuntime, string>();

  const giveUp = (
    session: TSession,
    runtime: TRuntime,
    turnId: string,
    keptTurnCount: number,
  ): "stop" => {
    const { id, modelLabel } = deps.describeSession(session);
    // The failed turn consumed the replay. "Send your message again" is only
    // true if the next message still carries the conversation.
    const staged = stagedByRuntime.get(runtime);
    if (staged) {
      stagedByRuntime.delete(runtime);
      deps.stageReplay(session, staged);
      deps.persist(session);
    }
    deps.emitNotice(session, {
      kind: "warning",
      message: `The handoff transcript is too long for ${modelLabel}. ADE kept the newest ${keptTurnCount} turn${keptTurnCount === 1 ? "" : "s"}. Send your message again.`,
      turnId,
    });
    deps.logger.warn("agent_chat.claude_replay_overflow_gave_up", {
      sessionId: id,
      turnId,
      keptTurnCount,
    });
    deps.onGaveUp(session);
    return "stop";
  };

  /**
   * Where this chat's replay came from. The persisted marker is the record;
   * chats forked before it existed are read back from their imported
   * envelopes, which carry the same fact.
   */
  const resolveOrigin = (session: TSession): TranscriptReplayOrigin | null => {
    const marker = deps.readOrigin(session);
    if (marker?.sourceSessionId) return marker;
    const provenance = deps.readForkProvenance(session);
    if (!provenance) return null;
    if (!provenance.replayFork) {
      // No discriminator on the envelopes, so infer it. A Claude chat forked
      // from another Claude chat was forked natively — its history lives on the
      // provider, and re-seeding it from the source transcript would silently
      // drop every turn taken since the fork. Only a cross-provider fork was
      // ever carried as a replay.
      if (!provenance.sourceProvider || provenance.sourceProvider === "claude") return null;
    }
    const origin: TranscriptReplayOrigin = {
      sourceSessionId: provenance.sourceSessionId,
      budgetChars: 0,
      keptTurnCount: 0,
      turnCount: 0,
    };
    deps.writeOrigin(session, origin);
    deps.persist(session);
    return origin;
  };

  return {
    /** Record the replay a turn just carried into the provider. */
    noteConsumedReplay(
      runtime: TRuntime,
      turnId: string,
      replay: string,
      isRetryTurn: boolean,
    ): void {
      consumedByRuntime.set(runtime, {
        turnId,
        replayChars: replay.length,
        attempt: isRetryTurn ? 1 : 0,
      });
    },

    forgetConsumedReplay(runtime: TRuntime): void {
      consumedByRuntime.delete(runtime);
    },

    /**
     * Answer a "prompt is too long" failure. `null` means this was not a replay
     * chat and the caller should fall through to its normal handling.
     */
    async recoverFromOverflow(
      session: TSession,
      runtime: TRuntime,
      turnId: string,
      options: { isRetryTurn: boolean },
    ): Promise<ReplayOverflowOutcome> {
      const consumed = consumedByRuntime.get(runtime);
      const record = consumed?.turnId === turnId ? consumed : null;
      consumedByRuntime.delete(runtime);
      const origin = resolveOrigin(session);
      if (!origin) return null;

      const attempt = record?.attempt ?? (options.isRetryTurn ? 1 : 0);
      // One automatic retry per message. A second failure is reported, not
      // retried: shrinking forever would just spend the user's turns.
      if (attempt >= 1) return giveUp(session, runtime, turnId, origin.keptTurnCount);

      const { id, modelLabel, contextWindowTokens } = deps.describeSession(session);
      const lastBudgetChars = record?.replayChars || origin.budgetChars;
      const budgetChars = lastBudgetChars > 0
        ? Math.floor(lastBudgetChars / 2)
        : replayBudgetChars(contextWindowTokens);
      if (budgetChars < CLAUDE_REPLAY_OVERFLOW_MIN_BUDGET_CHARS) {
        return giveUp(session, runtime, turnId, origin.keptTurnCount);
      }

      const fit = deps.buildSourceReplay(origin.sourceSessionId, contextWindowTokens, budgetChars);
      if (!fit || !fit.keptTurnCount || !fit.text.trim().length) {
        return giveUp(session, runtime, turnId, 0);
      }

      // A fresh provider session. Resuming the old one would put the shorter
      // replay on top of the prompt that already does not fit.
      await deps.resetProviderSession(session, runtime);
      deps.clearContinuityContext(session);
      deps.stageReplay(session, fit.text);
      stagedByRuntime.set(runtime, fit.text);
      deps.writeOrigin(session, {
        ...origin,
        budgetChars,
        keptTurnCount: fit.keptTurnCount,
        turnCount: fit.turnCount,
        ...(contextWindowTokens ? { contextWindowTokens } : {}),
      });
      deps.persist(session);
      deps.emitNotice(session, {
        kind: "info",
        message: `That was too long for ${modelLabel}. ADE is sending your message again with the newest ${fit.keptTurnCount} turn${fit.keptTurnCount === 1 ? "" : "s"} of the handoff.`,
        turnId,
      });
      deps.logger.info("agent_chat.claude_replay_overflow_retry", {
        sessionId: id,
        turnId,
        keptTurnCount: fit.keptTurnCount,
        budgetChars,
      });
      return "retry";
    },

    /**
     * The retry landed. Drop the staged copy: it is in the provider session
     * now, so re-staging it later would duplicate the conversation — and the
     * string itself can be a megabyte of transcript held per runtime.
     */
    noteRetrySucceeded(runtime: TRuntime): void {
      stagedByRuntime.delete(runtime);
      consumedByRuntime.delete(runtime);
    },

    /**
     * The automatic retry never reached the provider. Put the replay back so
     * the user's next message still carries the conversation, and say so.
     */
    reportRetryFailed(session: TSession, runtime: TRuntime, turnId: string): void {
      // Idempotent: whichever terminal path notices first restores the replay
      // and says so, and the others find nothing staged and stay quiet.
      if (!stagedByRuntime.has(runtime)) return;
      consumedByRuntime.delete(runtime);
      giveUp(session, runtime, turnId, deps.readOrigin(session)?.keptTurnCount ?? 0);
    },
  };
}
