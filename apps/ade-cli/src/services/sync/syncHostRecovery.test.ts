import { describe, expect, it, beforeEach } from "vitest";
import {
  classifySyncHostOwnerKind,
  diagnoseSyncHostReadiness,
  hostUnavailableErrorPayload,
  redactSyncHostReadinessSnapshot,
  recoverSyncHostConnection,
  resetSyncHostRecoveryForTests,
} from "./syncHostRecovery";
import type { SyncHostSingletonConflict, SyncHostSingletonOwner } from "./syncHostSingleton";

function owner(overrides: Partial<SyncHostSingletonOwner> = {}): SyncHostSingletonOwner {
  return {
    id: "owner-1",
    pid: 19621,
    port: 8787,
    appName: "ADE",
    packageChannel: null,
    adeHome: "/tmp/ade-home",
    serviceName: null,
    socketPath: "/tmp/ade-remote-sim/sock/ade.sock",
    projectRoot: "/tmp/worktrees/improving-browser",
    commandLine: "node apps/ade-cli/dist/cli.cjs serve --socket /tmp/ade-remote-sim/sock/ade.sock",
    processStartedAt: "2026-09-08T19:00:00.000Z",
    quitCommand: "kill 19621",
    createdAt: "2026-09-08T19:00:00.000Z",
    updatedAt: "2026-09-08T19:00:00.000Z",
    ...overrides,
  };
}

function conflict(overrides: Partial<SyncHostSingletonOwner> = {}): SyncHostSingletonConflict {
  return { reason: "lock", owner: owner(overrides) };
}

describe("syncHostRecovery", () => {
  beforeEach(() => {
    resetSyncHostRecoveryForTests();
  });

  it("classifies a worktree serve as a development runtime", () => {
    expect(classifySyncHostOwnerKind(owner())).toBe("development");
    expect(classifySyncHostOwnerKind(owner({
      commandLine: "/Applications/ADE.app/Contents/MacOS/ADE --serve",
      serviceName: "com.ade.runtime",
      projectRoot: null,
    }))).toBe("installed");
  });

  // A Windows command line quotes every argument and uses backslashes. The
  // POSIX matchers matched none of it, so every Windows conflict classified as
  // "unknown" — which also dropped the `development` leg of recoveryEligible
  // and left the Fix button permanently hidden on Windows.
  it("classifies owners on Windows and Linux, not only POSIX macOS", () => {
    const cases: Array<[string, string]> = [
      [String.raw`C:\Program Files\nodejs\node.exe "C:\Users\a\ADE\apps\ade-cli\dist\cli.cjs" "serve" "--socket" "\\.\pipe\ade"`, "development"],
      [String.raw`node.exe "C:\Users\a\ADE\.ade\worktrees\lane-x\apps\ade-cli\dist\cli.cjs" "serve"`, "development"],
      // The installer is per-user (`perMachine: false`), so this is where a
      // real Windows install actually lives.
      [String.raw`"C:\Users\a\AppData\Local\Programs\ADE\ADE.exe" --serve`, "installed"],
      [String.raw`"C:\Program Files\ADE\ADE.exe"`, "installed"],
      ["/opt/ADE/ade --serve", "installed"],
      ["/home/a/Apps/ADE-1.2.73.AppImage", "installed"],
      ["/usr/bin/python3 server.py", "unknown"],
    ];
    for (const [commandLine, expected] of cases) {
      expect(
        classifySyncHostOwnerKind(owner({ commandLine, serviceName: null, projectRoot: null })),
        commandLine,
      ).toBe(expected);
    }
  });

  it("joins an in-flight repair instead of opening a second stop/restart", async () => {
    let stops = 0;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = {
      detectConflict: () => conflict(),
      holdsLease: () => false,
      pidAlive: () => true,
      processMatchesOwner: () => true,
      terminatePid: async () => {
        stops += 1;
        await gate;
      },
      sleep: async () => {},
      now: () => Date.now(),
      waitMs: 0,
      selfPid: 1,
    };
    const first = recoverSyncHostConnection(deps);
    const second = recoverSyncHostConnection(deps);
    expect(second).toBe(first);
    release();
    await first;
    // Two callers, one stop. A second tap or a reconnect mid-repair must not
    // terminate a second process.
    expect(stops).toBe(1);
  });

  // `startSyncHost`, `restartBrain` and `prove` are injected closures with no
  // deadline of their own. Without this bound, one that never settles would
  // leave `inFlight` set forever and hang every later tap from every device.
  it("gives up on a repair whose dependency never settles", async () => {
    const result = await recoverSyncHostConnection({
      detectConflict: () => null,
      holdsLease: () => false,
      startSyncHost: () => new Promise<void>(() => {}),
      sleep: async () => {},
      waitMs: 0,
      maxRepairMs: 1_000,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.message).toContain("took too long");
  });

  it("bounds the tracked-operation map against caller-supplied ids", async () => {
    const deps = {
      detectConflict: () => null,
      holdsLease: () => true,
      sleep: async () => {},
      waitMs: 0,
      prove: async () => true,
    };
    for (let index = 0; index < 40; index += 1) {
      await recoverSyncHostConnection({ ...deps, operationId: `op-${index}` });
    }
    // An oversized id is ignored rather than truncated into a collision.
    const oversized = await recoverSyncHostConnection({ ...deps, operationId: "x".repeat(500) });
    expect(oversized.operationId).not.toBe("x".repeat(500));
    expect(oversized.operationId.length).toBeLessThanOrEqual(64);
  });

  it("diagnoses a verified conflict with phone-safe copy and no PID in the body", () => {
    const snapshot = diagnoseSyncHostReadiness({
      detectConflict: () => conflict(),
      holdsLease: () => false,
    });
    expect(snapshot.state).toBe("conflict");
    expect(snapshot.headline).toBe("Another ADE is blocking this machine");
    expect(snapshot.body).toContain("development runtime");
    expect(snapshot.body).not.toContain("19621");
    expect(snapshot.conflict?.ownerLabel).toBe("Development runtime");
    expect(snapshot.conflict?.projectLabel).toBe("improving-browser lane");
    expect(snapshot.conflict?.technicalDetail).toContain("pid: 19621");
    expect(snapshot.recoveryEligible).toBe(true);
  });

  it("does not offer destructive recovery for a legacy listener without birth identity", () => {
    const snapshot = diagnoseSyncHostReadiness({
      detectConflict: () => conflict({ processStartedAt: null }),
      holdsLease: () => false,
    });
    expect(snapshot.state).toBe("conflict");
    expect(snapshot.conflict?.ownerKind).toBe("development");
    expect(snapshot.recoveryEligible).toBe(false);
    expect(snapshot.conflict?.recoveryEligible).toBe(false);
  });

  it("rewrites host_unavailable without project-sync-host jargon", () => {
    const error = hostUnavailableErrorPayload(diagnoseSyncHostReadiness({
      detectConflict: () => null,
      holdsLease: () => false,
    }));
    expect(error.code).toBe("host_unavailable");
    expect(error.reason).toBe("starting");
    expect(error.message.toLowerCase()).not.toContain("hydration");
    expect(error.message.toLowerCase()).not.toContain("sync host");
  });

  it("redacts owner identity and disables recovery for unprivileged peers", () => {
    const snapshot = diagnoseSyncHostReadiness({
      detectConflict: () => conflict(),
      holdsLease: () => false,
    });
    const redacted = redactSyncHostReadinessSnapshot(snapshot, false);
    expect(redacted.recoveryEligible).toBe(false);
    expect(redacted.conflict).toMatchObject({
      ownerKind: "unknown",
      ownerLabel: "Another ADE runtime",
      projectLabel: null,
      impact: null,
      recoveryEligible: false,
    });
    expect(redacted.conflict?.technicalDetail).not.toContain("19621");
    expect(redacted.conflict?.technicalDetail).not.toContain("/tmp/ade-remote-sim");
  });

  it("stops a re-verified development blocker then proves recovery", async () => {
    const live = conflict();
    let remaining: SyncHostSingletonConflict | null = live;
    let holds = false;
    const terminated: number[] = [];
    const result = await recoverSyncHostConnection({
      detectConflict: () => remaining,
      holdsLease: () => holds,
      pidAlive: () => true,
      processMatchesOwner: () => true,
      terminatePid: async (pid) => {
        terminated.push(pid);
        remaining = null;
        holds = true;
      },
      prove: async () => holds,
      sleep: async () => {},
      now: () => 0,
      waitMs: 0,
      selfPid: 1,
    });
    expect(terminated).toEqual([19621]);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("succeeded");
    expect(result.steps.find((entry) => entry.id === "stop")?.status).toBe("done");
    expect(result.steps.find((entry) => entry.id === "prove")?.status).toBe("done");
  });

  it("does not stop a process after PID reuse", async () => {
    const terminated: number[] = [];
    const result = await recoverSyncHostConnection({
      detectConflict: () => conflict(),
      holdsLease: () => false,
      pidAlive: () => true,
      processMatchesOwner: () => false,
      terminatePid: async (pid) => {
        terminated.push(pid);
      },
      startSyncHost: async () => {},
      prove: async () => false,
      sleep: async () => {},
      now: () => 0,
      waitMs: 0,
      selfPid: 1,
    });
    expect(terminated).toEqual([]);
    expect(result.steps.find((entry) => entry.id === "stop")?.status).toBe("skipped");
  });

  it("does not stop a process when its identity cannot be verified", async () => {
    const terminated: number[] = [];
    const result = await recoverSyncHostConnection({
      detectConflict: () => conflict(),
      holdsLease: () => false,
      pidAlive: () => true,
      processMatchesOwner: () => null,
      terminatePid: async (pid) => {
        terminated.push(pid);
      },
      sleep: async () => {},
      now: () => 0,
      waitMs: 0,
      selfPid: 1,
    });
    expect(terminated).toEqual([]);
    expect(result.steps.find((entry) => entry.id === "stop")?.status).toBe("skipped");
  });

  it("rechecks process identity immediately before stopping", async () => {
    const terminated: number[] = [];
    let identityChecks = 0;
    const result = await recoverSyncHostConnection({
      detectConflict: () => conflict(),
      holdsLease: () => false,
      pidAlive: () => true,
      processMatchesOwner: () => {
        identityChecks += 1;
        return identityChecks === 1;
      },
      terminatePid: async (pid) => {
        terminated.push(pid);
      },
      sleep: async () => {},
      now: () => 0,
      waitMs: 0,
      selfPid: 1,
    });
    expect(identityChecks).toBe(2);
    expect(terminated).toEqual([]);
    expect(result.steps.find((entry) => entry.id === "stop")?.status).toBe("skipped");
  });

  it("does not stop a conflict without a stable owner identity", async () => {
    const terminated: number[] = [];
    const result = await recoverSyncHostConnection({
      detectConflict: () => conflict({ processStartedAt: null }),
      holdsLease: () => false,
      pidAlive: () => true,
      processMatchesOwner: () => true,
      terminatePid: async (pid) => {
        terminated.push(pid);
      },
      sleep: async () => {},
      now: () => 0,
      waitMs: 0,
      selfPid: 1,
    });
    expect(terminated).toEqual([]);
    expect(result.steps.find((entry) => entry.id === "stop")?.status).toBe("skipped");
  });

  it("never targets this brain's pid", async () => {
    const terminated: number[] = [];
    await recoverSyncHostConnection({
      detectConflict: () => conflict({ pid: 42 }),
      holdsLease: () => false,
      terminatePid: async (pid) => {
        terminated.push(pid);
      },
      sleep: async () => {},
      now: () => 0,
      waitMs: 0,
      selfPid: 42,
    });
    expect(terminated).toEqual([]);
  });
});
