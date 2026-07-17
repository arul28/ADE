import { nextCronFireAt as nextChatScheduledCronFireAt } from "../../../shared/chatScheduledWork";

export { nextChatScheduledCronFireAt };

/**
 * Durable scheduled-work delivery for chat sessions.
 *
 * ADE state wins, SDK view is advisory: the mirrored ADE record is the source
 * of truth for delivery. Claude's in-process scheduler is only a latency
 * optimization, and its CronList view may drift after restarts or busy ticks.
 */

export type ChatScheduledWorkKind = "wakeup" | "cron" | "loop";

export type ChatScheduledWorkStatus =
  | "scheduled"
  | "paused"
  | "fired"
  | "done"
  | "cancelled";

export type ChatScheduledWorkRecord = {
  id: string;
  sessionId: string;
  kind: ChatScheduledWorkKind;
  prompt: string;
  reason?: string;
  cron?: string;
  fireAt?: number;
  expiresAt?: number;
  createdAt: number;
  terminalAt?: number;
  status: ChatScheduledWorkStatus;
  pausedFlag: boolean;
  lastFiredAt?: number;
  lateFlag: boolean;
  activeTurnId?: string;
  outcomeSummary?: string;
  durable?: boolean;
  provider?: "claude";
  providerSessionId?: string;
  providerScheduleId?: string;
};

export type ChatScheduledWorkState = {
  version: 1;
  schedules: ChatScheduledWorkRecord[];
  pausedSessionIds: string[];
};

export type ChatScheduledWorkUpsert = Omit<
  ChatScheduledWorkRecord,
  "createdAt" | "status" | "pausedFlag" | "lateFlag"
> & Partial<Pick<
  ChatScheduledWorkRecord,
  "createdAt" | "status" | "pausedFlag" | "lateFlag"
>>;

export type ChatScheduledWorkTimerApi = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

type MaybePromise<T> = T | Promise<T>;

export type ChatScheduledWorkSchedulerOptions = {
  loadState(): MaybePromise<unknown>;
  saveState(state: ChatScheduledWorkState): MaybePromise<void>;
  now?: () => number;
  timers?: ChatScheduledWorkTimerApi;
  isGlobalPaused(): boolean;
  sessionState(sessionId: string): "active" | "ended" | "archived" | "missing";
  fire(schedule: ChatScheduledWorkRecord, context: { late: boolean }): Promise<void>;
  onTransition?: (
    schedule: ChatScheduledWorkRecord,
    status: ChatScheduledWorkStatus,
  ) => MaybePromise<void>;
};

export type ChatScheduledWorkScheduler = {
  start(): Promise<void>;
  dispose(): void;
  upsert(schedule: ChatScheduledWorkUpsert): Promise<ChatScheduledWorkRecord>;
  cancel(scheduleId: string): Promise<ChatScheduledWorkRecord | null>;
  setSchedulePaused(scheduleId: string, paused: boolean): Promise<ChatScheduledWorkRecord | null>;
  setSessionPaused(sessionId: string, paused: boolean): Promise<void>;
  refreshGlobalPause(): Promise<void>;
  list(sessionId?: string): ChatScheduledWorkRecord[];
  isSessionPaused(sessionId: string): boolean;
  nextWakeAt(sessionId: string): number | null;
  claimNativeFire(sessionId: string, turnId: string): ChatScheduledWorkRecord | null;
  recordTurnStarted(scheduleId: string, turnId: string): Promise<void>;
  recordTurnFinished(turnId: string, outcomeSummary?: string): Promise<void>;
};

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const TIMER_LATE_TOLERANCE_MS = 1_000;
const NATIVE_FIRE_GRACE_MS = 90_000;
const TERMINAL_HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_TERMINAL_HISTORY_RECORDS = 200;
const LEGACY_PROVISIONAL_CRON_PREFIX = "cron-tool:";

function nativeFireGraceMs(schedule: ChatScheduledWorkRecord): number {
  return schedule.provider === "claude" ? NATIVE_FIRE_GRACE_MS : 0;
}

const defaultTimers: ChatScheduledWorkTimerApi = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeSchedule(value: unknown): ChatScheduledWorkRecord | null {
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.id !== "string" || !record.id) return null;
  if (typeof record.sessionId !== "string" || !record.sessionId) return null;
  if (record.kind !== "wakeup" && record.kind !== "cron" && record.kind !== "loop") return null;
  if (typeof record.prompt !== "string") return null;

  const statuses: ChatScheduledWorkStatus[] = [
    "scheduled",
    "paused",
    "fired",
    "done",
    "cancelled",
  ];
  const status = statuses.includes(record.status as ChatScheduledWorkStatus)
    ? record.status as ChatScheduledWorkStatus
    : "scheduled";

  return {
    id: record.id,
    sessionId: record.sessionId,
    kind: record.kind,
    prompt: record.prompt,
    ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
    ...(typeof record.cron === "string" ? { cron: record.cron } : {}),
    ...(readTimestamp(record.fireAt) != null ? { fireAt: readTimestamp(record.fireAt) } : {}),
    ...(readTimestamp(record.expiresAt) != null ? { expiresAt: readTimestamp(record.expiresAt) } : {}),
    createdAt: readTimestamp(record.createdAt) ?? 0,
    ...(readTimestamp(record.terminalAt) != null ? { terminalAt: readTimestamp(record.terminalAt) } : {}),
    status,
    pausedFlag: record.pausedFlag === true,
    ...(readTimestamp(record.lastFiredAt) != null
      ? { lastFiredAt: readTimestamp(record.lastFiredAt) }
      : {}),
    lateFlag: record.lateFlag === true,
    ...(typeof record.activeTurnId === "string" && record.activeTurnId
      ? { activeTurnId: record.activeTurnId }
      : {}),
    ...(typeof record.outcomeSummary === "string"
      ? { outcomeSummary: record.outcomeSummary }
      : {}),
    ...(typeof record.durable === "boolean" ? { durable: record.durable } : {}),
    ...(record.provider === "claude" ? { provider: "claude" as const } : {}),
    ...(typeof record.providerSessionId === "string" && record.providerSessionId.trim()
      ? { providerSessionId: record.providerSessionId.trim() }
      : {}),
    ...(typeof record.providerScheduleId === "string"
      ? { providerScheduleId: record.providerScheduleId }
      : {}),
  };
}

function normalizeState(value: unknown): ChatScheduledWorkState {
  const record = asRecord(value);
  const schedules = Array.isArray(record?.schedules)
    ? record.schedules.map(normalizeSchedule).filter((item): item is ChatScheduledWorkRecord => item != null)
    : [];
  const pausedSessionIds = Array.isArray(record?.pausedSessionIds)
    ? record.pausedSessionIds.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  return {
    version: 1,
    schedules,
    pausedSessionIds: [...new Set(pausedSessionIds)],
  };
}

function cloneSchedule(schedule: ChatScheduledWorkRecord): ChatScheduledWorkRecord {
  return { ...schedule };
}

export function createChatScheduledWorkScheduler(
  options: ChatScheduledWorkSchedulerOptions,
): ChatScheduledWorkScheduler {
  const now = options.now ?? Date.now;
  const timers = options.timers ?? defaultTimers;
  const schedules = new Map<string, ChatScheduledWorkRecord>();
  const pausedSessionIds = new Set<string>();
  const timerHandles = new Map<string, unknown>();
  const inFlight = new Set<string>();
  let started = false;
  let disposed = false;
  let startPromise: Promise<void> | null = null;
  let persistenceTail = Promise.resolve();

  const stateSnapshot = (): ChatScheduledWorkState => ({
    version: 1,
    schedules: [...schedules.values()]
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .map(cloneSchedule),
    pausedSessionIds: [...pausedSessionIds].sort(),
  });

  const persist = async (): Promise<void> => {
    const snapshot = stateSnapshot();
    const write = persistenceTail.then(() => options.saveState(snapshot));
    persistenceTail = write.then(() => undefined, () => undefined);
    await write;
  };

  const emitTransition = async (
    schedule: ChatScheduledWorkRecord,
    status: ChatScheduledWorkStatus,
  ): Promise<void> => {
    if (!options.onTransition) return;
    try {
      await options.onTransition(cloneSchedule(schedule), status);
    } catch {
      // UI/event-feed failures must not compromise the durable scheduler state.
    }
  };

  const clearTimer = (scheduleId: string): void => {
    const handle = timerHandles.get(scheduleId);
    if (handle == null) return;
    timerHandles.delete(scheduleId);
    timers.clearTimeout(handle);
  };

  const isEffectivelyPaused = (schedule: ChatScheduledWorkRecord): boolean => (
    schedule.pausedFlag || pausedSessionIds.has(schedule.sessionId) || options.isGlobalPaused()
  );

  const isTerminal = (schedule: ChatScheduledWorkRecord): boolean =>
    schedule.status === "done" || schedule.status === "cancelled";

  const isExpired = (schedule: ChatScheduledWorkRecord, at = now()): boolean =>
    schedule.expiresAt != null && schedule.expiresAt <= at;

  const markTerminal = (
    schedule: ChatScheduledWorkRecord,
    status: Extract<ChatScheduledWorkStatus, "done" | "cancelled">,
  ): void => {
    schedule.status = status;
    schedule.terminalAt = now();
  };

  const quarantineInactiveProviderSchedule = (
    schedule: ChatScheduledWorkRecord,
  ): boolean => {
    if (schedule.provider !== "claude" || schedule.durable !== true || isTerminal(schedule)) return false;
    schedule.pausedFlag = true;
    schedule.status = "paused";
    delete schedule.activeTurnId;
    delete schedule.terminalAt;
    clearTimer(schedule.id);
    return true;
  };

  const pruneTerminalHistory = (): boolean => {
    const cutoff = now() - TERMINAL_HISTORY_RETENTION_MS;
    const terminal = [...schedules.values()]
      .filter(isTerminal)
      .sort((left, right) =>
        (right.terminalAt ?? right.createdAt) - (left.terminalAt ?? left.createdAt)
        || right.id.localeCompare(left.id));
    let changed = false;
    terminal.forEach((schedule, index) => {
      if ((schedule.terminalAt ?? schedule.createdAt) >= cutoff && index < MAX_TERMINAL_HISTORY_RECORDS) return;
      clearTimer(schedule.id);
      schedules.delete(schedule.id);
      changed = true;
    });
    return changed;
  };

  const processDue = async (scheduleId: string, overdueWhenArmed: boolean): Promise<void> => {
    if (disposed || inFlight.has(scheduleId)) return;
    const schedule = schedules.get(scheduleId);
    if (!schedule || (schedule.status !== "scheduled" && schedule.status !== "paused")) return;

    const currentTime = now();
    if (isExpired(schedule, currentTime)) {
      markTerminal(schedule, "cancelled");
      clearTimer(schedule.id);
      pruneTerminalHistory();
      await persist();
      await emitTransition(schedule, "cancelled");
      return;
    }
    if (schedule.fireAt == null || schedule.fireAt > currentTime) {
      arm(schedule);
      return;
    }

    if (options.sessionState(schedule.sessionId) !== "active") {
      if (!quarantineInactiveProviderSchedule(schedule)) {
        markTerminal(schedule, "cancelled");
        pruneTerminalHistory();
      }
      clearTimer(schedule.id);
      await persist();
      await emitTransition(schedule, schedule.status);
      return;
    }

    if (isEffectivelyPaused(schedule)) {
      if (schedule.status !== "paused") {
        schedule.status = "paused";
        await persist();
        await emitTransition(schedule, "paused");
      }
      return;
    }

    inFlight.add(scheduleId);
    const lateThresholdMs = nativeFireGraceMs(schedule) + TIMER_LATE_TOLERANCE_MS;
    const late = overdueWhenArmed || currentTime - schedule.fireAt > lateThresholdMs;
    schedule.status = "fired";
    schedule.lastFiredAt = currentTime;
    schedule.lateFlag = late;
    await persist();
    await emitTransition(schedule, "fired");

    try {
      await options.fire(cloneSchedule(schedule), { late });
    } catch {
      // A delivery may have reached the session before its caller failed. Keep
      // one-shots fired and advance crons so a retry cannot double-deliver.
    } finally {
      inFlight.delete(scheduleId);
    }

    const current = schedules.get(scheduleId);
    if (!current || current.status === "cancelled" || current.status === "done") return;
    if (current.kind !== "cron") return;

    current.fireAt = current.cron
      ? nextChatScheduledCronFireAt(current.cron, now()) ?? undefined
      : undefined;
    current.status = isEffectivelyPaused(current) ? "paused" : "scheduled";
    await persist();
    await emitTransition(current, current.status);
    arm(current);
  };

  const arm = (schedule: ChatScheduledWorkRecord): void => {
    clearTimer(schedule.id);
    if (disposed || inFlight.has(schedule.id) || schedule.status !== "scheduled") return;
    // Claude normally fires at fireAt (plus provider jitter). ADE waits through
    // this grace window so claimNativeFire can claim the row first; this timer
    // remains the backstop for busy, skipped, or dead provider processes.
    const providerAdjustedFireAt = schedule.fireAt == null
      ? undefined
      : schedule.fireAt + nativeFireGraceMs(schedule);
    const nextAt = schedule.expiresAt == null
      ? providerAdjustedFireAt
      : providerAdjustedFireAt == null
        ? schedule.expiresAt
        : Math.min(providerAdjustedFireAt, schedule.expiresAt);
    if (nextAt == null || !Number.isFinite(nextAt)) return;

    const currentTime = now();
    const overdueWhenArmed = providerAdjustedFireAt != null && providerAdjustedFireAt < currentTime;
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, nextAt - currentTime));
    const handle = timers.setTimeout(() => {
      timerHandles.delete(schedule.id);
      void processDue(schedule.id, overdueWhenArmed).catch(() => undefined);
    }, delay);
    timerHandles.set(schedule.id, handle);
  };

  const reconcileSchedule = async (schedule: ChatScheduledWorkRecord): Promise<void> => {
    if (schedule.status === "done" || schedule.status === "cancelled") return;
    if (isExpired(schedule)) {
      markTerminal(schedule, "cancelled");
      pruneTerminalHistory();
      await persist();
      await emitTransition(schedule, "cancelled");
      return;
    }
    if (options.sessionState(schedule.sessionId) !== "active") {
      if (!quarantineInactiveProviderSchedule(schedule)) {
        markTerminal(schedule, "cancelled");
        pruneTerminalHistory();
      }
      await persist();
      await emitTransition(schedule, schedule.status);
      return;
    }

    if (schedule.status === "fired") {
      if (schedule.kind === "cron") {
        schedule.fireAt = schedule.cron
          ? nextChatScheduledCronFireAt(schedule.cron, Math.max(now(), schedule.lastFiredAt ?? 0)) ?? undefined
          : undefined;
        schedule.status = isEffectivelyPaused(schedule) ? "paused" : "scheduled";
      } else {
        // A persisted fired one-shot was already claimed before the previous
        // process exited. Complete it without delivery so restore preserves
        // at-most-once semantics.
        markTerminal(schedule, "done");
        pruneTerminalHistory();
      }
      delete schedule.activeTurnId;
      await persist();
      await emitTransition(schedule, schedule.status);
    } else if (schedule.status === "scheduled" || schedule.status === "paused") {
      if (schedule.kind === "cron" && schedule.fireAt == null && schedule.cron) {
        schedule.fireAt = nextChatScheduledCronFireAt(schedule.cron, now()) ?? undefined;
      }
      const nextStatus = isEffectivelyPaused(schedule) ? "paused" : "scheduled";
      if (nextStatus !== schedule.status) {
        schedule.status = nextStatus;
        await persist();
        await emitTransition(schedule, nextStatus);
      }
    }
    arm(schedule);
  };

  const start = async (): Promise<void> => {
    if (started) return;
    if (startPromise) return startPromise;
    if (disposed) throw new Error("Chat scheduled work scheduler has been disposed");

    startPromise = (async () => {
      const state = normalizeState(await options.loadState());
      schedules.clear();
      pausedSessionIds.clear();
      let migrated = false;
      for (const schedule of state.schedules) {
        // Pre-1.2.27 builds persisted cron-tool placeholders before Claude
        // returned its canonical id. They are never provider jobs and cannot
        // be deleted through CronDelete, so they must never be restored.
        if (schedule.id.startsWith(LEGACY_PROVISIONAL_CRON_PREFIX)) {
          migrated = true;
          continue;
        }
        // Every pre-1.2.27 active row came from Claude scheduled tools but was
        // persisted without provider metadata. Quarantine it instead of
        // deleting or firing it: Claude remains the execution owner, while
        // Settings can cancel it and an authoritative provider snapshot can
        // retire it. `wakeup:<session>` is ADE's local alias, not a provider id.
        if (
          typeof schedule.durable !== "boolean"
          && schedule.status !== "done"
          && schedule.status !== "cancelled"
        ) {
          schedule.pausedFlag = true;
          schedule.status = "paused";
          schedule.durable = true;
          schedule.provider = "claude";
          if (!schedule.id.startsWith("wakeup:")) {
            schedule.providerScheduleId = schedule.id;
          }
          migrated = true;
        }
        schedules.set(schedule.id, schedule);
      }
      for (const sessionId of state.pausedSessionIds) pausedSessionIds.add(sessionId);
      migrated = pruneTerminalHistory() || migrated;
      started = true;
      for (const schedule of schedules.values()) await reconcileSchedule(schedule);
      if (migrated) await persist();
    })();
    return startPromise;
  };

  const updatePauseStatuses = async (sessionId?: string): Promise<void> => {
    const transitions: ChatScheduledWorkRecord[] = [];
    for (const schedule of schedules.values()) {
      if (sessionId != null && schedule.sessionId !== sessionId) continue;
      if (schedule.status !== "scheduled" && schedule.status !== "paused") continue;
      const nextStatus = isEffectivelyPaused(schedule) ? "paused" : "scheduled";
      if (nextStatus === schedule.status) continue;
      schedule.status = nextStatus;
      transitions.push(schedule);
    }
    await persist();
    for (const schedule of transitions) await emitTransition(schedule, schedule.status);
    for (const schedule of schedules.values()) {
      if (sessionId == null || schedule.sessionId === sessionId) arm(schedule);
    }
  };

  return {
    start,

    dispose(): void {
      disposed = true;
      for (const scheduleId of [...timerHandles.keys()]) clearTimer(scheduleId);
    },

    async upsert(input): Promise<ChatScheduledWorkRecord> {
      await start();
      const existing = schedules.get(input.id);
      const schedule: ChatScheduledWorkRecord = {
        ...existing,
        ...input,
        createdAt: input.createdAt ?? existing?.createdAt ?? now(),
        status: input.status ?? existing?.status ?? "scheduled",
        pausedFlag: input.pausedFlag ?? existing?.pausedFlag ?? false,
        lateFlag: input.lateFlag ?? existing?.lateFlag ?? false,
      };
      if (schedule.kind === "cron" && schedule.fireAt == null && schedule.cron) {
        schedule.fireAt = nextChatScheduledCronFireAt(schedule.cron, now()) ?? undefined;
      }
      if (schedule.status === "scheduled" || schedule.status === "paused") {
        schedule.status = isEffectivelyPaused(schedule) ? "paused" : "scheduled";
      }
      if (options.sessionState(schedule.sessionId) !== "active") {
        if (!quarantineInactiveProviderSchedule(schedule)) {
          markTerminal(schedule, "cancelled");
          pruneTerminalHistory();
        }
      } else if (!isTerminal(schedule)) {
        delete schedule.terminalAt;
      } else if (schedule.terminalAt == null) {
        schedule.terminalAt = now();
      }
      schedules.set(schedule.id, schedule);
      await persist();
      await emitTransition(schedule, schedule.status);
      arm(schedule);
      return cloneSchedule(schedule);
    },

    async cancel(scheduleId): Promise<ChatScheduledWorkRecord | null> {
      await start();
      const schedule = schedules.get(scheduleId);
      if (!schedule) return null;
      clearTimer(scheduleId);
      if (schedule.status !== "cancelled") {
        markTerminal(schedule, "cancelled");
        pruneTerminalHistory();
        await persist();
        await emitTransition(schedule, "cancelled");
      }
      return cloneSchedule(schedule);
    },

    async setSchedulePaused(scheduleId, paused): Promise<ChatScheduledWorkRecord | null> {
      await start();
      const schedule = schedules.get(scheduleId);
      if (!schedule || isTerminal(schedule)) return schedule ? cloneSchedule(schedule) : null;
      const previousStatus = schedule.status;
      schedule.pausedFlag = paused;
      if (schedule.status === "scheduled" || schedule.status === "paused") {
        schedule.status = isEffectivelyPaused(schedule) ? "paused" : "scheduled";
      }
      await persist();
      if (schedule.status !== previousStatus) await emitTransition(schedule, schedule.status);
      arm(schedule);
      return cloneSchedule(schedule);
    },

    async setSessionPaused(sessionId, paused): Promise<void> {
      await start();
      if (paused) pausedSessionIds.add(sessionId);
      else pausedSessionIds.delete(sessionId);
      await updatePauseStatuses(sessionId);
    },

    async refreshGlobalPause(): Promise<void> {
      await start();
      await updatePauseStatuses();
    },

    list(sessionId): ChatScheduledWorkRecord[] {
      return [...schedules.values()]
        .filter((schedule) => sessionId == null || schedule.sessionId === sessionId)
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
        .map(cloneSchedule);
    },

    isSessionPaused(sessionId): boolean {
      return pausedSessionIds.has(sessionId);
    },

    nextWakeAt(sessionId): number | null {
      if (options.isGlobalPaused() || pausedSessionIds.has(sessionId)) return null;
      let next: number | null = null;
      for (const schedule of schedules.values()) {
        if (
          schedule.sessionId !== sessionId ||
          schedule.status !== "scheduled" ||
          schedule.pausedFlag ||
          isExpired(schedule) ||
          schedule.fireAt == null ||
          !Number.isFinite(schedule.fireAt)
        ) continue;
        next = next == null ? schedule.fireAt : Math.min(next, schedule.fireAt);
      }
      return next;
    },

    claimNativeFire(sessionId, turnId): ChatScheduledWorkRecord | null {
      if (disposed || options.isGlobalPaused() || pausedSessionIds.has(sessionId)) return null;
      const currentTime = now();
      const schedule = [...schedules.values()]
        .filter((candidate) =>
          candidate.sessionId === sessionId
          && candidate.status === "scheduled"
          && !candidate.pausedFlag
          && !isExpired(candidate, currentTime)
          && candidate.fireAt != null
          && candidate.fireAt <= currentTime + TIMER_LATE_TOLERANCE_MS)
        .sort((left, right) => (left.fireAt ?? 0) - (right.fireAt ?? 0))[0];
      if (!schedule || options.sessionState(sessionId) !== "active") return null;

      clearTimer(schedule.id);
      inFlight.add(schedule.id);
      schedule.status = "fired";
      schedule.lastFiredAt = currentTime;
      schedule.lateFlag = currentTime - (schedule.fireAt ?? currentTime) > TIMER_LATE_TOLERANCE_MS;
      schedule.activeTurnId = turnId;
      const claimed = cloneSchedule(schedule);
      void (async () => {
        try {
          await persist();
          await emitTransition(schedule, "fired");
          if (schedule.kind === "cron" && schedule.status === "fired") {
            // Only clear the turn we claimed — a newer fire's recordTurnStarted
            // may already own activeTurnId, and its outcome summary must land.
            if (schedule.activeTurnId === turnId) delete schedule.activeTurnId;
            schedule.fireAt = schedule.cron
              ? nextChatScheduledCronFireAt(schedule.cron, currentTime) ?? undefined
              : undefined;
            schedule.status = isEffectivelyPaused(schedule) ? "paused" : "scheduled";
            await persist();
            await emitTransition(schedule, schedule.status);
            inFlight.delete(schedule.id);
            arm(schedule);
          }
        } finally {
          inFlight.delete(schedule.id);
        }
      })().catch(() => undefined);
      return claimed;
    },

    async recordTurnStarted(scheduleId, turnId): Promise<void> {
      await start();
      const schedule = schedules.get(scheduleId);
      if (!schedule || schedule.status === "done" || schedule.status === "cancelled") return;
      schedule.activeTurnId = turnId;
      await persist();
    },

    async recordTurnFinished(turnId, outcomeSummary): Promise<void> {
      await start();
      const finished: ChatScheduledWorkRecord[] = [];
      let changed = false;
      for (const schedule of schedules.values()) {
        if (schedule.activeTurnId !== turnId) continue;
        delete schedule.activeTurnId;
        if (outcomeSummary != null) schedule.outcomeSummary = outcomeSummary;
        if (schedule.kind !== "cron" && schedule.status === "fired") {
          markTerminal(schedule, "done");
          finished.push(schedule);
        }
        changed = true;
      }
      if (!changed) return;
      pruneTerminalHistory();
      await persist();
      for (const schedule of finished) await emitTransition(schedule, "done");
    },
  };
}
