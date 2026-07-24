import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BRAIN_LOOP_WATCHDOG_BREADCRUMB_FILE,
  BRAIN_LOOP_WATCHDOG_LAST_WEDGE_FILE,
  buildBrainLoopWatchdogWorkerSource,
  evaluateBrainLoopWatchdog,
  readBrainLoopWatchdogLastWedge,
  recoverBrainLoopWatchdogBreadcrumb,
  startBrainLoopWatchdog,
} from "./brainLoopWatchdog";

describe("brainLoopWatchdog", () => {
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
