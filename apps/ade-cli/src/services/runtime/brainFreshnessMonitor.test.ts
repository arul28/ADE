import { describe, expect, it, vi } from "vitest";
import { createBrainFreshnessMonitor } from "./brainFreshnessMonitor";

describe("brain freshness monitor", () => {
  it("does not hash or restart while the entrypoint stat is unchanged", async () => {
    const stat = vi.fn(async () => ({ mtimeMs: 10, size: 20 }));
    const computeHash = vi.fn(async () => "disk-hash");
    const restart = vi.fn();
    const monitor = createBrainFreshnessMonitor({
      filePath: "/tmp/cli.cjs",
      runningHash: "running-hash",
      isIdle: () => true,
      restart,
      logger: { warn: vi.fn() },
      stat,
      computeHash,
    });

    await monitor.probeNow();
    await monitor.probeNow();

    expect(stat).toHaveBeenCalledTimes(2);
    expect(computeHash).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it("waits for idle and restarts after a changed entrypoint hashes differently", async () => {
    const stats = [
      { mtimeMs: 10, size: 20 },
      { mtimeMs: 11, size: 21 },
    ];
    const stat = vi.fn(async () => stats.shift() ?? { mtimeMs: 11, size: 21 });
    const computeHash = vi.fn(async () => "disk-hash");
    const restart = vi.fn();
    const warn = vi.fn();
    let idle = false;
    const sleep = vi.fn(async () => {
      idle = true;
    });
    const monitor = createBrainFreshnessMonitor({
      filePath: "/tmp/cli.cjs",
      runningHash: "running-hash",
      isIdle: () => idle,
      restart,
      logger: { warn },
      stat,
      computeHash,
      sleep,
      now: (() => {
        let value = 0;
        return () => value += 10;
      })(),
      idlePollMs: 10,
      maxIdleWaitMs: 100,
    });

    await monitor.probeNow();
    await monitor.probeNow();

    expect(computeHash).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("brain.freshness_mismatch", {
      runningHash: "running-hash",
      diskHash: "disk-hash",
    });
    expect(warn).not.toHaveBeenCalledWith(
      "brain.freshness_restart_forced",
      expect.anything(),
    );
  });

  it("retries a changed entrypoint after a transient restart failure", async () => {
    const stat = vi.fn()
      .mockResolvedValueOnce({ mtimeMs: 10, size: 20 })
      .mockResolvedValue({ mtimeMs: 11, size: 21 });
    const restart = vi.fn()
      .mockRejectedValueOnce(new Error("launchctl failed"))
      .mockResolvedValueOnce(undefined);
    const monitor = createBrainFreshnessMonitor({
      filePath: "/tmp/cli.cjs",
      runningHash: "running-hash",
      isIdle: () => true,
      restart,
      logger: { warn: vi.fn() },
      stat,
      computeHash: async () => "disk-hash",
      setInterval: vi.fn(() => ({ unref: vi.fn() })) as never,
      clearInterval: vi.fn(),
    });

    await monitor.probeNow();
    await monitor.probeNow();
    await monitor.probeNow();

    expect(restart).toHaveBeenCalledTimes(2);
  });
});
