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
