import { describe, expect, it } from "vitest";
import type { MissionExecutionPolicy, OrchestratorStep, OrchestratorStepStatus } from "../../../shared/types";
import {
  DEFAULT_EXECUTION_POLICY,
  depthTierToPolicy,
  resolveExecutionPolicy,
  evaluateRunCompletion,
  stepTypeToPhase,
  phaseModelToExecutorKind
} from "./executionPolicy";

function makeStep(overrides: Partial<OrchestratorStep> & { id: string; status: OrchestratorStepStatus }): OrchestratorStep {
  return {
    runId: "run-1",
    missionStepId: null,
    stepKey: overrides.id,
    title: overrides.title ?? "Step",
    stepIndex: overrides.stepIndex ?? 0,
    dependencyStepIds: [],
    joinPolicy: "all_success",
    quorumCount: null,
    retryLimit: 1,
    retryCount: 0,
    lastAttemptId: null,
    laneId: overrides.laneId ?? null,
    metadata: overrides.metadata ?? null,
    createdAt: "2026-02-20T00:00:00.000Z",
    updatedAt: "2026-02-20T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    ...overrides
  };
}

describe("executionPolicy", () => {
  describe("depthTierToPolicy", () => {
    it("converts light tier to minimal policy", () => {
      const policy = depthTierToPolicy("light");
      expect(policy.planning.mode).toBe("off");
      expect(policy.testing.mode).toBe("none");
      expect(policy.validation.mode).toBe("off");
      expect(policy.codeReview.mode).toBe("off");
      expect(policy.integration.mode).toBe("off");
      expect(policy.merge.mode).toBe("off");
      expect(policy.completion.allowCompletionWithRisk).toBe(true);
    });

    it("converts standard tier to balanced policy", () => {
      const policy = depthTierToPolicy("standard");
      expect(policy.planning.mode).toBe("auto");
      expect(policy.testing.mode).toBe("post_implementation");
      expect(policy.validation.mode).toBe("optional");
      expect(policy.codeReview.mode).toBe("off");
      expect(policy.merge.mode).toBe("manual");
      expect(policy.completion.allowCompletionWithRisk).toBe(true);
    });

    it("converts deep tier to strict policy", () => {
      const policy = depthTierToPolicy("deep");
      expect(policy.planning.mode).toBe("manual_review");
      expect(policy.testing.mode).toBe("post_implementation");
      expect(policy.validation.mode).toBe("required");
      expect(policy.codeReview.mode).toBe("required");
      expect(policy.merge.mode).toBe("manual");
      expect(policy.completion.allowCompletionWithRisk).toBe(false);
    });
  });

  describe("resolveExecutionPolicy", () => {
    it("returns default when no sources provided", () => {
      const policy = resolveExecutionPolicy({});
      expect(policy).toEqual(DEFAULT_EXECUTION_POLICY);
    });

    it("mission metadata takes highest precedence", () => {
      const policy = resolveExecutionPolicy({
        missionMetadata: { testing: { mode: "tdd" } },
        missionDepthTier: "light",
        projectConfig: { testing: { mode: "none" } }
      });
      expect(policy.testing.mode).toBe("tdd");
    });

    it("depth tier takes precedence over project config", () => {
      const policy = resolveExecutionPolicy({
        missionDepthTier: "deep",
        projectConfig: { testing: { mode: "none" } }
      });
      expect(policy.testing.mode).toBe("post_implementation");
      expect(policy.codeReview.mode).toBe("required");
    });

    it("project config fills in when no mission-level override", () => {
      const policy = resolveExecutionPolicy({
        projectConfig: { merge: { mode: "auto_if_green" } }
      });
      expect(policy.merge.mode).toBe("auto_if_green");
      // Other fields come from default
      expect(policy.planning.mode).toBe("auto");
    });

    it("partial mission metadata merges with defaults", () => {
      const policy = resolveExecutionPolicy({
        missionMetadata: { planning: { mode: "manual_review" } }
      });
      expect(policy.planning.mode).toBe("manual_review");
      expect(policy.implementation.model).toBe("codex"); // from default
    });
  });

  describe("stepTypeToPhase", () => {
    it("maps step types to phases correctly", () => {
      expect(stepTypeToPhase("analysis")).toBe("planning");
      expect(stepTypeToPhase("code")).toBe("implementation");
      expect(stepTypeToPhase("implementation")).toBe("implementation");
      expect(stepTypeToPhase("test")).toBe("testing");
      expect(stepTypeToPhase("validation")).toBe("testing");
      expect(stepTypeToPhase("review")).toBe("codeReview");
      expect(stepTypeToPhase("integration")).toBe("integration");
      expect(stepTypeToPhase("merge")).toBe("merge");
      expect(stepTypeToPhase("unknown")).toBeNull();
    });

    it("falls back to taskType when stepType is empty", () => {
      expect(stepTypeToPhase("", "analysis")).toBe("planning");
      expect(stepTypeToPhase("", "review")).toBe("codeReview");
    });
  });

  describe("phaseModelToExecutorKind", () => {
    it("maps claude to claude executor", () => {
      expect(phaseModelToExecutorKind("claude")).toBe("claude");
    });

    it("maps codex and others to codex executor", () => {
      expect(phaseModelToExecutorKind("codex")).toBe("codex");
      expect(phaseModelToExecutorKind(undefined)).toBe("codex");
      expect(phaseModelToExecutorKind(null)).toBe("codex");
    });
  });

  describe("evaluateRunCompletion", () => {
    it("uses legacy behavior when policy is null", () => {
      const steps = [
        makeStep({ id: "s1", status: "succeeded", metadata: { stepType: "code" } }),
        makeStep({ id: "s2", status: "succeeded", metadata: { stepType: "test" } })
      ];
      const result = evaluateRunCompletion(steps, null);
      expect(result.status).toBe("succeeded");
      expect(result.completionReady).toBe(true);
      expect(result.diagnostics).toEqual([]);
    });

    it("succeeds when all required phases are satisfied", () => {
      const policy: MissionExecutionPolicy = {
        planning: { mode: "auto" },
        implementation: { model: "codex" },
        testing: { mode: "post_implementation" },
        validation: { mode: "optional" },
        codeReview: { mode: "off" },
        testReview: { mode: "off" },
        integration: { mode: "off" },
        merge: { mode: "off" },
        completion: { allowCompletionWithRisk: false }
      };
      const steps = [
        makeStep({ id: "s1", status: "succeeded", metadata: { stepType: "analysis" } }),
        makeStep({ id: "s2", status: "succeeded", metadata: { stepType: "code" } }),
        makeStep({ id: "s3", status: "succeeded", metadata: { stepType: "test" } })
      ];
      const result = evaluateRunCompletion(steps, policy);
      expect(result.status).toBe("succeeded");
      expect(result.completionReady).toBe(true);
    });

    it("returns succeeded_with_risk when tests disabled by policy and risk allowed", () => {
      const policy: MissionExecutionPolicy = {
        planning: { mode: "auto" },
        implementation: { model: "codex" },
        testing: { mode: "none" },
        validation: { mode: "off" },
        codeReview: { mode: "off" },
        testReview: { mode: "off" },
        integration: { mode: "off" },
        merge: { mode: "off" },
        completion: { allowCompletionWithRisk: true }
      };
      const steps = [
        makeStep({ id: "s1", status: "succeeded", metadata: { stepType: "analysis" } }),
        makeStep({ id: "s2", status: "succeeded", metadata: { stepType: "code" } })
      ];
      const result = evaluateRunCompletion(steps, policy);
      // No test steps exist but testing mode is none, so not required
      // However planning is required and present → no risk from testing
      expect(result.status).toBe("succeeded");
      expect(result.completionReady).toBe(true);
    });

    it("blocks completion when required phase is missing and risk not allowed", () => {
      const policy: MissionExecutionPolicy = {
        planning: { mode: "auto" },
        implementation: { model: "codex" },
        testing: { mode: "post_implementation" },
        validation: { mode: "required" },
        codeReview: { mode: "required" },
        testReview: { mode: "off" },
        integration: { mode: "off" },
        merge: { mode: "off" },
        completion: { allowCompletionWithRisk: false }
      };
      // Only implementation steps, no validation or review
      const steps = [
        makeStep({ id: "s1", status: "succeeded", metadata: { stepType: "code" } })
      ];
      const result = evaluateRunCompletion(steps, policy);
      // Missing required phases: planning, testing, validation, codeReview
      expect(result.diagnostics.some((d) => d.code === "phase_required_missing" && d.blocking)).toBe(true);
      expect(result.completionReady).toBe(false);
    });

    it("returns succeeded_with_risk when required phase missing but risk allowed", () => {
      const policy: MissionExecutionPolicy = {
        planning: { mode: "off" },
        implementation: { model: "codex" },
        testing: { mode: "post_implementation" },
        validation: { mode: "off" },
        codeReview: { mode: "off" },
        testReview: { mode: "off" },
        integration: { mode: "off" },
        merge: { mode: "off" },
        completion: { allowCompletionWithRisk: true }
      };
      // Implementation succeeded, testing required but no test steps
      const steps = [
        makeStep({ id: "s1", status: "succeeded", metadata: { stepType: "code" } })
      ];
      const result = evaluateRunCompletion(steps, policy);
      expect(result.status).toBe("succeeded_with_risk");
      expect(result.riskFactors).toContain("testing_required_but_missing");
      expect(result.completionReady).toBe(true);
    });

    it("reports not complete when merge step is blocked", () => {
      const policy: MissionExecutionPolicy = {
        ...DEFAULT_EXECUTION_POLICY,
        merge: { mode: "manual" }
      };
      const steps = [
        makeStep({ id: "s1", status: "succeeded", metadata: { stepType: "code" } }),
        makeStep({ id: "s2", status: "blocked", metadata: { stepType: "merge", blockedSticky: true } })
      ];
      const result = evaluateRunCompletion(steps, policy);
      // Blocked step means the merge phase is in-progress, not complete
      expect(result.completionReady).toBe(false);
      expect(result.diagnostics.some((d) => d.phase === "merge" && d.code === "phase_in_progress")).toBe(true);
    });

    it("returns failed when required phase has failed steps", () => {
      const policy: MissionExecutionPolicy = {
        ...DEFAULT_EXECUTION_POLICY,
        testing: { mode: "post_implementation" },
        completion: { allowCompletionWithRisk: false }
      };
      const steps = [
        makeStep({ id: "s1", status: "succeeded", metadata: { stepType: "code" } }),
        makeStep({ id: "s2", status: "failed", metadata: { stepType: "test" } })
      ];
      const result = evaluateRunCompletion(steps, policy);
      expect(result.status).toBe("failed");
      expect(result.completionReady).toBe(true);
    });

    it("correctly handles merge phase requirement", () => {
      const policy: MissionExecutionPolicy = {
        ...DEFAULT_EXECUTION_POLICY,
        merge: { mode: "auto_if_green" },
        completion: { allowCompletionWithRisk: true }
      };
      // All impl succeeded, but no merge step
      const steps = [
        makeStep({ id: "s1", status: "succeeded", metadata: { stepType: "code" } })
      ];
      const result = evaluateRunCompletion(steps, policy);
      expect(result.riskFactors).toContain("merge_required_but_missing");
      expect(result.status).toBe("succeeded_with_risk");
    });

    it("reports running when steps are still in progress", () => {
      const steps = [
        makeStep({ id: "s1", status: "succeeded", metadata: { stepType: "code" } }),
        makeStep({ id: "s2", status: "running", metadata: { stepType: "test" } })
      ];
      const result = evaluateRunCompletion(steps, DEFAULT_EXECUTION_POLICY);
      expect(result.status).toBe("running");
      expect(result.completionReady).toBe(false);
    });
  });
});
