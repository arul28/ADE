import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MachinePowerEvent } from "../../../../../ade-cli/src/services/power/machinePowerMonitor";
import { readGlobalState } from "../state/globalState";
import {
  createKeepAwakeService,
  parseSleepDisabled,
  type LidSleepController,
  type PowerSaveBlockerApi,
} from "./keepAwakeService";
import { createMachinePowerBrainBridge } from "./machinePowerBrainBridge";
import { createPowerStateService } from "./powerStateService";
import {
  disableSystemSleepOnAc,
  parsePmsetCustom,
  parsePowercfgQuery,
  readSystemSleepConfig,
} from "./systemSleepConfig";

// The main process's power surface, tested as one contract: what the machine's
// power state IS (powerStateService), how a sleep/wake reaches the brain
// (machinePowerBrainBridge), what the OS itself is configured to do
// (systemSleepConfig), and the opt-in setting layered on top (keepAwakeService).
// One file per folder rather than one per module — these four only mean
// anything together, and splitting them is how the same fact ends up asserted
// four times with four different fixtures.

// --- Local power + sleep state -----------------------------------------

type PowerMonitorEventName = "suspend" | "resume" | "on-ac" | "on-battery";

/** Stands in for Electron's `powerMonitor`, which the test fires by hand. */
function fakePowerMonitor(onBatteryPower = false) {
  const handlers = new Map<PowerMonitorEventName, Array<() => void>>();
  return {
    api: {
      on(event: string, handler: () => void) {
        const name = event as PowerMonitorEventName;
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
        return this;
      },
      isOnBatteryPower: () => onBatteryPower,
    },
    emit(event: PowerMonitorEventName): void {
      for (const handler of handlers.get(event) ?? []) handler();
    },
    listenerCount: (event: PowerMonitorEventName): number => handlers.get(event)?.length ?? 0,
  };
}

function serviceHarness(options: { onBatteryPower?: boolean } = {}) {
  const monitor = fakePowerMonitor(options.onBatteryPower ?? false);
  const events: MachinePowerEvent[] = [];
  let clock = 1_700_000_000_000;
  const service = createPowerStateService({
    powerMonitor: monitor.api as never,
    now: () => clock,
    readPower: async () => ({ battery: { percent: 44, charging: false }, onExternalPower: true }),
  });
  service.subscribe((event) => events.push(event));
  return {
    monitor,
    service,
    events,
    advance(ms: number): void {
      clock += ms;
    },
  };
}

describe("createPowerStateService", () => {
  it("binds the Electron power events on start", () => {
    const h = serviceHarness();
    h.service.start();

    for (const event of ["suspend", "resume", "on-ac", "on-battery"] as const) {
      expect(h.monitor.listenerCount(event)).toBe(1);
    }
    h.service.dispose();
  });

  it("marks the machine asleep on the pre-suspend beat", () => {
    const h = serviceHarness();
    h.service.start();

    h.monitor.emit("suspend");

    expect(h.service.getSleepState()).toBe("asleep");
    expect(h.events.at(-1)).toEqual({ kind: "suspend", at: expect.any(Number), announced: true });
    h.service.dispose();
  });

  it("wakes on resume and reports how long the machine was out", () => {
    const h = serviceHarness();
    h.service.start();
    h.monitor.emit("suspend");
    h.advance(40_000);

    h.monitor.emit("resume");

    expect(h.service.getSleepState()).toBe("awake");
    expect(h.events.at(-1)).toEqual(expect.objectContaining({ kind: "resume", announced: true }));
    // The pair of announcements is its own measurement. No timer fired here, so
    // the gap detector has nothing — and taking ITS answer would report some
    // earlier, unrelated sleep's length for this 40-second one.
    expect(h.service.getSuspendGapMs()).toBe(40_000);
    h.service.dispose();
  });

  it("prefers Electron's cross-platform wall-power answer over the platform read", async () => {
    const h = serviceHarness({ onBatteryPower: true });
    h.service.start();

    const power = await h.service.refreshPower();

    expect(power).toEqual({ battery: { percent: 44, charging: false }, onExternalPower: false });
    h.service.dispose();
  });

  it("publishes nothing for a failed platform read, even though Electron still answers", async () => {
    // Under Electron `isOnBatteryPower()` ALWAYS returns a boolean, so before
    // this guard every failed `pmset` — likeliest right after a wake, when the
    // resume path forces a refresh and pmset is slowest — was turned into
    // `{ onExternalPower: X }` with no `battery` key. That is the exact shape
    // that means "no battery hardware", so a MacBook at 20% on battery
    // rendered as a plugged-in desktop, and the monitor's keep-the-last-reading
    // guard (which only fires on null) never saw it.
    const monitor = fakePowerMonitor(true);
    const service = createPowerStateService({
      powerMonitor: monitor.api as never,
      readPower: async () => null,
    });

    await expect(service.refreshPower()).resolves.toBeNull();
    expect(service.getPower()).toBeNull();
    service.dispose();
  });

  it("keeps the last good reading when a later read fails", async () => {
    const monitor = fakePowerMonitor(true);
    let readable = true;
    const service = createPowerStateService({
      powerMonitor: monitor.api as never,
      readPower: async () =>
        (readable ? { battery: { percent: 20, charging: false }, onExternalPower: false } : null),
    });

    await service.refreshPower();
    readable = false;
    await service.refreshPower();

    expect(service.getPower()).toEqual({
      battery: { percent: 20, charging: false },
      onExternalPower: false,
    });
    service.dispose();
  });

  it("runs without Electron at all, for a main process that has none", async () => {
    const readPower = vi.fn(async () => ({ onExternalPower: true }));
    const service = createPowerStateService({ powerMonitor: null, readPower });

    service.start();
    await service.refreshPower();

    expect(readPower).toHaveBeenCalled();
    expect(service.getSleepState()).toBe("awake");
    service.dispose();
  });
});

// --- Forwarding the OS beat to the brain -------------------------------

/** A power source the test drives by hand, standing in for Electron's. */
function fakePowerSource() {
  const listeners = new Set<(event: MachinePowerEvent) => void>();
  return {
    source: {
      subscribe(listener: (event: MachinePowerEvent) => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    emit(event: MachinePowerEvent): void {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

describe("machinePowerBrainBridge", () => {
  it("forwards the pre-suspend beat to the brain within budget", async () => {
    const power = fakePowerSource();
    const report = vi.fn(async () => ({ accepted: true }));
    const bridge = createMachinePowerBrainBridge({
      powerSource: power.source,
      report,
      budgetMs: 500,
    });

    power.emit({ kind: "suspend", at: 1_000, announced: true });
    await bridge.lastHop();

    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith({ kind: "suspend", budgetMs: 500 });
    bridge.dispose();
  });

  it("forwards the wake too, so the directory stops saying asleep", async () => {
    const power = fakePowerSource();
    const report = vi.fn(async () => ({ accepted: true }));
    const bridge = createMachinePowerBrainBridge({
      powerSource: power.source,
      report,
      budgetMs: 500,
    });

    power.emit({ kind: "resume", at: 2_000, gapMs: 240_000, announced: true });
    await bridge.lastHop();

    expect(report).toHaveBeenCalledWith({ kind: "resume", budgetMs: 500 });
    bridge.dispose();
  });

  it("gives up on a brain that does not answer instead of holding the machine open", async () => {
    vi.useFakeTimers();
    try {
      const power = fakePowerSource();
      // A call that never settles is exactly the shape that would otherwise
      // sit inside the OS's short pre-suspend window forever.
      const report = vi.fn(() => new Promise<never>(() => {}));
      const bridge = createMachinePowerBrainBridge({
        powerSource: power.source,
        report,
        budgetMs: 2_000,
      });

      power.emit({ kind: "suspend", at: 1_000, announced: true });
      const hop = bridge.lastHop();
      expect(hop).not.toBeNull();

      let settled = false;
      void hop!.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(settled).toBe(true);
      bridge.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("swallows a brain that is not reachable at all", async () => {
    const power = fakePowerSource();
    const report = vi.fn(async () => {
      throw new Error("ADE runtime is not connected");
    });
    const bridge = createMachinePowerBrainBridge({
      powerSource: power.source,
      report,
      budgetMs: 500,
    });

    power.emit({ kind: "suspend", at: 1_000, announced: true });
    await expect(bridge.lastHop()).resolves.toBeUndefined();
    bridge.dispose();
  });

  it("stops forwarding once disposed", async () => {
    const power = fakePowerSource();
    const report = vi.fn(async () => ({ accepted: true }));
    const bridge = createMachinePowerBrainBridge({
      powerSource: power.source,
      report,
      budgetMs: 500,
    });

    bridge.dispose();
    power.emit({ kind: "suspend", at: 1_000, announced: true });
    expect(report).not.toHaveBeenCalled();
  });

  it("retries a failed resume hop until the brain takes it", async () => {
    // A resume rides a socket that is by definition mid-reconnect a beat after
    // the machine woke. Losing it is not a loss of precision: nothing else
    // clears an announced `asleep` for a nap under the gap detector's 60s
    // threshold, so the brain stays pinned asleep, holds every later network
    // failure as "Paused — computer asleep", and reports the next sleep's
    // length as the time since the first one.
    const power = fakePowerSource();
    let attempts = 0;
    const report = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("ADE runtime is not connected");
      return { accepted: true };
    });
    const bridge = createMachinePowerBrainBridge({
      powerSource: power.source,
      report,
      budgetMs: 500,
      resumeRetryMs: 0,
    });

    power.emit({ kind: "resume", at: 2_000, gapMs: 40_000, announced: true });
    await bridge.lastHop();

    expect(report).toHaveBeenCalledTimes(3);
    bridge.dispose();
  });

  it("stops retrying the resume as soon as one attempt lands", async () => {
    const power = fakePowerSource();
    const report = vi.fn(async () => ({ accepted: true }));
    const bridge = createMachinePowerBrainBridge({
      powerSource: power.source,
      report,
      budgetMs: 500,
      resumeRetryMs: 0,
    });

    power.emit({ kind: "resume", at: 2_000, gapMs: 40_000, announced: true });
    await bridge.lastHop();

    expect(report).toHaveBeenCalledTimes(1);
    bridge.dispose();
  });

  it("never retries the suspend, which must not be delayed by a retry", async () => {
    const power = fakePowerSource();
    const report = vi.fn(async () => {
      throw new Error("ADE runtime is not connected");
    });
    const bridge = createMachinePowerBrainBridge({
      powerSource: power.source,
      report,
      budgetMs: 500,
      resumeRetryMs: 0,
    });

    power.emit({ kind: "suspend", at: 1_000, announced: true });
    await bridge.lastHop();

    expect(report).toHaveBeenCalledTimes(1);
    bridge.dispose();
  });

  it("gives up on the resume after its last attempt rather than looping forever", async () => {
    const power = fakePowerSource();
    const report = vi.fn(async () => {
      throw new Error("ADE runtime is not connected");
    });
    const warn = vi.fn();
    const bridge = createMachinePowerBrainBridge({
      powerSource: power.source,
      report,
      budgetMs: 500,
      resumeAttempts: 3,
      resumeRetryMs: 0,
      logger: { warn },
    });

    power.emit({ kind: "resume", at: 2_000, gapMs: 40_000, announced: true });
    await bridge.lastHop();

    expect(report).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith("power.brain_hop_gave_up", { kind: "resume", attempts: 3 });
    bridge.dispose();
  });

  it("abandons an in-flight resume retry when the bridge is disposed", async () => {
    const power = fakePowerSource();
    const report = vi.fn(async () => {
      throw new Error("ADE runtime is not connected");
    });
    const bridge = createMachinePowerBrainBridge({
      powerSource: power.source,
      report,
      budgetMs: 500,
      resumeRetryMs: 0,
    });

    power.emit({ kind: "resume", at: 2_000, gapMs: 40_000, announced: true });
    bridge.dispose();
    await bridge.lastHop();

    expect(report.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("abandons an in-flight resume retry when a new suspend supersedes it", async () => {
    // A resume loop lives for ~12s (4 attempts on a 2s budget plus backoff),
    // which is long enough for the user to shut the lid inside it. Without a
    // generation guard the stale loop's next attempt delivers `resume` AFTER
    // the suspend: the brain writes `awake` and publishes it as the machine
    // goes dark, so the phone shows Connected to a sleeping Mac and chat
    // retries stop being held — the exact regression this branch removes.
    const power = fakePowerSource();
    const kinds: string[] = [];
    const report = vi.fn(async ({ kind }: { kind: "suspend" | "resume" }) => {
      kinds.push(kind);
      if (kind === "resume") throw new Error("ADE runtime is not connected");
      return { accepted: true };
    });
    const bridge = createMachinePowerBrainBridge({
      powerSource: power.source,
      report,
      budgetMs: 500,
      resumeAttempts: 4,
      resumeRetryMs: 0,
    });

    power.emit({ kind: "resume", at: 2_000, gapMs: 40_000, announced: true });
    const resumeHop = bridge.lastHop();
    power.emit({ kind: "suspend", at: 3_000, announced: true });
    await bridge.lastHop();
    await resumeHop;

    // Whatever the resume loop managed before being superseded, nothing it
    // sends may land after the suspend.
    expect(kinds.at(-1)).toBe("suspend");
    expect(kinds.filter((kind) => kind === "resume").length).toBeLessThan(4);
  });

  it("does not forward battery changes, which cost a directory write for nothing", async () => {
    const power = fakePowerSource();
    const report = vi.fn(async () => ({ accepted: true }));
    const bridge = createMachinePowerBrainBridge({
      powerSource: power.source,
      report,
      budgetMs: 500,
    });

    power.emit({
      kind: "power-change",
      at: 1_000,
      power: { onExternalPower: false, battery: { percent: 42, charging: false } },
    });
    expect(report).not.toHaveBeenCalled();
    bridge.dispose();
  });
});

// --- What the OS is configured to do -----------------------------------

const PMSET_CUSTOM = `Battery Power:
 lidwake              1
 standbydelaylow      10800
 sleep                5
 displaysleep         2
AC Power:
 lidwake              1
 autopoweroff         1
 sleep                10
 displaysleep         10
 disksleep            10
`;

const PMSET_NEVER = `AC Power:
 sleep                0 (sleep prevented by coreaudiod, powerd)
 displaysleep         10
`;

const POWERCFG_QUERY = `Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)
  Subgroup GUID: 238c9fa8-0aad-41ed-83f4-97be242c8f20  (Sleep)
    Power Setting GUID: 29f6c1db-86da-48c5-9fdb-f2b67b1f44da  (Sleep after)
      GUID Alias: STANDBYIDLE
      Minimum Possible Setting: 0x00000000
      Maximum Possible Setting: 0xffffffff
      Current AC Power Setting Index: 0x00000708
      Current DC Power Setting Index: 0x00000384
`;

describe("parsePmsetCustom", () => {
  it("reads the AC sleep timer, not the battery one", () => {
    expect(parsePmsetCustom(PMSET_CUSTOM)).toBe(10);
  });

  it("reads a zero timer through its trailing annotation", () => {
    expect(parsePmsetCustom(PMSET_NEVER)).toBe(0);
  });

  it("returns null when there is no AC section to read", () => {
    expect(parsePmsetCustom("Battery Power:\n sleep 5\n")).toBeNull();
  });

  it("returns null on empty, missing, and malformed output", () => {
    // "unreadable" and "never sleeps" must not collapse into the same answer:
    // one of them is reassurance we have not earned.
    expect(parsePmsetCustom("")).toBeNull();
    expect(parsePmsetCustom(null)).toBeNull();
    expect(parsePmsetCustom("AC Power:\n sleep\n displaysleep 10\n")).toBeNull();
    expect(parsePmsetCustom("AC Power:\n sleep -3\n")).toBeNull();
  });
});

describe("parsePowercfgQuery", () => {
  it("converts the hex AC index from seconds to minutes", () => {
    expect(parsePowercfgQuery(POWERCFG_QUERY)).toBe(30);
  });

  it("reports zero as never", () => {
    expect(
      parsePowercfgQuery(
        "      GUID Alias: STANDBYIDLE\n      Current AC Power Setting Index: 0x00000000\n",
      ),
    ).toBe(0);
  });

  it("rounds a sub-minute timer up, because it still stops agents", () => {
    expect(
      parsePowercfgQuery(
        "      GUID Alias: STANDBYIDLE\n      Current AC Power Setting Index: 0x0000001e\n",
      ),
    ).toBe(1);
  });

  it("refuses a report that never names STANDBYIDLE", () => {
    // An unscoped query prints a dozen AC indices; taking the first would
    // report the display timeout as the sleep timer.
    expect(
      parsePowercfgQuery(
        "      GUID Alias: VIDEOIDLE\n      Current AC Power Setting Index: 0x00000258\n",
      ),
    ).toBeNull();
  });

  it("returns null on empty and malformed output", () => {
    expect(parsePowercfgQuery("")).toBeNull();
    expect(parsePowercfgQuery(undefined)).toBeNull();
    expect(parsePowercfgQuery("GUID Alias: STANDBYIDLE\nCurrent AC Power Setting Index:\n")).toBeNull();
  });
});

describe("readSystemSleepConfig", () => {
  it("reports macOS as fixable behind a password", async () => {
    const config = await readSystemSleepConfig({
      platform: "darwin",
      execFileText: async () => ({ ok: true, stdout: PMSET_CUSTOM, stderr: "" }),
    });
    expect(config).toEqual({ sleepMinutesOnAc: 10, fixable: true, fixNeedsPassword: true });
  });

  it("reports Windows as fixable without one", async () => {
    const config = await readSystemSleepConfig({
      platform: "win32",
      execFileText: async () => ({ ok: true, stdout: POWERCFG_QUERY, stderr: "" }),
    });
    expect(config).toEqual({ sleepMinutesOnAc: 30, fixable: true, fixNeedsPassword: false });
  });

  it("degrades to null when the tool fails or the platform ships no desktop app", async () => {
    expect(
      await readSystemSleepConfig({
        platform: "darwin",
        execFileText: async () => ({ ok: false, stdout: "", stderr: "boom" }),
      }),
    ).toBeNull();
    expect(await readSystemSleepConfig({ platform: "linux" })).toBeNull();
  });
});

describe("disableSystemSleepOnAc", () => {
  it("elevates on macOS and edits the active scheme on Windows", async () => {
    const macCalls: Array<[string, string[]]> = [];
    await disableSystemSleepOnAc({
      platform: "darwin",
      execFileText: async (command, args) => {
        macCalls.push([command, args]);
        return { ok: true, stdout: "", stderr: "" };
      },
    });
    expect(macCalls[0]?.[0]).toBe("/usr/bin/osascript");
    expect(macCalls[0]?.[1].join(" ")).toContain("with administrator privileges");

    const winCalls: Array<[string, string[]]> = [];
    await disableSystemSleepOnAc({
      platform: "win32",
      execFileText: async (command, args) => {
        winCalls.push([command, args]);
        return { ok: true, stdout: "", stderr: "" };
      },
    });
    // Absolute System32 path, never a bare "powercfg" off PATH.
    expect(winCalls[0]?.[0]).toMatch(/powercfg\.exe$/i);
    expect(winCalls[0]?.[1]).toEqual(["/change", "standby-timeout-ac", "0"]);
  });

  it("names a cancelled password prompt as its own outcome", async () => {
    const result = await disableSystemSleepOnAc({
      platform: "darwin",
      execFileText: async () => ({
        ok: false,
        stdout: "",
        stderr: "execution error: User canceled. (-128)",
      }),
    });
    expect(result).toEqual({ ok: false, error: "You cancelled the password prompt." });
  });
});

// --- The keep-awake setting --------------------------------------------------

// Wrapped: this section owns file-scope temp-dir hooks, and at file scope
// they would run for every test above as well.
describe("keep-awake setting", () => {
  it("records the level once it sticks, and sends nothing but the level", async () => {
    // The analytics gate: a keep-awake choice is a meaningful user decision, so
    // it is captured — at the durable owner boundary, after the write, with a
    // closed outcome value and no machine, battery, or workload detail.
    const captured: Array<Record<string, unknown>> = [];
    const service = createKeepAwakeService({
      globalStatePath: statePath,
      platform: "darwin",
      powerSaveBlocker: fakeBlocker(),
      lidSleep: fakeLid(),
      systemSleepDeps: noSystemRead,
      readActiveTurns: async () => 0,
      productAnalyticsService: {
        captureInternal: (payload: Record<string, unknown>) => {
          captured.push(payload);
        },
      } as never,
    });

    await service.setLevel("while-away");
    await service.setLevel("never");

    expect(captured).toHaveLength(2);
    expect(captured[0]).toMatchObject({
      event: "ade_feature_used",
      surface: "desktop",
      properties: {
        feature: "connections",
        action: "preferences_changed",
        outcome: "keep_awake_while_away",
      },
    });
    expect(captured[1]).toMatchObject({
      properties: { outcome: "keep_awake_never" },
    });
    // One accepted event per level per day, keyed by the level, so a user
    // flip-flopping cannot mint a stream of them.
    expect(captured[0]!.dedupeKey).toBe("keep_awake_level:while-away");
    expect(captured[0]!.minimumIntervalMs).toBe(24 * 60 * 60_000);
    // Nothing beyond the three closed keys may ride along.
    expect(Object.keys(captured[0]!.properties as object).sort())
      .toEqual(["action", "feature", "outcome"]);
    service.dispose();
  });

  let tmpDir: string;
  let statePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-keep-awake-"));
    statePath = path.join(tmpDir, "ade-state.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** A powerSaveBlocker that records what was asked of it. */
  function fakeBlocker(): PowerSaveBlockerApi & { started: string[]; live: Set<number> } {
    const live = new Set<number>();
    const started: string[] = [];
    let nextId = 1;
    return {
      started,
      live,
      start(type) {
        started.push(type);
        const id = nextId++;
        live.add(id);
        return id;
      },
      stop(id) {
        live.delete(id);
      },
      isStarted(id) {
        return live.has(id);
      },
    };
  }

  function fakeLid(overrides: Partial<LidSleepController> = {}): LidSleepController & {
    calls: boolean[];
    disabled: boolean;
  } {
    const state = {
      calls: [] as boolean[],
      disabled: false,
      async read(): Promise<boolean | null> {
        return state.disabled;
      },
      async set(disabled: boolean): Promise<{ ok: boolean; error: string | null }> {
        state.calls.push(disabled);
        state.disabled = disabled;
        return { ok: true, error: null };
      },
      ...overrides,
    };
    return state as LidSleepController & { calls: boolean[]; disabled: boolean };
  }

  /** Nothing is readable, so the system-sleep half stays null throughout. */
  const noSystemRead = {
    execFileText: async () => ({ ok: false, stdout: "", stderr: "" }),
  };

  describe("keepAwakeService", () => {
    it("defaults to never and holds no lock", async () => {
      const blocker = fakeBlocker();
      const service = createKeepAwakeService({
        globalStatePath: statePath,
        platform: "darwin",
        powerSaveBlocker: blocker,
        lidSleep: fakeLid(),
        systemSleepDeps: noSystemRead,
        readActiveTurns: async () => 3,
      });
      const snapshot = await service.getSnapshot();
      expect(snapshot.preferences.level).toBe("never");
      await service.refreshBlocker();
      // A running turn must not arm anything while the level is `never`.
      expect(blocker.started).toEqual([]);
      service.dispose();
    });

    it("persists the chosen level across service instances", async () => {
      const first = createKeepAwakeService({
        globalStatePath: statePath,
        platform: "darwin",
        powerSaveBlocker: fakeBlocker(),
        lidSleep: fakeLid(),
        systemSleepDeps: noSystemRead,
        readActiveTurns: async () => 0,
      });
      await first.setLevel("while-away");
      first.dispose();

      expect(readGlobalState(statePath).keepAwakePreferences).toEqual({ level: "while-away" });

      const second = createKeepAwakeService({
        globalStatePath: statePath,
        platform: "darwin",
        powerSaveBlocker: fakeBlocker(),
        lidSleep: fakeLid(),
        systemSleepDeps: noSystemRead,
        readActiveTurns: async () => 0,
      });
      expect((await second.getSnapshot()).preferences.level).toBe("while-away");
      second.dispose();
    });

    it("degrades an unrecognized stored level to never", async () => {
      fs.writeFileSync(statePath, JSON.stringify({ keepAwakePreferences: { level: "forever" } }));
      const service = createKeepAwakeService({
        globalStatePath: statePath,
        platform: "darwin",
        powerSaveBlocker: fakeBlocker(),
        lidSleep: fakeLid(),
        systemSleepDeps: noSystemRead,
        readActiveTurns: async () => 0,
      });
      expect((await service.getSnapshot()).preferences.level).toBe("never");
      service.dispose();
    });

    it("takes the blocker when a turn starts and releases it when the turn ends", async () => {
      const blocker = fakeBlocker();
      let activeTurns = 0;
      const service = createKeepAwakeService({
        globalStatePath: statePath,
        platform: "darwin",
        powerSaveBlocker: blocker,
        lidSleep: fakeLid(),
        systemSleepDeps: noSystemRead,
        readActiveTurns: async () => activeTurns,
      });
      await service.setLevel("while-away");
      expect(blocker.live.size).toBe(0);

      activeTurns = 1;
      await service.refreshBlocker();
      expect(blocker.started).toEqual(["prevent-app-suspension"]);
      expect(blocker.live.size).toBe(1);

      activeTurns = 0;
      await service.refreshBlocker();
      expect(blocker.live.size).toBe(0);
      service.dispose();
    });

    it("clears a blocker failure once a later acquire succeeds", async () => {
      // One transient `powerSaveBlocker.start()` throw used to leave the settings
      // pane claiming the level was inert for the rest of the session, while the
      // lock was in fact being held.
      let throwOnce = true;
      const live = new Set<number>();
      const blocker: PowerSaveBlockerApi = {
        start(): number {
          if (throwOnce) {
            throwOnce = false;
            throw new Error("powerSaveBlocker unavailable");
          }
          const id = live.size + 1;
          live.add(id);
          return id;
        },
        stop(id: number): void {
          live.delete(id);
        },
        isStarted(id: number): boolean {
          return live.has(id);
        },
      };
      let activeTurns = 1;
      const service = createKeepAwakeService({
        globalStatePath: statePath,
        platform: "darwin",
        powerSaveBlocker: blocker,
        lidSleep: fakeLid(),
        systemSleepDeps: noSystemRead,
        readActiveTurns: async () => activeTurns,
      });
      await service.setLevel("while-away");
      expect((await service.getSnapshot()).levelError)
        .toBe("This machine wouldn't let ADE stay awake.");

      // Drop the lock and take it again — this time it works.
      activeTurns = 0;
      await service.refreshBlocker();
      activeTurns = 1;
      await service.refreshBlocker();

      expect(live.size).toBe(1);
      expect((await service.getSnapshot()).levelError).toBeNull();
      service.dispose();
    });

    it("does not let a blocker success wipe the lid level's own error", async () => {
      const service = createKeepAwakeService({
        globalStatePath: statePath,
        platform: "darwin",
        powerSaveBlocker: fakeBlocker(),
        lidSleep: fakeLid({
          async set() {
            return { ok: false, error: "You cancelled the password prompt." };
          },
        }),
        systemSleepDeps: noSystemRead,
        readActiveTurns: async () => 1,
      });
      await service.setLevel("while-away");
      const after = await service.setLevel("lid-closed");
      expect(after.levelError).toBe("You cancelled the password prompt.");

      // The blocker is acquired for the still-stored "while-away" level, and its
      // success says nothing about the lid prompt the user just cancelled.
      await service.refreshBlocker();
      expect((await service.getSnapshot()).levelError).toBe("You cancelled the password prompt.");
      service.dispose();
    });

    it("does not take the lock for a poll that was in flight when the level was switched off", async () => {
      // Asking the brain how many turns are running is an RPC. A user who picks
      // "Never" while one is in flight must not have the machine pinned awake by
      // the answer that lands a moment later.
      const blocker = fakeBlocker();
      const parked: { resolve: ((count: number) => void) | null } = { resolve: null };
      let calls = 0;
      const service = createKeepAwakeService({
        globalStatePath: statePath,
        platform: "darwin",
        powerSaveBlocker: blocker,
        lidSleep: fakeLid(),
        systemSleepDeps: noSystemRead,
        readActiveTurns: async () => {
          calls += 1;
          if (calls === 1) return 0;
          return new Promise<number>((resolve) => {
            parked.resolve = resolve;
          });
        },
      });
      await service.setLevel("while-away");

      const poll = service.refreshBlocker();
      await service.setLevel("never");
      parked.resolve?.(1);
      await poll;

      expect(blocker.started).toEqual([]);
      expect(blocker.live.size).toBe(0);
      service.dispose();
    });

    it("drops a held lock the moment Never is chosen, not when the brain answers", async () => {
      // The other half of the same hazard. `refreshBlocker` no-ops while a pass
      // is in flight, and that pass is an RPC bounded at seconds, not
      // milliseconds — so waiting for it would leave the Mac pinned awake long
      // after the user said stop. The release has to happen on the choice.
      const blocker = fakeBlocker();
      const parked: { resolve: ((count: number) => void) | null } = { resolve: null };
      let calls = 0;
      const service = createKeepAwakeService({
        globalStatePath: statePath,
        platform: "darwin",
        powerSaveBlocker: blocker,
        lidSleep: fakeLid(),
        systemSleepDeps: noSystemRead,
        readActiveTurns: async () => {
          calls += 1;
          if (calls === 1) return 1;
          return new Promise<number>((resolve) => {
            parked.resolve = resolve;
          });
        },
      });
      await service.setLevel("while-away");
      expect(blocker.live.size).toBe(1);

      const poll = service.refreshBlocker();
      await service.setLevel("never");
      // Released already, with the brain still holding the line.
      expect(blocker.live.size).toBe(0);

      parked.resolve?.(1);
      await poll;
      expect(blocker.live.size).toBe(0);
      service.dispose();
    });

    it("drops a HELD lock the instant Never is chosen, not when the in-flight poll returns", async () => {
      // The activity call is an RPC with its own budget; while it is outstanding
      // `refreshBlocker` skips the pass entirely, so a release routed only
      // through the poll leaves the machine pinned awake for as long as that call
      // takes to answer — bounded by the RPC timeout, not the poll interval.
      const blocker = fakeBlocker();
      const parked: { resolve: ((count: number) => void) | null } = { resolve: null };
      let calls = 0;
      const service = createKeepAwakeService({
        globalStatePath: statePath,
        platform: "darwin",
        powerSaveBlocker: blocker,
        lidSleep: fakeLid(),
        systemSleepDeps: noSystemRead,
        readActiveTurns: async () => {
          calls += 1;
          if (calls === 1) return 1;
          return new Promise<number>((resolve) => {
            parked.resolve = resolve;
          });
        },
      });
      await service.setLevel("while-away");
      expect(blocker.live.size).toBe(1);

      const poll = service.refreshBlocker();
      await service.setLevel("never");
      // The lock is gone BEFORE the parked call answers.
      expect(blocker.live.size).toBe(0);

      parked.resolve?.(3);
      await poll;
      // …and the answer that lands afterwards does not take it back.
      expect(blocker.live.size).toBe(0);
      expect(blocker.started).toEqual(["prevent-app-suspension"]);
      service.dispose();
    });

    it("releases the blocker rather than pinning the machine when the brain can't be asked", async () => {
      const blocker = fakeBlocker();
      let fail = false;
      const service = createKeepAwakeService({
        globalStatePath: statePath,
        platform: "darwin",
        powerSaveBlocker: blocker,
        lidSleep: fakeLid(),
        systemSleepDeps: noSystemRead,
        readActiveTurns: async () => {
          if (fail) throw new Error("brain unreachable");
          return 1;
        },
      });
      await service.setLevel("while-away");
      await service.refreshBlocker();
      expect(blocker.live.size).toBe(1);

      fail = true;
      await service.refreshBlocker();
      expect(blocker.live.size).toBe(0);
      service.dispose();
    });

    it("drops the blocker on dispose", async () => {
      const blocker = fakeBlocker();
      const service = createKeepAwakeService({
        globalStatePath: statePath,
        platform: "darwin",
        powerSaveBlocker: blocker,
        lidSleep: fakeLid(),
        systemSleepDeps: noSystemRead,
        readActiveTurns: async () => 2,
      });
      await service.setLevel("while-away");
      await service.refreshBlocker();
      expect(blocker.live.size).toBe(1);
      service.dispose();
      expect(blocker.live.size).toBe(0);
    });

    it("has no lid-closed level on Windows and refuses to store one", async () => {
      const service = createKeepAwakeService({
        globalStatePath: statePath,
        platform: "win32",
        powerSaveBlocker: fakeBlocker(),
        systemSleepDeps: noSystemRead,
        readActiveTurns: async () => 0,
      });
      const snapshot = await service.getSnapshot();
      expect(snapshot.lidClosedSupported).toBe(false);

      const after = await service.setLevel("lid-closed");
      // Stored levels must be levels that are actually in force.
      expect(after.preferences.level).toBe("never");
      expect(after.levelError).toBe("This machine can't stay awake with the lid closed.");
      expect(readGlobalState(statePath).keepAwakePreferences).toBeUndefined();
      service.dispose();
    });

    it("engages and releases the macOS lid switch exactly once per change", async () => {
      const lid = fakeLid();
      const service = createKeepAwakeService({
        globalStatePath: statePath,
        platform: "darwin",
        powerSaveBlocker: fakeBlocker(),
        lidSleep: lid,
        systemSleepDeps: noSystemRead,
        readActiveTurns: async () => 0,
      });
      const on = await service.setLevel("lid-closed");
      expect(lid.calls).toEqual([true]);
      expect(on.preferences.level).toBe("lid-closed");
      expect(on.lidClosedActive).toBe(true);

      // Re-picking the same level must not re-prompt for a password.
      await service.setLevel("lid-closed");
      expect(lid.calls).toEqual([true]);

      const off = await service.setLevel("while-away");
      expect(lid.calls).toEqual([true, false]);
      expect(off.lidClosedActive).toBe(false);
      service.dispose();
    });

    it("admits the machine is still pinned awake when the release fails", async () => {
      let allowSet = true;
      const lid = fakeLid();
      const guarded: LidSleepController = {
        read: lid.read.bind(lid),
        set: async (disabled) =>
          allowSet
            ? lid.set(disabled)
            : { ok: false, error: "macOS wouldn't turn this off." },
      };
      const service = createKeepAwakeService({
        globalStatePath: statePath,
        platform: "darwin",
        powerSaveBlocker: fakeBlocker(),
        lidSleep: guarded,
        systemSleepDeps: noSystemRead,
        readActiveTurns: async () => 0,
      });
      await service.setLevel("lid-closed");
      allowSet = false;

      const after = await service.setLevel("never");
      expect(after.preferences.level).toBe("never");
      // The switch is machine-wide and still on. Reporting a clean downgrade
      // would leave the user believing their battery is safe when it is not.
      expect(after.lidClosedActive).toBe(true);
      expect(after.levelError).toBe("This Mac is still set to stay awake. Try again.");
      service.dispose();
    });

    it("does not store lid-closed when the authorization fails", async () => {
      const lid = fakeLid({
        set: async () => ({ ok: false, error: "You cancelled the password prompt." }),
      });
      const service = createKeepAwakeService({
        globalStatePath: statePath,
        platform: "darwin",
        powerSaveBlocker: fakeBlocker(),
        lidSleep: lid,
        systemSleepDeps: noSystemRead,
        readActiveTurns: async () => 0,
      });
      const snapshot = await service.setLevel("lid-closed");
      expect(snapshot.preferences.level).toBe("never");
      expect(snapshot.levelError).toBe("You cancelled the password prompt.");
      expect(snapshot.lidClosedActive).toBe(false);
      service.dispose();
    });
  });

  describe("parseSleepDisabled", () => {
    it("reads the pmset switch, and admits when it cannot", () => {
      expect(parseSleepDisabled("  SleepDisabled  1\n")).toBe(true);
      expect(parseSleepDisabled("  SleepDisabled  0\n")).toBe(false);
      expect(parseSleepDisabled("  hibernatemode 3\n")).toBeNull();
      expect(parseSleepDisabled(null)).toBeNull();
    });
  });
});
