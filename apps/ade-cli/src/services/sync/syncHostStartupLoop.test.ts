import { describe, expect, it } from "vitest";
import { runSyncHostStartupLoop, SyncHostStartupAbortedError } from "./syncHostStartupLoop";
import {
  SyncHostSingletonConflictError,
  type SyncHostSingletonOwner,
} from "./syncHostSingleton";

function makeOwner(overrides: Partial<SyncHostSingletonOwner> = {}): SyncHostSingletonOwner {
  const now = "2026-06-09T00:00:00.000Z";
  return {
    id: "owner-1",
    pid: 4242,
    port: 8807,
    appName: "ADE Beta",
    packageChannel: "beta",
    adeHome: "/Users/example/.ade-beta",
    serviceName: "com.ade.runtime.beta",
    socketPath: "/Users/example/.ade-beta/sock/ade.sock",
    projectRoot: null,
    commandLine: null,
    quitCommand: "true",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function conflictError(owner: SyncHostSingletonOwner): SyncHostSingletonConflictError {
  return new SyncHostSingletonConflictError({ reason: "lock", owner });
}

const instantSleep = (): Promise<void> => Promise.resolve();

const betaEnv = {
  ADE_PACKAGE_CHANNEL: "beta",
  ADE_HOME: "/Users/example/.ade-beta",
} as NodeJS.ProcessEnv;

describe("runSyncHostStartupLoop", () => {
  it("returns after a first-attempt success without logging", async () => {
    const logs: string[] = [];
    await runSyncHostStartupLoop({
      startSyncHost: () => Promise.resolve(),
      isDone: () => false,
      log: (message) => logs.push(message),
      sleep: instantSleep,
    });
    expect(logs).toEqual([]);
  });

  it("retries failures until the host comes up and logs the recovery", async () => {
    const logs: string[] = [];
    let attempts = 0;
    await runSyncHostStartupLoop({
      startSyncHost: () => {
        attempts += 1;
        return attempts < 3 ? Promise.reject(new Error("port busy")) : Promise.resolve();
      },
      isDone: () => false,
      log: (message) => logs.push(message),
      sleep: instantSleep,
    });
    expect(attempts).toBe(3);
    // The identical failure is logged once, not once per retry.
    expect(logs).toEqual([
      "ADE brain sync host failed: port busy",
      "ADE brain mobile sync host recovered.",
    ]);
  });

  it("deduplicates changing messages from the same failure type", async () => {
    const logs: string[] = [];
    let attempts = 0;
    await runSyncHostStartupLoop({
      startSyncHost: () => {
        attempts += 1;
        return attempts < 3
          ? Promise.reject(new Error(`port busy on attempt ${attempts}`))
          : Promise.resolve();
      },
      isDone: () => false,
      log: (message) => logs.push(message),
      sleep: instantSleep,
    });

    expect(logs).toEqual([
      "ADE brain sync host failed: port busy on attempt 1",
      "ADE brain mobile sync host recovered.",
    ]);
  });

  it("takes over from a stale same-channel owner when it is the service child", async () => {
    const logs: string[] = [];
    const killed: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    let ownerAlive = true;
    let attempts = 0;
    await runSyncHostStartupLoop({
      startSyncHost: () => {
        attempts += 1;
        return ownerAlive
          ? Promise.reject(conflictError(makeOwner()))
          : Promise.resolve();
      },
      isDone: () => false,
      log: (message) => logs.push(message),
      getServiceMainPid: () => process.pid,
      kill: (pid, signal) => {
        killed.push({ pid, signal });
        if (signal === "SIGTERM") ownerAlive = false;
      },
      pidAlive: () => ownerAlive,
      sleep: instantSleep,
      env: betaEnv,
    });
    expect(attempts).toBe(2);
    expect(killed).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
    expect(logs.some((line) => line.includes("taking over mobile sync"))).toBe(true);
  });

  it("never takes over when it is not the service child", async () => {
    const killed: number[] = [];
    let attempts = 0;
    await runSyncHostStartupLoop({
      startSyncHost: () => {
        attempts += 1;
        return Promise.reject(conflictError(makeOwner()));
      },
      isDone: () => false,
      log: () => {},
      getServiceMainPid: () => process.pid + 1,
      kill: (pid) => {
        killed.push(pid);
      },
      sleep: instantSleep,
      env: betaEnv,
      maxAttempts: 3,
    });
    expect(attempts).toBe(3);
    expect(killed).toEqual([]);
  });

  it("rethrows a first-attempt cross-channel conflict so startup fails loudly", async () => {
    // Another build's live brain owning sync at STARTUP is a deliberate human
    // state — fail with quit instructions rather than silently running sync-less.
    const killed: number[] = [];
    let attempts = 0;
    const error = conflictError(makeOwner({
      packageChannel: null,
      adeHome: "/Users/example/.ade",
      serviceName: "com.ade.runtime",
      appName: "ADE",
    }));
    await expect(runSyncHostStartupLoop({
      startSyncHost: () => {
        attempts += 1;
        return Promise.reject(error);
      },
      isDone: () => false,
      log: () => {},
      getServiceMainPid: () => process.pid,
      kill: (pid) => {
        killed.push(pid);
      },
      sleep: instantSleep,
      env: betaEnv,
      maxAttempts: 3,
    })).rejects.toBe(error);
    expect(attempts).toBe(1);
    expect(killed).toEqual([]);
  });

  it("recovers when a cross-channel conflict appears after startup and later clears", async () => {
    // A dev-build brain that grabs the singleton mid-flight must not strand
    // phones on the ingress fallback forever: once it exits, the next slow
    // retry re-hosts. (Previously this rethrew and the loop died permanently.)
    const logs: string[] = [];
    const killed: number[] = [];
    let attempts = 0;
    const crossChannel = conflictError(makeOwner({
      packageChannel: null,
      adeHome: "/Users/example/.ade",
      serviceName: "com.ade.runtime",
      appName: "ADE",
    }));
    await runSyncHostStartupLoop({
      startSyncHost: () => {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new Error("port busy"));
        if (attempts < 4) return Promise.reject(crossChannel);
        return Promise.resolve();
      },
      isDone: () => false,
      log: (message) => logs.push(message),
      getServiceMainPid: () => process.pid,
      kill: (pid) => {
        killed.push(pid);
      },
      sleep: instantSleep,
      env: betaEnv,
    });
    expect(attempts).toBe(4);
    // Never kills a foreign-channel owner; just waits it out.
    expect(killed).toEqual([]);
    expect(logs.at(-1)).toBe("ADE brain mobile sync host recovered.");
  });

  it("stops once the brain is shutting down", async () => {
    let attempts = 0;
    let done = false;
    await runSyncHostStartupLoop({
      startSyncHost: () => {
        attempts += 1;
        done = true;
        return Promise.reject(new Error("shutting down"));
      },
      isDone: () => done,
      log: () => {},
      sleep: instantSleep,
    });
    expect(attempts).toBe(1);
  });

  // The loop retries forever on purpose so sync recovers when a rival brain
  // exits. That is also how a brain that lost its socket became an immortal
  // zombie — it never reached its own bind check.
  it("aborts instead of retrying forever once another brain owns the socket", async () => {
    let attempts = 0;
    let socketTaken = false;
    await expect(runSyncHostStartupLoop({
      startSyncHost: () => {
        attempts += 1;
        if (attempts >= 2) socketTaken = true;
        return Promise.reject(new Error("sync host unavailable"));
      },
      isDone: () => false,
      log: () => {},
      sleep: instantSleep,
      abortIf: () => socketTaken,
    })).rejects.toBeInstanceOf(SyncHostStartupAbortedError);
    expect(attempts).toBe(2);
  });

  it("keeps retrying while the socket is still ours", async () => {
    let attempts = 0;
    await runSyncHostStartupLoop({
      startSyncHost: () => {
        attempts += 1;
        if (attempts < 3) return Promise.reject(new Error("not yet"));
        return Promise.resolve(null);
      },
      isDone: () => false,
      log: () => {},
      sleep: instantSleep,
      abortIf: () => false,
    });
    expect(attempts).toBe(3);
  });
});
