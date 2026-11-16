import {
  getMachineProviderInstanceStore,
} from "../../../../../ade-cli/src/services/providerInstances/providerInstanceStore";
import { turnFailureKind, type TurnFailureKind } from "../analytics/agentTurnProductAnalytics";
import type { createCtoStateService } from "../cto/ctoStateService";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import { isPersonAuthoredUserMessage } from "./crossMachineHandoffSource";
import { getModelById, resolveChatProviderForDescriptor } from "../../../shared/modelRegistry";
import {
  isContextOverflowFailureText,
  type AgentChatEvent,
  type AgentChatEventEnvelope,
  type AgentChatLastTurnFailure,
  type AgentChatSendArgs,
  type AgentChatSession,
  type AgentChatSwitchAccountArgs,
  type AgentChatSwitchAccountResult,
  type AgentChatUpdateSessionArgs,
  type AgentChatUsageLimitResume,
} from "../../../shared/types/chat";
import type { CtoModelPreferences, CtoRefreshContextResult } from "../../../shared/types/cto";
import {
  defaultProviderInstanceId,
  isProviderInstanceProvider,
  type ProviderInstance,
  type ProviderInstanceProvider,
} from "../../../shared/types/providerInstances";
import { isUsageLimitFailureText, isUsageLimitTurn } from "../../../shared/usageLimitResumePresentation";

/** Why the CTO gets a fresh provider thread. */
export type CtoProviderThreadRefreshReason = "occupancy" | "compaction" | "overflow" | "model_fallback" | "manual";

/** Without a published reset, a CTO on a backup model tries its main model again after this. */
const CTO_FALLBACK_RETRY_MAIN_MS = 30 * 60_000;

/**
 * Occupancy, in percent of the model's window, at which the CTO's provider
 * thread is replaced after a settled turn. Low on purpose: the CTO's turns are
 * short and its memory is injected, so a small thread is fast and cheap, and a
 * fresh one loses nothing the notes and the conversation tail do not carry.
 */
const CTO_REFRESH_OCCUPANCY_PCT = 55;

/** A failed CTO message ADE sends once more, as the person wrote it. */
export type CtoResendMessage = Pick<AgentChatSendArgs, "text" | "displayText" | "attachments" | "contextAttachments" | "metadata">;

/** See ManagedChatSession.ctoPendingSettledAction. */
export type CtoPendingSettledAction = {
  kind: "overflow" | "fallback";
  message: CtoResendMessage | null;
  /** Short reason for the "all models unavailable" notice. */
  reasonText: string | null;
  /** `lastUserMessageSequence` when stored: a newer user message supersedes the resend. */
  userMessageSequence: number;
};

/** The parts of a chat-service session the CTO fallback reads and writes. */
export type CtoFallbackSession = {
  session: AgentChatSession;
  closed: boolean;
  deleted: boolean;
  turnErrorCategory?: Parameters<typeof turnFailureKind>[0];
  turnErrorKind?: TurnFailureKind | null;
  lastTurnFailure: AgentChatLastTurnFailure | null;
  lastUserMessageSequence?: number;
  usageLimitResume?: AgentChatUsageLimitResume | null;
  ctoRefreshPending?: CtoProviderThreadRefreshReason | null;
  ctoResentMessageKeys?: Set<string>;
  ctoFallbackIndex?: number | null;
  ctoFallbackSince?: number | null;
  ctoFallbackRetryAt?: number | null;
  ctoAccountApplied?: string;
  ctoPendingSettledAction?: CtoPendingSettledAction | null;
  ctoMidTaskReplies?: { granted: number; posted: number } | null;
};

export type CtoThreadFallbackDeps<M extends CtoFallbackSession> = {
  logger: Logger;
  ctoStateService: Pick<ReturnType<typeof createCtoStateService>, "getIdentity"> | null | undefined;
  /** True while anything runs on the CTO's provider thread (see agentChatService). */
  ctoThreadIsBusy: (managed: M) => boolean;
  /** An account move (Smart Balance) already owns this chat's failed turn. */
  accountMoveOwnsSession: (sessionId: string) => boolean;
  refreshCtoProviderThread: (
    managed: M,
    reason: CtoProviderThreadRefreshReason,
    options?: { notice?: boolean },
  ) => CtoRefreshContextResult;
  persistChatState: (managed: M) => unknown;
  emitChatEvent: (managed: M, event: AgentChatEvent) => void;
  readRecentTranscriptEnvelopes: (managed: M) => AgentChatEventEnvelope[];
  resolveSessionInstance: (managed: M) => ProviderInstance | null;
  usageLimitResetAtMs: (managed: M) => number | null;
  providerAccountEmail: (provider: string, instanceId: string | null | undefined) => string | null;
  updateSession: (args: AgentChatUpdateSessionArgs) => Promise<unknown>;
  switchAccount: (args: AgentChatSwitchAccountArgs) => Promise<AgentChatSwitchAccountResult>;
  sendMessage: (args: AgentChatSendArgs) => Promise<unknown>;
};

/** Failure kinds a different model would not hit. Context overflow and a busy thread are not among them. */
const CTO_FALLBACK_FAILURE_KINDS: ReadonlySet<string> = new Set([
  "rate_limit",
  "budget",
  "permission",
  "plan",
  "model_unavailable",
  "server_overloaded",
  "cli_missing",
]);

const CTO_FALLBACK_REASON_WORDS: Record<string, string> = {
  rate_limit: "rate limited",
  budget: "budget reached",
  permission: "not allowed on this account",
  plan: "not on this plan",
  model_unavailable: "model unavailable",
  server_overloaded: "provider overloaded",
  cli_missing: "CLI not installed",
};

export const ctoModelKey = (prefs: { modelId?: string | null; provider?: string; model?: string }): string =>
  (prefs.modelId?.trim() || `${prefs.provider ?? ""}/${prefs.model ?? ""}`).toLowerCase();

/** A model choice and its account, as one key: the same model on two accounts is two choices. */
const ctoChoiceKey = (prefs: CtoModelPreferences): string => `${ctoModelKey(prefs)}@${prefs.instanceId?.trim() ?? ""}`;

const ctoModelLabel = (prefs: { modelId?: string | null; model?: string }): string =>
  (prefs.modelId ? getModelById(prefs.modelId)?.displayName : null) ?? prefs.model ?? prefs.modelId ?? "the model";

/**
 * The CTO's backup-model state machine: moving to the next backup model when
 * a turn fails for a reason another model would not hit, coming back to the
 * main model later, and the settled-turn work (overflow refresh, owed
 * refresh) that waits for the thread to be idle.
 */
export function createCtoThreadFallback<M extends CtoFallbackSession>(deps: CtoThreadFallbackDeps<M>) {
  const {
    logger,
    ctoStateService,
    ctoThreadIsBusy,
    accountMoveOwnsSession,
    refreshCtoProviderThread,
    persistChatState,
    emitChatEvent,
    readRecentTranscriptEnvelopes,
    resolveSessionInstance,
    usageLimitResetAtMs,
    providerAccountEmail,
    updateSession,
    switchAccount,
    sendMessage,
  } = deps;

  const clearCtoFallbackState = (managed: M): void => {
    managed.ctoFallbackIndex = null;
    managed.ctoFallbackSince = null;
    managed.ctoFallbackRetryAt = null;
  };

  /**
   * Settled-turn work waits for the turn to be fully over: `done` is committed
   * a moment before the session reads idle, and a refresh must never tear
   * down a runtime still finishing a turn. Bounded; past it the work is kept
   * whole on `ctoPendingSettledAction` (see `deferCtoSettledAction`).
   */
  const whenCtoThreadIdle = async (managed: M): Promise<boolean> => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (managed.closed || managed.deleted) return false;
      if (!ctoThreadIsBusy(managed)) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return !ctoThreadIsBusy(managed);
  };

  /**
   * The message of the turn that just failed, when the person wrote it. A
   * scheduled wake, a child report or ADE's own prompt is never re-sent: its
   * delivery metadata belongs to the turn that failed. A mid-task message is
   * re-sent as the person typed it, never as the quick-reply wrapper.
   */
  const readCtoFailedPersonMessage = (
    managed: M,
    failedTurnId: string | null,
  ): CtoResendMessage | null => {
    const userMessages = readRecentTranscriptEnvelopes(managed)
      .map((envelope) => envelope.event)
      .filter((event): event is Extract<AgentChatEvent, { type: "user_message" }> => event.type === "user_message");
    const last = userMessages.at(-1);
    if (!last || !last.text.trim()) return null;
    if (failedTurnId && last.turnId && last.turnId !== failedTurnId) return null;
    if (!isPersonAuthoredUserMessage(last.metadata)) return null;
    const shown = last.displayText?.trim() || null;
    const text = last.metadata?.ctoMidTask === true && shown ? shown : last.text.trim();
    const { ctoMidTask: _midTask, ctoResend: _resend, ...metadata } = last.metadata ?? {};
    return {
      text,
      ...(shown && shown !== text ? { displayText: shown } : {}),
      ...(last.attachments?.length ? { attachments: last.attachments } : {}),
      ...(last.contextAttachments?.length ? { contextAttachments: last.contextAttachments } : {}),
      ...(Object.keys(metadata).length ? { metadata } : {}),
    };
  };

  /**
   * Send the person's failed message once more, marked as ADE's resend
   * (`metadata.ctoResend`), with its words, display text, attachments and
   * metadata as they were.
   */
  const resendCtoMessage = async (
    managed: M,
    message: CtoResendMessage,
    reason: "overflow" | "model_fallback",
  ): Promise<void> => {
    await sendMessage({
      sessionId: managed.session.id,
      ...message,
      metadata: { ...(message.metadata ?? {}), ctoResend: { reason } },
    });
  };

  const isCtoFallbackFailure = (
    managed: M,
    done: Extract<AgentChatEvent, { type: "done" }>,
    errorText: string | null,
  ): boolean => {
    if (done.status !== "failed") return false;
    if (isContextOverflowFailureText(errorText)) return false;
    if (isUsageLimitTurn(done, managed.usageLimitResume?.turnId) || isUsageLimitFailureText(errorText)) return true;
    const kind = managed.turnErrorKind ?? turnFailureKind(managed.turnErrorCategory ?? null, errorText);
    return CTO_FALLBACK_FAILURE_KINDS.has(kind);
  };

  /** A few words for why the model failed, for the "all unavailable" notice. */
  const ctoFallbackReasonText = (
    managed: M,
    done: Extract<AgentChatEvent, { type: "done" }>,
    errorText: string | null,
  ): string => {
    if (isUsageLimitTurn(done, managed.usageLimitResume?.turnId) || isUsageLimitFailureText(errorText)) {
      return "usage limit reached";
    }
    const kind = managed.turnErrorKind ?? turnFailureKind(managed.turnErrorCategory ?? null, errorText);
    return CTO_FALLBACK_REASON_WORDS[kind] ?? "provider error";
  };

  /** Whether the thread runs this choice now. No account named means any account of that model. */
  const ctoChoiceMatchesSession = (prefs: CtoModelPreferences, managed: M): boolean => {
    const sameModel = ctoModelKey(prefs) === ctoModelKey({
      modelId: managed.session.modelId,
      provider: managed.session.provider,
      model: managed.session.model,
    });
    if (!sameModel) return false;
    const provider = managed.session.provider;
    if (!isProviderInstanceProvider(provider)) return true;
    return resolveSessionInstance(managed)?.id === ctoWantedAccountId(provider, prefs.instanceId);
  };

  /** The account a CTO choice names; none named is the machine's default account for that provider. */
  const ctoWantedAccountId = (provider: ProviderInstanceProvider, instanceId: string | null | undefined): string => {
    const named = instanceId?.trim();
    if (named) return named;
    try {
      return getMachineProviderInstanceStore().resolve(provider, undefined).instance.id;
    } catch {
      return defaultProviderInstanceId(provider);
    }
  };

  /**
   * Move the CTO thread to the account picked in Settings (null: the
   * provider's default), keeping the thread. Applied once per change of the
   * pick (ctoAccountApplied), so a usage-limit move to another account is
   * not undone by the next ensure.
   */
  const applyCtoAccountChoice = async (managed: M, instanceId: string | null | undefined): Promise<void> => {
    const wanted = instanceId?.trim() ?? "";
    if (wanted === (managed.ctoAccountApplied ?? "")) return;
    const provider = managed.session.provider;
    if (!isProviderInstanceProvider(provider)) {
      managed.ctoAccountApplied = wanted;
      persistChatState(managed);
      return;
    }
    const result = await switchAccount({
      sessionId: managed.session.id,
      instanceId: ctoWantedAccountId(provider, wanted),
    }).catch((error): AgentChatSwitchAccountResult => ({
      ok: false,
      reason: "failed",
      message: error instanceof Error ? error.message : String(error),
    }));
    if (!result.ok) {
      logger.warn("agent_chat.cto_account_apply_failed", { sessionId: managed.session.id, instanceId: wanted, reason: result.reason });
      return;
    }
    managed.ctoAccountApplied = wanted;
    persistChatState(managed);
  };

  /** "Claude Opus 5", or "Claude Opus 5 · me@work.com" when the choice names an account. */
  const ctoChoiceLabel = (prefs: CtoModelPreferences): string => {
    const model = ctoModelLabel(prefs);
    const descriptor = prefs.modelId ? getModelById(prefs.modelId) : undefined;
    const provider = descriptor ? resolveChatProviderForDescriptor(descriptor).provider : prefs.provider;
    const account = prefs.instanceId?.trim() ? providerAccountEmail(provider, prefs.instanceId) : null;
    return account ? `${model} · ${account}` : model;
  };

  /** Session ids whose model is being moved to a backup; their identity preference stays the main model. */
  const ctoFallbackSwitches = new Set<string>();

  /**
   * Move the CTO to its next backup model and send the failed message again.
   * Each message tries each model once: the models already tried for it are
   * remembered until a turn completes. When none is left, one quiet notice
   * says so instead of nothing.
   */
  const switchCtoToFallbackModel = async (
    managed: M,
    message: CtoResendMessage | null,
    reasonText: string,
  ): Promise<boolean> => {
    if (!ctoStateService) return false;
    const identity = ctoStateService.getIdentity();
    const main = identity.modelPreferences;
    const fallbacks = identity.fallbackModels ?? [];
    if (!main || !fallbacks.length) return false;
    const tried = managed.ctoResentMessageKeys ?? new Set<string>();
    managed.ctoResentMessageKeys = tried;
    const messageKey = message?.text ?? "(no message)";
    const ordered = [main, ...fallbacks];
    const position = ordered.findIndex((prefs) => ctoChoiceMatchesSession(prefs, managed));
    if (position >= 0) tried.add(`fallback:${messageKey}:${ctoChoiceKey(ordered[position]!)}`);
    const next = ordered
      .slice(position + 1)
      .find((prefs) => prefs.modelId && !tried.has(`fallback:${messageKey}:${ctoChoiceKey(prefs)}`));
    if (!next?.modelId) {
      const exhaustedKey = `exhausted:${messageKey}`;
      if (!tried.has(exhaustedKey)) {
        tried.add(exhaustedKey);
        emitChatEvent(managed, {
          type: "system_notice",
          noticeKind: "info",
          message: `${ctoModelLabel(main)} and backups are unavailable — ${reasonText}.`,
        });
      }
      return false;
    }
    tried.add(`fallback:${messageKey}:${ctoChoiceKey(next)}`);
    const fromLabel = ctoModelLabel({ modelId: managed.session.modelId, model: managed.session.model });
    // Read on the main model's runtime, before the switch replaces it.
    const leavingMain = managed.ctoFallbackIndex == null;
    const mainResetAtMs = leavingMain ? usageLimitResetAtMs(managed) : null;
    ctoFallbackSwitches.add(managed.session.id);
    try {
      await updateSession({
        sessionId: managed.session.id,
        modelId: next.modelId,
        ...(next.reasoningEffort !== undefined ? { reasoningEffort: next.reasoningEffort } : {}),
      });
    } catch (error) {
      logger.warn("agent_chat.cto_model_fallback_failed", {
        sessionId: managed.session.id,
        modelId: next.modelId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      ctoFallbackSwitches.delete(managed.session.id);
    }
    // The backup's account (none named: the default one) runs it; same thread.
    if (isProviderInstanceProvider(managed.session.provider)) {
      const moved = await switchAccount({ sessionId: managed.session.id, instanceId: ctoWantedAccountId(managed.session.provider, next.instanceId) })
        .catch((error): AgentChatSwitchAccountResult => ({ ok: false, reason: "failed", message: getErrorMessage(error) }));
      if (!moved.ok) {
        logger.warn("agent_chat.cto_fallback_account_failed", { sessionId: managed.session.id, instanceId: next.instanceId, reason: moved.reason });
      }
    }
    const fallbackIndex = fallbacks.findIndex((prefs) => ctoChoiceKey(prefs) === ctoChoiceKey(next));
    if (fallbackIndex < 0) {
      clearCtoFallbackState(managed);
    } else {
      managed.ctoFallbackIndex = fallbackIndex;
      if (leavingMain || managed.ctoFallbackRetryAt == null) {
        const nowMs = Date.now();
        managed.ctoFallbackSince = nowMs;
        managed.ctoFallbackRetryAt = mainResetAtMs != null && mainResetAtMs > nowMs
          ? mainResetAtMs
          : nowMs + CTO_FALLBACK_RETRY_MAIN_MS;
      }
    }
    persistChatState(managed);
    emitChatEvent(managed, {
      type: "system_notice",
      noticeKind: "info",
      message: `${fromLabel} hit its limit — switched to ${ctoChoiceLabel(next)}.`,
    });
    refreshCtoProviderThread(managed, "model_fallback");
    logger.info("agent_chat.cto_model_fallback", {
      sessionId: managed.session.id,
      modelId: next.modelId,
      resent: Boolean(message),
      retryMainAt: managed.ctoFallbackRetryAt ?? null,
    });
    if (message) await resendCtoMessage(managed, message, "model_fallback");
    return true;
  };

  /**
   * On a backup model past the main model's reset (or 30 minutes without
   * one), the next CTO turn starts on the main model again. A main model that
   * still fails falls back again on its own.
   */
  const maybeReturnCtoToMainModel = async (managed: M): Promise<void> => {
    if (managed.session.identityKey !== "cto" || managed.ctoFallbackIndex == null || !ctoStateService) return;
    const retryAt = managed.ctoFallbackRetryAt
      ?? (managed.ctoFallbackSince != null ? managed.ctoFallbackSince + CTO_FALLBACK_RETRY_MAIN_MS : 0);
    if (Date.now() < retryAt || ctoThreadIsBusy(managed)) return;
    const main = ctoStateService.getIdentity().modelPreferences;
    if (!main?.modelId || ctoChoiceMatchesSession(main, managed)) {
      clearCtoFallbackState(managed);
      persistChatState(managed);
      return;
    }
    try {
      await updateSession({
        sessionId: managed.session.id,
        modelId: main.modelId,
        ...(main.reasoningEffort !== undefined ? { reasoningEffort: main.reasoningEffort } : {}),
      });
    } catch (error) {
      logger.warn("agent_chat.cto_model_return_failed", {
        sessionId: managed.session.id,
        modelId: main.modelId,
        error: error instanceof Error ? error.message : String(error),
      });
      managed.ctoFallbackRetryAt = Date.now() + CTO_FALLBACK_RETRY_MAIN_MS;
      persistChatState(managed);
      return;
    }
    // The main choice's account; none named is the default one, so a backup on
    // the same model but another account comes home too.
    if (isProviderInstanceProvider(managed.session.provider)) {
      await switchAccount({
        sessionId: managed.session.id,
        instanceId: ctoWantedAccountId(managed.session.provider, main.instanceId),
      }).catch(() => null);
    }
    clearCtoFallbackState(managed);
    refreshCtoProviderThread(managed, "model_fallback", { notice: false });
    persistChatState(managed);
    emitChatEvent(managed, {
      type: "system_notice",
      noticeKind: "info",
      message: `Back on ${ctoChoiceLabel(main)}.`,
    });
    logger.info("agent_chat.cto_model_returned", { sessionId: managed.session.id, modelId: main.modelId });
  };

  /**
   * Run an action the thread was too busy for. A newer user message means the
   * conversation moved on: an overflow still gets its fresh thread, but no
   * old message is sent again. Returns whether it did something.
   */
  const runCtoPendingSettledAction = async (managed: M): Promise<boolean> => {
    const pending = managed.ctoPendingSettledAction;
    if (!pending) return false;
    managed.ctoPendingSettledAction = null;
    const stillCurrent = (managed.lastUserMessageSequence ?? 0) === pending.userMessageSequence;
    if (pending.kind === "overflow") {
      const result = refreshCtoProviderThread(managed, "overflow");
      const key = `overflow:${pending.message?.text ?? ""}`;
      const keys = managed.ctoResentMessageKeys ?? new Set<string>();
      managed.ctoResentMessageKeys = keys;
      if (result.refreshed && stillCurrent && pending.message && !keys.has(key)) {
        keys.add(key);
        await resendCtoMessage(managed, pending.message, "overflow");
      }
      return result.refreshed;
    }
    if (!stillCurrent) return false;
    return await switchCtoToFallbackModel(managed, pending.message, pending.reasonText ?? "provider error");
  };

  /**
   * The thread stayed busy past the settle wait: keep the whole action (the
   * resend and the switch, not only the refresh) and try again every few
   * seconds for two minutes; the next settled turn runs it too, whichever
   * comes first.
   */
  const deferCtoSettledAction = (managed: M, action: CtoPendingSettledAction): void => {
    managed.ctoPendingSettledAction = action;
    let attempts = 0;
    const retry = (): void => {
      attempts += 1;
      void (async () => {
        if (managed.ctoPendingSettledAction !== action || managed.closed || managed.deleted) return;
        if (ctoThreadIsBusy(managed)) {
          if (attempts < 24) setTimeout(retry, 5_000).unref?.();
          return;
        }
        await runCtoPendingSettledAction(managed);
      })().catch((error) => {
        logger.warn("agent_chat.cto_turn_settled_action_failed", {
          sessionId: managed.session.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    };
    setTimeout(retry, 5_000).unref?.();
  };

  /**
   * An account move for the CTO did not land. The CTO keeps its one thread, so
   * instead of a new chat on the other account it moves to its backup models
   * once the move has let go of the thread. `onNoBackup` runs when none is
   * left (the usage-limit resume arms then).
   */
  const scheduleCtoFallbackAfterFailedMove = (
    managed: M,
    failedTurnId: string | null,
    onNoBackup?: () => void,
  ): void => {
    setTimeout(() => {
      void (async () => {
        const message = readCtoFailedPersonMessage(managed, failedTurnId);
        const reasonText = "usage limit reached";
        if (!(await whenCtoThreadIdle(managed))) {
          deferCtoSettledAction(managed, {
            kind: "fallback",
            message,
            reasonText,
            userMessageSequence: managed.lastUserMessageSequence ?? 0,
          });
          return;
        }
        const switched = await switchCtoToFallbackModel(managed, message, reasonText);
        if (!switched) onNoBackup?.();
      })().catch((error) => {
        logger.warn("agent_chat.cto_model_fallback_failed", {
          sessionId: managed.session.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, 0);
  };

  /**
   * What the CTO does when one of its turns settles, called from the `done`
   * commit (the one place every provider agrees a turn is over):
   * - overflow: a fresh thread, then the failed message once more;
   * - a limit, sign-in or provider failure: the next backup model, then the
   *   failed message once more;
   * - an action an earlier turn could not run because the thread stayed busy;
   * - otherwise a refresh that is owed (a compaction, a manual request) or
   *   due (the thread is past `CTO_REFRESH_OCCUPANCY_PCT`).
   * A person's Stop is not a failure and triggers nothing but an owed refresh.
   */
  const onCtoTurnSettled = (
    managed: M,
    done: Extract<AgentChatEvent, { type: "done" }>,
    input: { occupancyPct: number | null; errorText: string | null },
  ): void => {
    // Quick replies belong to the turn that got the mid-task message.
    managed.ctoMidTaskReplies = null;
    if (done.status === "completed") managed.ctoResentMessageKeys?.clear();
    const thisTurnOverflowed = done.status === "failed"
      && managed.lastTurnFailure?.kind === "context_overflow"
      && (!done.turnId || managed.lastTurnFailure.turnId === done.turnId);
    const sessionId = managed.session.id;
    // Another account is already taking this chat over (Smart Balance). If
    // that fails, `scheduleCtoFallbackAfterFailedMove` takes the backups.
    const accountMoveOwnsIt = accountMoveOwnsSession(sessionId);
    const wantsFallback = !thisTurnOverflowed && !accountMoveOwnsIt && isCtoFallbackFailure(managed, done, input.errorText);
    // A Stop is not a reason to refresh; only a turn that ran its course is.
    const dueForOccupancy = done.status === "completed"
      && input.occupancyPct != null
      && input.occupancyPct >= CTO_REFRESH_OCCUPANCY_PCT;
    if (
      !thisTurnOverflowed
      && !wantsFallback
      && !managed.ctoRefreshPending
      && !dueForOccupancy
      && !managed.ctoPendingSettledAction
    ) {
      return;
    }
    const failedTurnId = done.turnId ?? null;
    const reasonText = wantsFallback ? ctoFallbackReasonText(managed, done, input.errorText) : null;
    void (async () => {
      if (!(await whenCtoThreadIdle(managed))) {
        if (thisTurnOverflowed) managed.ctoRefreshPending ??= "overflow";
        else if (dueForOccupancy) managed.ctoRefreshPending ??= "occupancy";
        if (thisTurnOverflowed || wantsFallback) {
          deferCtoSettledAction(managed, {
            kind: thisTurnOverflowed ? "overflow" : "fallback",
            message: readCtoFailedPersonMessage(managed, failedTurnId),
            reasonText,
            userMessageSequence: managed.lastUserMessageSequence ?? 0,
          });
        }
        persistChatState(managed);
        return;
      }
      try {
        // This turn's own failure supersedes one an earlier turn left behind.
        if (thisTurnOverflowed || wantsFallback) managed.ctoPendingSettledAction = null;
        else if (await runCtoPendingSettledAction(managed)) return;
        if (thisTurnOverflowed) {
          const message = readCtoFailedPersonMessage(managed, failedTurnId);
          const result = refreshCtoProviderThread(managed, "overflow");
          const key = `overflow:${message?.text ?? ""}`;
          const keys = managed.ctoResentMessageKeys ?? new Set<string>();
          managed.ctoResentMessageKeys = keys;
          if (result.refreshed && message && !keys.has(key)) {
            keys.add(key);
            await resendCtoMessage(managed, message, "overflow");
          }
          return;
        }
        if (wantsFallback) {
          const switched = await switchCtoToFallbackModel(
            managed,
            readCtoFailedPersonMessage(managed, failedTurnId),
            reasonText ?? "provider error",
          );
          if (switched) return;
        }
        const reason = managed.ctoRefreshPending ?? (dueForOccupancy ? "occupancy" : null);
        if (reason) refreshCtoProviderThread(managed, reason);
      } catch (error) {
        logger.warn("agent_chat.cto_turn_settled_action_failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  };

  return {
    clearCtoFallbackState,
    /** True while the CTO's model is being moved to a backup (not the person's pick). */
    isSwitchingToFallback: (sessionId: string): boolean => ctoFallbackSwitches.has(sessionId),
    applyCtoAccountChoice,
    maybeReturnCtoToMainModel,
    scheduleCtoFallbackAfterFailedMove,
    onCtoTurnSettled,
  };
}
