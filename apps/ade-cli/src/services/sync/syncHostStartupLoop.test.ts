import { describe, expect, it } from "vitest";
import { runSyncHostStartupLoop, watchSyncHostAuthorityForRehost } from "./syncHostStartupLoop";
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

  it("logs a persistent sync-host conflict once, then at most once per ten minutes in one line", async () => {
    // One Alpha brain logged this conflict 9,700 times — once a minute, each a
    // multi-line message — while the release ADE simply sat there owning sync.
    const logs: string[] = [];
    const events: Array<{ event: string; meta: Record<string, unknown> }> = [];
    let clock = 0;
    const conflict = conflictError(makeOwner({ appName: "ADE Alpha", pid: 9253 }));
    await runSyncHostStartupLoop({
      startSyncHost: () => Promise.reject(conflict),
      isDone: () => false,
      log: (message) => logs.push(message),
      logEvent: (event, meta) => events.push({ event, meta }),
      // Each retry advances a full interval, so every attempt after the first
      // is eligible to restate the conflict — and still emits one line.
      sleep: () => {
        clock += 10 * 60_000;
        return Promise.resolve();
      },
      now: () => clock,
      maxAttempts: 4,
      env: betaEnv,
    });

    // First occurrence keeps the full detail, quit command included.
    expect(logs[0]).toContain("Another ADE brain is already hosting mobile sync");
    expect(logs[0]).toContain("Quit that brain before starting this ADE brain");
    const repeats = logs.slice(1);
    expect(repeats).toHaveLength(3);
    for (const line of repeats) {
      expect(line).not.toContain("\n");
      expect(line).toContain("still blocked by ADE Alpha (pid 9253)");
    }
    expect(repeats[0]).toContain("2 occurrences");
    expect(repeats.at(-1)).toContain("4 occurrences");

    // The structured half rides the same cadence, with the owning pid on it.
    const failures = events.filter((entry) => entry.event === "sync.host_start_failed");
    expect(failures).toHaveLength(4);
    expect(failures[0]?.meta).toMatchObject({
      code: "sync_host_singleton_conflict",
      ownerPid: 9253,
      occurrences: 1,
    });
    expect(failures.at(-1)?.meta).toMatchObject({ occurrences: 4 });
  });

  it("classifies a storage fault, records it, and slows down instead of looping on the raw errno", async () => {
    const logs: string[] = [];
    const recorded: Array<{ message: string; detail: string; code: string }> = [];
    const sleeps: number[] = [];
    const dbPath = "/Users/ada/Library/Mobile Documents/com~apple~CloudDocs/ADE/.ade/ade.db";
    let attempts = 0;
    await runSyncHostStartupLoop({
      startSyncHost: () => {
        attempts += 1;
        if (attempts < 3) {
          return Promise.reject(Object.assign(
            new Error("Unknown system error -11: Unknown system error -11, read"),
            { code: "Unknown system error -11", errno: -11, syscall: "read", path: dbPath },
          ));
        }
        return Promise.resolve();
      },
      isDone: () => false,
      log: (message) => logs.push(message),
      recordStorageFault: (fault, detail) => {
        recorded.push({ message: fault.message, detail, code: fault.code });
      },
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      fastRetryDelayMs: 2_000,
      slowRetryDelayMs: 30_000,
    });

    expect(attempts).toBe(3);
    // Never the fast cadence: a placeholder the provider cannot materialize is
    // not going to be readable two seconds later.
    expect(sleeps).toEqual([30_000, 30_000]);
    expect(recorded).toHaveLength(2);
    expect(recorded[0]?.code).toBe("storage_read_failed");
    expect(recorded[0]?.message).toContain(dbPath);
    expect(recorded[0]?.message).toContain("iCloud Drive");
    // The raw errno stays in `detail` for the log, never in the sentence.
    expect(recorded[0]?.detail).toContain("Unknown system error -11");
    expect(logs[0]).toContain("iCloud Drive");
    expect(logs[0]).not.toContain("Unknown system error");
    expect(logs.at(-1)).toBe("ADE brain mobile sync host recovered.");
  });

  /**
   * A storage fault that never clears used to be reportable only through the
   * account publisher — which exists only once this brain holds the sync-host
   * lease, and it only takes that lease once the sync host STARTS. So the
   * machines that most needed to send a report were exactly the machines that
   * could not. These cover the trigger that replaced it.
   */
  describe("sustained storage faults", () => {
    const placeholderError = () => Object.assign(
      new Error("Unknown system error -11: Unknown system error -11, read"),
      {
        code: "Unknown system error -11",
        errno: -11,
        syscall: "read",
        path: "/Users/ada/Library/Mobile Documents/com~apple~CloudDocs/ADE/.ade/ade.db",
      },
    );

    it("asks for exactly one report however long the fault lasts", async () => {
      const reports: Array<{ code: string; attempt: number }> = [];
      let attempts = 0;
      await runSyncHostStartupLoop({
        startSyncHost: () => {
          attempts += 1;
          return Promise.reject(placeholderError());
        },
        isDone: () => false,
        log: () => {},
        onSustainedStorageFault: ({ fault, attempt }) => {
          reports.push({ code: fault.code, attempt });
        },
        sleep: instantSleep,
        sustainedStorageFaultAttempts: 3,
        maxAttempts: 20,
      });

      expect(attempts).toBe(20);
      expect(reports).toEqual([{ code: "storage_read_failed", attempt: 3 }]);
    });

    it("waits for the fault to be sustained rather than reporting the first one", async () => {
      const reports: unknown[] = [];
      let attempts = 0;
      await runSyncHostStartupLoop({
        startSyncHost: () => {
          attempts += 1;
          // Two faults, then a working sync host: a transient read failure is
          // not worth a machine's daily diagnostics budget.
          return attempts < 3 ? Promise.reject(placeholderError()) : Promise.resolve();
        },
        isDone: () => false,
        log: () => {},
        onSustainedStorageFault: (event) => reports.push(event),
        sleep: instantSleep,
        sustainedStorageFaultAttempts: 3,
      });
      expect(reports).toEqual([]);
    });

    it("never asks when the failure is not a storage fault", async () => {
      const reports: unknown[] = [];
      await runSyncHostStartupLoop({
        startSyncHost: () => Promise.reject(new Error("port busy")),
        isDone: () => false,
        log: () => {},
        onSustainedStorageFault: (event) => reports.push(event),
        sleep: instantSleep,
        sustainedStorageFaultAttempts: 3,
        maxAttempts: 10,
      });
      expect(reports).toEqual([]);
    });

    it("keeps retrying when the report request throws", async () => {
      let attempts = 0;
      await runSyncHostStartupLoop({
        startSyncHost: () => {
          attempts += 1;
          return Promise.reject(placeholderError());
        },
        isDone: () => false,
        log: () => {},
        onSustainedStorageFault: () => {
          throw new Error("diagnostics sender is broken");
        },
        sleep: instantSleep,
        sustainedStorageFaultAttempts: 2,
        maxAttempts: 5,
      });
      expect(attempts).toBe(5);
    });
  });

  /**
   * "ADE brain sync host failed: …" appeared 160 times in one user's report and
   * not once in `brain.jsonl`: telemetry was blind to the most frequent brain
   * failure there is, because it only ever existed as free text on stderr.
   */
  describe("structured failure events", () => {
    it("emits the classified failure as a fact, at the deduped log cadence", async () => {
      const events: Array<{ event: string; meta: Record<string, unknown> }> = [];
      const logs: string[] = [];
      let attempts = 0;
      await runSyncHostStartupLoop({
        startSyncHost: () => {
          attempts += 1;
          if (attempts < 4) {
            return Promise.reject(Object.assign(
              new Error("Unknown system error -11: Unknown system error -11, read"),
              { code: "Unknown system error -11", errno: -11, syscall: "read", path: "/Users/ada/Dropbox/app/.ade/ade.db" },
            ));
          }
          return Promise.resolve();
        },
        isDone: () => false,
        log: (message) => logs.push(message),
        logEvent: (event, meta) => events.push({ event, meta }),
        sleep: instantSleep,
      });

      // One failure event and one recovery event: the three failures share a
      // signature, so the deduper narrates only the first within the minute —
      // and the structured half rides the same decision.
      const failures = events.filter((entry) => entry.event === "sync.host_start_failed");
      expect(failures).toHaveLength(1);
      expect(failures[0]?.meta).toMatchObject({
        signature: "storage_read_failed",
        attempt: 1,
        code: "storage_read_failed",
        errno: "Unknown system error -11",
        provider: "dropbox",
      });
      expect(events.at(-1)).toMatchObject({
        event: "sync.host_start_recovered",
        meta: { attempts: 3, lastFailureSignature: "storage_read_failed" },
      });
      // The human-readable line is kept, not replaced.
      expect(logs[0]).toContain("ADE brain sync host failed");
    });

    it("keeps running when the structured emitter throws", async () => {
      let attempts = 0;
      await runSyncHostStartupLoop({
        startSyncHost: () => {
          attempts += 1;
          return attempts < 3 ? Promise.reject(new Error("port busy")) : Promise.resolve();
        },
        isDone: () => false,
        log: () => {},
        logEvent: () => {
          throw new Error("logger is broken");
        },
        sleep: instantSleep,
      });
      expect(attempts).toBe(3);
    });
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

  // The loop retries forever on purpose so mobile sync recovers when a rival
  // brain exits.
  it("keeps retrying until the sync host comes up", async () => {
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
    });
    expect(attempts).toBe(3);
  });
});

describe("watchSyncHostAuthorityForRehost", () => {
  function harness(overrides: { holdsAfterGrace?: boolean; done?: boolean } = {}) {
    let handler: ((held: boolean) => void) | null = null;
    const logs: string[] = [];
    const events: string[] = [];
    let rehosts = 0;
    let holds = true;
    const stop = watchSyncHostAuthorityForRehost({
      onAuthorityChanged: (next) => {
        handler = next;
        return () => { handler = null; };
      },
      holds: () => holds,
      isDone: () => overrides.done === true,
      graceMs: 5_000,
      sleep: async () => {
        holds = overrides.holdsAfterGrace === true;
      },
      log: (message) => logs.push(message),
      logEvent: (event) => events.push(event),
      rehost: async () => { rehosts += 1; },
    });
    return {
      lose: () => { holds = false; handler?.(false); },
      regain: () => { holds = true; handler?.(true); },
      stop,
      logs,
      events,
      rehosts: () => rehosts,
      flush: () => new Promise((resolve) => setTimeout(resolve, 0)),
    };
  }

  it("re-hosts after a loss that outlives the grace", async () => {
    // The 2026-09-21 shape: a dev brain took the lease, then exited, and the
    // installed brain sat as a viewer until a manual restart.
    const h = harness();
    h.lose();
    await h.flush();
    expect(h.rehosts()).toBe(1);
    expect(h.events).toEqual(["sync.host_rehost_started"]);
  });

  it("ignores a loss that a project switch reverses within the grace", async () => {
    const h = harness({ holdsAfterGrace: true });
    h.lose();
    await h.flush();
    expect(h.rehosts()).toBe(0);
  });

  it("does nothing once the brain is shutting down, and after stop()", async () => {
    const shuttingDown = harness({ done: true });
    shuttingDown.lose();
    await shuttingDown.flush();
    expect(shuttingDown.rehosts()).toBe(0);

    const stopped = harness();
    stopped.stop();
    stopped.lose();
    await stopped.flush();
    expect(stopped.rehosts()).toBe(0);
  });

  it("retries a first-attempt cross-channel conflict when asked to, instead of throwing", async () => {
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
        return attempts < 3 ? Promise.reject(crossChannel) : Promise.resolve();
      },
      isDone: () => false,
      log: () => {},
      getServiceMainPid: () => process.pid,
      kill: () => {},
      sleep: instantSleep,
      env: betaEnv,
      retryFirstConflict: true,
    });
    expect(attempts).toBe(3);
  });
});
