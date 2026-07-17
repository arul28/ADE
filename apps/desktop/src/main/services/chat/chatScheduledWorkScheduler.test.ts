import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ChatScheduledWorkRecord,
  type ChatScheduledWorkState,
  createChatScheduledWorkScheduler,
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

  it("quarantines restored and newly persisted provider work when its owner is no longer active", async () => {
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
    await scheduler.upsert(wakeup({ fireAt: START }));

    sessionState = "ended";
    const claimed = scheduler.claimNativeFire("session-1", "native-turn-ended");

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
    await scheduler.upsert(wakeup({ fireAt: START + 500 }));

    const claimed = scheduler.claimNativeFire("session-1", "native-turn-1");
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
    expect(scheduler.claimNativeFire("session-1", "native-turn-grace")).toMatchObject({
      id: "wake-1",
      status: "fired",
      activeTurnId: "native-turn-grace",
    });
    await vi.advanceTimersByTimeAsync(90_000);

    expect(fire).not.toHaveBeenCalled();
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
