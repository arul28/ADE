/**
 * Tests for MissionHeader helper functions.
 *
 * MissionHeader uses several exports from missionHelpers. We test:
 * - computeProgress (step progress calculation)
 * - getAvailableLifecycleActions (lifecycle state machine)
 * - formatElapsed (elapsed time formatting)
 * - looksLikeLowSignalNoise (noise detection)
 * - compactText (text truncation)
 * - formatMissionWorkerPresentation (worker name derivation)
 */
import { describe, expect, it } from "vitest";
import {
  computeProgress,
  getAvailableLifecycleActions,
  formatElapsed,
  looksLikeLowSignalNoise,
  compactText,
  formatMissionWorkerPresentation,
  LIFECYCLE_ACTIONS,
  STATUS_CONFIG,
  PRIORITY_STYLES,
} from "./missionHelpers";

// ── computeProgress ──

describe("computeProgress", () => {
  it("returns zeros for empty steps", () => {
    expect(computeProgress([])).toEqual({ completed: 0, total: 0, pct: 0 });
  });

  it("counts succeeded and skipped as completed", () => {
    const steps = [
      { status: "succeeded" as const, metadata: null },
      { status: "skipped" as const, metadata: null },
      { status: "running" as const, metadata: null },
    ];
    const result = computeProgress(steps);
    expect(result.completed).toBe(2);
    expect(result.total).toBe(3);
    expect(result.pct).toBe(67);
  });

  it("excludes superseded steps from total", () => {
    const steps = [
      { status: "succeeded" as const, metadata: null },
      { status: "superseded" as const, metadata: null },
      { status: "running" as const, metadata: null },
    ];
    const result = computeProgress(steps);
    expect(result.total).toBe(2);
    expect(result.completed).toBe(1);
    expect(result.pct).toBe(50);
  });

  it("excludes display-only task steps", () => {
    const steps = [
      { status: "succeeded" as const, metadata: { isTask: true } },
      { status: "succeeded" as const, metadata: null },
      { status: "running" as const, metadata: null },
    ];
    const result = computeProgress(steps);
    expect(result.total).toBe(2);
    expect(result.completed).toBe(1);
  });

  it("excludes retry variants", () => {
    const steps = [
      { status: "failed" as const, metadata: null },
      { status: "running" as const, metadata: { retryOf: "step-1" } },
    ];
    const result = computeProgress(steps);
    expect(result.total).toBe(1);
  });

  it("counts canceled as completed", () => {
    const steps = [
      { status: "canceled" as const, metadata: null },
    ];
    const result = computeProgress(steps);
    expect(result.completed).toBe(1);
    expect(result.pct).toBe(100);
  });
});

// ── getAvailableLifecycleActions ──

describe("getAvailableLifecycleActions", () => {
  it("returns stop_run and cancel_mission for active run in non-terminal mission", () => {
    const actions = getAvailableLifecycleActions("in_progress", "active");
    expect(actions).toContain("stop_run");
    expect(actions).toContain("cancel_mission");
    expect(actions).not.toContain("archive_mission");
  });

  it("returns only cancel_mission when no active run but non-terminal", () => {
    const actions = getAvailableLifecycleActions("planning", null);
    expect(actions).not.toContain("stop_run");
    expect(actions).toContain("cancel_mission");
    expect(actions).not.toContain("archive_mission");
  });

  it("returns archive_mission for terminal missions", () => {
    const actions = getAvailableLifecycleActions("completed", "succeeded");
    expect(actions).toContain("archive_mission");
    expect(actions).not.toContain("cancel_mission");
  });

  it("returns archive_mission for failed missions", () => {
    const actions = getAvailableLifecycleActions("failed", "failed");
    expect(actions).toContain("archive_mission");
  });

  it("returns archive_mission for canceled missions", () => {
    const actions = getAvailableLifecycleActions("canceled", "canceled");
    expect(actions).toContain("archive_mission");
  });
});

// ── formatElapsed ──

describe("formatElapsed", () => {
  it("returns '--' for null startedAt", () => {
    expect(formatElapsed(null)).toBe("--");
  });

  it("formats seconds", () => {
    const start = new Date(Date.now() - 30_000).toISOString();
    const end = new Date().toISOString();
    expect(formatElapsed(start, end)).toBe("30s");
  });

  it("formats minutes and seconds", () => {
    const start = new Date(Date.now() - 125_000).toISOString();
    const end = new Date().toISOString();
    expect(formatElapsed(start, end)).toBe("2m 5s");
  });

  it("formats hours and minutes", () => {
    const start = new Date(Date.now() - 3_900_000).toISOString();
    const end = new Date().toISOString();
    expect(formatElapsed(start, end)).toBe("1h 5m");
  });

  it("uses current time when endedAt is null", () => {
    const start = new Date(Date.now() - 5_000).toISOString();
    const result = formatElapsed(start);
    // Should return a small number of seconds
    expect(result).toMatch(/^\d+s$/);
  });
});

// ── looksLikeLowSignalNoise ──

describe("looksLikeLowSignalNoise", () => {
  it("returns true for empty strings", () => {
    expect(looksLikeLowSignalNoise("")).toBe(true);
    expect(looksLikeLowSignalNoise("  ")).toBe(true);
  });

  it("returns true for 'streaming...'", () => {
    expect(looksLikeLowSignalNoise("streaming...")).toBe(true);
    expect(looksLikeLowSignalNoise("streaming")).toBe(true);
    expect(looksLikeLowSignalNoise("Streaming...")).toBe(true);
  });

  it("returns true for 'usage'", () => {
    expect(looksLikeLowSignalNoise("usage")).toBe(true);
    expect(looksLikeLowSignalNoise("Usage")).toBe(true);
  });

  it("returns true for MCP prefixed messages", () => {
    expect(looksLikeLowSignalNoise("mcp:tool_name")).toBe(true);
  });

  it("returns false for substantive content", () => {
    expect(looksLikeLowSignalNoise("I have implemented the auth module.")).toBe(false);
    expect(looksLikeLowSignalNoise("The build failed due to a type error in utils.ts")).toBe(false);
  });

  it("returns true for short non-word tokens", () => {
    expect(looksLikeLowSignalNoise("abc")).toBe(true);
  });

  it("returns true for permission-like strings", () => {
    expect(looksLikeLowSignalNoise("-rwxr-xr-x")).toBe(true);
  });
});

// ── compactText ──

describe("compactText", () => {
  it("returns empty for empty input", () => {
    expect(compactText("")).toBe("");
    expect(compactText("   ")).toBe("");
  });

  it("normalizes whitespace", () => {
    expect(compactText("hello   world")).toBe("hello world");
  });

  it("truncates to maxChars with ellipsis", () => {
    const result = compactText("This is a fairly long sentence that needs truncation.", 20);
    expect(result.length).toBeLessThanOrEqual(22);
    expect(result).toContain("...");
  });

  it("does not truncate short strings", () => {
    expect(compactText("short")).toBe("short");
  });
});

// ── formatMissionWorkerPresentation ──

describe("formatMissionWorkerPresentation", () => {
  it("returns empty presentation for empty input", () => {
    const result = formatMissionWorkerPresentation({});
    // With no title or stepKey, "Worker" is the raw input but
    // humanizeMissionWorkerText strips the "Worker:" / "worker" prefix,
    // resulting in empty label and fullLabel
    expect(result.label).toBe("");
    expect(result.phaseLabel).toBe("");
  });

  it("extracts phase from planner-prefixed title", () => {
    const result = formatMissionWorkerPresentation({ title: "planner: analyze requirements" });
    expect(result.phaseLabel).toBe("Planning");
    expect(result.label).toContain("analyze");
  });

  it("extracts phase from dev-prefixed title", () => {
    const result = formatMissionWorkerPresentation({ title: "developer: build auth" });
    expect(result.phaseLabel).toBe("Development");
  });

  it("extracts phase from test-prefixed title", () => {
    const result = formatMissionWorkerPresentation({ title: "tester: run unit tests" });
    expect(result.phaseLabel).toBe("Testing");
  });

  it("extracts phase from validator-prefixed title", () => {
    const result = formatMissionWorkerPresentation({ title: "validator: check contracts" });
    expect(result.phaseLabel).toBe("Validation");
  });

  it("uses stepKey as fallback when title is empty", () => {
    const result = formatMissionWorkerPresentation({ title: null, stepKey: "review-code" });
    expect(result.phaseLabel).toBe("Review");
  });

  it("strips Worker: prefix from titles", () => {
    const result = formatMissionWorkerPresentation({ title: "Worker: build feature" });
    expect(result.label).not.toContain("Worker:");
    expect(result.label).toContain("build");
  });
});

// ── LIFECYCLE_ACTIONS ──

describe("LIFECYCLE_ACTIONS", () => {
  it("has amber color for stop_run", () => {
    expect(LIFECYCLE_ACTIONS.stop_run.color).toBe("#F59E0B");
    expect(LIFECYCLE_ACTIONS.stop_run.confirmText).toBeNull();
  });

  it("has red color and confirm text for cancel_mission", () => {
    expect(LIFECYCLE_ACTIONS.cancel_mission.color).toBe("#EF4444");
    expect(LIFECYCLE_ACTIONS.cancel_mission.confirmText).toBeTruthy();
  });

  it("has gray color for archive_mission", () => {
    expect(LIFECYCLE_ACTIONS.archive_mission.color).toBe("#71717A");
  });
});

// ── STATUS_CONFIG ──

describe("STATUS_CONFIG", () => {
  it("has config for all mission statuses", () => {
    const statuses: string[] = ["queued", "planning", "in_progress", "intervention_required", "completed", "failed", "canceled"];
    for (const status of statuses) {
      const config = STATUS_CONFIG[status as keyof typeof STATUS_CONFIG];
      expect(config, `Missing STATUS_CONFIG for ${status}`).toBeDefined();
      expect(config.color).toMatch(/^#/);
      expect(config.label).toBeTruthy();
    }
  });
});

// ── PRIORITY_STYLES ──

describe("PRIORITY_STYLES", () => {
  it("has styles for all priorities", () => {
    const priorities: string[] = ["urgent", "high", "normal", "low"];
    for (const priority of priorities) {
      const style = PRIORITY_STYLES[priority as keyof typeof PRIORITY_STYLES];
      expect(style, `Missing PRIORITY_STYLES for ${priority}`).toBeDefined();
      expect(style.color).toMatch(/^#/);
      expect(style.background).toBeTruthy();
    }
  });
});
