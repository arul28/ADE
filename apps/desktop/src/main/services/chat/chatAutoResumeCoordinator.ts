import {
  AUTO_RESUME_ARMED_NOTICE_DETAIL,
  AUTO_RESUME_PAUSED_NOTICE_DETAIL,
  AUTO_RESUME_PAUSED_NOTICE_MESSAGE,
  AUTO_RESUME_PROMPT,
  AUTO_RESUME_REASON,
  AUTO_RESUME_SCHEDULED_WORK_SOURCE,
  autoResumeFireAtMs,
  autoResumeScheduleId,
  autoResumeScheduledMessage,
  isPendingAutoResumeScheduledWork,
  isUsageLimitChatError,
} from "../../../shared/chatAutoResume";
import type {
  AgentChatEvent,
  AgentChatProvider,
  AgentChatUsageLimitResume,
} from "../../../shared/types/chat";
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
  /**
   * The chat's current resume state, as the service stores it. The coordinator
   * writes this state but does not keep a copy, and a row that changes status
   * has to be projected onto whatever the chat is showing right now.
   */
  readResumeState?: (sessionId: string) => AgentChatUsageLimitResume | null;
  /**
   * Every transition of the contract's `usageLimitResume` state, in the frame
   * it happens. The chat service stores it on the session, mirrors the
   * deprecated park instant, and broadcasts `session_meta_updated`; this file
   * owns WHEN the state changes and to what, and nothing else.
   */
  onResumeStateChanged?: (
    sessionId: string,
    resume: AgentChatUsageLimitResume | null,
  ) => void;
  logger: Logger;
};

export type ChatAutoResumeArmArgs = {
  sessionId: string;
  provider: AgentChatProvider;
  /** Reset instant the provider published, or null when it publishes none. */
  resetAtMs: number | null;
  /** Raw provider text for the details toggle. Never parsed. */
  providerDetail?: string | null;
  error: AutoResumeErrorInput;
};

/**
 * What a re-arm actually did.
 *
 * `superseded` is not a failure: something newer than the state being restored
 * (a user message, an opt-out) already governs the chat, so the caller must
 * publish nothing. `failed` is, and the caller has to stop claiming a resume is
 * armed when no row exists to fire it.
 */
export type ChatAutoResumeRearmOutcome = "armed" | "superseded" | "failed";

export type ChatAutoResumeCoordinator = {
  maybeArmAfterUsageLimit: (args: ChatAutoResumeArmArgs) => void;
  /**
   * Resolves once the arm started for `sessionId` has finished writing (or
   * declining to write) its durable row. The Claude path awaits this before it
   * reaps the query: a reset that ran first would tear down the runtime while
   * the upsert was still in flight, which is exactly how a real limit ended up
   * with no resume armed.
   */
  whenArmed: (sessionId: string) => Promise<void>;
  /** Live streak state, for the contract's `attempts` and `paused`. */
  streakState: (sessionId: string) => { attempts: number; paused: boolean };
  /**
   * Re-creates the durable row for a resume that was cancelled and then not
   * spent — today only the manual Resume now whose dispatch failed. It restores
   * an arm that already happened, so it counts no attempt, emits no notice and
   * reports no analytics; it does apply the same schedulability guard the arm
   * path does, and undoes itself if a cancel lands while the upsert is in
   * flight. The caller owns the opt-out check, because only it knows the
   * session's `autoContinueAtUsageLimit`.
   */
  rearm: (
    sessionId: string,
    resume: AgentChatUsageLimitResume,
    epochAtDispatch: number,
  ) => Promise<ChatAutoResumeRearmOutcome>;
  /**
   * The chat's current cancel epoch, minting the record if this process has
   * none. A caller that is about to do something cancellable captures it first
   * and hands it back, so anything the user did in between outranks the undo.
   */
  cancelEpochFor: (sessionId: string) => number;
  /**
   * Puts a streak back the way it was before a cancel that turned out not to
   * count. `cancelForSession` zeroes the counter on the way past — correct for a
   * real user message, wrong for a manual resume whose turn never dispatched,
   * which would otherwise hand a capped chat two fresh arms and silently
   * un-pause it.
   */
  restoreStreak: (
    sessionId: string,
    streak: {
      attempts: number;
      paused: boolean;
      lastArmedFireAtMs?: number | null;
      epochAtDispatch: number;
    },
  ) => void;
  /**
   * Clears the streak so an explicit opt-in arms afresh. Turn on / Try again is
   * a human saying "try again", which is exactly the intervening event the cap
   * waits for — and it bumps the cancel epoch, so it outranks any undo still in
   * flight from an older resume attempt.
   */
  resetStreak: (sessionId: string) => void;
  /**
   * Drops the pending resume. The in-memory half lands synchronously; the
   * returned promise settles once the durable row is actually cancelled, which
   * only the manual Resume-now path needs to wait for (it dispatches the same
   * prompt itself).
   */
  cancelForSession: (sessionId: string, reason: string) => Promise<void>;
  /**
   * The durable row's status changed underneath the state — the user paused
   * this chat's scheduled work, a project-wide pause swept it, or either was
   * lifted. Ownership of that mapping lives here so the pause path and the arm
   * path cannot disagree about what a paused resume means.
   */
  noteRowStatusChanged: (
    sessionId: string,
    row: { id: string; status: string; pausedFlag?: boolean; fireAt?: number | undefined },
  ) => void;
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
  provider: AgentChatProvider | null;
  /** In-flight arm, awaited by `whenArmed`. */
  armPromise: Promise<void> | null;
};

/** Consecutive arms allowed with no intervening user message. */
const AUTO_RESUME_MAX_CONSECUTIVE_ARMS = 2;

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
  const {
    getScheduler,
    whenSchedulerReady,
    isSessionSchedulable,
    emitNotice,
    readResumeState,
    logger,
  } = deps;
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
      armPromise: null,
    };
    stateBySession.set(sessionId, created);
    return created;
  };

  /**
   * One `usageLimitResume` transition. Reported synchronously so the state a
   * client reads never lags the transcript notice that explains it.
   */
  const reportResumeState = (
    sessionId: string,
    resume: AgentChatUsageLimitResume | null,
  ): void => {
    try {
      deps.onResumeStateChanged?.(sessionId, resume);
    } catch (error) {
      logger.warn("agent_chat.auto_resume_state_report_failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const buildResumeState = (args: {
    state: AgentChatUsageLimitResume["state"];
    provider: AgentChatProvider;
    fireAtMs: number | null;
    resetAtMs: number | null;
    scheduleId: string | null;
    attempts: number;
    providerDetail?: string | null;
    turnId?: string | undefined;
  }): AgentChatUsageLimitResume => ({
    state: args.state,
    provider: args.provider,
    fireAt: args.fireAtMs == null ? null : new Date(args.fireAtMs).toISOString(),
    resetAt: args.resetAtMs == null ? null : new Date(args.resetAtMs).toISOString(),
    scheduleId: args.scheduleId,
    attempts: args.attempts,
    providerDetail: args.providerDetail?.trim() || null,
    turnId: args.turnId ?? null,
    updatedAt: new Date().toISOString(),
  });

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

  /**
   * The durable row, in one place. Both writers — the arm and the restore —
   * upsert exactly this shape under the deterministic id, so a row that comes
   * back after a failed manual resume cannot drift from the row that armed.
   */
  const autoResumeRowUpsert = (
    sessionId: string,
    fireAt: number,
  ): Parameters<ChatScheduledWorkScheduler["upsert"]>[0] => ({
    id: autoResumeScheduleId(sessionId),
    sessionId,
    kind: "wakeup" as const,
    prompt: AUTO_RESUME_PROMPT,
    reason: AUTO_RESUME_REASON,
    fireAt,
    status: "scheduled" as const,
    pausedFlag: false,
    lateFlag: false,
    durable: true,
    source: AUTO_RESUME_SCHEDULED_WORK_SOURCE,
  });

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
   * The in-memory half is synchronous by design — it runs inside the dispatch
   * choke points — but the sweep itself has to wait for the scheduler, and the
   * row may not exist yet at all. Bumping the epoch first is what makes both
   * cases safe: an arm that lands afterwards cancels the row it just created.
   *
   * The sweep is RETURNED rather than only fired off so a caller that is about
   * to dispatch the same prompt itself (manual Resume now) can wait for the
   * durable row to actually be gone before sending. Dispatch call sites ignore
   * the promise deliberately: they must not block a user message on a scheduler
   * write, and the epoch bump already makes a late-landing arm undo itself.
   */
  const cancelForSession = (sessionId: string, reason: string): Promise<void> => {
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
    // The limit no longer governs this chat once its resume is gone. Reported
    // unconditionally: the row being cancelled may predate this process, in
    // which case there is no in-memory state and the stored one is all a
    // client has.
    reportResumeState(sessionId, null);
    // The sweep runs whether or not this process has state for the chat: a row
    // armed before the last restart is on disk with nothing in the map yet.
    return (async () => {
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
   * Projects the durable row's status onto the state clients render.
   *
   * A paused resume is a resume that is NOT going to fire, so publishing
   * `armed` for it would count down to an instant nothing happens at — and,
   * once that instant passed, read as `resuming` and lock out the manual Resume
   * now that is the chat's only way forward. `no_reset` is the honest state for
   * it: a live limit with no schedule behind it, which is exactly what the pill
   * renders as "no reset time" with a working Retry. Un-pausing puts the row's
   * own fire time back.
   *
   * Only these two transitions are projected. Everything else about the state —
   * which limit, which turn, how many attempts — belongs to the arm that wrote
   * it and is carried through untouched.
   */
  const noteRowStatusChanged = (
    sessionId: string,
    row: { id: string; status: string; pausedFlag?: boolean; fireAt?: number | undefined },
  ): void => {
    if (row.id !== autoResumeScheduleId(sessionId)) return;
    const current = readResumeState?.(sessionId) ?? null;
    if (!current) return;
    const paused = row.status === "paused" || row.pausedFlag === true;
    if (paused) {
      if (current.state !== "armed" && current.state !== "resuming") return;
      reportResumeState(sessionId, {
        ...current,
        state: "no_reset",
        fireAt: null,
        scheduleId: null,
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    if (row.status !== "scheduled" || current.state !== "no_reset") return;
    if (row.fireAt == null || !Number.isFinite(row.fireAt)) return;
    reportResumeState(sessionId, {
      ...current,
      state: "armed",
      fireAt: new Date(row.fireAt).toISOString(),
      scheduleId: row.id,
      updatedAt: new Date().toISOString(),
    });
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
    // The row fired, so nothing is armed any more — same reason the report sits
    // above the state guard.
    reportResumeState(sessionId, null);
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
  const maybeArmAfterUsageLimit = (args: ChatAutoResumeArmArgs): void => {
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
    // No reset instant (or one already in the past): nothing to arm, so the
    // manual recovery path is the only one. The limit is still live, and the
    // contract has a state for exactly that.
    if (fireAt == null) {
      reportResumeState(sessionId, buildResumeState({
        state: "no_reset",
        provider: args.provider,
        fireAtMs: null,
        resetAtMs: args.resetAtMs,
        scheduleId: null,
        attempts: tracked?.consecutiveArms ?? 0,
        providerDetail: args.providerDetail,
        turnId,
      }));
      return;
    }
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
        reportResumeState(sessionId, buildResumeState({
          state: "paused",
          provider: args.provider,
          fireAtMs: fireAt,
          resetAtMs: args.resetAtMs,
          scheduleId: null,
          attempts: state.consecutiveArms,
          providerDetail: args.providerDetail,
          turnId,
        }));
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
              message: AUTO_RESUME_PAUSED_NOTICE_MESSAGE,
              detail: AUTO_RESUME_PAUSED_NOTICE_DETAIL,
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
    /**
     * What a chat reports when its row cannot fire: the limit is still live,
     * but there is no schedule behind it, which is exactly `no_reset` — a
     * countdown-free state whose Retry still works. Written from the NEW
     * limit's details, because the failure that got here may have arrived on a
     * dispatch that already reported the previous state as gone.
     */
    const reportPausedRowState = (): void => {
      reportResumeState(sessionId, buildResumeState({
        state: "no_reset",
        provider: args.provider,
        fireAtMs: null,
        resetAtMs: args.resetAtMs,
        scheduleId: null,
        attempts: state.consecutiveArms,
        providerDetail: args.providerDetail,
        turnId,
      }));
    };

    const armPromise = (async () => {
      try {
        await whenSchedulerReady();
        const scheduler = getScheduler();
        if (!scheduler) return;
        // The state report further down still runs for a reused row: a second
        // event can carry a turn id or provider detail the first one lacked.
        const armedRow = findPendingRow(sessionId);
        // A paused row is a decision, not a stale row: the user (or a global
        // pause) stopped this chat's scheduled work, and an upsert would
        // un-pause it behind their back. Leave the row and the state exactly as
        // they are — no countdown is the honest answer for a resume that is not
        // going to fire.
        if (armedRow && (armedRow.status === "paused" || armedRow.pausedFlag)) {
          // A pause/opt-out/user dispatch can win while the scheduler was
          // loading. Do not republish `no_reset` over that newer state, and
          // make sure its cancellation removes the paused row too.
          if (stateBySession.get(sessionId) !== state || state.cancelEpoch !== armedAtEpoch) {
            await cancelPendingRow(sessionId, "cancelled_while_arming");
            return;
          }
          logger.info("agent_chat.auto_resume_row_paused", {
            sessionId,
            scheduleId: armedRow.id,
            fireAt: new Date(fireAt).toISOString(),
          });
          reportPausedRowState();
          return;
        }
        // One failure can commit more than one error event for the same limit.
        // Re-upserting the row it already wrote would replace, persist, emit a
        // transition and re-arm the timer for a schedule that did not change.
        // Only a live `scheduled` row qualifies — a `fired` one is mid-delivery
        // and must not be adopted as if it were still waiting.
        const reusableRow = armedRow
          && armedRow.status === "scheduled"
          && !armedRow.pausedFlag
          && armedRow.fireAt === fireAt
          ? armedRow
          : null;
        const schedule = reusableRow
          ?? await scheduler.upsert(autoResumeRowUpsert(sessionId, fireAt));
        // The upsert can resolve with a paused row while a newer cancellation
        // is in flight. The paused projection must not outrank that newer
        // transition, and the row must be swept before this arm returns.
        if (stateBySession.get(sessionId) !== state || state.cancelEpoch !== armedAtEpoch) {
          await cancelPendingRow(sessionId, "cancelled_while_arming");
          return;
        }
        if (schedule.status === "cancelled" || schedule.status === "done") return;
        // The row was written PAUSED. Scheduled work for this chat (or for the
        // whole project) is paused, so the scheduler took the row and parked
        // it: it will not fire, and counting an attempt, announcing "Resumes
        // at ..." and publishing a countdown for it would all be lies. Reported
        // the same way a pause that arrives later is.
        if (schedule.status === "paused" || schedule.pausedFlag) {
          logger.info("agent_chat.auto_resume_row_paused", {
            sessionId,
            scheduleId: schedule.id,
            fireAt: new Date(fireAt).toISOString(),
          });
          reportPausedRowState();
          return;
        }
        // A cancel landed while the upsert was in flight (a user message, or a
        // sweep that ran while the scheduler was still loading its durable
        // state). The row it was looking for only exists now, so undo it here.
        // The epoch was checked immediately after upsert, before any status
        // projection. This later check closes a synchronous hook that mutates
        // state while inspecting the returned schedule in custom schedulers.
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
        // Reported before the notice de-dupe below, not after: a repeat error
        // event for the same fire time must still refresh the state clients
        // render from even when it adds no second transcript line.
        reportResumeState(sessionId, buildResumeState({
          state: "armed",
          provider: args.provider,
          fireAtMs: fireAt,
          resetAtMs: args.resetAtMs,
          scheduleId: schedule.id,
          attempts: state.consecutiveArms,
          providerDetail: args.providerDetail,
          turnId,
        }));
        if (state.noticeFireAt === fireAt) return;
        state.noticeFireAt = fireAt;
        emitAutoResumeNotice(sessionId, {
          message: autoResumeScheduledMessage(fireAt),
          detail: AUTO_RESUME_ARMED_NOTICE_DETAIL,
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
    // Held so `whenArmed` can wait on the upsert. Cleared by the same arm that
    // set it, so a later caller never awaits a settled arm from a past limit.
    state.armPromise = armPromise;
    void armPromise.finally(() => {
      if (state.armPromise === armPromise) state.armPromise = null;
    });
  };

  /**
   * Puts back a row the manual Resume now cancelled and then failed to spend.
   *
   * Deliberately NOT `maybeArmAfterUsageLimit`: this is the same arm, restored,
   * so counting it again would spend one of the two attempts the cap allows and
   * announce a second "Resumes at ..." for a schedule the chat never lost. What
   * it does share is the guard and the shape — a chat that stopped being
   * schedulable while the send was in flight gets nothing, and the row is the
   * arm path's own payload.
   *
   * `epochAtDispatch` is the caller's proof that nothing happened in between.
   * It is captured before the dispatch and compared here on both sides of the
   * upsert, so a user message or an opt-out that landed while the send was in
   * flight reports `superseded` and leaves the newer state alone. The record is
   * minted rather than looked up: after a restart there is no in-memory state,
   * and an epoch check against a record that does not exist is no check at all.
   */
  const rearm = async (
    sessionId: string,
    resume: AgentChatUsageLimitResume,
    epochAtDispatch: number,
  ): Promise<ChatAutoResumeRearmOutcome> => {
    if (resume.state !== "armed" || !resume.fireAt) return "failed";
    const fireAt = Date.parse(resume.fireAt);
    if (!Number.isFinite(fireAt)) return "failed";
    if (!isSessionSchedulable(sessionId)) return "failed";
    const state = ensureState(sessionId);
    if (state.cancelEpoch !== epochAtDispatch) return "superseded";
    try {
      await whenSchedulerReady();
      const scheduler = getScheduler();
      if (!scheduler) return "failed";
      if (stateBySession.get(sessionId) !== state || state.cancelEpoch !== epochAtDispatch) {
        return "superseded";
      }
      const schedule = await scheduler.upsert(autoResumeRowUpsert(sessionId, fireAt));
      if (schedule.status === "cancelled" || schedule.status === "done") return "failed";
      // A cancel that landed while the upsert was in flight was looking for a
      // row that only exists now, so undo it here — same rule the arm path
      // follows, and the reason the epoch is re-read rather than trusted.
      if (stateBySession.get(sessionId) !== state || state.cancelEpoch !== epochAtDispatch) {
        await cancelPendingRow(sessionId, "cancelled_while_rearming");
        return "superseded";
      }
      // The row was written and is already gone again: the only thing that
      // removes a pending row is a cancel, so this is a newer writer (a user
      // message taking the chat over) rather than a re-arm that failed. Saying
      // `failed` here would let the caller publish `no_reset` over a chat the
      // user just took back.
      if (!findPendingRow(sessionId)) return "superseded";
      logger.info("agent_chat.auto_resume_rearmed", {
        sessionId,
        scheduleId: schedule.id,
        fireAt: new Date(fireAt).toISOString(),
        status: schedule.status,
      });
      return "armed";
    } catch (error) {
      logger.warn("agent_chat.auto_resume_rearm_failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return "failed";
    }
  };

  /**
   * Undoes the streak half of a cancel that turned out not to count. Only the
   * fields `cancelForSession` zeroes are written back, and only for a chat this
   * process already tracks — a restored counter for a chat with no record would
   * be a counter for a limit nobody saw.
   */
  const restoreStreak = (
    sessionId: string,
    streak: {
      attempts: number;
      paused: boolean;
      lastArmedFireAtMs?: number | null;
      epochAtDispatch: number;
    },
  ): void => {
    const state = stateBySession.get(sessionId);
    if (!state) return;
    // Same epoch rule the re-arm follows: a user message, an opt-out or an
    // explicit Turn on that landed while the send was in flight already decided
    // what this chat's streak means, and an undo from an older attempt must not
    // reach back over it.
    if (state.cancelEpoch !== streak.epochAtDispatch) return;
    state.consecutiveArms = streak.attempts;
    state.pauseNoticed = streak.paused;
    if (streak.lastArmedFireAtMs !== undefined) {
      state.lastArmedFireAt = streak.lastArmedFireAtMs;
    }
  };

  /**
   * Clears the streak so the next arm counts from zero. Turn on / Try again is
   * a human saying "try again", which is the intervening event the cap waits
   * for. (Resume now does NOT come through here: the cancel it awaits already
   * zeroes the counter, and only a turn that actually starts keeps it zeroed.)
   *
   * The epoch bump is what makes it outrank a pending undo: a manual resume
   * that fails afterwards must not restore the streak this reset just cleared.
   */
  const resetStreak = (sessionId: string): void => {
    const state = stateBySession.get(sessionId);
    if (!state) return;
    state.cancelEpoch += 1;
    state.consecutiveArms = 0;
    state.lastArmedFireAt = null;
    state.noticeFireAt = null;
    state.pauseNoticed = false;
  };

  return {
    maybeArmAfterUsageLimit,
    rearm,
    cancelEpochFor: (sessionId: string): number => ensureState(sessionId).cancelEpoch,
    restoreStreak,
    noteRowStatusChanged,
    whenArmed: (sessionId: string): Promise<void> =>
      stateBySession.get(sessionId)?.armPromise ?? Promise.resolve(),
    streakState: (sessionId: string): { attempts: number; paused: boolean } => {
      const state = stateBySession.get(sessionId);
      return {
        attempts: state?.consecutiveArms ?? 0,
        paused: state?.pauseNoticed === true,
      };
    },
    resetStreak,
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
