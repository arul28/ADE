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
