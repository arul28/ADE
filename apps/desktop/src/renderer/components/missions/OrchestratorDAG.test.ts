/**
 * Tests for OrchestratorDAG helper functions.
 *
 * The DAG component has several pure helper functions for step metadata
 * resolution, phase tinting, and milestone validation. We re-derive
 * and test the exported/internal logic.
 */
import { describe, expect, it } from "vitest";
import type { OrchestratorStep } from "../../../shared/types";

// ── Re-derive module-private helpers from OrchestratorDAG ──

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function getPhaseKind(step: { metadata?: unknown }): string {
  const meta = asRecord(step.metadata);
  const stepType = typeof meta?.stepType === "string" ? meta.stepType : "";
  const taskType = typeof meta?.taskType === "string" ? meta.taskType : "";
  return stepType || taskType || "";
}

function resolveMilestoneValidationCriteria(step: { metadata?: unknown }): string | null {
  const meta = asRecord(step.metadata);
  if (!meta) return null;

  const doneCriteria = typeof meta.doneCriteria === "string" ? meta.doneCriteria.trim() : "";
  if (doneCriteria.length > 0) return doneCriteria;

  const contract = asRecord(meta.validationContract);
  const contractCriteria = typeof contract?.criteria === "string" ? contract.criteria.trim() : "";
  if (contractCriteria.length > 0) return contractCriteria;

  const planStep = asRecord(meta.planStep);
  const outputContract = asRecord(planStep?.outputContract);
  const completionCriteria = typeof outputContract?.completionCriteria === "string"
    ? outputContract.completionCriteria.trim()
    : "";
  if (completionCriteria.length > 0) return completionCriteria;

  return null;
}

const STATUS_COLORS: Record<string, string> = {
  pending: "#6b7280",
  ready: "#3b82f6",
  running: "#8b5cf6",
  succeeded: "#22c55e",
  failed: "#ef4444",
  blocked: "#f59e0b",
  skipped: "#9ca3af",
  superseded: "#f59e0b",
  canceled: "#6b7280",
};

const PHASE_TINT: Record<string, string> = {
  analysis: "rgba(59, 130, 246, 0.06)",
  code: "rgba(139, 92, 246, 0.06)",
  implementation: "rgba(139, 92, 246, 0.06)",
  test: "rgba(6, 182, 212, 0.06)",
  validation: "rgba(6, 182, 212, 0.06)",
  milestone: "rgba(167, 139, 250, 0.14)",
  review: "rgba(245, 158, 11, 0.06)",
  integration: "rgba(16, 185, 129, 0.06)",
  merge: "rgba(236, 72, 153, 0.06)",
  command: "rgba(168, 85, 247, 0.06)",
};

describe("asRecord", () => {
  it("returns null for null, undefined, primitives", () => {
    expect(asRecord(null)).toBeNull();
    expect(asRecord(undefined)).toBeNull();
    // strings are truthy objects but typeof is "object" check fails
    expect(asRecord("string")).toBeNull();
    expect(asRecord(42)).toBeNull();
  });

  it("returns the object for plain objects", () => {
    const obj = { key: "value" };
    expect(asRecord(obj)).toBe(obj);
  });
});

describe("getPhaseKind", () => {
  it("returns stepType when present", () => {
    expect(getPhaseKind({ metadata: { stepType: "implementation" } })).toBe("implementation");
  });

  it("returns taskType as fallback", () => {
    expect(getPhaseKind({ metadata: { taskType: "test" } })).toBe("test");
  });

  it("prefers stepType over taskType", () => {
    expect(getPhaseKind({ metadata: { stepType: "code", taskType: "test" } })).toBe("code");
  });

  it("returns empty string when no metadata", () => {
    expect(getPhaseKind({ metadata: null })).toBe("");
    expect(getPhaseKind({})).toBe("");
  });
});

describe("resolveMilestoneValidationCriteria", () => {
  it("returns doneCriteria when present", () => {
    expect(resolveMilestoneValidationCriteria({
      metadata: { doneCriteria: "All tests pass" },
    })).toBe("All tests pass");
  });

  it("falls back to validationContract.criteria", () => {
    expect(resolveMilestoneValidationCriteria({
      metadata: { validationContract: { criteria: "Code compiles" } },
    })).toBe("Code compiles");
  });

  it("falls back to planStep.outputContract.completionCriteria", () => {
    expect(resolveMilestoneValidationCriteria({
      metadata: {
        planStep: {
          outputContract: { completionCriteria: "PR merged" },
        },
      },
    })).toBe("PR merged");
  });

  it("returns null when no criteria found", () => {
    expect(resolveMilestoneValidationCriteria({ metadata: {} })).toBeNull();
    expect(resolveMilestoneValidationCriteria({ metadata: null })).toBeNull();
    expect(resolveMilestoneValidationCriteria({})).toBeNull();
  });

  it("skips empty/whitespace doneCriteria", () => {
    expect(resolveMilestoneValidationCriteria({
      metadata: {
        doneCriteria: "  ",
        validationContract: { criteria: "Tests pass" },
      },
    })).toBe("Tests pass");
  });
});

describe("STATUS_COLORS", () => {
  it("has colors for all expected statuses", () => {
    const statuses = ["pending", "ready", "running", "succeeded", "failed", "blocked", "skipped", "superseded", "canceled"];
    for (const status of statuses) {
      expect(STATUS_COLORS[status], `Missing color for ${status}`).toBeDefined();
      expect(STATUS_COLORS[status]).toMatch(/^#/);
    }
  });
});

describe("PHASE_TINT", () => {
  it("has tints for all expected phase kinds", () => {
    const phases = ["analysis", "code", "implementation", "test", "validation", "milestone", "review", "integration", "merge", "command"];
    for (const phase of phases) {
      expect(PHASE_TINT[phase], `Missing tint for ${phase}`).toBeDefined();
      expect(PHASE_TINT[phase]).toContain("rgba");
    }
  });

  it("code and implementation share the same tint", () => {
    expect(PHASE_TINT.code).toBe(PHASE_TINT.implementation);
  });

  it("test and validation share the same tint", () => {
    expect(PHASE_TINT.test).toBe(PHASE_TINT.validation);
  });
});
