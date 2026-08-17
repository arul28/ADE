import { describe, expect, it, vi } from "vitest";
import type { MachinePowerEvent, MachinePowerSource } from "../../../../../ade-cli/src/services/power/machinePowerMonitor";
import type { MachineSleepState } from "../../../shared/types/power";
import type { AgentChatEvent } from "../../../shared/types/chat";
import {
  createHostSleepChipTracker,
  type HostSleepChipSession,
} from "./hostSleepChipTracker";

type TestSession = HostSleepChipSession & { turnId: string | null };

/** A power source the test drives by hand, standing in for Electron's. */
function fakePowerSource(initialSleepState: MachineSleepState = "awake") {
  const listeners = new Set<(event: MachinePowerEvent) => void>();
  let sleepState = initialSleepState;
  // A real monitor stamps this from the same clock the tracker reads, so the
  // fake does too — the tracker age-bounds `asleep` against it, and a stamp
  // frozen at 0 would read as stale in every test that uses the real clock.
  let sleepStateAt = Date.now();
  const source: MachinePowerSource = {
    getPower: () => null,
    getSleepState: () => sleepState,
    getSleepStateAt: () => sleepStateAt,
    getSuspendGapMs: () => null,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    source,
    listenerCount: (): number => listeners.size,
    suspend(at = 1_000, stateAt = Date.now()): void {
      sleepState = "asleep";
      sleepStateAt = stateAt;
      for (const listener of [...listeners]) listener({ kind: "suspend", at, announced: true });
    },
    /** An announced wake: the host had a precise pre-suspend hook. */
    resume(at = 241_000, gapMs: number | null = 240_000): void {
      sleepState = "awake";
      sleepStateAt = at;
      for (const listener of [...listeners]) {
        listener({ kind: "resume", at, gapMs, announced: true });
      }
    },
    /** An INFERRED wake: a tick arrived 60s+ late and nobody announced anything. */
    inferResume(at = 90_000, gapMs = 75_000): void {
      for (const listener of [...listeners]) {
        listener({ kind: "resume", at, gapMs, announced: false });
      }
    },
  };
}

function trackerHarness(options: {
  powerSource?: MachinePowerSource | null;
  now?: () => number;
} = {}) {
  const running: TestSession = {
    closed: false,
    deleted: false,
    session: { id: "session-1", status: "active" },
    turnId: "turn-1",
  };
  const emitted: Array<{ sessionId: string; event: AgentChatEvent }> = [];
  const logger = { info: vi.fn(), debug: vi.fn() };
  const tracker = createHostSleepChipTracker<TestSession>({
    powerSource: options.powerSource ?? null,
    sessions: () => [running],
    sessionById: (id) => (id === running.session.id ? running : undefined),
    activeTurnIdFor: (session) => session.turnId,
    emit: (session, event) => emitted.push({ sessionId: session.session.id, event }),
    logger,
    ...(options.now ? { now: options.now } : {}),
  });
  const notices = (status: string) => emitted
    .map(({ event }) => event)
    .filter((event) => event.type === "system_notice" && event.status === status);
  return { tracker, running, emitted, logger, notices };
}

describe("createHostSleepChipTracker", () => {
  it("emits one chip that resolves in place, and holds the retry the sleep caused", () => {
    const power = fakePowerSource();
    const h = trackerHarness({ powerSource: power.source });

    power.suspend();
    expect(h.notices("host_asleep")).toHaveLength(1);
    expect(h.tracker.holdRetry(h.running, "unknown", null)).toBe(true);
    // The held retry must not add a second artifact.
    expect(h.notices("host_asleep")).toHaveLength(1);

    power.resume();
    const asleep = h.notices("host_asleep");
    const awake = h.notices("host_awake");
    expect(awake).toHaveLength(1);
    expect((awake[0] as { message: string }).message).toBe("Resumed · paused 4m");
    // Same identity is what folds the two halves onto one transcript row.
    expect((awake[0] as { detail: { hostSleep: { sleepId: string } } }).detail.hostSleep.sleepId)
      .toBe((asleep[0] as { detail: { hostSleep: { sleepId: string } } }).detail.hostSleep.sleepId);
  });

  it("leaves a failure the API itself named completely alone", () => {
    const power = fakePowerSource();
    const h = trackerHarness({ powerSource: power.source });

    power.suspend();
    expect(h.tracker.holdRetry(h.running, "overloaded", 529)).toBe(false);
  });

  // The gap detector fires on any tick 60s+ late, and an event-loop stall that
  // large does happen under load. Narrating it as a sleep is honest — nothing
  // ran either way — but letting it excuse provider retries would silence every
  // genuine `api_retry` for 30 seconds during a real network outage.
  it("narrates an inferred gap but never lets it silence a genuine retry", () => {
    const power = fakePowerSource();
    const now = vi.fn(() => 91_000);
    const h = trackerHarness({ powerSource: power.source, now });

    power.inferResume(90_000, 75_000);

    expect(h.notices("host_awake")).toHaveLength(1);
    expect(h.tracker.holdRetry(h.running, "transient_error", null)).toBe(false);
    expect(h.logger.info).not.toHaveBeenCalled();
  });

  it("still holds the retry inside the grace window after an ANNOUNCED wake", () => {
    const power = fakePowerSource();
    const h = trackerHarness({ powerSource: power.source, now: () => 251_000 });

    power.suspend();
    power.resume(241_000, 240_000);

    expect(h.tracker.holdRetry(h.running, "transient_error", null)).toBe(true);
  });

  // The tracker used to mirror the sleep state in its own variable, which was
  // born "awake" — so a chat service constructed while the lid was already shut
  // blamed the API for a retry the sleep caused.
  it("reads the sleep state from the source, so a tracker built mid-sleep is not fooled", () => {
    const power = fakePowerSource("asleep");
    const h = trackerHarness({ powerSource: power.source });

    expect(h.tracker.holdRetry(h.running, "unknown", null)).toBe(true);
  });

  it("stops holding retries once a stuck `asleep` has gone stale", () => {
    // The stuck state is reachable: a nap shorter than the gap detector's 60s
    // threshold clears only via the announced resume, and that hop rides a
    // socket which is mid-reconnect the instant the machine wakes. Until this
    // bound existed, one lost hop meant every `econnreset` for the rest of the
    // process rendered as "Paused — computer asleep" with no retry ever
    // reported — a genuine network outage, silently misattributed.
    const power = fakePowerSource();
    const clock = { value: 1_000_000 };
    const h = trackerHarness({ powerSource: power.source, now: () => clock.value });

    power.suspend(1_000, clock.value);
    expect(h.tracker.holdRetry(h.running, "econnreset", null)).toBe(true);

    // …the resume never lands, and the machine keeps running.
    clock.value += 11 * 60_000;
    expect(h.tracker.holdRetry(h.running, "econnreset", null)).toBe(false);
  });

  it("never resolves a chip for a turn that started after the wake", () => {
    // The suspend fan-out only reaches sessions with a turn in flight, so an
    // idle chat gets no paused half. After the wake `resolved` is true and the
    // sleepId is retained for the grace window, so a brand-new turn's first
    // `econnreset` used to emit the RESUMED half on its own — "Resumed · paused
    // 4h" about a turn that never paused, in a transcript five seconds old.
    const power = fakePowerSource();
    const h = trackerHarness({ powerSource: power.source, now: () => 251_000 });
    h.running.session.status = "idle";
    h.running.turnId = null;

    power.suspend();
    power.resume(241_000, 240_000);
    // …and NOW the user sends a message, whose first API call fails.
    h.running.session.status = "active";
    h.running.turnId = "turn-after-wake";

    expect(h.tracker.holdRetry(h.running, "econnreset", null)).toBe(true);
    expect(h.notices("host_awake")).toHaveLength(0);
    expect(h.emitted).toHaveLength(0);
  });

  it("still emits the paused half for a turn that starts while the machine is down", () => {
    // The mirror of the case above: `resolved` is false, so the sleep really is
    // what the user is waiting on and the chip is the honest thing to say.
    const power = fakePowerSource();
    const h = trackerHarness({ powerSource: power.source });
    h.running.session.status = "idle";
    h.running.turnId = null;

    power.suspend();
    h.running.session.status = "active";
    h.running.turnId = "turn-during-sleep";

    expect(h.tracker.holdRetry(h.running, "econnreset", null)).toBe(true);
    expect(h.notices("host_asleep")).toHaveLength(1);
  });

  it("does nothing at all without a power source", () => {
    const h = trackerHarness({ powerSource: null });

    expect(h.tracker.holdRetry(h.running, "unknown", null)).toBe(false);
    expect(h.emitted).toHaveLength(0);
  });

  it("leaves an idle chat alone when the machine sleeps", () => {
    const power = fakePowerSource();
    const h = trackerHarness({ powerSource: power.source });
    h.running.session.status = "idle";
    h.running.turnId = null;

    power.suspend();
    power.resume();

    expect(h.emitted).toHaveLength(0);
  });

  it("drops its subscription on dispose", () => {
    const power = fakePowerSource();
    const h = trackerHarness({ powerSource: power.source });

    expect(power.listenerCount()).toBe(1);
    h.tracker.dispose();
    expect(power.listenerCount()).toBe(0);
  });
});
