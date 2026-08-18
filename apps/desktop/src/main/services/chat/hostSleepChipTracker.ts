// ---------------------------------------------------------------------------
// The transcript's account of a host that went to sleep mid-turn.
//
// A machine that suspends mid-turn kills the agent's in-flight API call. Two
// things follow from knowing that, and both live here:
//
//  - The transcript gets ONE chip, which resolves itself in place on wake (the
//    renderer folds the two halves onto one row by `sleepId`).
//  - Provider retries whose cause the API could not name are held instead of
//    counted, because a socket cannot recover while the machine is dark.
//    Genuine API failures — overloaded, rate limits, anything with an HTTP
//    status — are untouched and keep retrying and reporting truthfully.
//
// The two decisions are pure and live in `shared/hostSleepNotice`; what is here
// is the bookkeeping that turns power events into chat events. It is a separate
// module rather than another closure inside `agentChatService` because it needs
// only four things from that service — emit, the active turn id, the session
// map, and a logger — and because a subsystem that owns mutable sleep state
// should be testable without standing up a chat service.
//
// Everything degrades to the old behaviour without a power source, which is
// what a runtime built with no host hook (and every existing test) gets.
// ---------------------------------------------------------------------------

import type { MachinePowerSource } from "../../../../../ade-cli/src/services/power/machinePowerMonitor";
import {
  HOST_ASLEEP_NOTICE_MESSAGE,
  HOST_ASLEEP_NOTICE_STATUS,
  HOST_AWAKE_NOTICE_STATUS,
  hostResumedNoticeMessage,
  shouldAttributeRetryToHostSuspend,
} from "../../../shared/hostSleepNotice";
import type { AgentChatEvent } from "../../../shared/types/chat";
import type { MachineSleepState } from "../../../shared/types/power";

/**
 * The slice of a managed chat session this tracker reads. Structural on
 * purpose: the chat service passes its own `ManagedChatSession` unchanged.
 */
export type HostSleepChipSession = {
  closed: boolean;
  deleted: boolean;
  session: { id: string; status?: string | null };
};

export type HostSleepChipTrackerOptions<TSession extends HostSleepChipSession> = {
  /** Null when this runtime has no host power hook at all. */
  powerSource?: MachinePowerSource | null;
  /** Every live session, for the fan-out at suspend. */
  sessions: () => Iterable<TSession>;
  sessionById: (sessionId: string) => TSession | undefined;
  activeTurnIdFor: (session: TSession) => string | null;
  emit: (session: TSession, event: AgentChatEvent) => void;
  logger: {
    info: (event: string, meta?: Record<string, unknown>) => void;
    debug: (event: string, meta?: Record<string, unknown>) => void;
  };
  now?: () => number;
};

export type HostSleepChipTracker<TSession extends HostSleepChipSession> = {
  /**
   * Emit the current half of the sleep chip for one session, at most once per
   * half. Called on the fan-out and again when a held retry proves the sleep is
   * what the user is actually waiting on.
   */
  ensureChipFor: (session: TSession) => void;
  /**
   * True when this provider retry is the host's sleep wearing the API's
   * clothes. Records the chip so the cause is named once, and tells the caller
   * to hold the retry rather than count it: neither the `api_retry` event that
   * drives "retry 3/10" nor the warning notice is emitted, because a socket
   * cannot recover while the machine is dark.
   *
   * Returns false — leaving retries and reporting completely untouched — for
   * every failure the API itself named, and whenever no host power source is
   * wired.
   */
  holdRetry: (session: TSession, error: string, errorStatus: number | null) => boolean;
  dispose: () => void;
};

export function createHostSleepChipTracker<TSession extends HostSleepChipSession>(
  options: HostSleepChipTrackerOptions<TSession>,
): HostSleepChipTracker<TSession> {
  const powerSource = options.powerSource ?? null;
  const now = options.now ?? Date.now;
  const { logger } = options;

  /** Identity of the most recent sleep; retained after the wake so the resume half can find it. */
  let sleepId: string | null = null;
  /** False while the machine is down, true once the wake has been observed. */
  let resolved = true;
  let gapMs: number | null = null;
  let counter = 0;
  /**
   * Epoch ms of the last ANNOUNCED resume.
   *
   * Only an announcement earns the retry-hold grace window. The gap detector
   * fires on any tick 60 s late, and an event-loop stall that large does happen
   * under load — letting an inference open the window would silently drop
   * genuine `api_retry` reporting for 30 s during a real network outage.
   */
  let lastAnnouncedResumeAt: number | null = null;
  /** What each session has already been told about the current sleep. */
  const chipBySession = new Map<
    string,
    { sleepId: string; turnId: string | null; resolved: boolean }
  >();

  /**
   * The source owns the sleep state; mirroring it here would drift whenever the
   * chat service was constructed mid-sleep, or whenever a suspend arrived
   * before this tracker subscribed.
   */
  const readSleepState = (): MachineSleepState | null => {
    if (!powerSource) return null;
    try {
      return powerSource.getSleepState();
    } catch {
      return null;
    }
  };

  /**
   * When that state was last set. Read from the source for the same reason the
   * state is: a stamp mirrored here would be wrong for any suspend that landed
   * before this tracker subscribed. Null when unreadable, which age-bounds the
   * attribution to nothing rather than to forever.
   */
  const readSleepStateAt = (): number | null => {
    if (!powerSource) return null;
    try {
      const at = powerSource.getSleepStateAt();
      return typeof at === "number" && Number.isFinite(at) ? at : null;
    } catch {
      return null;
    }
  };

  const ensureChipFor = (managed: TSession): void => {
    const currentSleepId = sleepId;
    if (!currentSleepId || managed.closed || managed.deleted) return;
    const seen = chipBySession.get(managed.session.id);
    if (seen?.sleepId === currentSleepId && seen.resolved === resolved) return;
    // Keep the turn the chip was born under: a wake that lands after the turn
    // ended must still resolve the chip where the user saw it pause.
    const turnId = seen?.sleepId === currentSleepId
      ? seen.turnId
      : options.activeTurnIdFor(managed);
    chipBySession.set(managed.session.id, { sleepId: currentSleepId, turnId, resolved });
    options.emit(managed, {
      type: "system_notice",
      noticeKind: "info",
      severity: "info",
      status: resolved ? HOST_AWAKE_NOTICE_STATUS : HOST_ASLEEP_NOTICE_STATUS,
      message: resolved ? hostResumedNoticeMessage(gapMs) : HOST_ASLEEP_NOTICE_MESSAGE,
      detail: {
        hostSleep: {
          sleepId: currentSleepId,
          ...(resolved && typeof gapMs === "number" ? { pausedMs: gapMs } : {}),
        },
      },
      ...(turnId ? { turnId } : {}),
    });
  };

  /**
   * Whether a suspend can actually interrupt anything in this session. An idle
   * chat has nothing to pause and gets no chip; a running turn does. The turn
   * id alone is not enough — a turn is `active` from the moment it is sent,
   * including the window before the provider hands back an id.
   */
  const turnInFlight = (managed: TSession): boolean =>
    !managed.closed
    && !managed.deleted
    && (options.activeTurnIdFor(managed) !== null || managed.session.status === "active");

  const onHostSuspend = (at: number): void => {
    resolved = false;
    gapMs = null;
    counter += 1;
    sleepId = `host-sleep-${at}-${counter}`;
    // A new sleep is a new chip, so nothing from the previous one carries over.
    chipBySession.clear();
    for (const managed of options.sessions()) {
      if (!turnInFlight(managed)) continue;
      ensureChipFor(managed);
    }
  };

  const onHostResume = (at: number, resumeGapMs: number | null, announced: boolean): void => {
    // The chip is honest for an inferred gap — nothing ran either way — but only
    // an announced sleep may excuse a provider retry.
    if (announced) lastAnnouncedResumeAt = at;
    gapMs = resumeGapMs;
    resolved = true;
    if (!sleepId) {
      // No pre-suspend beat reached us — the gap detector only ever learns
      // about a sleep on the way out of it, which is the Linux/headless case.
      // The chip is then born already resolved: still exactly one artifact.
      counter += 1;
      sleepId = `host-sleep-${at}-${counter}`;
      if (resumeGapMs === null) return;
      for (const managed of options.sessions()) {
        if (!turnInFlight(managed)) continue;
        ensureChipFor(managed);
      }
      return;
    }
    for (const sessionId of [...chipBySession.keys()]) {
      const managed = options.sessionById(sessionId);
      if (managed) ensureChipFor(managed);
    }
  };

  const unsubscribe = powerSource?.subscribe((event) => {
    try {
      if (event.kind === "suspend") onHostSuspend(event.at);
      else if (event.kind === "resume") onHostResume(event.at, event.gapMs, event.announced);
    } catch (error) {
      // Power narration must never be able to take down a live turn.
      logger.debug("agent_chat.host_power_event_failed", {
        kind: event.kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }) ?? null;

  const holdRetry = (managed: TSession, error: string, errorStatus: number | null): boolean => {
    if (!powerSource) return false;
    const sleepState = readSleepState();
    if (
      !shouldAttributeRetryToHostSuspend({
        error,
        errorStatus,
        sleepState,
        sleepStateAt: readSleepStateAt(),
        lastResumeAt: lastAnnouncedResumeAt,
        now: now(),
      })
    ) {
      return false;
    }
    // Only resolve a chip this session actually has. After the wake `resolved`
    // is true and `sleepId` is retained for the grace window, so a turn STARTED
    // after the wake — one the suspend fan-out never touched, because it was
    // idle when the lid shut — would otherwise be handed the resumed half on its
    // own: "Resumed · paused 4h" about a turn that was never paused. There is no
    // paused half to resolve, so there is nothing to say.
    if (!resolved || chipBySession.has(managed.session.id)) {
      ensureChipFor(managed);
    }
    logger.info("agent_chat.api_retry_held_for_host_suspend", {
      sessionId: managed.session.id,
      providerCause: error,
      sleepState,
    });
    return true;
  };

  return {
    ensureChipFor,
    holdRetry,
    dispose: (): void => {
      unsubscribe?.();
    },
  };
}
