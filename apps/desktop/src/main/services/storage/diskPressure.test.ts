import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyDiskPressure,
  createDiskPressureMonitor,
  DEFAULT_DISK_PRESSURE_THRESHOLDS,
  type DiskPressureState,
} from "./diskPressure";

const GiB = 1024 ** 3;
function statfsSequence(freeGiB: number[]) {
  let index = 0;
  return vi.fn(() => {
    const freeBytes = BigInt(Math.round(freeGiB[Math.min(index++, freeGiB.length - 1)]! * GiB));
    return {
      bavail: freeBytes,
      blocks: BigInt(100 * GiB),
      bsize: 1n,
    };
  }) as any;
}

describe("disk pressure classification", () => {
  it.each([
    [1 * GiB, 0.5, "exhausted"],
    [1 * GiB + 1, 0.5, "critical"],
    [4 * GiB, 0.5, "critical"],
    [20 * GiB, 0.02, "critical"],
    [4 * GiB + 1, 0.5, "warning"],
    [12 * GiB, 0.5, "warning"],
    [20 * GiB, 0.05, "warning"],
    [12 * GiB + 1, 0.050001, "normal"],
  ] satisfies Array<[number, number, DiskPressureState]>) (
    "classifies %s free bytes at fraction %s as %s",
    (freeBytes, freeFraction, expected) => {
      expect(classifyDiskPressure(
        { freeBytes, freeFraction },
        DEFAULT_DISK_PRESSURE_THRESHOLDS,
      )).toBe(expected);
    },
  );
});

describe("disk pressure monitor", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("rises immediately and requires two lower-severity samples to fall", () => {
    let now = 0;
    const monitor = createDiskPressureMonitor({
      roots: ["/one"],
      statfs: statfsSequence([20, 0.5, 20, 20]),
      now: () => now,
    });

    expect(monitor.getSnapshot({ maxAgeMs: 0 }).state).toBe("normal");
    now += 1;
    expect(monitor.getSnapshot({ maxAgeMs: 0 }).state).toBe("exhausted");
    now += 1;
    expect(monitor.getSnapshot({ maxAgeMs: 0 }).state).toBe("exhausted");
    now += 1;
    expect(monitor.getSnapshot({ maxAgeMs: 0 }).state).toBe("normal");
  });

  it.each([
    ["normal", [true, true, true, true]],
    ["warning", [true, true, true, true]],
    ["critical", [true, true, false, false]],
    ["exhausted", [false, false, false, false]],
  ] satisfies Array<[DiskPressureState, boolean[]]>) (
    "applies the operation matrix in %s",
    (state, expected) => {
      const freeByState: Record<DiskPressureState, number> = {
        normal: 20,
        warning: 8,
        critical: 3,
        exhausted: 0.5,
      };
      const monitor = createDiskPressureMonitor({
        roots: ["/matrix"],
        statfs: statfsSequence([freeByState[state]]),
      });
      const kinds = ["chat_turn", "cli_launch", "high_write_job", "compression"] as const;
      expect(kinds.map((kind) => monitor.canPerform(kind).allowed)).toEqual(expected);
    },
  );

  it("fails open when every root measurement fails and logs each root once", () => {
    const warn = vi.fn();
    const statfs = vi.fn(() => { throw new Error("unsupported filesystem"); }) as any;
    const monitor = createDiskPressureMonitor({
      roots: ["/unknown-a", "/unknown-b", "/unknown-a"],
      statfs,
      logger: { warn },
    });

    expect(monitor.getSnapshot({ maxAgeMs: 0 })).toMatchObject({ state: "normal", perRoot: [] });
    expect(monitor.canPerform("chat_turn")).toEqual({ allowed: true, state: "normal" });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("fails open immediately when measurements become unavailable", () => {
    let call = 0;
    const statfs = vi.fn(() => {
      call += 1;
      if (call > 1) throw new Error("measurement unavailable");
      return { bavail: BigInt(GiB / 2), blocks: BigInt(100 * GiB), bsize: 1n };
    }) as any;
    const monitor = createDiskPressureMonitor({ roots: ["/becomes-unknown"], statfs, logger: { warn: vi.fn() } });

    expect(monitor.getSnapshot({ maxAgeMs: 0 }).state).toBe("exhausted");
    expect(monitor.getSnapshot({ maxAgeMs: 0 }).state).toBe("normal");
    expect(monitor.canPerform("chat_turn")).toEqual({ allowed: true, state: "normal" });
  });

  it("runs its unrefed timer only with subscribers and notifies only on transitions", async () => {
    vi.useFakeTimers();
    const statfs = statfsSequence([20, 8, 8, 0.5, 0.5]);
    const monitor = createDiskPressureMonitor({
      roots: ["/timer"],
      statfs,
      sampleIntervalMs: 1_000,
    });
    expect(statfs).not.toHaveBeenCalled();

    const listener = vi.fn();
    const unsubscribe = monitor.subscribe(listener);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(statfs).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ state: "warning" }));

    await vi.advanceTimersByTimeAsync(1_000);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ state: "exhausted" }));

    unsubscribe();
    const callsAfterUnsubscribe = statfs.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(statfs).toHaveBeenCalledTimes(callsAfterUnsubscribe);
  });
});
