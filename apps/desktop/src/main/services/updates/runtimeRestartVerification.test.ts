import { describe, expect, it, vi } from "vitest";
import type { MachineRuntimeIdentity } from "../localRuntime/localRuntimeConnectionPool";
import {
  runVerifiedRuntimeRestart,
  verifyRuntimeIdentity,
} from "./runtimeRestartVerification";

function identity(overrides: Partial<MachineRuntimeIdentity> = {}): MachineRuntimeIdentity {
  return {
    ok: true,
    version: "1.2.63",
    buildHash: "hash-new",
    pid: 100,
    expectedBuildHash: "hash-new",
    compatibleNewer: false,
    detail: "Background service is running 1.2.63.",
    ...overrides,
  };
}

describe("verifyRuntimeIdentity", () => {
  it("accepts a runtime whose version and build match", () => {
    expect(verifyRuntimeIdentity({ identity: identity(), expectedVersion: "1.2.63" }))
      .toEqual({ matches: true, detail: "Background service is running 1.2.63." });
  });

  it("rejects a runtime still on the pre-update version", () => {
    const verdict = verifyRuntimeIdentity({
      identity: identity({ version: "1.2.62", buildHash: "hash-old" }),
      expectedVersion: "1.2.63",
    });
    expect(verdict.matches).toBe(false);
    expect(verdict).toMatchObject({ reason: "version" });
  });

  it("rejects a matching version running a different build", () => {
    const verdict = verifyRuntimeIdentity({
      identity: identity({ buildHash: "hash-old" }),
      expectedVersion: "1.2.63",
    });
    expect(verdict).toMatchObject({ matches: false, reason: "build" });
  });

  it("rejects an answering runtime while the pre-update process is still alive", () => {
    const verdict = verifyRuntimeIdentity({
      identity: identity({ pid: 999 }),
      expectedVersion: "1.2.63",
      staleRuntime: { pid: 62456, version: "1.2.62" },
    });
    expect(verdict).toMatchObject({ matches: false, reason: "stale_runtime" });
    expect(verdict.detail).toContain("62456");
  });

  it("keeps a newer protocol-compatible brain", () => {
    const verdict = verifyRuntimeIdentity({
      identity: identity({ version: "1.3.0", buildHash: "hash-newer", compatibleNewer: true }),
      expectedVersion: "1.2.63",
    });
    expect(verdict.matches).toBe(true);
  });

  it("reports an endpoint that does not answer", () => {
    expect(verifyRuntimeIdentity({ identity: null, expectedVersion: "1.2.63" }))
      .toMatchObject({ matches: false, reason: "unreachable" });
  });
});

describe("runVerifiedRuntimeRestart", () => {
  it("skips the restart when the runtime already matches", async () => {
    const restartService = vi.fn(async () => {});
    const outcome = await runVerifiedRuntimeRestart({
      expectedVersion: "1.2.63",
      probeIdentity: async () => identity(),
      restartService,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain("Restart not needed");
    expect(restartService).not.toHaveBeenCalled();
  });

  it("restarts and re-verifies when a stale runtime answered", async () => {
    const probes = [
      identity({ version: "1.2.62", buildHash: "hash-old", pid: 62456 }),
      identity({ pid: 70000 }),
    ];
    const restartService = vi.fn(async () => {});
    let stale: { pid: number; version: string | null } | null = { pid: 62456, version: "1.2.62" };
    const outcome = await runVerifiedRuntimeRestart({
      expectedVersion: "1.2.63",
      probeIdentity: async () => probes.shift() ?? identity(),
      restartService: async () => {
        stale = null;
        await restartService();
      },
      readStaleRuntime: () => stale,
    });
    expect(restartService).toHaveBeenCalledTimes(1);
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain("Restarted and verified");
  });

  it("restarts when the socket answers correctly but the old brain is still alive", async () => {
    // The reported machine: a replacement brain bound the socket and answered
    // 1.2.63 while the pre-update process kept running and kept the sync lease.
    const restartService = vi.fn(async () => {});
    const outcome = await runVerifiedRuntimeRestart({
      expectedVersion: "1.2.63",
      probeIdentity: async () => identity({ pid: 70000 }),
      restartService,
      readStaleRuntime: () => ({ pid: 62456, version: "1.2.62" }),
      maxRestarts: 2,
    });
    expect(restartService).toHaveBeenCalledTimes(2);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("62456");
    expect(outcome.detail).toContain("Still wrong after 2 restarts");
  });

  it("reports failure truthfully when the wrong runtime survives every restart", async () => {
    const restartService = vi.fn(async () => {});
    const outcome = await runVerifiedRuntimeRestart({
      expectedVersion: "1.2.63",
      probeIdentity: async () => identity({ version: "1.2.62", buildHash: "hash-old" }),
      restartService,
      maxRestarts: 2,
    });
    expect(restartService).toHaveBeenCalledTimes(2);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("running 1.2.62");
  });

  it("reports a restart that threw", async () => {
    const outcome = await runVerifiedRuntimeRestart({
      expectedVersion: "1.2.63",
      probeIdentity: async () => identity({ version: "1.2.62", buildHash: "hash-old" }),
      restartService: async () => {
        throw new Error("launchctl kickstart failed");
      },
      maxRestarts: 1,
    });
    expect(outcome).toEqual({
      ok: false,
      detail: "The background service did not restart: launchctl kickstart failed",
    });
  });

  it("treats a probe that throws as an unreachable runtime", async () => {
    const restartService = vi.fn(async () => {});
    const outcome = await runVerifiedRuntimeRestart({
      expectedVersion: "1.2.63",
      probeIdentity: async () => {
        throw new Error("socket gone");
      },
      restartService,
      maxRestarts: 1,
    });
    expect(restartService).toHaveBeenCalledTimes(1);
    expect(outcome.ok).toBe(false);
  });
});
