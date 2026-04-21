import { describe, expect, it } from "vitest";
import { parseGhostDoctorProcessHealth } from "./localComputerUse";

describe("parseGhostDoctorProcessHealth", () => {
  it("treats stale Ghost OS processes as a health problem", () => {
    const health = parseGhostDoctorProcessHealth(
      "[FAIL] Processes: 34 Ghost OS processes found (expect 0 or 1)",
    );

    expect(health.state).toBe("stale");
    expect(health.processCount).toBe(34);
    expect(health.detail).toContain("Stop the stale processes");
  });

  it("accepts the healthy 0-or-1 process case", () => {
    const health = parseGhostDoctorProcessHealth(
      "[ok] Processes: 1 Ghost OS process found",
    );

    expect(health.state).toBe("healthy");
    expect(health.processCount).toBe(1);
  });
});
