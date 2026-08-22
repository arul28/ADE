import { describe, expect, it, vi } from "vitest";
import { createSingleFlightBrainRestart } from "./singleFlightBrainRestart";

describe("createSingleFlightBrainRestart", () => {
  it("runs one restart when the monitor and the memory guard both ask at once", async () => {
    let release: () => void = () => {};
    const restart = vi.fn(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const onCoalesced = vi.fn();
    const single = createSingleFlightBrainRestart(restart, { onCoalesced });

    const first = single("brain.freshness_restart_failed");
    const second = single("brain.memory_restart_command_failed");

    expect(restart).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledWith("brain.freshness_restart_failed");
    expect(onCoalesced).toHaveBeenCalledWith("brain.memory_restart_command_failed");

    release();
    await Promise.all([first, second]);
  });

  it("reports the failure to every caller and lets the next caller retry", async () => {
    const restart = vi.fn()
      .mockRejectedValueOnce(new Error("service restart failed"))
      .mockResolvedValueOnce(undefined);
    const single = createSingleFlightBrainRestart(restart);

    const first = single("brain.freshness_restart_failed");
    const second = single("brain.memory_restart_command_failed");

    await expect(first).rejects.toThrow("service restart failed");
    await expect(second).rejects.toThrow("service restart failed");
    expect(restart).toHaveBeenCalledTimes(1);

    await expect(single("brain.freshness_restart_failed")).resolves.toBeUndefined();
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it("reports a synchronous throw as a rejection rather than throwing at the call site", async () => {
    const single = createSingleFlightBrainRestart(() => {
      throw new Error("spawn failed");
    });

    await expect(single("brain.memory_restart_command_failed")).rejects.toThrow("spawn failed");
  });
});
