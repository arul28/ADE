import type {
  ModelSelection,
  OrchestrationManifest,
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
    modelId: "claude-sonnet-4-6",
    reasoningEffort: null,
    codexFastMode: false,
    routingKey: "fallback",
  };
}

export function isOrchestrationPlanApproved(
  manifest: OrchestrationManifest,
): boolean {
  if (manifest.currentPhase !== "planning") return true;
  return typeof manifest.leadState.planApprovedAt === "string"
    && manifest.leadState.planApprovedAt.trim().length > 0;
}
