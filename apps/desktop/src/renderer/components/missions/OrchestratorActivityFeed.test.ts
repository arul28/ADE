/**
 * Tests for OrchestratorActivityFeed helper functions.
 *
 * The OrchestratorActivityFeed component has several pure helper functions
 * (sortTimeline, relativeTime, formatTimestamp, eventSeverity) that are
 * module-private. We test the exported collapseFeedMessages from missionHelpers
 * and classifyErrorSource which the feed uses for badge coloring.
 */
import { describe, expect, it } from "vitest";
import {
  collapseFeedMessages,
  classifyErrorSource,
  NOISY_EVENT_TYPES,
} from "./missionHelpers";

describe("collapseFeedMessages", () => {
  it("returns empty array for empty input", () => {
    expect(collapseFeedMessages([])).toEqual([]);
  });

  it("returns single-item group for one event", () => {
    const events = [{ eventType: "step_registered", stepId: "s1" }];
    const result = collapseFeedMessages(events);
    expect(result).toHaveLength(1);
    expect(result[0].count).toBe(1);
    expect(result[0].item).toBe(events[0]);
  });

  it("collapses consecutive events with same eventType and stepId", () => {
    const events = [
      { eventType: "step_status_changed", stepId: "s1" },
      { eventType: "step_status_changed", stepId: "s1" },
      { eventType: "step_status_changed", stepId: "s1" },
    ];
    const result = collapseFeedMessages(events);
    expect(result).toHaveLength(1);
    expect(result[0].count).toBe(3);
    expect(result[0].collapsed).toHaveLength(3);
    // Representative is the last event
    expect(result[0].item).toBe(events[2]);
  });

  it("does not collapse events with different stepIds", () => {
    const events = [
      { eventType: "step_status_changed", stepId: "s1" },
      { eventType: "step_status_changed", stepId: "s2" },
    ];
    const result = collapseFeedMessages(events);
    expect(result).toHaveLength(2);
    expect(result[0].count).toBe(1);
    expect(result[1].count).toBe(1);
  });

  it("does not collapse events with different eventTypes", () => {
    const events = [
      { eventType: "step_registered", stepId: "s1" },
      { eventType: "step_status_changed", stepId: "s1" },
    ];
    const result = collapseFeedMessages(events);
    expect(result).toHaveLength(2);
  });

  it("collapses groups at boundaries correctly", () => {
    const events = [
      { eventType: "a", stepId: "s1" },
      { eventType: "a", stepId: "s1" },
      { eventType: "b", stepId: "s1" },
      { eventType: "a", stepId: "s1" },
    ];
    const result = collapseFeedMessages(events);
    expect(result).toHaveLength(3);
    expect(result[0].count).toBe(2);
    expect(result[0].item.eventType).toBe("a");
    expect(result[1].count).toBe(1);
    expect(result[1].item.eventType).toBe("b");
    expect(result[2].count).toBe(1);
    expect(result[2].item.eventType).toBe("a");
  });

  it("handles null stepId", () => {
    const events = [
      { eventType: "run_created", stepId: null },
      { eventType: "run_created", stepId: null },
    ];
    const result = collapseFeedMessages(events);
    expect(result).toHaveLength(1);
    expect(result[0].count).toBe(2);
  });
});

describe("classifyErrorSource", () => {
  it("classifies rate limit errors as Provider", () => {
    expect(classifyErrorSource("Rate limit exceeded")).toBe("Provider");
    expect(classifyErrorSource("429 too many requests")).toBe("Provider");
    expect(classifyErrorSource("rate_limit_error")).toBe("Provider");
  });

  it("classifies quota/api key errors as Provider", () => {
    expect(classifyErrorSource("Quota exhausted for model")).toBe("Provider");
    expect(classifyErrorSource("Invalid API key")).toBe("Provider");
    expect(classifyErrorSource("Unauthorized request")).toBe("Provider");
  });

  it("classifies provider-name errors as Provider", () => {
    expect(classifyErrorSource("Anthropic API returned 500")).toBe("Provider");
    expect(classifyErrorSource("OpenAI model not available")).toBe("Provider");
    expect(classifyErrorSource("Server overloaded")).toBe("Provider");
  });

  it("classifies spawn/process errors as Executor", () => {
    expect(classifyErrorSource("Failed to spawn process")).toBe("Executor");
    expect(classifyErrorSource("ENOENT: no such file")).toBe("Executor");
    expect(classifyErrorSource("Process exit code 1")).toBe("Executor");
  });

  it("classifies timeout errors as Executor", () => {
    expect(classifyErrorSource("Request timed out after 30s")).toBe("Executor");
    expect(classifyErrorSource("Operation timeout")).toBe("Executor");
  });

  it("classifies worker/session errors as Executor", () => {
    expect(classifyErrorSource("Worker crash detected")).toBe("Executor");
    expect(classifyErrorSource("Session terminated")).toBe("Executor");
    expect(classifyErrorSource("startup_failure: could not init")).toBe("Executor");
  });

  it("classifies environment/sandbox errors as Runtime", () => {
    expect(classifyErrorSource("External CLI backend missing from environment")).toBe("Runtime");
    expect(classifyErrorSource("Sandbox violation")).toBe("Runtime");
    expect(classifyErrorSource("Permission denied")).toBe("Runtime");
  });

  it("classifies config/environment errors as Runtime", () => {
    expect(classifyErrorSource("Config not found")).toBe("Runtime");
    expect(classifyErrorSource("Environment variable missing")).toBe("Runtime");
    expect(classifyErrorSource("Worktree path invalid")).toBe("Runtime");
  });

  it("defaults to ADE for unrecognized errors", () => {
    expect(classifyErrorSource("Something went wrong")).toBe("ADE");
    expect(classifyErrorSource("Internal error: null pointer")).toBe("ADE");
  });
});

describe("NOISY_EVENT_TYPES", () => {
  it("contains known maintenance event types", () => {
    expect(NOISY_EVENT_TYPES.has("scheduler_tick")).toBe(true);
    expect(NOISY_EVENT_TYPES.has("claim_heartbeat")).toBe(true);
    expect(NOISY_EVENT_TYPES.has("context_snapshot_created")).toBe(true);
  });

  it("does not contain meaningful events", () => {
    expect(NOISY_EVENT_TYPES.has("step_status_changed")).toBe(false);
    expect(NOISY_EVENT_TYPES.has("run_created")).toBe(false);
    expect(NOISY_EVENT_TYPES.has("attempt_started")).toBe(false);
  });
});
