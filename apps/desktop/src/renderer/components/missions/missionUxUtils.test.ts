import { describe, it, expect } from "vitest";
import {
  STATUS_CONFIG,
  classifyErrorSource,
  computeProgress,
  collapseFeedMessages,
  getAvailableLifecycleActions,
  formatResetCountdown,
  usagePercentColor,
} from "./missionHelpers";

/* ════════════════════ STATUS_CONFIG (VAL-UX-007) ════════════════════ */

describe("STATUS_CONFIG", () => {
  it("has entries for all MissionStatus values", () => {
    const statuses = [
      "queued", "planning", "in_progress",
      "intervention_required", "completed", "failed", "canceled",
    ] as const;
    for (const s of statuses) {
      expect(STATUS_CONFIG[s]).toBeDefined();
      expect(STATUS_CONFIG[s].color).toBeTruthy();
      expect(STATUS_CONFIG[s].label).toBeTruthy();
      expect(STATUS_CONFIG[s].icon).toBeTruthy();
      expect(STATUS_CONFIG[s].background).toBeTruthy();
      expect(STATUS_CONFIG[s].border).toBeTruthy();
    }
  });

  it("contains exactly 7 entries (one per status)", () => {
    expect(Object.keys(STATUS_CONFIG)).toHaveLength(7);
  });
});

/* ════════════════════ classifyErrorSource (VAL-UX-008) ════════════════════ */

describe("classifyErrorSource", () => {
  it("classifies rate limit errors as Provider", () => {
    expect(classifyErrorSource("Rate limit exceeded for anthropic API")).toBe("Provider");
    expect(classifyErrorSource("429 Too Many Requests")).toBe("Provider");
    expect(classifyErrorSource("API key invalid")).toBe("Provider");
    expect(classifyErrorSource("OpenAI quota exceeded")).toBe("Provider");
  });

  it("classifies spawn/process errors as Executor", () => {
    expect(classifyErrorSource("spawn ENOENT")).toBe("Executor");
    expect(classifyErrorSource("Process exit code 1")).toBe("Executor");
    expect(classifyErrorSource("Worker timed out after 300s")).toBe("Executor");
    expect(classifyErrorSource("startup_failure: no output")).toBe("Executor");
  });

  it("classifies env/config errors as Runtime", () => {
    expect(classifyErrorSource("MCP server connection failed")).toBe("Runtime");
    expect(classifyErrorSource("Sandbox permission denied")).toBe("Runtime");
    expect(classifyErrorSource("Gmail MCP probe failed")).toBe("Runtime");
    expect(classifyErrorSource("Lane worktree not found")).toBe("Runtime");
  });

  it("defaults to ADE for internal errors", () => {
    expect(classifyErrorSource("Internal orchestrator error")).toBe("ADE");
    expect(classifyErrorSource("Unknown error")).toBe("ADE");
    expect(classifyErrorSource("")).toBe("ADE");
  });
});

/* ════════════════════ computeProgress (VAL-UX-003) ════════════════════ */

describe("computeProgress", () => {
  it("excludes superseded steps from both numerator and denominator", () => {
    const steps = [
      { status: "succeeded" as const, metadata: {} },
      { status: "succeeded" as const, metadata: {} },
      { status: "running" as const, metadata: {} },
      { status: "superseded" as const, metadata: {} }, // excluded
      { status: "superseded" as const, metadata: {} }, // excluded
    ];
    const result = computeProgress(steps);
    expect(result.total).toBe(3);         // 2 succeeded + 1 running
    expect(result.completed).toBe(2);     // 2 succeeded
    expect(result.pct).toBe(67);
  });

  it("excludes retry variants via retryOf metadata", () => {
    const steps = [
      { status: "succeeded" as const, metadata: {} },
      { status: "failed" as const, metadata: { retryOf: "step-1" } },
      { status: "succeeded" as const, metadata: { retryOf: "step-1" } },
      { status: "running" as const, metadata: {} },
    ];
    const result = computeProgress(steps);
    // step-1 (succeeded) + running step = 2 total, 1 completed
    expect(result.total).toBe(2);
    expect(result.completed).toBe(1);
  });

  it("returns zero for empty array", () => {
    const result = computeProgress([]);
    expect(result.total).toBe(0);
    expect(result.completed).toBe(0);
    expect(result.pct).toBe(0);
  });

  it("10 logical steps with 2 retried shows X/10 not X/12", () => {
    const steps: Array<{ status: string; metadata: Record<string, unknown> }> = Array.from({ length: 10 }, (_, i) => ({
      status: i < 5 ? "succeeded" : "running",
      metadata: {},
    }));
    // Add 2 retry variants (should be excluded)
    steps.push(
      { status: "failed", metadata: { retryOf: "step-0" } },
      { status: "failed", metadata: { retryOf: "step-1" } },
    );
    const result = computeProgress(steps as never[]);
    expect(result.total).toBe(10);
    expect(result.completed).toBe(5);
    expect(result.pct).toBe(50);
  });
});

/* ════════════════════ collapseFeedMessages (VAL-UX-002) ════════════════════ */

describe("collapseFeedMessages", () => {
  it("collapses 5 consecutive identical events into 1 with count=5", () => {
    const events = Array.from({ length: 5 }, (_, i) => ({
      eventType: "manual_step_requires_operator",
      stepId: "step-1",
      id: `ev-${i}`,
    }));
    const result = collapseFeedMessages(events);
    expect(result).toHaveLength(1);
    expect(result[0]!.count).toBe(5);
    expect(result[0]!.collapsed).toHaveLength(5);
  });

  it("does not collapse different event types", () => {
    const events = [
      { eventType: "step_started", stepId: "s1" },
      { eventType: "step_completed", stepId: "s1" },
      { eventType: "step_started", stepId: "s2" },
    ];
    const result = collapseFeedMessages(events);
    expect(result).toHaveLength(3);
    expect(result.every((r) => r.count === 1)).toBe(true);
  });

  it("does not collapse same type but different stepId", () => {
    const events = [
      { eventType: "step_started", stepId: "s1" },
      { eventType: "step_started", stepId: "s2" },
    ];
    const result = collapseFeedMessages(events);
    expect(result).toHaveLength(2);
  });

  it("handles empty array", () => {
    expect(collapseFeedMessages([])).toHaveLength(0);
  });

  it("handles single event", () => {
    const result = collapseFeedMessages([{ eventType: "test", stepId: null }]);
    expect(result).toHaveLength(1);
    expect(result[0]!.count).toBe(1);
  });
});

/* ════════════════════ getAvailableLifecycleActions (VAL-UX-006) ════════════════════ */

describe("getAvailableLifecycleActions", () => {
  it("shows stop_run + cancel_mission for active run", () => {
    const actions = getAvailableLifecycleActions("in_progress", "active");
    expect(actions).toContain("stop_run");
    expect(actions).toContain("cancel_mission");
    expect(actions).not.toContain("archive_mission");
  });

  it("shows archive_mission for terminal missions", () => {
    for (const status of ["completed", "failed", "canceled"] as const) {
      const actions = getAvailableLifecycleActions(status, "succeeded");
      expect(actions).toContain("archive_mission");
      expect(actions).not.toContain("cancel_mission");
    }
  });

  it("cancel_mission requires non-terminal status", () => {
    const actions = getAvailableLifecycleActions("completed", null);
    expect(actions).not.toContain("cancel_mission");
  });

  it("archive only for terminal missions", () => {
    const actionsQueued = getAvailableLifecycleActions("queued", null);
    expect(actionsQueued).not.toContain("archive_mission");
    const actionsActive = getAvailableLifecycleActions("in_progress", "active");
    expect(actionsActive).not.toContain("archive_mission");
  });
});

/* ════════════════════ formatResetCountdown (VAL-USAGE-004) ════════════════════ */

describe("formatResetCountdown", () => {
  it("formats hours and minutes", () => {
    expect(formatResetCountdown(2 * 3_600_000 + 15 * 60_000)).toBe("resets in 2h 15m");
  });

  it("formats only minutes for < 1 hour", () => {
    expect(formatResetCountdown(45 * 60_000)).toBe("resets in 45m");
  });

  it("handles zero/negative as 'resets now'", () => {
    expect(formatResetCountdown(0)).toBe("resets now");
    expect(formatResetCountdown(-1000)).toBe("resets now");
  });
});

/* ════════════════════ usagePercentColor (VAL-USAGE-001) ════════════════════ */

describe("usagePercentColor", () => {
  it("returns green for < 60%", () => {
    expect(usagePercentColor(30)).toBe("#22C55E");
    expect(usagePercentColor(59)).toBe("#22C55E");
  });

  it("returns amber for 60-80%", () => {
    expect(usagePercentColor(60)).toBe("#F59E0B");
    expect(usagePercentColor(80)).toBe("#F59E0B");
  });

  it("returns red for > 80%", () => {
    expect(usagePercentColor(81)).toBe("#EF4444");
    expect(usagePercentColor(100)).toBe("#EF4444");
  });
});
