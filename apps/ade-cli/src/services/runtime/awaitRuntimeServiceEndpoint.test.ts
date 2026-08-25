import { describe, expect, it, vi } from "vitest";
import { awaitRuntimeServiceEndpoint } from "./awaitRuntimeServiceEndpoint";

const instantSleep = () => Promise.resolve();

/** A probe that fails `failures` times and answers on the next call. */
function probeAfter(failures: number): { probe: () => Promise<boolean>; calls: () => number } {
  let calls = 0;
  return {
    probe: () => {
      calls += 1;
      return Promise.resolve(calls > failures);
    },
    calls: () => calls,
  };
}

describe("awaitRuntimeServiceEndpoint", () => {
  it("never installs anything when the brain already answers", async () => {
    const installService = vi.fn();
    const onStarting = vi.fn();

    const result = await awaitRuntimeServiceEndpoint({
      probe: () => Promise.resolve(true),
      installService,
      onStarting,
      budgetMs: 10_000,
      sleep: instantSleep,
    });

    expect(result).toEqual({ ready: true, starting: false, detail: "background service is running" });
    expect(installService).not.toHaveBeenCalled();
    expect(onStarting).not.toHaveBeenCalled();
  });

  it("keeps dialing after the install until the brain answers", async () => {
    const { probe, calls } = probeAfter(4);
    const onStarting = vi.fn();

    const result = await awaitRuntimeServiceEndpoint({
      probe,
      installService: () => Promise.resolve({ ok: true, message: "installed" }),
      onStarting,
      budgetMs: 10_000,
      sleep: instantSleep,
      pollMs: 1,
    });

    expect(result.ready).toBe(true);
    expect(calls()).toBe(5);
    // Announced once, as soon as the service is supervised.
    expect(onStarting).toHaveBeenCalledTimes(1);
  });

  // The whole point of the helper: a supervised brain that outlasts the budget
  // is `starting`, not a failure. Reporting it as one is what turned a slow
  // machine into "couldn't be set up".
  it("reports a brain that outlasts the budget as starting, not failed", async () => {
    let clock = 0;
    const result = await awaitRuntimeServiceEndpoint({
      probe: () => Promise.resolve(false),
      installService: () => Promise.resolve({ ok: true, message: "installed" }),
      onStarting: () => {},
      budgetMs: 100,
      sleep: () => {
        clock += 50;
        return Promise.resolve();
      },
      now: () => clock,
      pollMs: 50,
    });

    expect(result).toEqual({
      ready: false,
      starting: true,
      detail: "background service is still starting",
    });
  });

  it("waits on an install that reported `starting` rather than treating it as failed", async () => {
    const { probe } = probeAfter(2);
    const onStarting = vi.fn();

    const result = await awaitRuntimeServiceEndpoint({
      probe,
      installService: () => Promise.resolve({
        ok: false,
        starting: true,
        message: "the background service is still starting",
      }),
      onStarting,
      budgetMs: 10_000,
      sleep: instantSleep,
      pollMs: 1,
    });

    expect(result.ready).toBe(true);
    expect(onStarting).toHaveBeenCalledTimes(1);
  });

  it("returns the installer's own message when the install genuinely failed", async () => {
    const onStarting = vi.fn();

    const result = await awaitRuntimeServiceEndpoint({
      probe: () => Promise.resolve(false),
      installService: () => Promise.resolve({ ok: false, message: "launchctl load failed." }),
      onStarting,
      budgetMs: 10_000,
      sleep: instantSleep,
    });

    expect(result).toEqual({ ready: false, starting: false, detail: "launchctl load failed." });
    expect(onStarting).not.toHaveBeenCalled();
  });

  it("still gives the endpoint one chance with a zero budget", async () => {
    const { probe, calls } = probeAfter(1);

    const result = await awaitRuntimeServiceEndpoint({
      probe,
      installService: () => Promise.resolve({ ok: true, message: "installed" }),
      onStarting: () => {},
      budgetMs: 0,
      sleep: instantSleep,
    });

    // One probe before the install, one after; the second answers.
    expect(result.ready).toBe(true);
    expect(calls()).toBe(2);
  });
});
