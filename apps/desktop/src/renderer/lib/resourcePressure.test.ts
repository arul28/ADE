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
});
