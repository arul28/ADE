import { describe, expect, it, vi } from "vitest";
import {
  BRAIN_MEMORY_RESTART_REASON,
  createBrainMemoryRestartGuard,
} from "./brainMemoryRestart";

const SAMPLE = {
  rssBytes: 2_000_000_000,
  thresholdBytes: 1_610_612_736,
  sustainedMs: 900_000,
  heapUsedBytes: 120_000_000,
};

/** A clock the guard's wait loop drives forward one poll at a time. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let clock = 1_000_000;
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
}

describe("createBrainMemoryRestartGuard", () => {
  it("restarts an idle, unattached brain and says why in one line", async () => {
    const restart = vi.fn();
    const warn = vi.fn();
    const guard = createBrainMemoryRestartGuard({
      isIdle: () => true,
      isQuiet: () => true,
      restart,
      logger: { warn },
      ...fakeClock(),
    });

    await guard.handle(SAMPLE);

    expect(restart).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("brain.memory_restart", {
      ...SAMPLE,
      attached: false,
      reason: BRAIN_MEMORY_RESTART_REASON,
    });
    // The copy has to survive a reader who arrives at it during an outage.
    expect(BRAIN_MEMORY_RESTART_REASON).toContain("not a crash");
  });

  it("never interrupts work, however much memory is held", async () => {
    const restart = vi.fn();
    const warn = vi.fn();
    const guard = createBrainMemoryRestartGuard({
      isIdle: () => false,
      restart,
      logger: { warn },
      maxQuietWaitMs: 60_000,
      pollMs: 10_000,
      ...fakeClock(),
    });

    await guard.handle({ ...SAMPLE, rssBytes: 8_000_000_000 });

    expect(restart).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe("brain.memory_restart_deferred");
  });

  it("waits for a busy brain to go quiet, then restarts it", async () => {
    const restart = vi.fn();
    let idleAfter = 3;
    const guard = createBrainMemoryRestartGuard({
      isIdle: () => (idleAfter-- <= 0),
      restart,
      logger: { warn: vi.fn() },
      maxQuietWaitMs: 600_000,
      pollMs: 30_000,
      ...fakeClock(),
    });

    await guard.handle(SAMPLE);

    expect(restart).toHaveBeenCalledTimes(1);
  });

  // A desktop app holds a connection open all day and reconnects after a
  // restart without the user noticing. Treating that as "busy" would make the
  // mitigation dead for exactly the people who run into the leak.
  it("restarts an attached but idle brain once the wait is spent", async () => {
    const restart = vi.fn();
    const warn = vi.fn();
    const guard = createBrainMemoryRestartGuard({
      isIdle: () => true,
      isQuiet: () => false,
      restart,
      logger: { warn },
      maxQuietWaitMs: 60_000,
      pollMs: 20_000,
      ...fakeClock(),
    });

    await guard.handle(SAMPLE);

    expect(restart).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "brain.memory_restart",
      expect.objectContaining({ attached: true }),
    );
  });

  it("restarts once, however many samples report the same pressure", async () => {
    const restart = vi.fn();
    const guard = createBrainMemoryRestartGuard({
      isIdle: () => true,
      restart,
      logger: { warn: vi.fn() },
      ...fakeClock(),
    });

    await guard.handle(SAMPLE);
    await guard.handle(SAMPLE);
    await guard.handle(SAMPLE);

    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("reports a failed handover and stays available for the next run", async () => {
    const warn = vi.fn();
    const restart = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("service restart failed");
      })
      .mockImplementationOnce(() => {});
    const guard = createBrainMemoryRestartGuard({
      isIdle: () => true,
      restart,
      logger: { warn },
      ...fakeClock(),
    });

    await guard.handle(SAMPLE);
    expect(warn).toHaveBeenCalledWith(
      "brain.memory_restart_failed",
      expect.objectContaining({ error: "service restart failed" }),
    );

    await guard.handle(SAMPLE);
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it("does nothing once the brain is shutting down", async () => {
    const restart = vi.fn();
    const guard = createBrainMemoryRestartGuard({
      isIdle: () => true,
      restart,
      logger: { warn: vi.fn() },
      ...fakeClock(),
    });

    guard.stop();
    await guard.handle(SAMPLE);

    expect(restart).not.toHaveBeenCalled();
  });
});
