import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BRAIN_LOOP_WATCHDOG_BREADCRUMB_FILE,
  BRAIN_LOOP_WATCHDOG_LAST_WEDGE_FILE,
  BRAIN_LOOP_WATCHDOG_LAST_REPORT_FILE,
  BRAIN_LOOP_WATCHDOG_REPORT_FILE,
  DEFAULT_BRAIN_LOOP_WATCHDOG_MS,
  buildBrainLoopWatchdogWorkerSource,
  evaluateBrainLoopWatchdog,
  readBrainLoopWatchdogLastWedge,
  recoverBrainLoopWatchdogBreadcrumb,
  classifyBrainLoopLag,
  DEFAULT_BRAIN_RSS_RESTART_BYTES,
  initialBrainMemoryPressureState,
  resolveBrainLoopWatchdogThresholdMs,
  resolveBrainRssRestartBytes,
  trackBrainMemoryPressure,
  startBrainLoopWatchdog,
} from "./brainLoopWatchdog";

describe("brainLoopWatchdog", () => {
  it("allows a 30 second event-loop stall before the watchdog terminates the brain", () => {
    expect(DEFAULT_BRAIN_LOOP_WATCHDOG_MS).toBe(30_000);
  });

  it("builds a valid worker program from the tested watchdog evaluator", () => {
    expect(() => new Function(buildBrainLoopWatchdogWorkerSource())).not.toThrow();
  });

  it("detects a main-thread heartbeat gap while the worker check cadence stays healthy", () => {
    expect(evaluateBrainLoopWatchdog({
      nowWallMs: 20_000,
      nowMonotonicMs: 20_000,
      lastHeartbeatWallMs: 4_000,
      lastHeartbeatMonotonicMs: 4_000,
      previousCheckWallMs: 19_000,
      previousCheckMonotonicMs: 19_000,
      thresholdMs: 15_000,
      checkIntervalMs: 1_000,
    })).toEqual({
      blocked: true,
      blockedMs: 16_000,
      slept: false,
      sleepGapMs: 0,
    });
  });

  it("skips a suspend/resume gap when worker wall and monotonic clocks jump together", () => {
    expect(evaluateBrainLoopWatchdog({
      nowWallMs: 120_000,
      nowMonotonicMs: 120_000,
      lastHeartbeatWallMs: 1_000,
      lastHeartbeatMonotonicMs: 1_000,
      previousCheckWallMs: 2_000,
      previousCheckMonotonicMs: 2_000,
      thresholdMs: 15_000,
      checkIntervalMs: 1_000,
    })).toEqual({
      blocked: false,
      blockedMs: 119_000,
      slept: true,
      // Reported to the main thread, which cannot measure its own absence.
      sleepGapMs: 118_000,
    });
  });

  it("uses both clocks so a wall-clock adjustment alone cannot trigger a kill", () => {
    expect(evaluateBrainLoopWatchdog({
      nowWallMs: 80_000,
      nowMonotonicMs: 5_000,
      lastHeartbeatWallMs: 1_000,
      lastHeartbeatMonotonicMs: 4_000,
      previousCheckWallMs: 79_000,
      previousCheckMonotonicMs: 4_000,
      thresholdMs: 15_000,
      checkIntervalMs: 1_000,
    })).toMatchObject({
      blocked: false,
      blockedMs: 1_000,
      slept: false,
    });
  });

  // The 2026-08-20 report: 17-minute heartbeat lags with `lastCommand: "idle"`,
  // 2-5 seconds of CPU across the whole gap, and an event-loop histogram that
  // sometimes read zero. Every one of those was logged as a near miss.
  it("reads a suspended process as a suspension, not as a near miss", () => {
    expect(classifyBrainLoopLag({
      heartbeatLagMs: 1_048_563,
      eventLoopDelayMaxMs: 0,
      cpuDeltaMs: 4_000,
      sleepObserved: true,
    })).toEqual({
      verdict: "suspended",
      suspensionShaped: true,
      observedLagMs: 1_048_563,
    });
  });

  it("holds the same lag as a stall until the worker confirms it slept", () => {
    // Identical numbers, minus the worker's report. Nothing else can tell a
    // suspended process from one blocked in a syscall, so it stays a stall.
    expect(classifyBrainLoopLag({
      heartbeatLagMs: 1_048_563,
      eventLoopDelayMaxMs: 0,
      cpuDeltaMs: 4_000,
      sleepObserved: false,
    })).toMatchObject({ verdict: "stall", suspensionShaped: true });
  });

  it("still warns about a genuine stall, however long it lasted", () => {
    // A busy loop: the gap and the CPU it burned are the same length, and the
    // worker kept ticking through it.
    expect(classifyBrainLoopLag({
      heartbeatLagMs: 600_000,
      eventLoopDelayMaxMs: 599_000,
      cpuDeltaMs: 598_000,
      sleepObserved: true,
    })).toEqual({
      verdict: "stall",
      suspensionShaped: false,
      observedLagMs: 600_000,
    });
  });

  it("never excuses a short stutter as sleep", () => {
    expect(classifyBrainLoopLag({
      heartbeatLagMs: 4_000,
      eventLoopDelayMaxMs: 3_900,
      cpuDeltaMs: 0,
      sleepObserved: true,
    })).toMatchObject({ verdict: "stall", suspensionShaped: false });
  });

  it("says nothing about an ordinary heartbeat", () => {
    expect(classifyBrainLoopLag({
      heartbeatLagMs: 12,
      eventLoopDelayMaxMs: 24,
      cpuDeltaMs: 30,
      sleepObserved: false,
    }).verdict).toBe("normal");
  });

  it("only reports pressure after a full run of samples over the threshold", () => {
    const threshold = 1_000;
    let state = initialBrainMemoryPressureState();
    const feed = (rssBytes: number, nowMonotonicMs: number) => {
      const outcome = trackBrainMemoryPressure({
        state,
        rssBytes,
        thresholdBytes: threshold,
        nowMonotonicMs,
      });
      state = outcome.state;
      return outcome;
    };

    expect(feed(2_000, 0).triggered).toBe(false);
    expect(feed(2_000, 300_000).triggered).toBe(false);
    const third = feed(2_000, 600_000);
    expect(third.triggered).toBe(true);
    expect(third.sustainedMs).toBe(600_000);
    // Not on every sample after that: a leak that keeps growing must not
    // restart in a loop.
    for (let sample = 4; sample <= 14; sample += 1) {
      expect(feed(2_000, sample * 300_000).triggered, `sample ${sample}`).toBe(false);
    }
    // But it does ask again on the slow cadence. The host may have deferred or
    // failed the restart, and the memory it was asked about is still held.
    expect(feed(2_000, 15 * 300_000).triggered).toBe(true);
    expect(feed(2_000, 16 * 300_000).triggered).toBe(false);
  });

  it("forgets a run the moment memory comes back down", () => {
    const threshold = 1_000;
    let state = initialBrainMemoryPressureState();
    for (const rssBytes of [2_000, 2_000]) {
      state = trackBrainMemoryPressure({
        state,
        rssBytes,
        thresholdBytes: threshold,
        nowMonotonicMs: 0,
      }).state;
    }
    state = trackBrainMemoryPressure({
      state,
      rssBytes: 500,
      thresholdBytes: threshold,
      nowMonotonicMs: 300_000,
    }).state;
    expect(state).toEqual(initialBrainMemoryPressureState());
  });

  it("reports nothing when the mitigation is turned off", () => {
    expect(trackBrainMemoryPressure({
      state: initialBrainMemoryPressureState(),
      rssBytes: 8_000_000_000,
      thresholdBytes: null,
      nowMonotonicMs: 0,
      requiredSamples: 1,
    }).triggered).toBe(false);
  });

  it("reads the restart threshold without letting a typo arm a restart loop", () => {
    expect(resolveBrainRssRestartBytes(undefined)).toBe(DEFAULT_BRAIN_RSS_RESTART_BYTES);
    expect(resolveBrainRssRestartBytes("nonsense")).toBe(DEFAULT_BRAIN_RSS_RESTART_BYTES);
    expect(resolveBrainRssRestartBytes("0")).toBeNull();
    expect(resolveBrainRssRestartBytes("off")).toBeNull();
    // A zero in any unit is the same explicit "off" as the word: only an
    // unparseable value earns the default back.
    expect(resolveBrainRssRestartBytes("0kb")).toBeNull();
    expect(resolveBrainRssRestartBytes("0 mb")).toBeNull();
    expect(resolveBrainRssRestartBytes("2000000000")).toBe(2_000_000_000);
    // A threshold an idle brain is already over would restart it forever.
    expect(resolveBrainRssRestartBytes("1000")).toBe(268_435_456);
    // A unit suffix is read, not truncated. `parseInt` read "1gb" as 1, which
    // the floor above then turned into 256 MB -- the restart chain the floor
    // exists to prevent.
    expect(resolveBrainRssRestartBytes("1gb")).toBe(1_073_741_824);
    expect(resolveBrainRssRestartBytes("2 GB")).toBe(2_147_483_648);
    expect(resolveBrainRssRestartBytes("1500mb")).toBe(1_572_864_000);
    // Anything the whole value does not explain falls back to the default.
    expect(resolveBrainRssRestartBytes("1.5e9")).toBe(DEFAULT_BRAIN_RSS_RESTART_BYTES);
    expect(resolveBrainRssRestartBytes("2000000000 bytes")).toBe(DEFAULT_BRAIN_RSS_RESTART_BYTES);
  });

  it("allows Windows background work more time before declaring the brain wedged", () => {
    expect(resolveBrainLoopWatchdogThresholdMs(undefined, "win32")).toBe(60_000);
    expect(resolveBrainLoopWatchdogThresholdMs(undefined, "darwin")).toBe(30_000);
    expect(resolveBrainLoopWatchdogThresholdMs("45000", "win32")).toBe(45_000);
  });

  it("renames a crash breadcrumb to last-wedge and emits the recovery warning", () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-loop-watchdog-"));
    const breadcrumb = {
      lastCommand: "ai.getStatus",
      blockedMs: 16_250,
      ts: "2026-07-23T12:00:00.000Z",
    };
    fs.writeFileSync(
      path.join(runtimeDir, BRAIN_LOOP_WATCHDOG_BREADCRUMB_FILE),
      JSON.stringify(breadcrumb),
      "utf8",
    );
    const warn = vi.fn();
    try {
      expect(recoverBrainLoopWatchdogBreadcrumb({ runtimeDir, warn })).toEqual(breadcrumb);
      expect(warn).toHaveBeenCalledWith("brain.recovered_from_wedge", breadcrumb);
      expect(fs.existsSync(path.join(runtimeDir, BRAIN_LOOP_WATCHDOG_BREADCRUMB_FILE))).toBe(false);
      expect(JSON.parse(
        fs.readFileSync(path.join(runtimeDir, BRAIN_LOOP_WATCHDOG_LAST_WEDGE_FILE), "utf8"),
      )).toEqual(breadcrumb);
      expect(readBrainLoopWatchdogLastWedge(runtimeDir)).toEqual(breadcrumb);
    } finally {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("preserves watchdog diagnostics and recovers the matching Node report", () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-loop-watchdog-report-"));
    const breadcrumb = {
      lastCommand: "idle",
      blockedMs: 31_250,
      ts: "2026-08-01T04:11:00.000Z",
      thresholdMs: 30_000,
      diagnostics: {
        capturedAt: "2026-08-01T04:10:29.000Z",
        heartbeatLagMs: 12,
        eventLoopDelay: { maxMs: 24, meanMs: 20, p99Ms: 23 },
        memory: {
          rss: 1_000,
          heapTotal: 900,
          heapUsed: 800,
          external: 100,
          arrayBuffers: 50,
        },
        resources: {
          userCpuMicros: 10,
          systemCpuMicros: 20,
          maxRssKb: 30,
          minorPageFaults: 40,
          majorPageFaults: 50,
          fsReads: 60,
          fsWrites: 70,
          voluntaryContextSwitches: 80,
          involuntaryContextSwitches: 90,
        },
      },
      diagnosticReportPath: path.join(runtimeDir, BRAIN_LOOP_WATCHDOG_REPORT_FILE),
    };
    fs.writeFileSync(
      path.join(runtimeDir, BRAIN_LOOP_WATCHDOG_BREADCRUMB_FILE),
      JSON.stringify(breadcrumb),
      "utf8",
    );
    fs.writeFileSync(
      path.join(runtimeDir, BRAIN_LOOP_WATCHDOG_REPORT_FILE),
      "diagnostic report",
      "utf8",
    );
    try {
      const recovered = recoverBrainLoopWatchdogBreadcrumb({ runtimeDir, warn: vi.fn() });
      expect(recovered).toEqual({
        ...breadcrumb,
        diagnosticReportPath: path.join(runtimeDir, BRAIN_LOOP_WATCHDOG_LAST_REPORT_FILE),
      });
      expect(fs.existsSync(path.join(runtimeDir, BRAIN_LOOP_WATCHDOG_REPORT_FILE))).toBe(false);
      expect(fs.readFileSync(
        path.join(runtimeDir, BRAIN_LOOP_WATCHDOG_LAST_REPORT_FILE),
        "utf8",
      )).toBe("diagnostic report");
      expect(readBrainLoopWatchdogLastWedge(runtimeDir)).toEqual(recovered);
    } finally {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("reports a recovered breadcrumb once before a disabled watchdog returns", () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-loop-watchdog-capture-"));
    const breadcrumb = {
      lastCommand: "chat.send",
      blockedMs: 18_000,
      ts: "2026-07-23T12:00:00.000Z",
    };
    fs.writeFileSync(
      path.join(runtimeDir, BRAIN_LOOP_WATCHDOG_BREADCRUMB_FILE),
      JSON.stringify(breadcrumb),
      "utf8",
    );
    const onRecovered = vi.fn();
    try {
      const stop = startBrainLoopWatchdog({
        runtimeDir,
        env: { ADE_DISABLE_LOOP_WATCHDOG: "1" },
        warn: vi.fn(),
        onRecovered,
      });
      stop();
      expect(onRecovered).toHaveBeenCalledTimes(1);
      expect(onRecovered).toHaveBeenCalledWith(breadcrumb);
    } finally {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });
});
