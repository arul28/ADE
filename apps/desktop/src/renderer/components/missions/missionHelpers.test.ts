import { describe, expect, it } from "vitest";
import {
  compactText,
  computeProgress,
  formatElapsed,
  formatMissionWorkerPresentation,
  getAvailableLifecycleActions,
  getMissionStatusBadgeConfig,
  isMissionVisiblyActive,
  looksLikeLowSignalNoise,
  narrativeForEvent,
} from "./missionHelpers";

describe("narrativeForEvent", () => {
  it("uses step keys from timeline detail instead of exposing internal ids", () => {
    expect(narrativeForEvent({
      eventType: "step_registered",
      reason: "add_steps",
      stepId: "e57e9ac4-8efd-4a8b-ad17-24f99d299b10",
      detail: {
        stepKey: "worker_context-the-original-scenario-fixtures-worker-wa_1778196304920",
      },
    })).toBe('Added "context the original scenario fixtures worker wa" to the plan');
  });

  it("falls back to a generic step label when only an id is available", () => {
    expect(narrativeForEvent({
      eventType: "step_status_changed",
      reason: "readiness_recomputed",
      stepId: "e57e9ac4-8efd-4a8b-ad17-24f99d299b10",
    })).toBe("Step update: readiness_recomputed");
  });

  it("renders steering and replan timeline events with operator context", () => {
    expect(narrativeForEvent({
      eventType: "coordinator_steering",
      reason: "operator directive",
      detail: {
        directive: "Prioritize the schedule-risk console and defer broad dashboard polish.",
        targetStepKey: "implement-risk-console",
      },
    })).toBe("User steering for implement risk console: Prioritize the schedule-risk console and defer broad dashboard polish.");

    expect(narrativeForEvent({
      eventType: "plan_revised",
      reason: "revise_plan",
      detail: {
        reason: "Scope changed after operator review.",
      },
    })).toBe("Plan revised: Scope changed after operator review.");
  });
});

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

  it("excludes legacy task shells identified by stepType", () => {
    const steps = [
      { status: "pending" as const, metadata: { stepType: "task" } },
      { status: "succeeded" as const, metadata: { stepType: "implementation", spawnedByCoordinator: true } },
    ];
    const result = computeProgress(steps);
    expect(result.total).toBe(1);
    expect(result.completed).toBe(1);
  });

  it("can include user-facing planned task shells while still excluding system trackers", () => {
    const steps = [
      { status: "succeeded" as const, metadata: { displayOnlyTask: true, systemManaged: true, plannerLaunchTracker: true } },
      { status: "succeeded" as const, metadata: { stepType: "planning" } },
      { status: "succeeded" as const, metadata: { stepType: "implementation" } },
      { status: "pending" as const, metadata: { stepType: "task", displayOnlyTask: true } },
    ];
    const result = computeProgress(steps, { includeDisplayOnlyTaskShells: true });
    expect(result.total).toBe(3);
    expect(result.completed).toBe(2);
    expect(result.pct).toBe(67);
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
    expect(result).toMatch(/^\d+s$/);
  });
});

describe("looksLikeLowSignalNoise", () => {
  it("returns true for empty strings", () => {
    expect(looksLikeLowSignalNoise("")).toBe(true);
    expect(looksLikeLowSignalNoise("  ")).toBe(true);
  });

  it("returns true for streaming placeholders", () => {
    expect(looksLikeLowSignalNoise("streaming...")).toBe(true);
    expect(looksLikeLowSignalNoise("streaming")).toBe(true);
    expect(looksLikeLowSignalNoise("Streaming...")).toBe(true);
  });

  it("returns true for usage placeholders", () => {
    expect(looksLikeLowSignalNoise("usage")).toBe(true);
    expect(looksLikeLowSignalNoise("Usage")).toBe(true);
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

describe("formatMissionWorkerPresentation", () => {
  it("returns generic worker presentation for empty input", () => {
    const result = formatMissionWorkerPresentation({});
    expect(result.label).toBe("Worker");
    expect(result.phaseLabel).toBeNull();
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

  it("collapses generated planning-worker prompts to a readable label", () => {
    const result = formatMissionWorkerPresentation({
      title: "you-are-the-read-only-planning-worker-for-ade-mi",
      stepKey: "worker_you-are-the-read-only-planning-worker-for-ade-mi_1778163691752",
    });
    expect(result.label).toBe("Planning worker");
    expect(result.phaseLabel).toBe("Planning");
  });
});

describe("getMissionStatusBadgeConfig", () => {
  it("prefers the run-view lifecycle status for selected mission badges", () => {
    const config = getMissionStatusBadgeConfig("in_progress", "blocked");
    expect(config.label).toBe("Blocked");
    expect(config.color).toBe("#F59E0B");
  });

  it("falls back to raw mission status when no run-view status is available", () => {
    const config = getMissionStatusBadgeConfig("in_progress", null);
    expect(config.label).toBe("Running");
    expect(config.color).toBe("#22C55E");
  });

  it("lets terminal mission status override a stale running run-view status", () => {
    const config = getMissionStatusBadgeConfig("completed", "running");
    expect(config.label).toBe("Done");
  });
});

describe("isMissionVisiblyActive", () => {
  it("does not pulse a raw running mission once the run-view is blocked", () => {
    expect(isMissionVisiblyActive("in_progress", "blocked")).toBe(false);
  });

  it("keeps active styling for run-view starting and running states", () => {
    expect(isMissionVisiblyActive("queued", "starting")).toBe(true);
    expect(isMissionVisiblyActive("queued", "running")).toBe(true);
  });

  it("does not keep active styling when a terminal mission has a stale active run-view", () => {
    expect(isMissionVisiblyActive("completed", "running")).toBe(false);
  });
});
