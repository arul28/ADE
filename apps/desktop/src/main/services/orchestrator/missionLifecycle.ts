/**
 * missionLifecycle.ts
 *
 * Mission run management: start, approve, cancel, cleanup, steer, sync,
 * provision lanes, synthesize team manifest, integration contexts.
 *
 * Extracted from aiOrchestratorService.ts — pure refactor, no behavior changes.
 * NOTE: Due to the massive cross-dependencies (50+ closure references),
 * this module re-exports function signatures. The actual implementations
 * remain in the facade until full extraction is complete, and are injected
 * via the deps parameter pattern.
 *
 * This file establishes the module boundary and type contracts.
 */

import type {
  OrchestratorContext,
  MissionRunStartArgs,
  MissionRunStartResult,
  MissionRuntimeProfile,
  ParallelMissionStepDescriptor,
  OrchestratorChatMessage,
} from "./orchestratorContext";
import {
  nowIso,
  isRecord,
  buildOutcomeSummary,
  deriveMissionStatusFromRun,
  mapOrchestratorStepStatus,
} from "./orchestratorContext";
import type {
  OrchestratorRunGraph,
  MissionDetail,
  MissionStatus,
  MissionStep,
  TeamManifest,
  TeamComplexityAssessment,
  TeamWorkerAssignment,
  OrchestratorWorkerRole,
} from "../../../shared/types";

// ── Helper Functions ─────────────────────────────────────────────

export function deriveScopeFromStepCount(stepCount: number): TeamComplexityAssessment["estimatedScope"] {
  if (stepCount <= 2) return "small";
  if (stepCount <= 6) return "medium";
  if (stepCount <= 15) return "large";
  return "very_large";
}

export function inferRoleFromStepMetadata(metadata: Record<string, unknown>, kind: string): OrchestratorWorkerRole {
  const stepType = typeof metadata.stepType === "string" ? metadata.stepType.toLowerCase() : kind.toLowerCase();
  if (stepType.includes("test") && stepType.includes("review")) return "test_review";
  if (stepType.includes("test")) return "testing";
  if (stepType.includes("code_review") || stepType.includes("review")) return "code_review";
  if (stepType.includes("integration") || stepType.includes("merge")) return "integration";
  if (stepType.includes("plan") || stepType.includes("design")) return "planning";
  return "implementation";
}

export function parseNumericDependencyIndices(metadata: Record<string, unknown>): number[] {
  const raw = metadata.dependencyIndices;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0)
    .map((v) => Math.floor(v));
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "step";
}

export function isParallelCandidateStepType(stepType: string): boolean {
  const lower = stepType.toLowerCase();
  return lower === "implementation" || lower === "testing" || lower === "code_review" ||
    lower === "test_review" || lower === "documentation" || lower === "validation";
}

export function toStepKey(step: MissionStep, position: number): string {
  const raw = step.title?.trim() || `step-${position}`;
  return slugify(raw) || `step-${position}`;
}

/**
 * Build parallel step descriptors from mission steps.
 */
export function buildParallelDescriptors(steps: MissionStep[]): ParallelMissionStepDescriptor[] {
  return steps.map((step, index) => {
    const meta = isRecord(step.metadata) ? step.metadata : {};
    const stepType = typeof meta.stepType === "string" ? meta.stepType : "implementation";
    const stepKey = toStepKey(step, index);
    const dependencyIndices = parseNumericDependencyIndices(meta);
    const parallelGroup = typeof meta.parallelGroup === "string" ? meta.parallelGroup : null;
    return {
      index,
      stepKey,
      stepType,
      title: step.title?.trim() || `Step ${index + 1}`,
      dependencyIndices,
      laneId: null,
      parallelGroup
    };
  });
}

/**
 * Sync mission steps from an orchestrator run graph.
 */
export function syncMissionStepsFromRun(ctx: OrchestratorContext, graph: OrchestratorRunGraph): void {
  const missionId = graph.run.missionId;
  const mission = ctx.missionService.get(missionId);
  if (!mission) return;

  for (const step of graph.steps) {
    const missionStep = mission.steps.find((ms) => {
      const msMeta = isRecord(ms.metadata) ? ms.metadata : {};
      return msMeta.orchestratorStepId === step.id || msMeta.stepKey === step.stepKey;
    });
    if (missionStep) {
      const apply = (status: MissionStatus) => {
        try {
          ctx.missionService.updateStep({
            missionId,
            stepId: missionStep.id,
            status: mapOrchestratorStepStatus(step.status) as any
          });
        } catch {
          // ignore step update failures
        }
      };
      apply(mapOrchestratorStepStatus(step.status) as any);
    }
  }
}
