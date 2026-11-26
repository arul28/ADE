import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ChatScheduledWorkCheckRun,
  type ChatScheduledWorkRecord,
  type ChatScheduledWorkState,
  createChatScheduledWorkScheduler,
  decideScheduledWorkCheck,
} from "./chatScheduledWorkScheduler";

const START = Date.parse("2026-07-09T09:00:00.000Z");

function wakeup(
  overrides: Partial<ChatScheduledWorkRecord> = {},
): ChatScheduledWorkRecord {
  return {
    id: "wake-1",
    sessionId: "session-1",
    kind: "wakeup",
    prompt: "Check PR CI",
    createdAt: START - 60_000,
    status: "scheduled",
    pausedFlag: false,
    lateFlag: false,
    fireAt: START + 60_000,
    durable: false,
    ...overrides,
  };
}

function storedState(schedules: ChatScheduledWorkRecord[]): ChatScheduledWorkState {
  return { version: 1, schedules, pausedSessionIds: [] };
}

function cloneState(state: ChatScheduledWorkState | null): ChatScheduledWorkState | null {
  return state == null ? null : structuredClone(state);
}

function requireState(state: ChatScheduledWorkState | null): ChatScheduledWorkState {
  if (state == null) throw new Error("Expected persisted scheduler state");
  return state;
}

function createFireMock() {
  return vi.fn(async (
    _schedule: ChatScheduledWorkRecord,
    _context: { late: boolean },
  ) => undefined);
}

/** One claim store shared by several brains, like the project database's kv table. */
function sharedClaims() {
  const held = new Set<string>();
  const key = (schedule: ChatScheduledWorkRecord) => `${schedule.id}@${schedule.fireAt}`;
  return {
    claimFire: (schedule: ChatScheduledWorkRecord) => {
      if (held.has(key(schedule))) return false;
      held.add(key(schedule));
      return true;
    },
    releaseFire: (schedule: ChatScheduledWorkRecord) => {
      held.delete(key(schedule));
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createChatScheduledWorkScheduler", () => {
  it("drops provisional cron ids and quarantines canonical legacy jobs during startup migration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let state: ChatScheduledWorkState | null = storedState([
      wakeup({
        id: "cron-tool:session-1:toolu_legacy",
        kind: "cron",
        cron: "*/20 * * * *",
      }),
      wakeup({ id: "1ababc75", kind: "cron", cron: "*/20 * * * *", durable: undefined }),
      wakeup({
        id: "cron-provider-1",
        kind: "cron",
        cron: "*/20 * * * *",
        durable: true,
      }),
      wakeup({ id: "wake-native", kind: "wakeup", durable: undefined }),
    ]);
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => cloneState(state),
      saveState: (next) => { state = structuredClone(next); },
      isGlobalPaused: () => false,
      sessionState: () => "active",
      fire: createFireMock(),
    });

    await scheduler.start();

    expect(scheduler.list().map((item) => item.id)).toEqual(["1ababc75", "cron-provider-1", "wake-native"]);
    expect(scheduler.list().find((item) => item.id === "1ababc75")).toEqual(expect.objectContaining({
      status: "paused",
      pausedFlag: true,
      durable: true,
      provider: "claude",
      providerScheduleId: "1ababc75",
    }));
    expect(scheduler.list().find((item) => item.id === "wake-native")).toEqual(expect.objectContaining({
      status: "paused",
      pausedFlag: true,
      durable: true,
      provider: "claude",
      providerScheduleId: "wake-native",
    }));
    expect(requireState(state).schedules.map((item) => item.id)).toEqual(["1ababc75", "cron-provider-1", "wake-native"]);
    scheduler.dispose();
  });

  it("keeps a migrated legacy provider cron visible when its owner is inactive", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let state: ChatScheduledWorkState | null = storedState([wakeup({
      id: "legacy-provider-cron",
      kind: "cron",
      cron: "*/20 * * * *",
      durable: undefined,
    })]);
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => cloneState(state),
      saveState: (next) => { state = structuredClone(next); },
      isGlobalPaused: () => false,
      sessionState: () => "ended",
      fire: createFireMock(),
    });

    await scheduler.start();

    expect(requireState(state).schedules).toEqual([
      expect.objectContaining({
        id: "legacy-provider-cron",
        status: "paused",
        pausedFlag: true,
        durable: true,
        provider: "claude",
        providerScheduleId: "legacy-provider-cron",
      }),
    ]);
    scheduler.dispose();
  });

  it.each(["wakeup", "loop"] as const)(
    "quarantines an active legacy %s without inventing a provider id for ADE aliases",
    async (kind) => {
      vi.useFakeTimers();
      vi.setSystemTime(START);
      let state: ChatScheduledWorkState | null = storedState([wakeup({
        id: `wakeup:session-1:${kind}`,
        kind,
        durable: undefined,
      })]);
      const scheduler = createChatScheduledWorkScheduler({
        loadState: () => cloneState(state),
        saveState: (next) => { state = structuredClone(next); },
        isGlobalPaused: () => false,
        sessionState: () => "ended",
        fire: createFireMock(),
      });

      await scheduler.start();

      expect(requireState(state).schedules).toEqual([
        expect.objectContaining({
          id: `wakeup:session-1:${kind}`,
          status: "paused",
          pausedFlag: true,
          durable: true,
          provider: "claude",
        }),
      ]);
      expect(requireState(state).schedules[0]?.providerScheduleId).toBeUndefined();
      scheduler.dispose();
    },
  );

  it("cancels a recurring job at its provider expiry instead of firing again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let state: ChatScheduledWorkState | null = null;
    const fire = createFireMock();
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => null,
      saveState: (next) => { state = structuredClone(next); },
      isGlobalPaused: () => false,
      sessionState: () => "active",
      fire,
    });
    await scheduler.upsert(wakeup({
      id: "cron-expiring",
      kind: "cron",
      cron: "* * * * *",
      fireAt: START + 60_000,
      expiresAt: START + 30_000,
      durable: true,
    }));

    await vi.advanceTimersByTimeAsync(30_000);

    expect(fire).not.toHaveBeenCalled();
    expect(requireState(state).schedules[0]).toEqual(expect.objectContaining({
      id: "cron-expiring",
      status: "cancelled",
      durable: true,
      expiresAt: START + 30_000,
    }));
    scheduler.dispose();
  });

  it("cancels persisted work for an ended session during start reconciliation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let state: ChatScheduledWorkState | null = storedState([wakeup()]);
    const transitions: string[] = [];
    const fire = createFireMock();
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => cloneState(state),
      saveState: (next) => {
        state = structuredClone(next);
      },
      isGlobalPaused: () => false,
      sessionState: () => "ended",
      fire,
      onTransition: (_schedule, status) => {
        transitions.push(status);
      },
    });

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fire).not.toHaveBeenCalled();
    expect(transitions).toEqual(["cancelled"]);
    expect(requireState(state).schedules[0]).toEqual(expect.objectContaining({
      id: "wake-1",
      status: "cancelled",
    }));
    scheduler.dispose();
  });

  it("pauses provider work when its owner is inactive", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let state: ChatScheduledWorkState | null = storedState([wakeup({
      durable: true,
      provider: "claude",
      providerScheduleId: "provider-wake-1",
    })]);
    const transitions: string[] = [];
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => cloneState(state),
      saveState: (next) => { state = structuredClone(next); },
      isGlobalPaused: () => false,
      sessionState: () => "ended",
      fire: createFireMock(),
      onTransition: (_schedule, status) => { transitions.push(status); },
    });

    await scheduler.start();

    expect(transitions).toEqual(["paused"]);
    expect(requireState(state).schedules[0]).toEqual(expect.objectContaining({
      status: "paused",
      pausedFlag: true,
      provider: "claude",
      providerScheduleId: "provider-wake-1",
    }));
    expect(requireState(state).schedules[0]?.terminalAt).toBeUndefined();
    scheduler.dispose();

    let newState: ChatScheduledWorkState | null = null;
    const endedScheduler = createChatScheduledWorkScheduler({
      loadState: () => null,
      saveState: (next) => { newState = structuredClone(next); },
      isGlobalPaused: () => false,
      sessionState: () => "ended",
      fire: createFireMock(),
    });
    const newSchedule = await endedScheduler.upsert(wakeup({
      durable: true,
      provider: "claude",
      providerScheduleId: "provider-wake-2",
    }));

    expect(newSchedule).toEqual(expect.objectContaining({ status: "paused", pausedFlag: true }));
    expect(requireState(newState).schedules[0]).toEqual(expect.objectContaining({
      status: "paused",
      pausedFlag: true,
    }));
    endedScheduler.dispose();
  });

  it("cancels work when its session becomes ended before processDue fires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let sessionState: "active" | "ended" = "active";
    let state: ChatScheduledWorkState | null = null;
    const transitions: string[] = [];
    const fire = createFireMock();
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => cloneState(state),
      saveState: (next) => {
        state = structuredClone(next);
      },
      isGlobalPaused: () => false,
      sessionState: () => sessionState,
      fire,
      onTransition: (_schedule, status) => {
        transitions.push(status);
      },
    });
    await scheduler.upsert(wakeup({ fireAt: START + 1_000 }));

    sessionState = "ended";
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fire).not.toHaveBeenCalled();
    expect(transitions).toEqual(["scheduled", "cancelled"]);
    expect(requireState(state).schedules[0]?.status).toBe("cancelled");
    scheduler.dispose();
  });

  it("does not let an ended session claim a native scheduled fire", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let sessionState: "active" | "ended" = "active";
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => null,
      saveState: () => undefined,
      isGlobalPaused: () => false,
      sessionState: () => sessionState,
      fire: createFireMock(),
    });
    await scheduler.upsert(wakeup({ fireAt: START, provider: "claude" }));

    sessionState = "ended";
    const claimed = scheduler.claimNativeFire("session-1", "native-turn-ended", "wake-1");

    expect(claimed).toBeNull();
    expect(scheduler.list("session-1")[0]).toEqual(expect.objectContaining({
      id: "wake-1",
      status: "scheduled",
    }));
    scheduler.dispose();
  });

  it("persists a new schedule as cancelled when its session is ended", async () => {
    let state: ChatScheduledWorkState | null = null;
    const transitions: string[] = [];
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => null,
      saveState: (next) => {
        state = structuredClone(next);
      },
      isGlobalPaused: () => false,
      sessionState: () => "ended",
      fire: createFireMock(),
      onTransition: (_schedule, status) => {
        transitions.push(status);
      },
    });

    const schedule = await scheduler.upsert(wakeup());

    expect(schedule.status).toBe("cancelled");
    expect(transitions).toEqual(["cancelled"]);
    expect(requireState(state).schedules[0]?.status).toBe("cancelled");
    scheduler.dispose();
  });

  it("retains an old schedule for seven days from its terminal transition", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let state: ChatScheduledWorkState | null = null;
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => null,
      saveState: (next) => { state = structuredClone(next); },
      isGlobalPaused: () => false,
      sessionState: () => "active",
      fire: createFireMock(),
    });
    await scheduler.upsert(wakeup({ createdAt: START - 8 * 24 * 60 * 60 * 1_000 }));

    await scheduler.cancel("wake-1");

    expect(requireState(state).schedules).toEqual([
      expect.objectContaining({ id: "wake-1", status: "cancelled", terminalAt: START }),
    ]);
    scheduler.dispose();
  });

  it("persists an arm and re-arms it in a fresh scheduler after restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let state: ChatScheduledWorkState | null = null;
    const saveState = vi.fn((next: ChatScheduledWorkState) => {
      state = structuredClone(next);
    });

    const first = createChatScheduledWorkScheduler({
      loadState: () => cloneState(state),
      saveState,
      isGlobalPaused: () => false,
      sessionState: () => "active",
      fire: createFireMock(),
    });
    await first.upsert(wakeup());
    expect(requireState(state).schedules).toEqual([expect.objectContaining({
      id: "wake-1",
      fireAt: START + 60_000,
      status: "scheduled",
    })]);
    first.dispose();

    const fire = createFireMock();
    const restarted = createChatScheduledWorkScheduler({
      loadState: () => cloneState(state),
      saveState,
      isGlobalPaused: () => false,
      sessionState: () => "active",
      fire,
    });
    await restarted.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire).toHaveBeenCalledWith(
      expect.objectContaining({ id: "wake-1", status: "fired" }),
      { late: false },
    );
    restarted.dispose();
  });

  it("late-fires an overdue one-shot once, then completes its persisted claim on restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let state: ChatScheduledWorkState | null = storedState([
      wakeup({ fireAt: START - 60_000 }),
    ]);
    const saveState = (next: ChatScheduledWorkState) => {
      state = structuredClone(next);
    };
    const fire = createFireMock();
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => cloneState(state),
      saveState,
      isGlobalPaused: () => false,
      sessionState: () => "active",
      fire,
    });
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(fire).toHaveBeenCalledOnce();
    expect(fire).toHaveBeenCalledWith(expect.objectContaining({ lateFlag: true }), { late: true });
    expect(requireState(state).schedules[0]?.status).toBe("fired");
    scheduler.dispose();

    const afterRestart = createFireMock();
    const transitions: string[] = [];
    const restarted = createChatScheduledWorkScheduler({
      loadState: () => cloneState(state),
      saveState,
      isGlobalPaused: () => false,
      sessionState: () => "active",
      fire: afterRestart,
      onTransition: (_schedule, status) => {
        transitions.push(status);
      },
    });
    await restarted.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(afterRestart).not.toHaveBeenCalled();
    expect(transitions).toEqual(["done"]);
    expect(requireState(state).schedules[0]).toEqual(expect.objectContaining({
      status: "done",
    }));
    restarted.dispose();
  });

  it.each([
    { name: "no wake message reached the chat", recorded: false, fires: 1, status: "fired" },
    { name: "the wake message is in the transcript", recorded: true, fires: 0, status: "done" },
    { name: "the transcript cannot be read", recorded: new Error("unreadable"), fires: 0, status: "done" },
    { name: "the user cancels during the read", recorded: false, cancelDuringRead: true, fires: 0, status: "cancelled" },
    { name: "the fire was only just claimed, by a brain that may still deliver it", recorded: false, firedAgoMs: 1_000, fires: 1, status: "fired", settleMs: 60_000 },
  ])("after a restart, a fired one-shot with no turn: $name", async ({ recorded, cancelDuringRead, firedAgoMs, fires, status, settleMs }) => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let state: ChatScheduledWorkState | null = storedState([
      { ...wakeup({ fireAt: START - 300_000 }), status: "fired", lastFiredAt: START - (firedAgoMs ?? 120_000) },
    ]);
    const fire = createFireMock();
    const reads: number[] = [];
    let scheduler: ReturnType<typeof createChatScheduledWorkScheduler> | null = null;
    scheduler = createChatScheduledWorkScheduler({
      loadState: () => cloneState(state),
      saveState: (next) => { state = structuredClone(next); },
      isGlobalPaused: () => false,
      sessionState: () => "active",
      fire,
      wakeMessageRecorded: async (schedule) => {
        reads.push(Date.now());
        if (cancelDuringRead) await scheduler!.cancel(schedule.id);
        if (recorded instanceof Error) throw recorded;
        return recorded;
      },
    });
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    if (settleMs) {
      expect(reads).toHaveLength(0);
      expect(fire).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(settleMs);
    }
    await vi.advanceTimersByTimeAsync(1_000);

    expect(reads).toHaveLength(1);
    expect(fire).toHaveBeenCalledTimes(fires);
    expect(requireState(state).schedules[0]?.status).toBe(status);
    scheduler.dispose();
  });

  it("recomputes and re-arms a persisted fired cron without re-firing it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let state: ChatScheduledWorkState | null = storedState([
      wakeup({
        id: "cron-1",
        kind: "cron",
        cron: "* * * * *",
        status: "fired",
        fireAt: START - 60_000,
        lastFiredAt: START - 30_000,
        activeTurnId: "stale-turn",
        durable: true,
      }),
    ]);
    const fire = createFireMock();
    const transitions: string[] = [];
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => cloneState(state),
      saveState: (next) => {
        state = structuredClone(next);
      },
      isGlobalPaused: () => false,
      sessionState: () => "active",
      fire,
      onTransition: (_schedule, status) => {
        transitions.push(status);
      },
    });

    await scheduler.start();

    expect(fire).not.toHaveBeenCalled();
    expect(transitions).toEqual(["scheduled"]);
    expect(requireState(state).schedules[0]).toEqual(expect.objectContaining({
      status: "scheduled",
      fireAt: START + 60_000,
    }));
    expect(requireState(state).schedules[0]?.activeTurnId).toBeUndefined();
    scheduler.dispose();
  });

  it("runs one catch-up for three missed cron occurrences, then resumes cadence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START + 2 * 60_000 + 30_000);
    let state: ChatScheduledWorkState | null = storedState([
      wakeup({
        id: "cron-1",
        kind: "cron",
        cron: "* * * * *",
        fireAt: START,
        durable: true,
      }),
    ]);
    const fire = createFireMock();
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => cloneState(state),
      saveState: (next) => {
        state = structuredClone(next);
      },
      isGlobalPaused: () => false,
      sessionState: () => "active",
      fire,
    });
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire.mock.calls[0]?.[1]).toEqual({ late: true });
    expect(requireState(state).schedules[0]).toEqual(expect.objectContaining({
      status: "scheduled",
      fireAt: START + 3 * 60_000,
      lastFiredAt: START + 2 * 60_000 + 30_000,
    }));

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fire).toHaveBeenCalledTimes(2);
    expect(fire.mock.calls[1]?.[1]).toEqual({ late: false });
    expect(requireState(state).schedules[0]?.fireAt).toBe(START + 4 * 60_000);
    scheduler.dispose();
  });

  it("blocks a session-paused fire and late-fires it once on unpause", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let state: ChatScheduledWorkState | null = null;
    const fire = createFireMock();
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => cloneState(state),
      saveState: (next) => {
        state = structuredClone(next);
      },
      isGlobalPaused: () => false,
      sessionState: () => "active",
      fire,
    });
    await scheduler.upsert(wakeup());
    await scheduler.setSessionPaused("session-1", true);
    expect(requireState(state).pausedSessionIds).toEqual(["session-1"]);
    expect(requireState(state).schedules[0]?.status).toBe("paused");

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(fire).not.toHaveBeenCalled();
    await scheduler.setSessionPaused("session-1", false);
    await vi.advanceTimersByTimeAsync(0);

    expect(fire).toHaveBeenCalledOnce();
    expect(fire.mock.calls[0]?.[1]).toEqual({ late: true });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fire).toHaveBeenCalledOnce();
    scheduler.dispose();
  });

  it("blocks a globally paused fire and late-fires it once after refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let globalPaused = true;
    let state: ChatScheduledWorkState | null = null;
    const fire = createFireMock();
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => cloneState(state),
      saveState: (next) => {
        state = structuredClone(next);
      },
      isGlobalPaused: () => globalPaused,
      sessionState: () => "active",
      fire,
    });
    await scheduler.upsert(wakeup());
    expect(scheduler.nextWakeAt("session-1")).toBeNull();
    expect(requireState(state).schedules[0]?.status).toBe("paused");

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(fire).not.toHaveBeenCalled();
    globalPaused = false;
    await scheduler.refreshGlobalPause();
    await vi.advanceTimersByTimeAsync(0);

    expect(fire).toHaveBeenCalledOnce();
    expect(fire.mock.calls[0]?.[1]).toEqual({ late: true });
    scheduler.dispose();
  });

  it("moves a fired one-shot to done when its unattended turn finishes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let state: ChatScheduledWorkState | null = storedState([
      wakeup({ fireAt: START }),
    ]);
    const transitions: string[] = [];
    let scheduler: ReturnType<typeof createChatScheduledWorkScheduler>;
    scheduler = createChatScheduledWorkScheduler({
      loadState: () => cloneState(state),
      saveState: (next) => {
        state = structuredClone(next);
      },
      isGlobalPaused: () => false,
      sessionState: () => "active",
      onTransition: (_schedule, status) => {
        transitions.push(status);
      },
      fire: async (schedule) => {
        await scheduler.recordTurnStarted(schedule.id, "turn-1");
      },
    });
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await scheduler.recordTurnFinished("turn-1", "CI passed");

    expect(transitions).toEqual(["fired", "done"]);
    expect(requireState(state).schedules[0]).toEqual(expect.objectContaining({
      status: "done",
      outcomeSummary: "CI passed",
    }));
    scheduler.dispose();
  });

  it("lets an SDK-native wake claim a due schedule before the ADE timer can duplicate it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let state: ChatScheduledWorkState | null = null;
    const fire = createFireMock();
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => cloneState(state),
      saveState: (next) => {
        state = structuredClone(next);
      },
      isGlobalPaused: () => false,
      sessionState: () => "active",
      fire,
    });
    await scheduler.upsert(wakeup({ fireAt: START + 500, provider: "claude" }));

    const claimed = scheduler.claimNativeFire("session-1", "native-turn-1", "wake-1");
    expect(claimed).toMatchObject({
      id: "wake-1",
      status: "fired",
      activeTurnId: "native-turn-1",
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fire).not.toHaveBeenCalled();
    expect(requireState(state).schedules[0]).toEqual(expect.objectContaining({
      status: "fired",
      activeTurnId: "native-turn-1",
    }));
    scheduler.dispose();
  });

  it("gives Claude native fire a grace window and cancels the ADE backstop after a native claim", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let state: ChatScheduledWorkState | null = null;
    const fire = createFireMock();
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => cloneState(state),
      saveState: (next) => { state = structuredClone(next); },
      isGlobalPaused: () => false,
      sessionState: () => "active",
      fire,
    });
    await scheduler.upsert(wakeup({
      fireAt: START,
      durable: true,
      provider: "claude",
      providerScheduleId: "native-grace-claim",
    }));

    await vi.advanceTimersByTimeAsync(5_000);
    expect(fire).not.toHaveBeenCalled();
    expect(scheduler.claimNativeFire("session-1", "native-turn-grace", "native-grace-claim")).toMatchObject({
      id: "wake-1",
      status: "fired",
      activeTurnId: "native-turn-grace",
    });
    await vi.advanceTimersByTimeAsync(90_000);

    expect(fire).not.toHaveBeenCalled();
    scheduler.dispose();
  });

  it("settles a one-shot Claude delivered without a claim as done and cancels the ADE backstop", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let state: ChatScheduledWorkState | null = null;
    const fire = createFireMock();
    const transitions: string[] = [];
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => cloneState(state),
      saveState: (next) => { state = structuredClone(next); },
      isGlobalPaused: () => false,
      sessionState: () => "active",
      fire,
      onTransition: (schedule, status) => { transitions.push(`${schedule.id}:${status}`); },
    });
    await scheduler.upsert(wakeup({ fireAt: START, durable: true, provider: "claude" }));
    await scheduler.upsert(wakeup({
      id: "cron-1",
      kind: "cron",
      cron: "*/5 * * * *",
      fireAt: START + 300_000,
      durable: true,
      provider: "claude",
    }));

    await vi.advanceTimersByTimeAsync(5_000);
    expect(await scheduler.markFired("wake-1")).toMatchObject({ status: "done", lastFiredAt: START });
    // Recurring work is never settled this way: its next occurrence stays armed.
    expect(await scheduler.markFired("cron-1")).toMatchObject({ status: "scheduled" });
    // A fire ADE claimed for a running turn waits for that turn, which
    // records its outcome, instead of settling here with no summary.
    await scheduler.upsert(wakeup({ id: "wake-claimed", fireAt: START, durable: true, provider: "claude", providerScheduleId: "claimed" }));
    expect(scheduler.claimNativeFire("session-1", "turn-claimed", "claimed")).toMatchObject({ status: "fired" });
    // The Stop hook's snapshot arrives after the claim has been persisted.
    await vi.advanceTimersByTimeAsync(0);
    expect(await scheduler.markFired("wake-claimed")).toMatchObject({ status: "fired", activeTurnId: "turn-claimed" });
    await scheduler.recordTurnFinished("turn-claimed", "Deploy still queued.");
    expect(requireState(state).schedules.find((schedule) => schedule.id === "wake-claimed"))
      .toMatchObject({ status: "done", outcomeSummary: "Deploy still queued." });
    await vi.advanceTimersByTimeAsync(120_000);

    expect(fire).not.toHaveBeenCalled();
    expect(requireState(state).schedules.find((schedule) => schedule.id === "wake-1")?.status).toBe("done");
    // The transcript learns the wake-up fired (`Woke at …`), not that it was cancelled.
    expect(transitions).toContain("wake-1:done");
    expect(transitions).not.toContain("wake-1:cancelled");
    scheduler.dispose();
  });

  it("does not let a native Claude turn claim provider-neutral scheduled work", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const fire = createFireMock();
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => null,
      saveState: () => undefined,
      isGlobalPaused: () => false,
      sessionState: () => "active",
      fire,
    });
    await scheduler.upsert(wakeup({
      id: "action:session-1:schedule-1",
      fireAt: START,
      durable: true,
    }));

    expect(scheduler.claimNativeFire("session-1", "unrelated-native-turn")).toBeNull();
    await vi.advanceTimersByTimeAsync(0);

    expect(fire).toHaveBeenCalledWith(
      expect.objectContaining({ id: "action:session-1:schedule-1" }),
      { late: false },
    );
    expect(fire.mock.calls[0]?.[0]).not.toHaveProperty("provider");
    scheduler.dispose();
  });

  it("uses the Claude grace deadline for normal and genuinely late backstop fires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const onTimeFire = createFireMock();
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => null,
      saveState: () => undefined,
      isGlobalPaused: () => false,
      sessionState: () => "active",
      fire: onTimeFire,
    });
    await scheduler.upsert(wakeup({
      fireAt: START,
      durable: true,
      provider: "claude",
      providerScheduleId: "native-grace-backstop",
    }));

    await vi.advanceTimersByTimeAsync(89_999);
    expect(onTimeFire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onTimeFire).toHaveBeenCalledWith(
      expect.objectContaining({ id: "wake-1", lateFlag: false }),
      { late: false },
    );
    scheduler.dispose();

    vi.setSystemTime(START + 91_001);
    const lateFire = createFireMock();
    const lateScheduler = createChatScheduledWorkScheduler({
      loadState: () => storedState([wakeup({
        id: "wake-late",
        fireAt: START,
        durable: true,
        provider: "claude",
        providerScheduleId: "native-grace-late",
      })]),
      saveState: () => undefined,
      isGlobalPaused: () => false,
      sessionState: () => "active",
      fire: lateFire,
    });
    await lateScheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(lateFire).toHaveBeenCalledWith(
      expect.objectContaining({ id: "wake-late", lateFlag: true }),
      { late: true },
    );
    lateScheduler.dispose();
  });

  it("defers a busy Claude cron without advancing it and late-fires exactly once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let state: ChatScheduledWorkState | null = null;
    let delivered = 0;
    let deferChecks = 0;
    const shouldDefer = vi.fn(() => {
      deferChecks += 1;
      return deferChecks <= 2;
    });
    const fire = vi.fn(async (
      _schedule: ChatScheduledWorkRecord,
      _context: { late: boolean },
    ) => { delivered += 1; });
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => null,
      saveState: (next) => { state = structuredClone(next); },
      isGlobalPaused: () => false,
      sessionState: () => "active",
      shouldDefer,
      fire,
    });
    await scheduler.upsert(wakeup({
      id: "cron-deferred",
      kind: "cron",
      cron: "* * * * *",
      fireAt: START,
      lastFiredAt: START - 60_000,
      lateFlag: true,
      durable: true,
      provider: "claude",
      providerScheduleId: "cron-deferred",
    }));

    await vi.advanceTimersByTimeAsync(90_000);
    expect(requireState(state).schedules[0]).toEqual(expect.objectContaining({
      status: "scheduled",
      fireAt: START,
      lastFiredAt: START - 60_000,
      lateFlag: true,
    }));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(requireState(state).schedules[0]).toEqual(expect.objectContaining({
      status: "scheduled",
      fireAt: START,
      lastFiredAt: START - 60_000,
      lateFlag: true,
    }));
    await vi.advanceTimersByTimeAsync(20_000);

    expect(shouldDefer).toHaveBeenCalledTimes(3);
    expect(fire).toHaveBeenCalledOnce();
    expect(fire.mock.calls[0]?.[1]).toEqual({ late: true });
    expect(delivered).toBe(1);
    expect(requireState(state).schedules[0]).toEqual(expect.objectContaining({
      status: "scheduled",
      fireAt: START + 180_000,
      lastFiredAt: START + 130_000,
      lateFlag: true,
    }));
    scheduler.dispose();
  });

  it("lets a native claim win during the busy-defer retry window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let state: ChatScheduledWorkState | null = null;
    const fire = vi.fn(async () => undefined);
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => null,
      saveState: (next) => { state = structuredClone(next); },
      isGlobalPaused: () => false,
      sessionState: () => "active",
      shouldDefer: () => true,
      fire,
    });
    await scheduler.upsert(wakeup({
      fireAt: START,
      durable: true,
      provider: "claude",
      providerScheduleId: "native-defer-claim",
    }));

    await vi.advanceTimersByTimeAsync(90_000);
    expect(requireState(state).schedules[0]).toEqual(expect.objectContaining({
      status: "scheduled",
      fireAt: START,
    }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(scheduler.claimNativeFire("session-1", "native-turn-after-defer", "native-defer-claim")).toMatchObject({
      id: "wake-1",
      status: "fired",
      activeTurnId: "native-turn-after-defer",
    });
    await vi.advanceTimersByTimeAsync(20_000);

    expect(fire).not.toHaveBeenCalled();
    expect(requireState(state).schedules[0]).toEqual(expect.objectContaining({
      status: "fired",
      activeTurnId: "native-turn-after-defer",
    }));
    scheduler.dispose();
  });

  it("expires a repeatedly deferred Claude wake without delivering it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let state: ChatScheduledWorkState | null = null;
    const fire = vi.fn(async () => undefined);
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => null,
      saveState: (next) => { state = structuredClone(next); },
      isGlobalPaused: () => false,
      sessionState: () => "active",
      shouldDefer: () => true,
      fire,
    });
    await scheduler.upsert(wakeup({
      fireAt: START,
      expiresAt: START + 105_000,
      durable: true,
      provider: "claude",
      providerScheduleId: "native-defer-expiry",
    }));

    await vi.advanceTimersByTimeAsync(90_000);
    expect(requireState(state).schedules[0]?.status).toBe("scheduled");
    await vi.advanceTimersByTimeAsync(15_000);

    expect(fire).not.toHaveBeenCalled();
    expect(requireState(state).schedules[0]).toEqual(expect.objectContaining({
      status: "cancelled",
      terminalAt: START + 105_000,
    }));
    scheduler.dispose();
  });

  it("fires non-Claude schedules at their exact fire time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const fire = createFireMock();
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => null,
      saveState: () => undefined,
      isGlobalPaused: () => false,
      sessionState: () => "active",
      fire,
    });
    await scheduler.upsert(wakeup({ fireAt: START + 1_000 }));

    await vi.advanceTimersByTimeAsync(999);
    expect(fire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fire).toHaveBeenCalledWith(
      expect.objectContaining({ id: "wake-1", lateFlag: false }),
      { late: false },
    );
    scheduler.dispose();
  });

  it.each([
    // The winner's one-shot stays `fired` until its turn finishes.
    { kind: "wakeup" as const, cron: undefined, settled: { status: "fired", fireAt: START + 1_000 } },
    { kind: "cron" as const, cron: "*/20 * * * *", settled: { status: "scheduled", fireAt: START + 20 * 60_000 } },
  ])("delivers a due $kind once when several brains share the same rows", async ({ kind, cron, settled }) => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    // One persisted state and one claim store, as in the project database.
    let state: ChatScheduledWorkState | null = storedState([wakeup({ kind, cron, fireAt: START + 1_000 })]);
    const claims = sharedClaims();
    const brains = [createFireMock(), createFireMock(), createFireMock()].map((fire) => ({
      fire,
      scheduler: createChatScheduledWorkScheduler({
        loadState: () => cloneState(state),
        saveState: (next) => { state = structuredClone(next); },
        isGlobalPaused: () => false,
        sessionState: () => "active",
        ...claims,
        fire,
      }),
    }));
    for (const { scheduler } of brains) await scheduler.start();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(brains.reduce((total, { fire }) => total + fire.mock.calls.length, 0)).toBe(1);

    // The others follow the winner's persisted outcome and never re-fire it.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(brains.reduce((total, { fire }) => total + fire.mock.calls.length, 0)).toBe(1);
    for (const { scheduler } of brains.filter(({ fire }) => fire.mock.calls.length === 0)) {
      expect(scheduler.list()[0]).toEqual(expect.objectContaining({ ...settled, lastFiredAt: START + 1_000 }));
    }
    brains.forEach(({ scheduler }) => scheduler.dispose());
  });

  it("gives an occurrence back when recording its fire fails, so a later attempt delivers it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let failFiredWrite = true;
    const fire = createFireMock();
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => null,
      saveState: (next) => {
        if (failFiredWrite && next.schedules.some((item) => item.status === "fired")) {
          failFiredWrite = false;
          throw new Error("disk full");
        }
      },
      isGlobalPaused: () => false,
      sessionState: () => "active",
      ...sharedClaims(),
      fire,
    });
    await scheduler.upsert(wakeup({ fireAt: START }));

    await vi.advanceTimersByTimeAsync(0);
    expect(fire).not.toHaveBeenCalled();
    expect(scheduler.list()[0]).toEqual(expect.objectContaining({ status: "scheduled", fireAt: START }));

    await vi.advanceTimersByTimeAsync(20_000);
    expect(fire).toHaveBeenCalledTimes(1);
    expect(scheduler.list()[0]).toEqual(expect.objectContaining({ status: "fired", lastFiredAt: START + 20_000 }));
    scheduler.dispose();
  });

  it("completes a one-shot immediately when its delivery owns no tracked turn", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let state: ChatScheduledWorkState | null = null;
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => null,
      saveState: (next) => { state = structuredClone(next); },
      isGlobalPaused: () => false,
      sessionState: () => "active",
      fire: async () => ({ complete: true }),
    });
    await scheduler.upsert(wakeup({ fireAt: START }));

    await vi.advanceTimersByTimeAsync(0);

    expect(requireState(state).schedules[0]).toEqual(expect.objectContaining({
      status: "done",
      lastFiredAt: START,
      terminalAt: START,
    }));
    scheduler.dispose();
  });

  it("restores an occurrence when delivery proves it never started", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let state: ChatScheduledWorkState | null = null;
    const fire = vi.fn()
      .mockResolvedValueOnce({ retry: true })
      .mockResolvedValueOnce({ complete: true });
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => null,
      saveState: (next) => { state = structuredClone(next); },
      isGlobalPaused: () => false,
      sessionState: () => "active",
      // The retry gives the occurrence's claim back, so it can be claimed again.
      ...sharedClaims(),
      fire,
    });
    await scheduler.upsert(wakeup({
      fireAt: START,
      lastFiredAt: START - 60_000,
      lateFlag: true,
    }));

    await vi.advanceTimersByTimeAsync(0);
    expect(requireState(state).schedules[0]).toEqual(expect.objectContaining({
      status: "scheduled",
      fireAt: START,
      lastFiredAt: START - 60_000,
      lateFlag: true,
    }));

    await vi.advanceTimersByTimeAsync(20_000);
    expect(fire).toHaveBeenCalledTimes(2);
    expect(requireState(state).schedules[0]).toEqual(expect.objectContaining({
      status: "done",
      lastFiredAt: START + 20_000,
    }));
    scheduler.dispose();
  });

  it("does not deliver a one-shot that is cancelled while it is being marked fired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let state: ChatScheduledWorkState | null = null;
    const fire = createFireMock();
    const schedulerRef: { current: ReturnType<typeof createChatScheduledWorkScheduler> | null } = { current: null };
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => null,
      saveState: (next) => { state = structuredClone(next); },
      isGlobalPaused: () => false,
      sessionState: () => "active",
      fire,
      onTransition: async (schedule, status) => {
        // A user message (or a superseding schedule) can cancel the row in the
        // window between the fired transition and dispatch.
        if (status === "fired") await schedulerRef.current?.cancel(schedule.id);
      },
    });
    schedulerRef.current = scheduler;
    await scheduler.upsert(wakeup({ fireAt: START }));

    await vi.advanceTimersByTimeAsync(0);

    expect(fire).not.toHaveBeenCalled();
    expect(requireState(state).schedules[0]?.status).toBe("cancelled");
    scheduler.dispose();
  });

  it("claims only the provider schedule named by an explicit native signal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => null,
      saveState: () => undefined,
      isGlobalPaused: () => false,
      sessionState: () => "active",
      fire: createFireMock(),
    });
    await scheduler.upsert(wakeup({
      id: "cron-a",
      kind: "cron",
      cron: "* * * * *",
      fireAt: START,
      provider: "claude",
      providerScheduleId: "provider-a",
    }));
    await scheduler.upsert(wakeup({
      id: "cron-b",
      kind: "cron",
      cron: "* * * * *",
      fireAt: START,
      provider: "claude",
      providerScheduleId: "provider-b",
    }));

    expect(scheduler.claimNativeFire("session-1", "unrelated-turn", "missing-provider")).toBeNull();
    expect(scheduler.claimNativeFire("session-1", "native-turn-b", "provider-b")).toMatchObject({
      id: "cron-b",
      activeTurnId: "native-turn-b",
    });
    expect(scheduler.list().find((item) => item.id === "cron-a")?.status).toBe("scheduled");
    scheduler.dispose();
  });

  it("limits an ambiguous native cron signal to CronCreate-owned schedules", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => null,
      saveState: () => undefined,
      isGlobalPaused: () => false,
      sessionState: () => "active",
      fire: createFireMock(),
    });
    await scheduler.upsert(wakeup({
      id: "native-wakeup",
      kind: "wakeup",
      fireAt: START - 500,
      provider: "claude",
    }));
    await scheduler.upsert(wakeup({
      id: "native-cron",
      kind: "cron",
      cron: "* * * * *",
      fireAt: START,
      provider: "claude",
      providerScheduleId: "provider-cron",
    }));

    expect(scheduler.claimNativeFire("session-1", "ambiguous-cron-turn")).toMatchObject({
      id: "native-cron",
      activeTurnId: "ambiguous-cron-turn",
    });
    expect(scheduler.list().find((item) => item.id === "native-wakeup")?.status).toBe("scheduled");
    expect(scheduler.claimNativeFire("session-1", "explicit-wakeup-turn", "native-wakeup")).toMatchObject({
      id: "native-wakeup",
      activeTurnId: "explicit-wakeup-turn",
    });
    scheduler.dispose();
  });

  it("clears a native cron claim's active turn before re-arming", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let state: ChatScheduledWorkState | null = null;
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => cloneState(state),
      saveState: (next) => {
        state = structuredClone(next);
      },
      isGlobalPaused: () => false,
      sessionState: () => "active",
      fire: createFireMock(),
    });
    await scheduler.upsert(wakeup({
      id: "cron-1",
      kind: "cron",
      cron: "* * * * *",
      fireAt: START + 500,
      provider: "claude",
      providerScheduleId: "provider-cron-1",
    }));

    expect(scheduler.claimNativeFire("session-1", "native-turn-1")).toMatchObject({
      id: "cron-1",
      status: "fired",
      activeTurnId: "native-turn-1",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(scheduler.list()[0]).toEqual(expect.objectContaining({
      status: "scheduled",
      fireAt: START + 60_000,
    }));
    expect(scheduler.list()[0]?.activeTurnId).toBeUndefined();
    expect(requireState(state).schedules[0]?.activeTurnId).toBeUndefined();
    scheduler.dispose();
  });
});

describe("a cron's check", () => {
  function checkedCron(overrides: Partial<ChatScheduledWorkRecord> = {}): ChatScheduledWorkRecord {
    return wakeup({
      id: "cron-check",
      kind: "cron",
      cron: "* * * * *",
      fireAt: START + 60_000,
      durable: true,
      check: "gh pr checks 12",
      checkHash: "hash-a",
      ...overrides,
    });
  }

  it("wakes only on new output, and once per failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let state: ChatScheduledWorkState | null = storedState([checkedCron()]);
    const runs: ChatScheduledWorkCheckRun[] = [
      { ok: true, outputHash: "hash-a", detail: "pending" },
      { ok: true, outputHash: "hash-b", detail: "pass" },
      { ok: false, detail: "Exited with code 1.", exitCode: 1 },
      { ok: false, detail: "Exited with code 1.", exitCode: 1 },
      // Back to the output from before the failure: not news.
      { ok: true, outputHash: "hash-b", detail: "pass" },
      { ok: true, outputHash: "hash-c", detail: "merged" },
    ];
    const runCheck = vi.fn(async () => runs.shift()!);
    const fire = createFireMock();
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => cloneState(state),
      saveState: (next) => { state = structuredClone(next); },
      isGlobalPaused: () => false,
      sessionState: () => "active",
      ...sharedClaims(),
      runCheck,
      fire,
    });
    await scheduler.start();

    const woke: Array<string | undefined> = [];
    for (let minute = 1; minute <= 6; minute += 1) {
      const before = fire.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      const context = fire.mock.calls[before]?.[1] as { check?: { because: string } } | undefined;
      woke.push(fire.mock.calls.length > before ? context?.check?.because ?? "no-check" : undefined);
      // Every occurrence moves on, quiet or not.
      expect(requireState(state).schedules[0]?.fireAt).toBe(START + (minute + 1) * 60_000);
    }

    expect(runCheck).toHaveBeenCalledTimes(6);
    expect(woke).toEqual([undefined, "changed", "failed", undefined, undefined, "changed"]);
    expect(requireState(state).schedules[0]).toEqual(expect.objectContaining({
      checkHash: "hash-c",
      lastCheckedAt: START + 6 * 60_000,
      lastFiredAt: START + 6 * 60_000,
    }));
    expect(requireState(state).schedules[0]?.checkFailing).toBeUndefined();
    scheduler.dispose();
  });

  it.each([
    ["a pass is the baseline", { ok: true, outputHash: "hash-a" }, { wake: false, checkHash: "hash-a", checkFailing: false }],
    ["a failure still wakes once", { ok: false }, { wake: true, because: "failed", checkFailing: true }],
  ] as const)("on a row never checked (a restored routine), %s", (_name, run, expected) => {
    expect(decideScheduledWorkCheck({}, run)).toEqual(expected);
  });

  it("keeps a wake that was never delivered as news for the retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let state: ChatScheduledWorkState | null = storedState([checkedCron()]);
    const fire = vi.fn(async (
      _schedule: ChatScheduledWorkRecord,
      _context: { late: boolean; check?: { because: string } },
    ): Promise<void | { retry: true }> => undefined);
    fire.mockResolvedValueOnce({ retry: true });
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => cloneState(state),
      saveState: (next) => { state = structuredClone(next); },
      isGlobalPaused: () => false,
      sessionState: () => "active",
      ...sharedClaims(),
      runCheck: async () => ({ ok: true, outputHash: "hash-b", detail: "pass" }),
      fire,
    });
    await scheduler.start();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(requireState(state).schedules[0]).toEqual(expect.objectContaining({ status: "scheduled", checkHash: "hash-a" }));
    await vi.advanceTimersByTimeAsync(20_000);

    expect(fire.mock.calls.map(([, context]) => context.check?.because)).toEqual(["changed", "changed"]);
    expect(requireState(state).schedules[0]?.checkHash).toBe("hash-b");
    scheduler.dispose();
  });

  it("keeps a quiet routine going when saving its quiet check fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let state: ChatScheduledWorkState | null = storedState([checkedCron()]);
    let failNextSave = false;
    const claims = sharedClaims();
    const releaseFire = vi.fn(claims.releaseFire);
    const runCheck = vi.fn(async (): Promise<ChatScheduledWorkCheckRun> => ({ ok: true, outputHash: "hash-a", detail: "pending" }));
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => cloneState(state),
      saveState: (next) => {
        if (failNextSave) {
          failNextSave = false;
          throw new Error("disk full");
        }
        state = structuredClone(next);
      },
      isGlobalPaused: () => false,
      sessionState: () => "active",
      claimFire: claims.claimFire,
      releaseFire,
      runCheck,
      fire: createFireMock(),
    });
    await scheduler.start();

    failNextSave = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runCheck).toHaveBeenCalledTimes(1);
    expect(releaseFire).toHaveBeenCalledTimes(1);
    // The retry runs the check again and saves the spent occurrence.
    await vi.advanceTimersByTimeAsync(20_000);

    expect(runCheck).toHaveBeenCalledTimes(2);
    expect(requireState(state).schedules[0]).toEqual(expect.objectContaining({
      status: "scheduled",
      fireAt: START + 2 * 60_000,
      lastCheckedAt: START + 80_000,
    }));
    scheduler.dispose();
  });

  it.each([
    ["the first returns", false, 20_000],
    // A delivery that never returns lets go of the chat after its ceiling.
    ["the first never returns", true, 60_000],
  ] as const)("delivers two wakes due on the same tick one after the other when %s", async (_name, hangs, secondAfterMs) => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let state: ChatScheduledWorkState | null = storedState([
      checkedCron({ id: "cron-a" }),
      checkedCron({ id: "cron-b", check: "cat status.txt" }),
    ]);
    // A send takes a moment to return; once it does, the chat reports its turn
    // (shouldDefer) until the turn ends.
    let turnEndsAt = 0;
    const fire = createFireMock();
    fire.mockImplementationOnce(() => new Promise<undefined>((resolve) => {
      if (hangs) return;
      setTimeout(() => {
        turnEndsAt = Date.now() + 10_000;
        resolve(undefined);
      }, 1_000);
    }));
    const onDeliveryHung = vi.fn();
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => cloneState(state),
      saveState: (next) => { state = structuredClone(next); },
      isGlobalPaused: () => false,
      sessionState: () => "active",
      ...sharedClaims(),
      runCheck: async (schedule) => ({ ok: true, outputHash: `new-${schedule.id}`, detail: "news" }),
      shouldDefer: () => Date.now() < turnEndsAt,
      fire,
      onDeliveryHung,
    });
    await scheduler.start();

    await vi.advanceTimersByTimeAsync(60_000);
    // The chat takes one wake at a time; the other keeps its news for the retry.
    expect(fire).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(secondAfterMs - 20_000);
    expect(fire).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(fire.mock.calls.map(([schedule]) => schedule.id).sort()).toEqual(["cron-a", "cron-b"]);
    expect(fire.mock.calls.every(([, context]) => (context as { check?: unknown }).check)).toBe(true);
    expect(onDeliveryHung).toHaveBeenCalledTimes(hangs ? 1 : 0);
    scheduler.dispose();
  });

  it("keeps a wake's news when its row is replaced before the send", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let state: ChatScheduledWorkState | null = storedState([checkedCron()]);
    const fire = createFireMock();
    let replaced = false;
    // The routine is rewritten (no status, no hash: it inherits them) while
    // its fired transition is being reported.
    const { status: _status, checkHash: _hash, ...rewrite } = checkedCron({ prompt: "Rewritten prompt" });
    const scheduler: ReturnType<typeof createChatScheduledWorkScheduler> = createChatScheduledWorkScheduler({
      loadState: () => cloneState(state),
      saveState: (next) => { state = structuredClone(next); },
      isGlobalPaused: () => false,
      sessionState: () => "active",
      ...sharedClaims(),
      runCheck: async () => ({ ok: true, outputHash: "hash-new", detail: "news" }),
      onTransition: async (_schedule, status) => {
        if (status !== "fired" || replaced) return;
        replaced = true;
        await scheduler.upsert(rewrite);
      },
      fire,
    });
    await scheduler.start();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fire).not.toHaveBeenCalled();
    expect(requireState(state).schedules[0]).toEqual(expect.objectContaining({
      status: "scheduled",
      checkHash: "hash-a",
      prompt: "Rewritten prompt",
    }));
    expect(requireState(state).schedules[0]?.lastFiredAt).toBeUndefined();

    // The same output is still news to the rewritten routine.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ prompt: "Rewritten prompt" }));
    scheduler.dispose();
  });

  it("keeps a cron running when it is rewritten as scheduled during its delivery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const cron = wakeup({ id: "cron-plain", kind: "cron", cron: "* * * * *", durable: true });
    let state: ChatScheduledWorkState | null = storedState([cron]);
    let scheduler: ReturnType<typeof createChatScheduledWorkScheduler> | null = null;
    const fire = createFireMock();
    fire.mockImplementationOnce(async () => {
      await scheduler?.upsert({ ...cron, status: "scheduled", fireAt: START + 120_000, prompt: "Rewritten prompt" });
      return undefined;
    });
    scheduler = createChatScheduledWorkScheduler({
      loadState: () => cloneState(state),
      saveState: (next) => { state = structuredClone(next); },
      isGlobalPaused: () => false,
      sessionState: () => "active",
      ...sharedClaims(),
      fire,
    });
    await scheduler.start();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fire).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(fire).toHaveBeenCalledTimes(2);
    expect(fire.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ prompt: "Rewritten prompt" }));
    scheduler.dispose();
  });

  it("refuses Run now on a chat that is taking a timer wake", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let state: ChatScheduledWorkState | null = storedState([
      checkedCron({ id: "cron-a" }),
      checkedCron({ id: "cron-b", fireAt: START + 3_600_000 }),
    ]);
    let finishSend: () => void = () => undefined;
    const fire = createFireMock();
    fire.mockImplementationOnce(() => new Promise<undefined>((resolve) => { finishSend = () => resolve(undefined); }));
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => cloneState(state),
      saveState: (next) => { state = structuredClone(next); },
      isGlobalPaused: () => false,
      sessionState: () => "active",
      ...sharedClaims(),
      runCheck: async () => ({ ok: true, outputHash: "hash-new", detail: "news" }),
      fire,
    });
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fire).toHaveBeenCalledTimes(1);

    await expect(scheduler.runNow("cron-b")).resolves.toEqual(expect.objectContaining({ fired: false }));
    expect(fire).toHaveBeenCalledTimes(1);
    finishSend();
    await vi.advanceTimersByTimeAsync(0);
    await expect(scheduler.runNow("cron-b")).resolves.toEqual({ fired: true });
    expect(fire).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it("adopts the check verdict of the brain that owned the occurrence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let state: ChatScheduledWorkState | null = storedState([checkedCron()]);
    const claims = sharedClaims();
    const options = {
      loadState: () => cloneState(state),
      saveState: (next: ChatScheduledWorkState) => { state = structuredClone(next); },
      isGlobalPaused: () => false,
      sessionState: () => "active" as const,
      claimFire: claims.claimFire,
      releaseFire: claims.releaseFire,
    };
    const ownerFire = createFireMock();
    const owner = createChatScheduledWorkScheduler({
      ...options,
      runCheck: async () => ({ ok: true, outputHash: "hash-b", detail: "pass" }),
      fire: ownerFire,
    });
    const followerFire = createFireMock();
    const followerCheck = vi.fn(async (): Promise<ChatScheduledWorkCheckRun> => ({ ok: true, outputHash: "hash-b", detail: "pass" }));
    const follower = createChatScheduledWorkScheduler({ ...options, runCheck: followerCheck, fire: followerFire });
    await owner.start();
    await follower.start();

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ownerFire).toHaveBeenCalledTimes(1);
    owner.dispose();
    // The follower now owns later occurrences; the same output is old news.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(followerCheck).toHaveBeenCalled();
    expect(followerFire).not.toHaveBeenCalled();
    follower.dispose();
  });

  it.each([
    ["a cancel", {}],
    ["the routine's expiry", { expiresAt: START + 70_000 }],
    ["the chat ending", {}],
  ] as const)("lets %s that lands during the check win", async (name, overrides) => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let state: ChatScheduledWorkState | null = storedState([checkedCron(overrides)]);
    let finishCheck: (run: ChatScheduledWorkCheckRun) => void = () => undefined;
    const claims = sharedClaims();
    const claimFire = vi.fn(claims.claimFire);
    const releaseFire = vi.fn(claims.releaseFire);
    const fire = createFireMock();
    let chatActive = true;
    const scheduler = createChatScheduledWorkScheduler({
      loadState: () => cloneState(state),
      saveState: (next) => { state = structuredClone(next); },
      isGlobalPaused: () => false,
      sessionState: () => (chatActive ? "active" : "ended"),
      claimFire,
      releaseFire,
      runCheck: () => new Promise((resolve) => { finishCheck = resolve; }),
      fire,
    });
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);

    if (name === "a cancel") await scheduler.cancel("cron-check");
    else if (name === "the chat ending") chatActive = false;
    else await vi.advanceTimersByTimeAsync(15_000);
    finishCheck({ ok: true, outputHash: "hash-new", detail: "news" });
    await vi.advanceTimersByTimeAsync(0);

    expect(fire).not.toHaveBeenCalled();
    // The check runs before the claim, so there is nothing to release.
    expect(releaseFire).not.toHaveBeenCalled();
    expect(claimFire).not.toHaveBeenCalled();
    expect(requireState(state).schedules[0]).toEqual(expect.objectContaining({ status: "cancelled", checkHash: "hash-a" }));
    scheduler.dispose();
  });
});
