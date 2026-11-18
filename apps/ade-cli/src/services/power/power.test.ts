import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { spawnMock, execFileOverride } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileOverride: { current: null as ((...args: any[]) => unknown) | null },
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
    execFile: (...args: unknown[]) =>
      (execFileOverride.current ?? (actual.execFile as (...forwarded: unknown[]) => unknown))(...args),
  };
});

import type { MachinePower } from "../../../../desktop/src/shared/types/power";
import {
  createMachinePowerMonitor,
  type MachinePowerEvent,
} from "./machinePowerMonitor";
import {
  buildWindowsPowerQueryArgs,
  parsePmsetBatteryOutput,
  parseWindowsPowerOutput,
  readMachinePower,
} from "./machinePowerReader";
import {
  SUSPEND_GAP_THRESHOLD_MS,
  SUSPEND_GAP_TICK_MS,
  createSuspendGapDetector,
  type SuspendGapDetector,
} from "./suspendGapDetector";
import { createBrainKeepAwakeService } from "./brainKeepAwakeService";
import { cloudKeepAwakePaths, createCloudKeepAwake, decideCloudBusy, type CloudBusyTerminal } from "./cloudKeepAwake";
import { createCloudDiskGrower } from "./cloudDiskGrow";
import { createCloudSetupUpsizer } from "./cloudSetupUpsize";
import { CloudProviderError } from "../../../../desktop/src/main/services/adeCloud/cloudProvider";
import { cloudDiskGrowStatePath } from "./cloudDiskGuard";
import { cloudCatalogOf } from "../../../../desktop/src/shared/adeCloud";
import { prepareCloudComputerToStop } from "./cloudPrepareStop";
import { CLOUD_COMPUTER_REMOVING_SENTENCE, CLOUD_DELETE_FREEZE_MS, cloudDeleteFreezeRefusal, liftCloudDeleteFreeze } from "./cloudDeleteFreeze";
import { cloudChatStoppedForRest } from "../cloudChats/cloudChatUploader";

// The brain's power surface as one contract: reading what the hardware says
// (machinePowerReader), noticing a suspend nobody announced (suspendGapDetector),
// and the monitor that composes both into the state the publisher ships.
// Kept in one file because the three only mean anything together — the monitor's
// behavior IS the reader's output crossed with the detector's.

// --- Reading the hardware, per platform --------------------------------

const MACBOOK_ON_BATTERY = [
  "Now drawing from 'Battery Power'",
  " -InternalBattery-0 (id=12345678)\t83%; discharging; 3:11 remaining present: true",
].join("\n");

const MACBOOK_CHARGING = [
  "Now drawing from 'AC Power'",
  " -InternalBattery-0 (id=12345678)\t47%; charging; 1:02 remaining present: true",
].join("\n");

const MAC_STUDIO = "Now drawing from 'AC Power'\n";

describe("parsePmsetBatteryOutput", () => {
  it("reads a discharging laptop", () => {
    expect(parsePmsetBatteryOutput(MACBOOK_ON_BATTERY)).toEqual({
      battery: { percent: 83, charging: false },
      onExternalPower: false,
    });
  });

  it("reads a charging laptop", () => {
    expect(parsePmsetBatteryOutput(MACBOOK_CHARGING)).toEqual({
      battery: { percent: 47, charging: true },
      onExternalPower: true,
    });
  });

  it("reports a desktop as having no battery rather than an empty one", () => {
    // The Mac Studio bug: anything that invents a percentage here shows "0%"
    // for hardware that does not exist.
    expect(parsePmsetBatteryOutput(MAC_STUDIO)).toEqual({ onExternalPower: true });
  });

  it("treats a charged laptop as not charging", () => {
    expect(parsePmsetBatteryOutput([
      "Now drawing from 'AC Power'",
      " -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true",
    ].join("\n"))).toEqual({
      battery: { percent: 100, charging: false },
      onExternalPower: true,
    });
  });

  it("treats optimized-charging 'not charging' as not charging", () => {
    // A plugged-in Mac holding at 80% under optimized battery charging prints
    // "not charging" — which contains the word the charging test looks for.
    expect(parsePmsetBatteryOutput([
      "Now drawing from 'AC Power'",
      " -InternalBattery-0 (id=1)\t80%; not charging; 0:00 remaining present: true",
    ].join("\n"))).toEqual({
      battery: { percent: 80, charging: false },
      onExternalPower: true,
    });
  });

  it("returns null for unreadable output", () => {
    expect(parsePmsetBatteryOutput(null)).toBeNull();
    expect(parsePmsetBatteryOutput("   ")).toBeNull();
  });
});

describe("parseWindowsPowerOutput", () => {
  it("reads a laptop on battery", () => {
    expect(parseWindowsPowerOutput("64|False|False")).toEqual({
      battery: { percent: 64, charging: false },
      onExternalPower: false,
    });
  });

  it("reads a laptop charging on mains", () => {
    expect(parseWindowsPowerOutput("64|True|True")).toEqual({
      battery: { percent: 64, charging: true },
      onExternalPower: true,
    });
  });

  it("reports a desktop with no battery hardware", () => {
    expect(parseWindowsPowerOutput("none")).toEqual({ onExternalPower: true });
  });

  it("tells a battery it could not read apart from a machine that has none", () => {
    // With `$ErrorActionPreference = 'SilentlyContinue'` a WMI hiccup leaves
    // both classes null, which used to print `none` — a confident "this is a
    // desktop" that the directory's whole-blob coalesce then wrote over the
    // last good laptop reading.
    expect(parseWindowsPowerOutput("unknown")).toBeNull();
  });

  it("keeps a known battery when one poll omits the percentage", () => {
    // Reaching the pipe form means a battery class DID return an instance, so
    // a missing `EstimatedChargeRemaining` is an unreadable percentage, not
    // absent hardware. Answering `{ onExternalPower }` here is the battery-less
    // shape, and it turned a laptop into a desktop for that poll.
    expect(parseWindowsPowerOutput("||True")).toBeNull();
    expect(parseWindowsPowerOutput("|True|True")).toBeNull();
  });

  it("returns null for unreadable output", () => {
    expect(parseWindowsPowerOutput(null)).toBeNull();
  });
});

describe("buildWindowsPowerQueryArgs", () => {
  it("runs a fixed, non-interactive, profile-free script", () => {
    const args = buildWindowsPowerQueryArgs();
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    expect(args).toHaveLength(4);
  });

  it("proves absence from Win32_Battery only, and reports its failure as unknown", () => {
    // `root/wmi\BatteryStatus` genuinely does not exist on many hosts, so its
    // error proves nothing about hardware. `Win32_Battery` is a standard CIM
    // class present everywhere that simply returns no instances on a desktop,
    // so it is the only one whose silence may be read as "no battery" — and
    // only when the query itself did not error.
    const script = buildWindowsPowerQueryArgs()[3] ?? "";
    expect(script).toContain("-ErrorVariable batteryError");
    expect(/Win32_Battery -ErrorVariable batteryError/.test(script)).toBe(true);
    expect(script).toContain("Write('unknown')");
    expect(script).toContain("Write('none')");
  });
});

describe("readMachinePower", () => {
  it("reads Linux battery and mains state straight from sysfs", async () => {
    const files: Record<string, string> = {
      "/sys/class/power_supply/BAT0/type": "Battery\n",
      "/sys/class/power_supply/BAT0/capacity": "56\n",
      "/sys/class/power_supply/BAT0/status": "Discharging\n",
      "/sys/class/power_supply/AC/type": "Mains\n",
      "/sys/class/power_supply/AC/online": "0\n",
    };
    await expect(readMachinePower({
      platform: "linux",
      readDir: () => ["AC", "BAT0"],
      readTextFile: (filePath) => files[filePath] ?? null,
    })).resolves.toEqual({
      battery: { percent: 56, charging: false },
      onExternalPower: false,
    });
  });

  it("treats a Linux host with only mains supplies as a battery-less desktop", async () => {
    const files: Record<string, string> = {
      "/sys/class/power_supply/AC/type": "Mains\n",
      "/sys/class/power_supply/AC/online": "1\n",
    };
    await expect(readMachinePower({
      platform: "linux",
      readDir: () => ["AC"],
      readTextFile: (filePath) => files[filePath] ?? null,
    })).resolves.toEqual({ onExternalPower: true });
  });

  it("infers Linux wall power from the battery when no mains supply is exposed", async () => {
    const files: Record<string, string> = {
      "/sys/class/power_supply/BAT0/type": "Battery\n",
      "/sys/class/power_supply/BAT0/capacity": "90\n",
      "/sys/class/power_supply/BAT0/status": "Charging\n",
    };
    await expect(readMachinePower({
      platform: "linux",
      readDir: () => ["BAT0"],
      readTextFile: (filePath) => files[filePath] ?? null,
    })).resolves.toEqual({
      battery: { percent: 90, charging: true },
      onExternalPower: true,
    });
  });

  it("answers null for an unreadable Linux sysfs rather than guessing", async () => {
    await expect(readMachinePower({
      platform: "linux",
      readDir: () => null,
      readTextFile: () => null,
    })).resolves.toBeNull();
    // A battery that is there but whose charge cannot be read is not a desktop:
    // "no battery" would also slow the monitor to its desktop rate.
    const files: Record<string, string> = {
      "/sys/class/power_supply/AC/type": "Mains\n",
      "/sys/class/power_supply/AC/online": "1\n",
      "/sys/class/power_supply/BAT0/type": "Battery\n",
    };
    await expect(readMachinePower({
      platform: "linux",
      readDir: () => ["AC", "BAT0"],
      readTextFile: (filePath) => files[filePath] ?? null,
    })).resolves.toBeNull();
  });

  it("hides the console window on every Windows spawn", async () => {
    const execFileText = vi.fn(async () => "none");
    await readMachinePower({ platform: "win32", execFileText });
    // The reader never spawns directly, so the guarantee under test is that it
    // routes through the one helper that sets windowsHide.
    expect(execFileText).toHaveBeenCalledTimes(1);
    const [command, args] = execFileText.mock.calls[0] as unknown as [string, string[]];
    expect(command.toLowerCase()).toContain("powershell.exe");
    expect(args).toEqual(buildWindowsPowerQueryArgs());
  });

  it("publishes nothing for a timed-out read instead of a confident wrong answer", async () => {
    // This is the whole point of the null. A failed read used to return
    // `{ onExternalPower: true }` — truthy, non-null, and indistinguishable
    // downstream from a real reading — so a single `pmset` timeout republished
    // a 20%-on-battery MacBook to the account directory as "plugged in".
    await expect(readMachinePower({
      platform: "darwin",
      execFileText: async () => null,
    })).resolves.toBeNull();
  });

  it("answers null for a timed-out Windows read too", async () => {
    await expect(readMachinePower({
      platform: "win32",
      execFileText: async () => null,
    })).resolves.toBeNull();
  });

  it("publishes nothing when Windows could not read the battery, rather than 'desktop'", async () => {
    await expect(readMachinePower({
      platform: "win32",
      execFileText: async () => "unknown",
    })).resolves.toBeNull();
    // A machine that genuinely has no battery still answers.
    await expect(readMachinePower({
      platform: "win32",
      execFileText: async () => "none",
    })).resolves.toEqual({ onExternalPower: true });
  });

  it("answers null when the platform read throws", async () => {
    await expect(readMachinePower({
      platform: "darwin",
      execFileText: async () => {
        throw new Error("pmset exploded");
      },
    })).resolves.toBeNull();
  });

  it("reports an unsupported platform as unknown, not as on external power", async () => {
    await expect(readMachinePower({ platform: "freebsd" })).resolves.toBeNull();
  });
});

// --- Noticing a suspend nobody announced -------------------------------

/**
 * Drives the detector with a clock the test moves by hand, because the whole
 * point of the detector is that wall-clock time and elapsed timer time
 * disagree — something real timers cannot reproduce.
 */
function harness(thresholdMs = SUSPEND_GAP_THRESHOLD_MS) {
  let clock = 1_000_000;
  const gaps: number[] = [];
  let pending: { handler: () => void; dueAt: number } | null = null;
  const detector = createSuspendGapDetector({
    thresholdMs,
    onGap: (gapMs) => gaps.push(gapMs),
    now: () => clock,
    setTimer: (handler, delayMs) => {
      pending = { handler, dueAt: clock + delayMs };
      return pending;
    },
    clearTimer: () => {
      pending = null;
    },
  });
  return {
    detector,
    gaps,
    /** Move the clock forward and fire the timer if it came due. */
    advance(ms: number): void {
      clock += ms;
      const due = pending;
      if (due && clock >= due.dueAt) {
        pending = null;
        due.handler();
      }
    },
    /** Move the clock without letting the timer fire — this is what sleep is. */
    sleep(ms: number): void {
      clock += ms;
    },
    isArmed: (): boolean => pending !== null,
  };
}

describe("createSuspendGapDetector", () => {
  it("stays quiet while ticks arrive on time", () => {
    const h = harness();
    h.detector.start();
    for (let tick = 0; tick < 5; tick += 1) h.advance(SUSPEND_GAP_TICK_MS);
    expect(h.gaps).toEqual([]);
    expect(h.detector.getLastGapMs()).toBeNull();
  });

  it("reports the whole absence when a tick fires minutes late", () => {
    const h = harness();
    h.detector.start();
    // The machine was out for four minutes: the tick was due 15 s in and did
    // not run until 4 min later.
    h.sleep(SUSPEND_GAP_TICK_MS + 240_000);
    h.advance(0);
    expect(h.gaps).toHaveLength(1);
    expect(h.gaps[0]).toBe(240_000 + SUSPEND_GAP_TICK_MS);
    expect(h.detector.getLastGapMs()).toBe(240_000 + SUSPEND_GAP_TICK_MS);
  });

  it("does not call a busy event loop a suspend", () => {
    const h = harness();
    h.detector.start();
    h.sleep(SUSPEND_GAP_TICK_MS + SUSPEND_GAP_THRESHOLD_MS - 1);
    h.advance(0);
    expect(h.gaps).toEqual([]);
  });

  it("keeps watching after a gap", () => {
    const h = harness();
    h.detector.start();
    h.sleep(SUSPEND_GAP_TICK_MS + 120_000);
    h.advance(0);
    h.sleep(SUSPEND_GAP_TICK_MS + 120_000);
    h.advance(0);
    expect(h.gaps).toHaveLength(2);
    expect(h.isArmed()).toBe(true);
  });

  it("lets an out-of-band check close the gap without waiting for the timer", () => {
    const h = harness();
    h.detector.start();
    // A host with its own wake signal calls check() the moment it resumes.
    h.sleep(SUSPEND_GAP_TICK_MS + 300_000);
    h.detector.check();
    expect(h.gaps).toEqual([300_000 + SUSPEND_GAP_TICK_MS]);
  });

  it("ignores an out-of-band check that arrives before the tick is due", () => {
    const h = harness();
    h.detector.start();
    h.sleep(1_000);
    h.detector.check();
    expect(h.gaps).toEqual([]);
    expect(h.isArmed()).toBe(true);
  });

  it("reports nothing once stopped, however long the machine is out", () => {
    const h = harness();
    h.detector.start();
    h.detector.stop();
    h.sleep(600_000);
    h.detector.check();
    expect(h.gaps).toEqual([]);
    expect(h.isArmed()).toBe(false);
  });
});

// --- Composing both into published state -------------------------------

type FakeGapDetector = SuspendGapDetector & {
  /** Report a gap the way a late timer tick would. */
  fire: (gapMs: number) => void;
  /** Arm a gap that `check()` will find — what an announced resume drains. */
  pendingGapMs: number | null;
  bind: (listener: (gapMs: number) => void) => void;
};

/** A detector the test fires by hand, standing in for a real missed tick. */
function fakeGapDetector(): FakeGapDetector {
  let onGap: ((gapMs: number) => void) | null = null;
  let lastGapMs: number | null = null;
  const detector: FakeGapDetector = {
    pendingGapMs: null,
    start: () => {},
    stop: () => {},
    getLastGapMs: () => lastGapMs,
    check: () => {
      if (detector.pendingGapMs === null) return;
      lastGapMs = detector.pendingGapMs;
      detector.pendingGapMs = null;
    },
    fire: (gapMs: number) => {
      lastGapMs = gapMs;
      onGap?.(gapMs);
    },
    bind: (listener) => {
      onGap = listener;
    },
  };
  return detector;
}

function monitorHarness(power: MachinePower = { onExternalPower: true }) {
  const events: MachinePowerEvent[] = [];
  const detector = fakeGapDetector();
  let clock = 5_000;
  let reading: MachinePower | null = power;
  const monitor = createMachinePowerMonitor({
    now: () => clock,
    readPower: async () => reading,
    createGapDetector: (onGap) => {
      detector.bind(onGap);
      return detector;
    },
  });
  monitor.subscribe((event) => events.push(event));
  return {
    monitor,
    events,
    detector,
    /** What the next `refreshPower()` reads back off the platform. */
    setPower(next: MachinePower | null): void {
      reading = next;
    },
    advance(ms: number): void {
      clock += ms;
    },
  };
}

describe("createMachinePowerMonitor", () => {
  it("starts awake and publishes the platform reading", async () => {
    const h = monitorHarness({ battery: { percent: 71, charging: false }, onExternalPower: false });
    await h.monitor.refreshPower();

    expect(h.monitor.getSleepState()).toBe("awake");
    expect(h.monitor.getPublication()).toEqual({
      power: { batteryPercent: 71, charging: false, onExternalPower: false },
      sleepState: "awake",
      sleepStateAt: expect.any(Number),
    });
  });

  it("publishes a battery-less machine without inventing a percentage", async () => {
    const h = monitorHarness({ onExternalPower: true });
    await h.monitor.refreshPower();

    expect(h.monitor.getPublication().power).toEqual({
      batteryPercent: null,
      charging: null,
      onExternalPower: true,
    });
  });

  it("marks the machine asleep on an announced suspend, before it goes dark", () => {
    const h = monitorHarness();
    h.monitor.noteAnnouncedSuspend();

    expect(h.monitor.getSleepState()).toBe("asleep");
    expect(h.events).toEqual([{ kind: "suspend", at: expect.any(Number), announced: true }]);
  });

  it("ignores a repeated suspend announcement", () => {
    const h = monitorHarness();
    h.monitor.noteAnnouncedSuspend();
    h.monitor.noteAnnouncedSuspend();

    expect(h.events.filter((event) => event.kind === "suspend")).toHaveLength(1);
  });

  it("wakes on an announced resume and carries the measured gap", () => {
    const h = monitorHarness();
    h.monitor.noteAnnouncedSuspend();
    h.detector.pendingGapMs = 240_000;
    h.advance(240_000);
    h.monitor.noteAnnouncedResume();

    expect(h.monitor.getSleepState()).toBe("awake");
    expect(h.monitor.getSuspendGapMs()).toBe(240_000);
    expect(h.events.at(-1)).toEqual({
      kind: "resume",
      at: expect.any(Number),
      gapMs: 240_000,
      announced: true,
    });
  });

  it("emits exactly one resume when the detector and the announcement agree", () => {
    const h = monitorHarness();
    h.monitor.noteAnnouncedSuspend();
    h.detector.pendingGapMs = 90_000;
    h.monitor.noteAnnouncedResume();

    expect(h.events.filter((event) => event.kind === "resume")).toHaveLength(1);
  });

  it("times a short announced sleep by its own announcement, not by an older gap", () => {
    // The detector records only gaps it MEASURED, and a 40-second nap never
    // clears the 60s threshold — so `getLastGapMs()` is still holding last
    // night's four-hour sleep. Reporting that would render "Resumed · paused
    // 4h" for a 40-second lid close and persist the wrong number into the
    // transcript forever.
    const h = monitorHarness();
    h.detector.fire(4 * 60 * 60_000);
    h.monitor.noteAnnouncedSuspend();
    h.advance(40_000);
    h.monitor.noteAnnouncedResume();

    expect(h.monitor.getSuspendGapMs()).toBe(40_000);
    expect(h.events.at(-1)).toMatchObject({ kind: "resume", gapMs: 40_000, announced: true });
  });

  it("falls back to the detector when the resume was announced but the suspend was not", () => {
    const h = monitorHarness();
    h.detector.pendingGapMs = 300_000;
    h.monitor.noteAnnouncedResume();

    expect(h.monitor.getSuspendGapMs()).toBe(300_000);
  });

  it("detects a sleep it was never told about from the heartbeat gap alone", () => {
    // The Linux and headless-brain path: no platform suspend hook exists, so
    // the missed tick is the only evidence there ever was.
    const h = monitorHarness();
    h.detector.fire(300_000);

    expect(h.monitor.getSleepState()).toBe("awake");
    expect(h.monitor.getSuspendGapMs()).toBe(300_000);
    expect(h.events.at(-1)).toEqual({
      kind: "resume",
      at: expect.any(Number),
      gapMs: 300_000,
      announced: false,
    });
  });

  it("re-anchors both stamps when a suspend is announced while still asleep", () => {
    // Reaching a second announced suspend without a resume in between means the
    // FIRST sleep's resume never arrived. The sleep starting now is the one
    // everything downstream must measure: left on the old stamp, the next
    // resume writes "paused 6h" into the transcript for a two-minute nap — the
    // exact lie the announcement stamp was added to prevent — and the state
    // keeps looking fresh to anything that age-bounds it.
    const h = monitorHarness();
    const initial = h.monitor.getSleepStateAt();
    h.advance(60_000);
    h.monitor.noteAnnouncedSuspend();
    const firstSuspendAt = h.monitor.getSleepStateAt();
    // The resume for that sleep is lost: the hop failed and the nap was too
    // short for the gap detector's 60s threshold to notice.
    h.advance(6 * 60 * 60_000);
    h.monitor.noteAnnouncedSuspend();
    const secondSuspendAt = h.monitor.getSleepStateAt();
    h.advance(120_000);
    h.monitor.noteAnnouncedResume();

    expect(firstSuspendAt).toBeGreaterThan(initial);
    expect(secondSuspendAt).toBeGreaterThan(firstSuspendAt);
    expect(h.monitor.getSuspendGapMs()).toBe(120_000);
    expect(h.events.at(-1)).toMatchObject({ kind: "resume", gapMs: 120_000 });
  });

  it("leaves sleepStateAt alone across an ordinary awake-to-awake refresh", async () => {
    // The poll runs every minute and usually finds a changed battery reading.
    // That is a power change, not a sleep transition, so the stamp must not
    // move: anything that age-bounds the published sleep state would otherwise
    // read every machine as freshly-known forever.
    const h = monitorHarness({ battery: { percent: 80, charging: true }, onExternalPower: true });
    await h.monitor.refreshPower();
    const initial = h.monitor.getSleepStateAt();

    h.advance(60_000);
    h.setPower({ battery: { percent: 61, charging: false }, onExternalPower: false });
    await h.monitor.refreshPower();

    expect(h.events.at(-1)).toMatchObject({ kind: "power-change" });
    expect(h.monitor.getSleepState()).toBe("awake");
    expect(h.monitor.getSleepStateAt()).toBe(initial);
  });

  it("ignores a duplicate resume announcement with nothing to wake from", () => {
    // The resume hop retries, and a retry after a timeout can be delivered
    // twice. The second delivery must not replay the last gap this process ever
    // measured as if it had just happened.
    const h = monitorHarness();
    h.monitor.noteAnnouncedSuspend();
    h.advance(45_000);
    h.monitor.noteAnnouncedResume();
    const afterFirst = h.events.length;
    h.advance(1_000);
    h.monitor.noteAnnouncedResume();

    expect(h.events).toHaveLength(afterFirst);
    expect(h.monitor.getSuspendGapMs()).toBe(45_000);
  });

  it("keeps the last known power when a read comes back unreadable", async () => {
    // `readMachinePower` answers null for a machine it could not read. Letting
    // that overwrite a real reading is how one `pmset` timeout republished a
    // laptop on battery as plugged in.
    let reading: MachinePower | null = { battery: { percent: 20, charging: false }, onExternalPower: false };
    const monitor = createMachinePowerMonitor({ readPower: async () => reading });
    await monitor.refreshPower();
    reading = null;
    await monitor.refreshPower();

    expect(monitor.getPower()).toEqual({
      battery: { percent: 20, charging: false },
      onExternalPower: false,
    });
    expect(monitor.getPublication().power).toMatchObject({ onExternalPower: false });
  });

  it("publishes no power at all when the machine was never readable", async () => {
    const monitor = createMachinePowerMonitor({ readPower: async () => null });
    await monitor.refreshPower();

    expect(monitor.getPower()).toBeNull();
    expect(monitor.getPublication().power).toBeNull();
  });

  it("keeps serving other subscribers when one throws", () => {
    const h = monitorHarness();
    const good = vi.fn();
    h.monitor.subscribe(() => {
      throw new Error("consumer blew up");
    });
    h.monitor.subscribe(good);
    h.monitor.noteAnnouncedSuspend();

    expect(good).toHaveBeenCalledTimes(1);
  });

  it("stops reporting once disposed", () => {
    const h = monitorHarness();
    h.monitor.dispose();
    h.monitor.noteAnnouncedSuspend();

    expect(h.events).toEqual([]);
  });
});

function fakeKeepAwakeChild() {
  return Object.assign(new EventEmitter(), {
    kill: vi.fn(() => true),
    unref: vi.fn(),
  });
}

describe("createBrainKeepAwakeService", () => {
  const children: ReturnType<typeof fakeKeepAwakeChild>[] = [];
  const services: Array<ReturnType<typeof createBrainKeepAwakeService>> = [];
  const temporaryDirectories: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    children.length = 0;
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => {
      const child = fakeKeepAwakeChild();
      children.push(child);
      return child;
    });
  });

  afterEach(() => {
    for (const service of services.splice(0)) service.dispose();
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    spawnMock.mockReset();
    execFileOverride.current = null;
    vi.useRealTimers();
  });

  /** One poll interval of the real `start()` timer, with its async read settled. */
  const poll = () => vi.advanceTimersByTimeAsync(5_000);

  /** Starts the service the way the brain does; its first pass runs at once. */
  async function started(service: ReturnType<typeof createBrainKeepAwakeService>) {
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    return service;
  }

  function makeService(
    readActiveAgentWork: () => Promise<boolean | number>,
    options: { platform?: NodeJS.Platform; level?: "never" | "while-away" } = {},
  ) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "brain-keep-awake-test-"));
    temporaryDirectories.push(directory);
    const statePath = path.join(directory, "keep-awake.json");
    fs.writeFileSync(statePath, JSON.stringify({
      version: 1,
      preferences: { level: options.level ?? "while-away" },
      legacyMigrationComplete: true,
    }));
    const service = createBrainKeepAwakeService({
      statePath,
      platform: options.platform ?? "darwin",
      pollMs: 5_000,
      readActiveAgentWork,
    });
    services.push(service);
    return Object.assign(service, {
      savedLevel: () => JSON.parse(fs.readFileSync(statePath, "utf8")).preferences.level as string,
    });
  }

  type ExecDone = (error: Error | null, stdout: string, stderr: string) => void;

  it.each([
    { name: "keeps the choice when Linux grants the lock", failure: null, level: "while-away", reportsError: false },
    { name: "reports a refused Linux lock as soon as the choice is saved", failure: new Error("Access denied"), level: "never", reportsError: true },
  ])("$name", async ({ failure, level, reportsError }) => {
    execFileOverride.current = (_file, _args, _options, done: ExecDone) => done(failure, "", "");
    const service = makeService(async () => false, { platform: "linux", level: "never" });

    const snapshot = await service.setLevel("while-away");

    expect(snapshot.preferences.level).toBe(level);
    expect(service.savedLevel()).toBe(level);
    expect(Boolean(snapshot.levelError)).toBe(reportsError);
  });

  it("does not let a slow Linux lock check overwrite a newer choice", async () => {
    const checks: ExecDone[] = [];
    execFileOverride.current = (_file, _args, _options, done: ExecDone) => checks.push(done);
    const service = makeService(async () => false, { platform: "linux", level: "never" });

    const enabling = service.setLevel("while-away");
    expect(checks).toHaveLength(1);
    await service.setLevel("never");
    checks[0]!(null, "", "");
    const snapshot = await enabling;

    expect(snapshot.preferences.level).toBe("never");
    expect(service.savedLevel()).toBe("never");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("holds one caffeinate child through repeated active polls, releases it when idle, and starts again with work", async () => {
    let active = true;
    await started(makeService(async () => active));
    await poll();
    await poll();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      "/usr/bin/caffeinate",
      ["-i", "-w", String(process.pid)],
      expect.objectContaining({ stdio: "ignore", windowsHide: true }),
    );
    expect(children).toHaveLength(1);

    active = false;
    await poll();
    expect(children[0]?.kill).toHaveBeenCalledTimes(1);

    active = true;
    await poll();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(children[1]).not.toBe(children[0]);
  });

  it("stops a held child for Never, skips later polls, and releases another held child on dispose", async () => {
    const neverService = await started(makeService(async () => true));
    const neverChild = children[0];
    const snapshot = await neverService.setLevel("never");

    expect(snapshot.preferences.level).toBe("never");
    expect(neverChild?.kill).toHaveBeenCalledTimes(1);
    await poll();
    await poll();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const disposeService = await started(makeService(async () => true));
    const disposeChild = children[1];
    expect(spawnMock).toHaveBeenCalledTimes(2);
    disposeService.dispose();
    expect(disposeChild?.kill).toHaveBeenCalledTimes(1);
  });

  it("keeps the lock through brief activity read failures, then releases on the third and resets after success", async () => {
    let failRead = false;
    await started(makeService(() => failRead
      ? Promise.reject(new Error("activity source unavailable"))
      : Promise.resolve(true)));
    const child = children[0];

    failRead = true;
    await poll();
    await poll();
    expect(child?.kill).not.toHaveBeenCalled();

    failRead = false;
    await poll();
    expect(child?.kill).not.toHaveBeenCalled();

    failRead = true;
    await poll();
    await poll();
    expect(child?.kill).not.toHaveBeenCalled();
    await poll();
    expect(child?.kill).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe("cloud keep awake", () => {
  // the provider sleeps a machine after its idle timer; the brain keeps it awake
  // only by reaching the machine's own wake URL. A missed ping while work runs
  // freezes that work; a ping for the wrong machine keeps another one billing.
  it("pings this machine's wake URL while work runs or another machine just did work here, never a copied disk's, and counts an unreadable state as busy", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cloud-keepawake-"));
    const paths = cloudKeepAwakePaths(home);
    fs.mkdirSync(paths.dir, { recursive: true });
    const writeWake = (instanceId: string) =>
      fs.writeFileSync(paths.wakeUrl, JSON.stringify({ instanceId, url: "https://wake-abc.agent37.app" }));
    const pinged: string[] = [];
    let busy: boolean | "throws" = true;
    let clock = 1_000_000;
    const keepAwake = createCloudKeepAwake({
      env: { ADE_CLOUD_INSTANCE_ID: "thisbox001" },
      adeHome: home,
      intervalMs: 60_000,
      now: () => clock,
      readBusy: async () => {
        if (busy === "throws") throw new Error("activity read failed");
        return { busy, reasons: busy ? ["chat"] : [] };
      },
      fetch: async (url) => {
        pinged.push(url);
        return { status: 502 };
      },
    });
    try {
      writeWake("sourcebox1"); // the disk was forked from another machine
      await keepAwake.tick();
      expect(pinged).toEqual([]);

      writeWake("thisbox001");
      await keepAwake.tick();
      expect(pinged).toEqual(["https://wake-abc.agent37.app"]);
      expect(JSON.parse(fs.readFileSync(paths.state, "utf8"))).toMatchObject({ v: 1, busy: true, hasWakeUrl: true });

      busy = false;
      await keepAwake.tick();
      expect(pinged).toHaveLength(1);

      // A command another machine ran here keeps it awake until the next
      // ping, and only that long: an idle box still sleeps.
      await keepAwake.noteUse();
      await keepAwake.tick();
      expect(pinged).toHaveLength(2);
      clock += 61_000;
      await keepAwake.tick();
      expect(pinged).toHaveLength(2);

      // No ping for a while: work near the sleep timer pings at once, not at the next tick.
      await keepAwake.noteUse();
      expect(pinged).toHaveLength(3);
      await keepAwake.tick();
      expect(pinged).toHaveLength(3);

      busy = "throws";
      await keepAwake.tick();
      expect(pinged).toHaveLength(4);
    } finally {
      keepAwake.dispose();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("cloud busy terminals", () => {
  // What a terminal runs decides whether a restart (a disk grow, an update) may cut it. ADE reopens its own agent
  // CLIs after a restart; a command, or an agent CLI someone started by hand, would be cut. An `ade` command that
  // waits on its own disk grow is named apart, so that grow doesn't wait on the terminal that asked for it.
  const now = 10_000_000;
  const terminal = (patch: Partial<CloudBusyTerminal>): CloudBusyTerminal => ({
    kind: "shell", state: "running", atPrompt: false, foreground: null, foregroundArgs: null, lastOutputAt: now - 1_000, lastInputAt: 0, ...patch,
  });
  it.each<[string, CloudBusyTerminal, string[]]>([
    ["a shell at its prompt: idle", terminal({ atPrompt: true }), []],
    ["a quiet command in a shell: a restart would cut it", terminal({ foreground: "sleep", foregroundArgs: ["sleep", "300"] }), ["terminal"]],
    ["ADE's own agent CLI at work: it continues after a restart", terminal({ kind: "agent_cli", foreground: "claude" }), ["agent_cli"]],
    ["an agent CLI started by hand in a shell: a restart would cut it", terminal({ foreground: "claude", foregroundArgs: ["claude"] }), ["shell_agent_cli"]],
    ["`ade cloud resize --free` waiting on its grow", terminal({ foreground: "node", foregroundArgs: ["node", "/home/ade/.ade/bin/cli.cjs", "cloud", "resize", "--free", "8", "--reason", "room"] }), ["disk_grow_command"]],
    ["`ade android start`, whose first boot grows the disk", terminal({ foreground: "ade", foregroundArgs: ["/usr/local/bin/ade", "android", "start", "--lane", "x"] }), ["disk_grow_command"]],
    ["`ade cloud resize --request`, which grows nothing itself: a command", terminal({ foreground: "node", foregroundArgs: ["node", "cli.cjs", "cloud", "resize", "--request", "--size", "large"] }), ["terminal"]],
    ["a command untouched for an hour: idle", terminal({ foreground: "sleep", foregroundArgs: ["sleep", "9999"], lastOutputAt: now - 61 * 60_000 }), []],
  ])("%s", (_label, busyTerminal, reasons) => {
    const decided = decideCloudBusy({ chats: [], terminals: [busyTerminal], setupRunning: false, holds: [] }, now);

    expect(decided.reasons).toEqual(reasons);
    expect(decided.busy).toBe(reasons.length > 0);
    expect(decided.waitingOnPerson).toBe(false);
  });
});

describe("cloud disk grow for a lane setup", () => {
  const GB = 1024 ** 3;
  const ENOSPC = "Setup ran out of disk space (no space left on device). Last error: npm error nospc ENOSPC: no space left on device, write";
  /** The disk as statfs reads it: `free` of `total`, in GB. */
  const disk = (free: number, total: number) => ({ bsize: 4096, blocks: (total * GB) / 4096, bavail: (free * GB) / 4096 }) as fs.StatsFs;

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Each run: the free space it started with, the lowest it read while it ran, what the disk read when setup said ENOSPC,
  // the disk's size, and whether the server grows it when asked (default) or refuses (the plan's disk).
  it.each([
    ["a disk with room left (a tool's own limit, not the disk)", [[3.5, 3, 3, 8]], [false]],
    ["a disk that really ran short", [[3.5, 0.2, 0.2, 8]], [true]],
    ["a disk that ran short, then read roomy again once the failed install cleaned up", [[3.5, 0.1, 3.4, 8]], [true]],
    ["a second fill that peaked no higher than the first (the disk didn't grow)", [[3.5, 0.2, 0.2, 8], [3.5, 0.3, 3.2, 8]], [true, false]],
    // Leaves its files behind on failure and frees them in the next run: each run adds about the same, and fills a bigger disk.
    ["an installer that doesn't clean up, filling 4 GB, then 8, then 12", [[3.5, 0.1, 0.1, 4], [4.1, 0.1, 0.1, 8], [4.1, 0.1, 0.1, 12]], [true, true, true]],
    // The plan's disk refused the grow; the person made room and pressed Retry: the same fill asks again.
    ["a grow the server refused, then a Retry that fills the same disk", [[3.5, 0.2, 0.2, 8, "refuses"], [3.5, 0.2, 0.2, 8]], [true, true]],
    // The rollback itself can't be written on the disk that just filled: it still holds for the Retry.
    ["a refused grow whose rollback couldn't be saved, then a Retry", [[3.5, 0.2, 0.2, 8, "refuses, disk full"], [3.5, 0.2, 0.2, 8]], [true, true]],
    // Taking a refused grow back keeps the grow before it: a later fill no higher than that one's peak doesn't grow.
    ["a grow, a refused grow, then a fill no higher than the first", [[3.5, 0.2, 0.2, 8], [4.1, 0.1, 0.1, 12, "refuses"], [3.5, 0.3, 0.3, 8]], [true, true, false]],
  ] as Array<[string, Array<[number, number, number, number, ("refuses" | "refuses, disk full" | undefined)?]>, boolean[]]>)("%s", async (_label, runs, grows) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cloud-disk-grow-"));
    try {
      vi.useFakeTimers();
      // The reserve's 4 MB never reaches the test machine's disk.
      vi.spyOn(fs.promises, "mkdir").mockResolvedValue(undefined);
      vi.spyOn(fs.promises, "writeFile").mockResolvedValue(undefined);
      const statfs = vi.spyOn(fs, "statfsSync");
      let diskGb = 0;
      let refuse: "refuses" | "refuses, disk full" | undefined;
      let historyDiskFull = false;
      const writeFileSync = fs.writeFileSync;
      vi.spyOn(fs, "writeFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        if (historyDiskFull && String(file).includes("setup-disk-grows")) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        return (writeFileSync as (...args: unknown[]) => void)(file, ...rest);
      }) as typeof fs.writeFileSync);
      // The account server: this computer's size, and a grow it starts or refuses. Anything else answers empty.
      const server = new Proxy({
        getInstance: async () => ({ resources: { cpu: 2, memory: 4, disk: diskGb }, metadata: {} }),
        getAccount: async () => { throw new Error("no catalog here"); },
        resizeInstance: async () => {
          if (refuse) historyDiskFull = refuse === "refuses, disk full";
          if (refuse) throw new CloudProviderError("The plan's disk is full.", "disk_limit", 403, { reason: "account_limit" });
          return "updating";
        },
      } as Record<string, unknown>, { get: (target, key) => (key === "then" ? undefined : target[key as string] ?? (async () => ({}))) });
      const setup = createCloudDiskGrower({ instanceId: "i-1", client: async () => server as never, path: home, adeHome: home }).setupDisk(() => true);
      const answers: boolean[] = [];
      for (const [startFree, lowFree, fullFree, total, answerOfServer] of runs) {
        diskGb = total;
        refuse = answerOfServer;
        // The person freed disk before this run: writes land again.
        historyDiskFull = false;
        statfs.mockReturnValue(disk(startFree!, total!));
        setup.setupStarting({ launchId: "launch-1" });
        // The install runs: the disk reads its low point, then whatever it reads when setup says ENOSPC.
        statfs.mockReturnValue(disk(lowFree!, total!));
        vi.advanceTimersByTime(5_000);
        statfs.mockReturnValue(disk(fullFree!, total!));
        const answer = setup.diskFull({ launchId: "launch-1", error: ENOSPC });
        // The launch saved its mark: a grow the server started counts; a refused one doesn't.
        if (answer.grow) {
          const room = await setup.makeRoom({ launchId: "launch-1", laneId: "lane-1", signal: new AbortController().signal });
          // A Retry after a refusal really reaches the server and starts its grow.
          expect(room?.state).toBe(refuse ? "refused" : "growing");
        }
        setup.setupEnded({ launchId: "launch-1" });
        answers.push(answer.grow);
      }
      expect(answers).toEqual(grows);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("a setup that fills the disk after a restart waits on the grow an earlier boot asked for, never asking twice", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cloud-disk-grow-"));
    const controller = new AbortController();
    try {
      vi.spyOn(fs, "statfsSync").mockReturnValue(disk(0.2, 4));
      // The last boot asked for 8 GB a minute ago; the disk still reads 4.
      fs.mkdirSync(path.dirname(cloudDiskGrowStatePath(home)), { recursive: true });
      fs.writeFileSync(cloudDiskGrowStatePath(home), JSON.stringify({ v: 1, state: "growing", toGb: 8, at: Date.now() - 60_000, instanceId: "i-1", fromBytes: 4 * GB }));
      const client = vi.fn(async () => null);
      const grower = createCloudDiskGrower({ instanceId: "i-1", client, path: home, adeHome: home });

      const room = await grower.makeRoomForSetup({ stillIdle: () => true, signal: controller.signal });

      expect(room).toMatchObject({ state: "growing", detail: expect.stringContaining("8 GB") });
      expect(client).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("cloud disk grow an agent or the Android emulator asks for", () => {
  const GB = 1024 ** 3;
  const disk = (free: number, total: number) => ({ bsize: 4096, blocks: (total * GB) / 4096, bavail: (free * GB) / 4096 }) as fs.StatsFs;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // An X-Large computer with an 8 GB disk and 2.7 GB free asks for 7.2 GB free: a 16 GB disk. Plus has 30 GB at one
  // time; `usedGb` is all the account's computers now. Extra disk is $2 for 10 GB a month, the monthly limit $10:
  // from 26 GB used the grow goes 4 GB past the plan, about 80¢ a month. The approval answers yes, no, or the agent
  // limits' refusal (decided in `cloud.grow_disk`'s approval, `cloudAgentActions.test.ts`). `usedAfterAsk`: another
  // computer took more of the plan's disk while the approval waited, so the grow now costs more.
  it.each([
    ["inside the plan's disk: it grows with no card", { usedGb: 8, extra: "off" }, "yes", { asked: 0, grows: true, state: "grown" }],
    ["past the plan with extra disk on: the person's yes on a card, then it grows", { usedGb: 26, extra: "on" }, "yes", { asked: 1, grows: true, state: "grown" }],
    ["past the plan with extra disk on, and the person says no: nothing grows", { usedGb: 26, extra: "on" }, "no", { asked: 1, grows: false, state: "declined" }],
    ["past the plan with extra disk turned down: no card, the computers holding the disk named", { usedGb: 26, extra: "asked" }, "yes", { asked: 0, grows: false, state: "limit" }],
    ["past the agents' extra disk: nothing grows, the computers holding the disk named", { usedGb: 26, extra: "on" }, "agent_limit", { asked: 1, grows: false, state: "limit", reason: "agent_limit" }],
    ["the cost rises while the approval waits: asked again at the new cost, then it grows", { usedGb: 26, extra: "on", usedAfterAsk: 28 }, "yes", { asked: 2, grows: true, state: "grown" }],
    ["the account's extra disk never turned on: no card, nothing grows", { usedGb: 26, extra: "off" }, "yes", { asked: 0, grows: false, state: "limit", reason: "needs_approval" }],
    ["past the account's own monthly limit: no card, nothing grows", { usedGb: 78, extra: "on" }, "yes", { asked: 0, grows: false, state: "limit", reason: "monthly_limit" }],
  ] as Array<[string, { usedGb: number; extra: "off" | "on" | "asked"; usedAfterAsk?: number }, "yes" | "no" | "agent_limit", { asked: number; grows: boolean; state: string; reason?: string }]>)("%s", async (_label, account, answer, expected) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cloud-disk-fit-"));
    try {
      const statfs = vi.spyOn(fs, "statfsSync").mockReturnValue(disk(2.7, 8));
      const resized: number[] = [];
      const client = {
        getInstance: async () => ({ id: "i-1", type: "vm", resources: { cpu: 4, memory: 16, disk: 8 }, metadata: {} }),
        getAccount: async () => ({
          plan: "paid",
          rules: "paid",
          planId: "plus",
          disk: { usedGb: approveExtra.mock.calls.length && account.usedAfterAsk != null ? account.usedAfterAsk : account.usedGb, limitGb: 30 },
          extraDisk: { available: true, state: account.extra, monthlyLimitCents: 1000, usedCents: 0 },
          catalog: { ...cloudCatalogOf(null), extraDiskCentsPer10GbMonth: 200 },
        }),
        listInstances: async () => [
          { id: "i-1", name: null, resources: { cpu: 4, memory: 16, disk: 8 }, metadata: { ade_lane_name: "android-lane" } },
          { id: "i-2", name: "web box", resources: { cpu: 2, memory: 4, disk: 18 }, metadata: {} },
        ],
        resizeInstance: async (_id: string, resources: { disk?: number }) => {
          resized.push(resources.disk ?? 0);
          // The bigger disk lands (here without the restart that would end the brain).
          statfs.mockReturnValue(disk(10.5, resources.disk ?? 8));
          return "running";
        },
        patchMetadata: async () => undefined,
        setInstanceMetadata: async () => undefined,
      };
      const approveExtra = vi.fn(async (_fit: { toGb: number; monthCents: number }) =>
        answer === "agent_limit" ? { reason: "agent_limit" as const, sentence: "Past what agents may use alone." } : answer === "yes");
      const grower = createCloudDiskGrower({ instanceId: "i-1", client: async () => client as never, path: home, adeHome: home });

      const result = await grower.growToFit({ needFreeBytes: 7.2 * GB, reason: "Android emulator first boot", origin: "android", stillIdle: () => true, approveExtra });

      expect(result.state).toBe(expected.state);
      expect(approveExtra).toHaveBeenCalledTimes(expected.asked);
      // A second ask is at the cost the account has now, not the first one's.
      if (expected.asked === 2) expect(approveExtra.mock.calls[1]![0].monthCents).toBeGreaterThan(approveExtra.mock.calls[0]![0].monthCents);
      expect(resized).toEqual(expected.grows ? [16] : []);
      if (result.state === "limit") {
        expect(result.lanes).toEqual([{ laneName: "android-lane", diskGb: 8 }, { laneName: "web box", diskGb: 18 }]);
        if (expected.reason) expect(result.reason).toBe(expected.reason);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("cloud setup upsize for a lane setup that ran out of memory", () => {
  const OUT_OF_MEMORY = "Setup used nearly all of this computer's memory (4 GB), so ADE stopped it before the computer had to restart. Use a bigger size, or make setup use less memory, then retry.";

  // How the launch's record reads its size choice, what the account server answers the ask (a move it starts, its
  // 409 `size_kept`, a refusal, a lost answer), whether that run's setup moved up, and whether the next run of the
  // same launch on the same Small may ask again.
  it.each<[string, "default" | "picked" | "unreadable", "starts" | "kept" | "out_of_hours" | "lost", "growing" | "refused", boolean]>([
    ["a move the server starts", "default", "starts", "growing", false],
    ["a lost answer (the move may have happened)", "default", "lost", "growing", false],
    ["a size the server keeps (picked for the launch)", "unreadable", "kept", "refused", true],
    ["a size the launch's record says was picked: never asked", "picked", "starts", "refused", true],
    ["a move refused for hours", "default", "out_of_hours", "refused", true],
  ])("%s", async (_label, choice, answer, state, asksAgain) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cloud-upsize-"));
    try {
      const resizes: unknown[] = [];
      const server = {
        getInstance: async () => ({ resources: { cpu: 2, memory: 4, disk: 8 }, metadata: {} }),
        getAccount: async () => { throw new Error("no catalog here"); },
        resizeInstance: async (...args: unknown[]) => {
          resizes.push(args);
          if (answer === "kept") throw new CloudProviderError("Small was picked for this launch, so ADE didn't move it up.", "size_kept", 409, { reason: "picked" });
          if (answer === "out_of_hours") throw new CloudProviderError("You're out of hours.", "out_of_hours", 402);
          if (answer === "lost") throw new CloudProviderError("ADE Cloud did not answer in time. Try again.", "timeout", 0);
          return "updating";
        },
      };
      const readLaunch = async () => {
        if (choice === "unreadable") throw new Error("network down");
        return { request: { sizeChoice: choice } };
      };
      const upsizer = createCloudSetupUpsizer({ instanceId: "i-1", client: async () => server as never, adeHome: home, memTotalMb: () => 3_900, readLaunch });
      const setup = upsizer.setupMemory(() => true);
      const controller = new AbortController();

      expect(setup.outOfMemory({ launchId: "launch-1", error: OUT_OF_MEMORY })).toEqual({ upsize: true });
      const room = await setup.moreMemory({ launchId: "launch-1", laneId: "lane-1", signal: controller.signal });
      controller.abort();

      expect(room?.state).toBe(state);
      // The move asked for is Medium, for this launch, as the computer's own; a picked size is never asked to move.
      expect(resizes).toEqual(choice === "picked" ? [] : [["i-1", { cpu: 4, memory: 8 }, { computerIdle: true, origin: "auto", launchId: "launch-1" }]]);
      if (room?.state === "refused") expect(room.error).toMatch(/^Setup used nearly all of this computer's memory .*\. \S/);
      // A move that started counts (one step per launch); one that didn't is taken back, so a Retry asks again.
      expect(createCloudSetupUpsizer({ instanceId: "i-1", client: async () => server as never, adeHome: home, memTotalMb: () => 3_900 })
        .setupMemory(() => true).outOfMemory({ launchId: "launch-1", error: OUT_OF_MEMORY }).upsize).toBe(asksAgain);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("a computer already bigger than a Small never asks to move", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cloud-upsize-"));
    try {
      const client = vi.fn(async () => null);
      const setup = createCloudSetupUpsizer({ instanceId: "i-1", client, adeHome: home, memTotalMb: () => 7_800 }).setupMemory(() => true);
      expect(setup.outOfMemory({ launchId: "launch-1", error: OUT_OF_MEMORY })).toEqual({ upsize: false, error: OUT_OF_MEMORY });
      expect(client).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// A plan change, an automation end or a project delete removes an awake
// computer right after its prepare and save. Work that starts between the two
// is lost with the computer, so the prepare freezes new work, and the freeze
// must end whenever the server will keep the computer.
describe("cloud prepare-stop before a delete", () => {
  afterEach(() => {
    liftCloudDeleteFreeze();
  });

  /** One project runtime; `busy` turns are still running when the prepare reads it. */
  function runtimeWith(args: { busy: () => number; onInterrupt?: () => void }) {
    return {
      agentChatService: {
        interruptRunningTurns: async (options?: { onStopping?: (sessionId: string) => void }) => {
          options?.onStopping?.("chat-1");
          args.onInterrupt?.();
          return 1;
        },
        listBusyFacts: () => Array.from({ length: args.busy() }, () => ({ waitingOnPerson: false, lastActivityAt: 0 })),
      },
      ptyService: { interruptAgentClis: () => 0 },
    } as never;
  }

  it.each<[string, { forDelete: boolean; busy: () => number; timeoutMs: number }, boolean]>([
    ["confirmed for a delete: frozen until the delete", { forDelete: true, busy: () => 0, timeoutMs: 40_000 }, true],
    ["a turn still runs at the deadline: the server keeps it, so no freeze", { forDelete: true, busy: () => 1, timeoutMs: 1_000 }, false],
    ["not for a delete (the 0-hours stop, a Sleep): no freeze", { forDelete: false, busy: () => 0, timeoutMs: 40_000 }, false],
  ])("%s", async (_label, input, frozen) => {
    let refusedDuringPrepare: string | null = null;
    const result = await prepareCloudComputerToStop({
      runtimes: [runtimeWith({ busy: input.busy, onInterrupt: () => { refusedDuringPrepare = cloudDeleteFreezeRefusal(); } })],
      timeoutMs: input.timeoutMs,
      forDelete: input.forDelete,
    });

    expect(result.frozen).toBe(frozen);
    // From the start of a delete's prepare, so nothing starts between the interrupts and the save.
    expect(refusedDuringPrepare).toBe(input.forDelete ? CLOUD_COMPUTER_REMOVING_SENTENCE : null);
    expect(cloudDeleteFreezeRefusal()).toBe(frozen ? CLOUD_COMPUTER_REMOVING_SENTENCE : null);
    // A computer the server never deletes takes work again on its own.
    expect(cloudDeleteFreezeRefusal(Date.now() + CLOUD_DELETE_FREEZE_MS + 1)).toBeNull();
    // The stopped chat's saved row reads Stopped while the computer rests.
    expect(cloudChatStoppedForRest("chat-1")).toBe(true);
  });

  it("a prepare that fails part way leaves nothing frozen", async () => {
    const broken = runtimeWith({ busy: () => { throw new Error("chat service gone"); } });

    await expect(prepareCloudComputerToStop({ runtimes: [broken], timeoutMs: 40_000, forDelete: true })).rejects.toThrow("chat service gone");

    expect(cloudDeleteFreezeRefusal()).toBeNull();
  });
});
