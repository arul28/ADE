import {
  AUTO_RESUME_PROMPT,
  AUTO_RESUME_REASON,
  AUTO_RESUME_SCHEDULED_WORK_SOURCE,
  autoResumeFireAtMs,
  autoResumeScheduleId,
  autoResumeScheduledMessage,
  isPendingAutoResumeScheduledWork,
  isUsageLimitChatError,
} from "../../../shared/chatAutoResume";
import type { AgentChatEvent } from "../../../shared/types/chat";
import type { Logger } from "../logging/logger";
import type {
  ChatScheduledWorkRecord,
  ChatScheduledWorkScheduler,
} from "./chatScheduledWorkScheduler";

type AutoResumeNotice = Extract<AgentChatEvent, { type: "system_notice" }>;

/**
 * The subset of an `error` chat event this coordinator reads. Structural on
 * purpose: the chat service owns `AgentChatEvent`, and taking the whole union
 * here would drag its session types along for two fields.
 */
export type AutoResumeErrorInput = {
  message?: string | null;
  errorInfo?: string | { category?: string | null } | null;
  turnId?: string | undefined;
};

/**
 * The whole analytics payload this coordinator may produce, spelled out as a
 * closed type rather than a property bag. The product question is only whether
 * auto-resume rescues a limited chat, so `armed` (a resume was scheduled),
 * `resumed` (an auto-resume-originated turn started) and `paused` (the re-arm
 * cap stopped the loop) are the whole vocabulary — and nothing about the chat,
 * the limit, or the reset instant can be added here without changing the type.
 *
 * `cancelled` is deliberately absent: a cancel fires on ordinary user activity,
 * so counting it would measure typing rather than the workflow, and the number
 * that matters (armed minus resumed) is already derivable.
 */
export type ChatAutoResumeAnalyticsProperties = {
  action: "auto_resume";
  outcome: "armed" | "resumed" | "paused";
  /** Coarse provider slug only; the analytics sanitizer drops anything unlisted. */
  provider?: string;
};

export type ChatAutoResumeCoordinatorDeps = {
  /** Assigned late by the chat service, so it is read per call, not captured. */
  getScheduler: () => ChatScheduledWorkScheduler | null;
  /** Resolves once the scheduler has loaded its durable state. */
  whenSchedulerReady: () => Promise<void>;
  /** False for archived, ended, or non-schedulable chats. */
  isSessionSchedulable: (sessionId: string) => boolean;
  emitNotice: (sessionId: string, notice: AutoResumeNotice) => void;
  /**
   * Coarse workflow-outcome analytics. Injected for the same reason `logger` and
   * `emitNotice` are: this file owns the transitions, not the transport, and it
   * must not be able to reach the analytics service (or a session id) directly.
   * Optional, so a wiring without analytics keeps auto-resume working.
   */
  captureAnalytics?: (properties: ChatAutoResumeAnalyticsProperties) => void;
  logger: Logger;
};

export type ChatAutoResumeCoordinator = {
  maybeArmAfterUsageLimit: (args: {
    sessionId: string;
    provider: string;
    /** Reset instant the provider published, or null when it publishes none. */
    resetAtMs: number | null;
    error: AutoResumeErrorInput;
  }) => void;
  cancelForSession: (sessionId: string, reason: string) => void;
  noteScheduleDismissed: (sessionId: string) => void;
  noteResumeTurnStarted: (sessionId: string) => void;
  noteTurnFinished: (sessionId: string) => void;
  forgetSession: (sessionId: string) => void;
  forgetAll: () => void;
};

/**
 * Per-session auto-resume bookkeeping.
 *
 * `cancelEpoch` closes the arm/cancel race. Arming is asynchronous — it waits
 * on the scheduler and then upserts — so a user message can land while the
 * upsert is still in flight and find nothing to cancel, and a cancel issued
 * while the brain is still loading its durable state finds nothing either
 * even though a row exists on disk. Every cancel bumps the epoch; the arm
 * captures it before scheduling and undoes its own row if it moved.
 *
 * `consecutiveArms` bounds re-arming. The reset instant we can see is not
 * always the limit that rejected the turn: Claude's snapshot is session (5h)
 * scoped and `mergeSnapshot` carries a stale `resetsAtMs` forward, so a
 * weekly-limit rejection can arm against a session reset, fail at the same
 * limit when it fires, and re-arm every cycle — burning a real turn each
 * time. Two attempts, then the chat waits for a human.
 *
 * A record exists only for a chat that actually hit a usage limit. Cancel and
 * dismissal read the map and never create: they run on every dispatch for every
 * chat, so minting there would grow the map for the life of the process with
 * nothing in it to cancel. Nothing is lost by it either — an arm creates its
 * record synchronously before its first await, so "no record" means "no arm in
 * flight", which is exactly the case a cancel has nothing to outrank.
 */
type AutoResumeSessionState = {
  cancelEpoch: number;
  consecutiveArms: number;
  /** An arm is between the scheduler wait and its upsert. */
  arming: boolean;
  /** Notice de-dupe: one "auto-resume scheduled" line per armed fire time. */
  noticeFireAt: number | null;
  /**
   * Reset instant the streak last counted. Separate from `noticeFireAt`
   * because dismissing the schedule has to let a later limit re-announce
   * without also re-opening the counting window against the same instant.
   */
  lastArmedFireAt: number | null;
  /** One "auto-resume paused" line per capped streak, not one per failure. */
  pauseNoticed: boolean;
  /** A fired resume dispatched a turn that has not reported `done` yet. */
  resumeTurnPending: boolean;
  /** That turn died at the limit again, so its completion proves nothing. */
  resumeTurnHitLimit: boolean;
  /**
   * Coarse provider slug of the limit that armed this streak, kept only so the
   * fired resume's analytics carries the same one the arm did — the resume
   * dispatch reaches this file with no provider in hand.
   */
  provider: string | null;
};

/** Consecutive arms allowed with no intervening user message. */
const AUTO_RESUME_MAX_CONSECUTIVE_ARMS = 2;

const PAUSED_NOTICE_DETAIL =
  "The usage limit stopped this chat again after two automatic resumes, so ADE will not schedule another one. Send a message when you want to continue.";
const SCHEDULED_NOTICE_DETAIL =
  "ADE will ask this chat to continue the interrupted task once the usage limit resets. Sending a message or retrying the turn cancels it.";

/**
 * Auto-resume after a provider usage limit resets.
 *
 * Owns the whole subsystem: the per-chat streak state, the durable row, the two
 * system notices, and the races between arming, cancelling and firing. The chat
 * service keeps only thin call sites — it reports what happened (a limit error,
 * a dispatch, a dismissal, a turn finishing) and this decides what that means.
 */
export function createChatAutoResumeCoordinator(
  deps: ChatAutoResumeCoordinatorDeps,
): ChatAutoResumeCoordinator {
  const { getScheduler, whenSchedulerReady, isSessionSchedulable, emitNotice, logger } = deps;
  const stateBySession = new Map<string, AutoResumeSessionState>();

  const ensureState = (sessionId: string): AutoResumeSessionState => {
    const existing = stateBySession.get(sessionId);
    if (existing) return existing;
    const created: AutoResumeSessionState = {
      cancelEpoch: 0,
      consecutiveArms: 0,
      arming: false,
      noticeFireAt: null,
      lastArmedFireAt: null,
      pauseNoticed: false,
      resumeTurnPending: false,
      resumeTurnHitLimit: false,
      provider: null,
    };
    stateBySession.set(sessionId, created);
    return created;
  };

  /**
   * One coarse fact per auto-resume transition. Every call site is a state
   * change that already happened, never an attempt, so a retried arm or a
   * repeated report cannot turn one workflow into a burst.
   */
  const captureOutcome = (
    outcome: ChatAutoResumeAnalyticsProperties["outcome"],
    provider: string | null,
  ): void => {
    deps.captureAnalytics?.({
      action: "auto_resume",
      outcome,
      ...(provider ? { provider } : {}),
    });
  };

  const findPendingRow = (sessionId: string): ChatScheduledWorkRecord | null =>
    getScheduler()?.list(sessionId).find(isPendingAutoResumeScheduledWork) ?? null;

  const cancelPendingRow = async (sessionId: string, reason: string): Promise<void> => {
    const scheduler = getScheduler();
    if (!scheduler) return;
    const pending = findPendingRow(sessionId);
    if (!pending) return;
    try {
      await scheduler.cancel(pending.id);
      logger.info("agent_chat.auto_resume_cancelled", {
        sessionId,
        scheduleId: pending.id,
        reason,
      });
    } catch (error) {
      logger.warn("agent_chat.auto_resume_cancel_failed", {
        sessionId,
        scheduleId: pending.id,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /**
   * The one auto-resume notice envelope. Both lines — armed and paused — are
   * rate-limit notices attributed to the turn that failed, so the card renders
   * them in the same place with the same weight.
   */
  const emitAutoResumeNotice = (
    sessionId: string,
    notice: { message: string; detail: string; turnId?: string | undefined },
  ): void => {
    emitNotice(sessionId, {
      type: "system_notice",
      noticeKind: "rate_limit",
      severity: "info",
      message: notice.message,
      detail: notice.detail,
      ...(notice.turnId ? { turnId: notice.turnId } : {}),
    });
  };

  /**
   * Cancels ADE's own auto-resume row and nothing else. Engaging with a chat is
   * not a reason to drop a cron or wakeup the user (or the agent) asked for, so
   * the sweep is scoped by the `auto_resume_limit` tag.
   *
   * Synchronous at the call site by design — it runs inside the dispatch choke
   * points — but the sweep itself has to wait for the scheduler, and the row may
   * not exist yet at all. Bumping the epoch first is what makes both cases safe:
   * an arm that lands afterwards cancels the row it just created.
   */
  const cancelForSession = (sessionId: string, reason: string): void => {
    const state = stateBySession.get(sessionId);
    if (state) {
      state.cancelEpoch += 1;
      state.noticeFireAt = null;
      state.lastArmedFireAt = null;
      // A user message is exactly the intervening event the re-arm cap waits for.
      state.consecutiveArms = 0;
      state.pauseNoticed = false;
      state.resumeTurnPending = false;
      state.resumeTurnHitLimit = false;
    }
    // The sweep runs whether or not this process has state for the chat: a row
    // armed before the last restart is on disk with nothing in the map yet.
    void (async () => {
      try {
        await whenSchedulerReady();
        await cancelPendingRow(sessionId, reason);
      } catch (error) {
        logger.warn("agent_chat.auto_resume_cancel_failed", {
          sessionId,
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  };

  /**
   * The user dismissed the schedule from Chat info. The scheduler cancels the
   * row itself; this is the in-memory half.
   */
  const noteScheduleDismissed = (sessionId: string): void => {
    const state = stateBySession.get(sessionId);
    // No record is not a gap, so do not "fix" this by minting one: an arm
    // creates its record synchronously before its first await, so a dismissal
    // that finds nothing has no in-flight arm to outrank, and any arm after it
    // is answering a new limit and should be allowed to schedule.
    if (!state) return;
    // An explicit dismissal outranks an arm that is still in flight: the epoch
    // bump is what makes that arm undo the row it is about to write, because the
    // upsert's own `scheduled` status would otherwise win over the dismissal and
    // resurrect the row the user just cancelled.
    state.cancelEpoch += 1;
    // Let a later limit announce a fresh resume. The counting window
    // (`lastArmedFireAt`) deliberately survives — dismissing a schedule is not
    // evidence that the reset instant it armed against was right.
    state.noticeFireAt = null;
  };

  /**
   * A fired resume's turn, watched to completion.
   *
   * The cap counts arms that were never proven right. A resume that runs
   * without dying at the limit again proves the window we armed against was
   * the one gating the chat, so the streak starts over. Nothing else can do
   * this: a fired resume always carries `scheduledWake`, which is exactly what
   * the dispatch sweep skips, so without this the cap is a lifetime budget and
   * a healthy headless chat pauses itself after two limits days apart.
   *
   * Tracked as one flag per session rather than by turn id: the dispatched
   * `user_message` does not carry a turn id on every provider (Codex assigns it
   * only once the provider answers), and the scheduler will not deliver a wake
   * into a live turn, so the next `done` on this chat is the resume's own.
   */
  const noteResumeTurnStarted = (sessionId: string): void => {
    const state = stateBySession.get(sessionId);
    // Reported BEFORE the state guard, not after. The armed row is durable and
    // outlives this process, so a resume armed yesterday fires today with
    // nothing in the map — and dropping those would make `resumed` look rarer
    // than `armed` purely because ADE restarted, which is the one bias this
    // measurement cannot carry. Only the not-pending -> pending edge reports,
    // so a repeated note about the same live resume cannot double-count it.
    if (!state?.resumeTurnPending) captureOutcome("resumed", state?.provider ?? null);
    if (!state) return;
    state.resumeTurnPending = true;
    state.resumeTurnHitLimit = false;
  };

  const noteTurnFinished = (sessionId: string): void => {
    const state = stateBySession.get(sessionId);
    if (!state || !state.resumeTurnPending) return;
    state.resumeTurnPending = false;
    if (state.resumeTurnHitLimit) {
      state.resumeTurnHitLimit = false;
      return;
    }
    state.consecutiveArms = 0;
    state.pauseNoticed = false;
    state.lastArmedFireAt = null;
    state.noticeFireAt = null;
  };

  /**
   * Arms one durable resume per chat when a turn dies at a usage limit AND the
   * provider told us when the limit lifts. The row uses a deterministic id, so
   * a repeat failure replaces the pending resume instead of stacking a second
   * one. Delivery itself is ordinary scheduled work: if a turn is active when
   * it comes due, the scheduler defers to the next turn boundary rather than
   * pushing a second prompt into a live turn.
   */
  const maybeArmAfterUsageLimit = (args: {
    sessionId: string;
    provider: string;
    resetAtMs: number | null;
    error: AutoResumeErrorInput;
  }): void => {
    if (!isUsageLimitChatError(args.error)) return;
    const { sessionId } = args;
    const turnId = args.error.turnId;
    const tracked = stateBySession.get(sessionId);
    // Recorded before the reset instant is even consulted: a repeat limit with
    // no publishable reset still means the resume we spent was wasted.
    if (tracked?.resumeTurnPending) {
      tracked.resumeTurnHitLimit = true;
    }
    const fireAt = autoResumeFireAtMs(args.resetAtMs, Date.now());
    // No reset instant (or one already in the past): keep the manual recovery
    // card as the only path, exactly as before.
    if (fireAt == null) return;
    if (!isSessionSchedulable(sessionId)) return;
    if (tracked?.arming) return;
    const state = tracked ?? ensureState(sessionId);
    // Remembered only for the fired resume's analytics; see the field's note.
    state.provider = args.provider;
    if (state.consecutiveArms >= AUTO_RESUME_MAX_CONSECUTIVE_ARMS) {
      // Two resumes have already fired straight back into the same limit, so
      // the reset instant this provider publishes is not the one gating this
      // chat. Stop spending a turn per cycle and hand it back to the user.
      if (!state.pauseNoticed) {
        state.pauseNoticed = true;
        // Guarded by the same flag as the notice, so a chat that keeps failing
        // at the limit reports the pause once per streak rather than once per
        // failure.
        captureOutcome("paused", args.provider);
        // Detached on purpose, like the scheduled notice below. This runs from
        // inside the chat service's event commit, before the error event that
        // triggered it has minted its sequence number, so emitting inline
        // numbers the notice BELOW the error and renders it above the failure
        // it explains. Deferring by one microtask is sufficient and no more:
        // the commit mints the sequence synchronously in that same frame.
        // Anything awaited between here and that mint would break the ordering
        // again, which is what the transcript-order assertion in the cap
        // regression test pins.
        void (async () => {
          try {
            await Promise.resolve();
            emitAutoResumeNotice(sessionId, {
              message: "Auto-resume paused after two attempts",
              detail: PAUSED_NOTICE_DETAIL,
              turnId,
            });
          } catch (error) {
            logger.warn("agent_chat.auto_resume_notice_failed", {
              sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })();
      }
      return;
    }
    state.arming = true;
    const armedAtEpoch = state.cancelEpoch;

    void (async () => {
      try {
        await whenSchedulerReady();
        const scheduler = getScheduler();
        if (!scheduler) return;
        const schedule = await scheduler.upsert({
          id: autoResumeScheduleId(sessionId),
          sessionId,
          kind: "wakeup",
          prompt: AUTO_RESUME_PROMPT,
          reason: AUTO_RESUME_REASON,
          fireAt,
          status: "scheduled",
          pausedFlag: false,
          lateFlag: false,
          durable: true,
          source: AUTO_RESUME_SCHEDULED_WORK_SOURCE,
        });
        if (schedule.status === "cancelled" || schedule.status === "done") return;
        // A cancel landed while the upsert was in flight (a user message, or a
        // sweep that ran while the scheduler was still loading its durable
        // state). The row it was looking for only exists now, so undo it here.
        if (stateBySession.get(sessionId) !== state || state.cancelEpoch !== armedAtEpoch) {
          await cancelPendingRow(sessionId, "cancelled_while_arming");
          return;
        }
        // One failure can commit more than one error event — a provider `error`
        // notification and the failed turn's completion carry the same limit —
        // so the cap counts distinct reset instants, not raw arms. A genuinely
        // wrong-window re-arm always brings a fresh reset instant with it,
        // because a repeat of the same one is already in the past by then and
        // never gets this far.
        if (state.lastArmedFireAt !== fireAt) {
          state.consecutiveArms += 1;
          state.lastArmedFireAt = fireAt;
          // Bound by construction: this is the same gate the cap counts, so a
          // streak reports at most `AUTO_RESUME_MAX_CONSECUTIVE_ARMS` arms, and
          // the duplicate error events one failure can commit collapse into one.
          captureOutcome("armed", args.provider);
        }
        logger.info("agent_chat.auto_resume_scheduled", {
          sessionId,
          scheduleId: schedule.id,
          provider: args.provider,
          fireAt: new Date(fireAt).toISOString(),
          status: schedule.status,
          consecutiveArms: state.consecutiveArms,
        });
        if (state.noticeFireAt === fireAt) return;
        state.noticeFireAt = fireAt;
        emitAutoResumeNotice(sessionId, {
          message: autoResumeScheduledMessage(fireAt),
          detail: SCHEDULED_NOTICE_DETAIL,
          turnId,
        });
      } catch (error) {
        logger.warn("agent_chat.auto_resume_schedule_failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        state.arming = false;
      }
    })();
  };

  return {
    maybeArmAfterUsageLimit,
    cancelForSession,
    noteScheduleDismissed,
    noteResumeTurnStarted,
    noteTurnFinished,
    forgetSession: (sessionId: string): void => {
      stateBySession.delete(sessionId);
    },
    forgetAll: (): void => {
      stateBySession.clear();
    },
  };
}
