import { describe, expect, it } from "vitest";
import type { AppResourceUsageSnapshot } from "../../shared/types";
import {
  appResourcePressureLevel,
  clampPressureLevel,
  pressureLevelForThresholds,
  resourcePressureDescription,
} from "./resourcePressure";

function makeUsage(overrides: Partial<AppResourceUsageSnapshot>): AppResourceUsageSnapshot {
  return {
    sampledAt: "2026-04-06T12:00:00.000Z",
    processCount: 1,
    cpuPercent: 0,
    mainCpuPercent: 0,
    rendererCpuPercent: 0,
    memoryMB: 0,
    mainMemoryMB: 0,
    rendererMemoryMB: 0,
    activePtyCount: 0,
    ptyProcessCount: 0,
    ptyCpuPercent: 0,
    ptyMemoryMB: 0,
    freeMemoryMB: 8_000,
    totalMemoryMB: 16_000,
    ...overrides,
  };
}

describe("resourcePressure", () => {
  it("keeps zero free system memory visible in the pressure description", () => {
    const usage = makeUsage({
      freeMemoryMB: 0,
      totalMemoryMB: 16_000,
    });

    expect(appResourcePressureLevel(usage)).toBe(0);
    expect(resourcePressureDescription(usage)).toContain("100% system memory used");
  });

  it("uses shared truncating clamp and threshold helpers", () => {
    expect(clampPressureLevel(2.8)).toBe(2);
    expect(clampPressureLevel(9)).toBe(4);
    expect(pressureLevelForThresholds(70, [30, 50, 70, 90])).toBe(3);
    expect(pressureLevelForThresholds(null, [30, 50, 70, 90])).toBe(0);
  });

  it("describes legacy snapshots without role data using honest terminal labels", () => {
    const usage = makeUsage({
      activePtyCount: 4,
      ptyProcessCount: 9,
      ptyCpuPercent: 71,
      ptyMemoryMB: 1536,
    });

    const description = resourcePressureDescription(usage);
    expect(description).toContain("4 live terminals");
    expect(description).toContain("9 terminal processes");
    expect(description).toContain("71% CPU");
    expect(description).toContain("1.5 GB");
    expect(description).not.toContain("agent process");
  });

  it("distinguishes ADE infrastructure from provider and shell load when roles are present", () => {
    const usage = makeUsage({
      activePtyCount: 3,
      ptyProcessCount: 7,
      ptyCpuPercent: 80,
      ptyMemoryMB: 2048,
      processSample: { status: "ok", reason: null, sampledAt: "2026-04-06T12:00:00.000Z", durationMs: 42 },
      roleUsage: [
        { role: "electron-main", processCount: 1, cpuPercent: 8, memoryMB: 400 },
        { role: "electron-renderer", processCount: 2, cpuPercent: 4, memoryMB: 600 },
        { role: "electron-helper", processCount: 3, cpuPercent: 1, memoryMB: 200 },
        { role: "ade-runtime", processCount: 1, cpuPercent: 3, memoryMB: 300 },
        { role: "ade-pty-host", processCount: 0, cpuPercent: null, memoryMB: null },
        { role: "provider-agent", processCount: 4, cpuPercent: 62, memoryMB: 1400 },
        { role: "shell", processCount: 2, cpuPercent: 2, memoryMB: 90 },
        { role: "unknown", processCount: 1, cpuPercent: 13, memoryMB: 210 },
      ],
    });

    const description = resourcePressureDescription(usage);
    expect(description).toContain("ADE app 16% CPU · 1.5 GB resident");
    expect(description).toContain("4 agent processes 62% CPU · 1.4 GB resident");
    expect(description).toContain("other terminal processes 15% CPU · 300 MB resident");
    expect(description).not.toContain("temporarily unavailable");
  });

  it("notes staleness when the process sample is unavailable", () => {
    const usage = makeUsage({
      activePtyCount: 2,
      ptyProcessCount: 0,
      ptyCpuPercent: null,
      ptyMemoryMB: null,
      processSample: { status: "unavailable", reason: "timeout", sampledAt: "2026-04-06T12:00:00.000Z", durationMs: 1000 },
    });

    const description = resourcePressureDescription(usage);
    expect(description).toContain("Terminal process metrics are temporarily unavailable.");
  });
});
