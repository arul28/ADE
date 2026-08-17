import { describe, expect, it, vi } from "vitest";
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
  const monitor = createMachinePowerMonitor({
    now: () => clock,
    readPower: async () => power,
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

  it("leaves sleepStateAt alone across an ordinary awake-to-awake refresh", () => {
    const h = monitorHarness();
    const initial = h.monitor.getSleepStateAt();
    h.advance(60_000);

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
