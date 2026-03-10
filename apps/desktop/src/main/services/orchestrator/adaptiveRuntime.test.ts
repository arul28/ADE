import { describe, expect, it } from "vitest";
import {
  classifyTaskComplexity,
  scaleParallelismCap,
  evaluateModelDowngrade,
} from "./adaptiveRuntime";
import type { TeamComplexityAssessment } from "../../../shared/types";

// ---------------------------------------------------------------------------
// VAL-ENH-001: Task complexity classifier exists
// ---------------------------------------------------------------------------
describe("classifyTaskComplexity", () => {
  it("returns trivial for typo fix", () => {
    expect(classifyTaskComplexity("fix typo in readme")).toBe("trivial");
  });

  it("returns simple for a bug fix", () => {
    expect(classifyTaskComplexity("fix bug in login form validation")).toBe("simple");
  });

  it("returns moderate for a feature", () => {
    expect(classifyTaskComplexity("integrate OAuth2 authentication service with user management module and add API endpoint for token refresh")).toBe("moderate");
  });

  it("returns complex for a large overhaul", () => {
    expect(classifyTaskComplexity(
      "overhaul the entire architecture of the distributed microservice system including database migration, " +
      "API redesign, and cross-cutting concerns across multiple teams with parallel deployment strategy"
    )).toBe("complex");
  });

  it("returns trivial for empty string", () => {
    expect(classifyTaskComplexity("")).toBe("trivial");
  });

  it("returns simple for short description without keywords", () => {
    expect(classifyTaskComplexity("add a new button to the header")).toBe("simple");
  });
});

// ---------------------------------------------------------------------------
// VAL-ENH-003: TeamComplexityAssessment drives parallelism
// ---------------------------------------------------------------------------
describe("scaleParallelismCap", () => {
  it("small scope gets ≤ 2", () => {
    expect(scaleParallelismCap("small")).toBeLessThanOrEqual(2);
  });

  it("medium scope gets 2", () => {
    expect(scaleParallelismCap("medium")).toBe(2);
  });

  it("large scope gets ≥ 4", () => {
    expect(scaleParallelismCap("large")).toBeGreaterThanOrEqual(4);
  });

  it("very_large scope gets ≥ 4", () => {
    expect(scaleParallelismCap("very_large")).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// VAL-USAGE-003: Model downgrade at usage threshold
// ---------------------------------------------------------------------------
describe("evaluateModelDowngrade", () => {
  it("does not downgrade when usage is below threshold", () => {
    const result = evaluateModelDowngrade({
      currentModelId: "anthropic/claude-sonnet-4-6",
      downgradeThresholdPct: 70,
      currentUsagePct: 50,
    });
    expect(result.downgraded).toBe(false);
    expect(result.resolvedModelId).toBe("anthropic/claude-sonnet-4-6");
  });

  it("downgrades when usage exceeds threshold", () => {
    const result = evaluateModelDowngrade({
      currentModelId: "anthropic/claude-sonnet-4-6",
      downgradeThresholdPct: 70,
      currentUsagePct: 80,
    });
    expect(result.downgraded).toBe(true);
    expect(result.resolvedModelId).not.toBe("anthropic/claude-sonnet-4-6");
    expect(result.reason).toContain("80%");
  });

  it("does not downgrade when threshold is null", () => {
    const result = evaluateModelDowngrade({
      currentModelId: "anthropic/claude-sonnet-4-6",
      downgradeThresholdPct: null,
      currentUsagePct: 90,
    });
    expect(result.downgraded).toBe(false);
  });

  it("uses explicit cheaper model when provided", () => {
    const result = evaluateModelDowngrade({
      currentModelId: "anthropic/claude-sonnet-4-6",
      downgradeThresholdPct: 70,
      currentUsagePct: 80,
      cheaperModelId: "anthropic/claude-haiku-3-5",
    });
    expect(result.downgraded).toBe(true);
    expect(result.resolvedModelId).toBe("anthropic/claude-haiku-3-5");
  });
});
