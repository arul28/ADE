import { describe, expect, it } from "vitest";
import type { ProcessRuntime, ProcessRuntimeStatus } from "../../../shared/types";
import { formatProcessStatus, hasInspectableProcessOutput, isActiveProcessStatus } from "./processUtils";

const ALL_STATUSES: ProcessRuntimeStatus[] = [
  "stopped",
  "starting",
  "running",
  "degraded",
  "stopping",
  "exited",
  "crashed",
];

describe("isActiveProcessStatus", () => {
  it.each(["running", "starting", "degraded", "stopping"] as const)(
    "returns true for '%s'",
    (status) => {
      expect(isActiveProcessStatus(status)).toBe(true);
    },
  );

  it.each(["stopped", "exited", "crashed"] as const)(
    "returns false for '%s'",
    (status) => {
      expect(isActiveProcessStatus(status)).toBe(false);
    },
  );

  it("covers every status in ProcessRuntimeStatus", () => {
    for (const status of ALL_STATUSES) {
      expect(typeof isActiveProcessStatus(status)).toBe("boolean");
    }
  });
});

function makeRuntime(overrides: Partial<ProcessRuntime> = {}): ProcessRuntime {
  return {
    laneId: "lane-1",
    processId: "proc-1",
    status: "stopped",
    readiness: "unknown",
    pid: null,
    startedAt: null,
    endedAt: null,
    exitCode: null,
    lastExitCode: null,
    lastEndedAt: null,
    uptimeMs: null,
    ports: [],
    logPath: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("hasInspectableProcessOutput", () => {
  it("returns false for a pristine stopped process with no timing info", () => {
    expect(hasInspectableProcessOutput(makeRuntime({ status: "stopped" }))).toBe(false);
  });

  it("returns true for any non-stopped status", () => {
    for (const status of ALL_STATUSES.filter((s) => s !== "stopped")) {
      expect(hasInspectableProcessOutput(makeRuntime({ status }))).toBe(true);
    }
  });

  it("returns true for stopped process with startedAt", () => {
    expect(
      hasInspectableProcessOutput(makeRuntime({ status: "stopped", startedAt: "2026-01-01T00:00:00Z" })),
    ).toBe(true);
  });

  it("returns true for stopped process with lastEndedAt", () => {
    expect(
      hasInspectableProcessOutput(makeRuntime({ status: "stopped", lastEndedAt: "2026-01-01T00:00:00Z" })),
    ).toBe(true);
  });

  it("returns true for stopped process with lastExitCode", () => {
    expect(
      hasInspectableProcessOutput(makeRuntime({ status: "stopped", lastExitCode: 0 })),
    ).toBe(true);
  });

  it("returns true for stopped process with lastExitCode of 0", () => {
    expect(
      hasInspectableProcessOutput(makeRuntime({ status: "stopped", lastExitCode: 0 })),
    ).toBe(true);
  });
});

describe("formatProcessStatus", () => {
  it("returns plain status for non-crash/exit statuses", () => {
    for (const status of ["stopped", "starting", "running", "degraded", "stopping"] as const) {
      expect(formatProcessStatus({ status, lastExitCode: null })).toBe(status);
    }
  });

  it("appends exit code to crashed status", () => {
    expect(formatProcessStatus({ status: "crashed", lastExitCode: 137 })).toBe("crashed:137");
  });

  it("appends exit code to exited status", () => {
    expect(formatProcessStatus({ status: "exited", lastExitCode: 0 })).toBe("exited:0");
  });

  it("returns plain status for crashed/exited without exit code", () => {
    expect(formatProcessStatus({ status: "crashed", lastExitCode: null })).toBe("crashed");
    expect(formatProcessStatus({ status: "exited", lastExitCode: null })).toBe("exited");
  });

  it("does not append exit code to non-crash/exit statuses even if present", () => {
    expect(formatProcessStatus({ status: "running", lastExitCode: 1 })).toBe("running");
    expect(formatProcessStatus({ status: "stopped", lastExitCode: 0 })).toBe("stopped");
  });

  it("handles exit code 0 for crashed status", () => {
    expect(formatProcessStatus({ status: "crashed", lastExitCode: 0 })).toBe("crashed:0");
  });
});
