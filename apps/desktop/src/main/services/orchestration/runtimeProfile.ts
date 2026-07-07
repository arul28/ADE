import type {
  ModelSelection,
  OrchestrationManifest,
  UserOverrideEntry,
} from "../../../shared/types/orchestration";
export { applyOrchestrationPermissionProfile } from "../../../shared/orchestrationRuntimePolicy";

export type OrchestrationRoutingResult = ModelSelection & {
  routingKey: "byRoleTag" | "byTag" | "byRole" | "default" | "fallback" | "override";
};

export function resolveOrchestrationModel(
  manifest: OrchestrationManifest,
  role: "worker" | "validator",
  tag: string,
  override?: ModelSelection,
): OrchestrationRoutingResult {
  if (override) return { ...override, routingKey: "override" };
  const r = manifest.modelRouting;
  const byRoleTag = r.byRoleTag?.[`${role}:${tag}`];
  if (byRoleTag) return { ...byRoleTag, routingKey: "byRoleTag" };
  const byTag = r.byTag?.[tag];
  if (byTag) return { ...byTag, routingKey: "byTag" };
  const byRole = r.byRole?.[role];
  if (byRole) return { ...byRole, routingKey: "byRole" };
  if (r.default) return { ...r.default, routingKey: "default" };
  return {
    provider: "claude",
    modelId: "claude-sonnet-5",
    reasoningEffort: null,
    fastMode: false,
    routingKey: "fallback",
  };
}

export function isOrchestrationPlanApproved(
  manifest: OrchestrationManifest,
): boolean {
  if (manifest.currentPhase !== "planning") return true;
  if (manifest.planSpec?.approval.state === "approved") return true;
  return typeof manifest.leadState.planApprovedAt === "string"
    && manifest.leadState.planApprovedAt.trim().length > 0;
}

/**
 * The deterministic dev-loop gates. Model selection unlocks only after the
 * three deliberation rounds are recorded; approval only after the lead marks
 * planning ready. Both are no-ops once the run has left the planning phase.
 */
export function isPlanningReadyForModelSelection(
  manifest: OrchestrationManifest,
): boolean {
  if (manifest.currentPhase !== "planning") return true;
  const stage = manifest.leadState.planning?.stage;
  return stage === "rounds_complete" || stage === "ready";
}

export function isPlanningReadyForApproval(
  manifest: OrchestrationManifest,
): boolean {
  if (manifest.currentPhase !== "planning") return true;
  return manifest.leadState.planning?.stage === "ready";
}

const NEGATED_VALIDATION_WAIVER_RE =
  /\b(?:do\s+not|don't|dont|never)\s+(?:skip|waive|bypass)\s+(?:the\s+)?validation\b|\bno\s+validation\s+(?:shortcuts?|skips?|waivers?|bypasses?)\b|\bnot\s+without\s+(?:running\s+)?validation\b/i;
const POSITIVE_VALIDATION_WAIVER_RE =
  /\b(?:skip|waive|bypass)\s+(?:the\s+)?validation\b|\bno\s+validation\s+(?:required|needed|necessary|for\s+(?:this\s+)?run)\b|\bwithout\s+(?:running\s+)?validation\b|\bvalidation\s+(?:is\s+)?(?:waived|skipped|not\s+required|unnecessary|unneeded)\b/i;

export function isExplicitValidationWaiverEntry(
  entry: Pick<UserOverrideEntry, "scope" | "appliedToId" | "instruction" | "affectedDefault">,
): boolean {
  if (
    entry.scope !== "phase" ||
    entry.appliedToId !== "planning" ||
    entry.affectedDefault !== "validation"
  ) {
    return false;
  }
  const instruction = entry.instruction.trim();
  if (!instruction) return false;
  if (NEGATED_VALIDATION_WAIVER_RE.test(instruction)) return false;
  return POSITIVE_VALIDATION_WAIVER_RE.test(instruction);
}

export function hasExplicitValidationWaiver(
  manifest: OrchestrationManifest,
): boolean {
  return manifest.userOverrides.some(isExplicitValidationWaiverEntry);
}

export function hasOrchestrationModelRouting(
  manifest: OrchestrationManifest,
): boolean {
  return (
    Object.keys(manifest.modelRouting.byRoleTag ?? {}).length > 0 ||
    Object.keys(manifest.modelRouting.byTag ?? {}).length > 0 ||
    Object.keys(manifest.modelRouting.byRole ?? {}).length > 0 ||
    Boolean(manifest.modelRouting.default)
  );
}
