import { describe, expect, it } from "vitest";
import { plannerPlanToMissionSteps, validateAndCanonicalizePlannerPlan } from "./missionPlanningService";

describe("missionPlanningService planner contract", () => {
  it("accepts valid plans and canonicalizes step order", () => {
    const raw = {
      schemaVersion: "1.0",
      missionSummary: {
        title: "Ship feature",
        objective: "Implement and verify",
        domain: "backend",
        complexity: "medium",
        strategy: "parallel-lite",
        parallelismCap: 2
      },
      assumptions: [],
      risks: [],
      steps: [
        {
          stepId: "verify",
          name: "Verify",
          description: "Run tests",
          taskType: "test",
          executorHint: "either",
          preferredScope: "lane",
          requiresContextProfiles: ["deterministic"],
          dependencies: ["implement"],
          artifactHints: [],
          claimPolicy: { lanes: ["backend"] },
          maxAttempts: 2,
          retryPolicy: { baseMs: 5000, maxMs: 120000, multiplier: 2, maxRetries: 1 },
          outputContract: { expectedSignals: ["tests_pass"], completionCriteria: "tests_pass" }
        },
        {
          stepId: "implement",
          name: "Implement",
          description: "Write code",
          taskType: "code",
          executorHint: "either",
          preferredScope: "lane",
          requiresContextProfiles: ["deterministic"],
          dependencies: [],
          artifactHints: [],
          claimPolicy: { lanes: ["backend"] },
          maxAttempts: 2,
          retryPolicy: { baseMs: 5000, maxMs: 120000, multiplier: 2, maxRetries: 1 },
          outputContract: { expectedSignals: ["code_done"], completionCriteria: "code_done" }
        }
      ],
      handoffPolicy: {
        externalConflictDefault: "intervention"
      }
    };

    const { plan, validationErrors } = validateAndCanonicalizePlannerPlan(raw);
    expect(validationErrors).toEqual([]);
    expect(plan.steps.map((step) => step.stepId)).toEqual(["implement", "verify"]);
  });

  it("rejects duplicate step IDs, unresolved deps, and quorum mismatch", () => {
    const raw = {
      schemaVersion: "1.0",
      missionSummary: {
        title: "Invalid",
        objective: "Invalid",
        domain: "mixed",
        complexity: "low",
        strategy: "sequential",
        parallelismCap: 1
      },
      assumptions: [],
      risks: [],
      steps: [
        {
          stepId: "same",
          name: "Step A",
          description: "A",
          taskType: "analysis",
          executorHint: "either",
          preferredScope: "lane",
          requiresContextProfiles: ["deterministic"],
          dependencies: ["missing"],
          artifactHints: [],
          claimPolicy: { lanes: ["analysis"] },
          maxAttempts: 2,
          retryPolicy: { baseMs: 5000, maxMs: 120000, multiplier: 2, maxRetries: 1 },
          outputContract: { expectedSignals: [], completionCriteria: "done" }
        },
        {
          stepId: "same",
          name: "Step B",
          description: "B",
          taskType: "code",
          executorHint: "either",
          preferredScope: "lane",
          requiresContextProfiles: ["deterministic"],
          dependencies: [],
          joinPolicy: "quorum",
          artifactHints: [],
          claimPolicy: { lanes: ["backend"] },
          maxAttempts: 2,
          retryPolicy: { baseMs: 5000, maxMs: 120000, multiplier: 2, maxRetries: 1 },
          outputContract: { expectedSignals: [], completionCriteria: "done" }
        }
      ],
      handoffPolicy: {
        externalConflictDefault: "intervention"
      }
    };

    const { validationErrors } = validateAndCanonicalizePlannerPlan(raw);
    expect(validationErrors.some((entry) => entry.includes("Duplicate stepId"))).toBe(true);
    expect(validationErrors.some((entry) => entry.includes("Unresolved dependency"))).toBe(true);
    expect(validationErrors.some((entry) => entry.includes("joinPolicy=quorum"))).toBe(true);
  });

  it("rejects dependency cycles and max-attempt bounds", () => {
    const raw = {
      schemaVersion: "1.0",
      missionSummary: {
        title: "Cycle",
        objective: "Cycle",
        domain: "mixed",
        complexity: "medium",
        strategy: "parallel-lite",
        parallelismCap: 2
      },
      assumptions: [],
      risks: [],
      steps: [
        {
          stepId: "a",
          name: "A",
          description: "A",
          taskType: "analysis",
          executorHint: "either",
          preferredScope: "lane",
          requiresContextProfiles: ["deterministic"],
          dependencies: ["b"],
          artifactHints: [],
          claimPolicy: { lanes: ["analysis"] },
          maxAttempts: 0,
          retryPolicy: { baseMs: 5000, maxMs: 120000, multiplier: 2, maxRetries: 1 },
          outputContract: { expectedSignals: [], completionCriteria: "done" }
        },
        {
          stepId: "b",
          name: "B",
          description: "B",
          taskType: "code",
          executorHint: "either",
          preferredScope: "lane",
          requiresContextProfiles: ["deterministic"],
          dependencies: ["a"],
          artifactHints: [],
          claimPolicy: { lanes: ["backend"] },
          maxAttempts: 2,
          retryPolicy: { baseMs: 5000, maxMs: 120000, multiplier: 2, maxRetries: 1 },
          outputContract: { expectedSignals: [], completionCriteria: "done" }
        }
      ],
      handoffPolicy: {
        externalConflictDefault: "intervention"
      }
    };

    const { validationErrors } = validateAndCanonicalizePlannerPlan(raw);
    expect(validationErrors.some((entry) => entry.includes("maxAttempts outside bounds"))).toBe(true);
    expect(validationErrors.some((entry) => entry.includes("Dependency cycle detected"))).toBe(true);
  });

  it("maps executor defaults deterministically for mission steps", () => {
    const { plan } = validateAndCanonicalizePlannerPlan({
      schemaVersion: "1.0",
      missionSummary: {
        title: "Routing",
        objective: "Route executors",
        domain: "mixed",
        complexity: "medium",
        strategy: "parallel-lite",
        parallelismCap: 2
      },
      assumptions: [],
      risks: [],
      steps: [
        {
          stepId: "analysis",
          name: "Analyze",
          description: "Analyze",
          taskType: "analysis",
          executorHint: "either",
          preferredScope: "lane",
          requiresContextProfiles: ["deterministic"],
          dependencies: [],
          artifactHints: [],
          claimPolicy: { lanes: ["analysis"] },
          maxAttempts: 2,
          retryPolicy: { baseMs: 5000, maxMs: 120000, multiplier: 2, maxRetries: 1 },
          outputContract: { expectedSignals: [], completionCriteria: "done" }
        },
        {
          stepId: "code",
          name: "Code",
          description: "Code",
          taskType: "code",
          executorHint: "either",
          preferredScope: "lane",
          requiresContextProfiles: ["deterministic"],
          dependencies: ["analysis"],
          artifactHints: [],
          claimPolicy: { lanes: ["backend"] },
          maxAttempts: 2,
          retryPolicy: { baseMs: 5000, maxMs: 120000, multiplier: 2, maxRetries: 1 },
          outputContract: { expectedSignals: [], completionCriteria: "done" }
        }
      ],
      handoffPolicy: {
        externalConflictDefault: "intervention"
      }
    });

    const steps = plannerPlanToMissionSteps({
      plan,
      requestedEngine: "auto",
      resolvedEngine: "claude_cli",
      executorPolicy: "both",
      degraded: false,
      reasonCode: null,
      validationErrors: []
    });
    expect(steps).toHaveLength(2);
    expect(steps[0]?.metadata.executorKind).toBe("claude");
    expect(steps[1]?.metadata.executorKind).toBe("codex");

    const codexOnly = plannerPlanToMissionSteps({
      plan,
      requestedEngine: "auto",
      resolvedEngine: "claude_cli",
      executorPolicy: "codex",
      degraded: false,
      reasonCode: null,
      validationErrors: []
    });
    expect(codexOnly.every((step) => step.metadata.executorKind === "codex")).toBe(true);

    const claudeOnly = plannerPlanToMissionSteps({
      plan,
      requestedEngine: "auto",
      resolvedEngine: "claude_cli",
      executorPolicy: "claude",
      degraded: false,
      reasonCode: null,
      validationErrors: []
    });
    expect(claudeOnly.every((step) => step.metadata.executorKind === "claude")).toBe(true);
  });
});
