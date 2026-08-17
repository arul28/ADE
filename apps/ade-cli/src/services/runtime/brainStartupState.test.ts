import { describe, expect, it, vi } from "vitest";
import {
  describeWindowsStartupProbe,
  readBrainStartupState,
  type BrainStartupProbe,
} from "./brainStartupState";
import type {
  WindowsServicePidRecord,
  WindowsSupervisorState,
} from "../../serviceManager/windowsSupervisor";

function deps(overrides: {
  installed?: boolean | null;
  running?: boolean | null;
  pid?: number | null;
  ageMs?: number | null;
  crashLooping?: boolean;
} = {}) {
  return {
    platform: "darwin" as NodeJS.Platform,
    getServiceStatus: async () => ({
      installed: overrides.installed === undefined ? true : overrides.installed,
      running: overrides.running === undefined ? true : overrides.running,
    }),
    getServiceMainPid: async () => (overrides.pid === undefined ? 4242 : overrides.pid),
    readBrainAgeMs: async () => (overrides.ageMs === undefined ? 5_000 : overrides.ageMs),
    hasRecentCrashLoop: async () => overrides.crashLooping === true,
    youngBrainMs: 120_000,
  };
}

function windowsProbe(overrides: Partial<BrainStartupProbe> = {}) {
  return {
    platform: "win32" as NodeJS.Platform,
    readWindowsStartupProbe: async (): Promise<BrainStartupProbe> => ({
      installed: true,
      running: false,
      supervised: true,
      ageMs: 5_000,
      ...overrides,
    }),
    hasRecentCrashLoop: async () => false,
    youngBrainMs: 120_000,
  };
}

const NOW = 1_800_000_000_000;

function runningSupervisor(
  record: Partial<WindowsServicePidRecord> = {},
): WindowsSupervisorState {
  return {
    state: "running",
    running: true,
    pid: 4242,
    record: {
      supervisorPid: 4242,
      runtimePid: 4343,
      runtimeStartedAtMs: NOW,
      restartCount: 0,
      lastExitCode: null,
      lastExitAt: null,
      nextRestartAt: null,
      lastLaunchError: null,
      sessionBound: false,
      ...record,
    },
    error: null,
    diagnostic: null,
  };
}

describe("readBrainStartupState", () => {
  it("calls a registered service whose brain is young 'starting'", async () => {
    await expect(readBrainStartupState(deps())).resolves.toMatchObject({
      starting: true,
      ageMs: 5_000,
    });
  });

  it("stops calling it starting once the brain outlives the young window", async () => {
    await expect(readBrainStartupState(deps({ ageMs: 130_000 }))).resolves.toMatchObject({
      starting: false,
    });
  });

  it("is not starting when the service is absent or stopped", async () => {
    await expect(readBrainStartupState(deps({ installed: false }))).resolves.toMatchObject({
      starting: false,
    });
    await expect(readBrainStartupState(deps({ running: false }))).resolves.toMatchObject({
      starting: false,
    });
  });

  it("fails closed when the age cannot be read or a probe throws", async () => {
    await expect(readBrainStartupState(deps({ ageMs: null }))).resolves.toMatchObject({
      starting: false,
    });
    await expect(readBrainStartupState({
      platform: "darwin",
      getServiceStatus: async () => {
        throw new Error("systemctl missing");
      },
    })).resolves.toMatchObject({ starting: false });
  });

  // A crash-looping brain is respawned every few seconds, so it is ALWAYS young:
  // without this veto `ade doctor` would report "starting, nothing to repair"
  // forever on a permanently broken machine.
  it("refuses to call a crash-looping brain starting even while it is young", async () => {
    await expect(
      readBrainStartupState(deps({ crashLooping: true })),
    ).resolves.toMatchObject({ starting: false, ageMs: 5_000 });
  });

  it("does not spend the crash-loop probe on a brain that is not young anyway", async () => {
    const hasRecentCrashLoop = vi.fn(async () => false);
    await readBrainStartupState({ ...deps({ ageMs: 130_000 }), hasRecentCrashLoop });
    expect(hasRecentCrashLoop).not.toHaveBeenCalled();
  });

  describe("windows", () => {
    it("calls a young single-start supervised brain starting", async () => {
      await expect(readBrainStartupState(windowsProbe())).resolves.toMatchObject({
        starting: true,
        ageMs: 5_000,
        serviceInstalled: true,
      });
    });

    it("is not starting when no supervisor of ours is running", async () => {
      await expect(
        readBrainStartupState(windowsProbe({ supervised: false, ageMs: null, installed: true })),
      ).resolves.toMatchObject({ starting: false });
    });

    it("reads youth from the supervisor record, one start only", () => {
      // Mirrors the installer's own young-brain predicate: a first start whose
      // runtime pid is alive is young; anything the supervisor has already
      // restarted is a crash loop wearing a fresh timestamp.
      const young = describeWindowsStartupProbe({
        supervisor: runningSupervisor({ runtimeStartedAtMs: NOW - 5_000 }),
        isAlive: () => true,
        nowMs: NOW,
      });
      expect(young).toMatchObject({ supervised: true, ageMs: 5_000 });

      const restarted = describeWindowsStartupProbe({
        supervisor: runningSupervisor({ restartCount: 2, runtimeStartedAtMs: NOW - 5_000 }),
        isAlive: () => true,
        nowMs: NOW,
      });
      expect(restarted).toMatchObject({ supervised: true, ageMs: null });

      const deadRuntime = describeWindowsStartupProbe({
        supervisor: runningSupervisor({ runtimeStartedAtMs: NOW - 5_000 }),
        isAlive: () => false,
        nowMs: NOW,
      });
      expect(deadRuntime).toMatchObject({ supervised: true, ageMs: null });
    });

    it("is not supervised when the recorded supervisor is not verifiably ours", () => {
      expect(describeWindowsStartupProbe({
        supervisor: {
          state: "stopped",
          running: false,
          pid: null,
          record: null,
          error: null,
          diagnostic: "no record",
        },
        isAlive: () => true,
        // No pid record leaves "installed" unknown, not false: this probe never
        // reads the HKCU Run entry, which can be registered on its own.
      })).toMatchObject({ supervised: false, installed: null, ageMs: null });
    });

    it("never asks the status command whether the brain answered", async () => {
      const getServiceStatus = vi.fn(async () => ({ installed: true, running: false }));
      await expect(
        readBrainStartupState({ ...windowsProbe(), getServiceStatus }),
      ).resolves.toMatchObject({ starting: true });
      expect(getServiceStatus).not.toHaveBeenCalled();
    });
  });
});
