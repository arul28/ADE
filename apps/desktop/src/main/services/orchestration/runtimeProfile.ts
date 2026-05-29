import type {
  AgentChatClaudePermissionMode,
  AgentChatCodexApprovalPolicy,
  AgentChatCodexConfigSource,
  AgentChatCodexSandbox,
  AgentChatCreateArgs,
  AgentChatDroidPermissionMode,
  AgentChatOpenCodePermissionMode,
  AgentChatProvider,
} from "../../../shared/types";
import type {
  ModelSelection,
  OrchestrationManifest,
} from "../../../shared/types/orchestration";

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

export function applyOrchestrationPermissionProfile(
  provider: AgentChatProvider | string,
): Partial<Pick<
  AgentChatCreateArgs,
  | "claudePermissionMode"
  | "codexApprovalPolicy"
  | "codexSandbox"
  | "codexConfigSource"
  | "cursorModeId"
  | "droidPermissionMode"
  | "opencodePermissionMode"
>> {
  switch (provider) {
    case "claude":
      return {
        claudePermissionMode: "bypassPermissions" satisfies AgentChatClaudePermissionMode,
      };
    case "codex":
      return {
        codexSandbox: "danger-full-access" satisfies AgentChatCodexSandbox,
        codexApprovalPolicy: "never" satisfies AgentChatCodexApprovalPolicy,
        codexConfigSource: "flags" satisfies AgentChatCodexConfigSource,
      };
    case "cursor":
      return { cursorModeId: "full-auto" };
    case "droid":
      return {
        droidPermissionMode: "auto-high" satisfies AgentChatDroidPermissionMode,
      };
    case "opencode":
      return {
        opencodePermissionMode: "full-auto" satisfies AgentChatOpenCodePermissionMode,
      };
    default:
      return {};
  }
}

export function isOrchestrationPlanApproved(
  manifest: OrchestrationManifest,
): boolean {
  if (manifest.currentPhase !== "planning") return true;
  return typeof manifest.leadState.planApprovedAt === "string"
    && manifest.leadState.planApprovedAt.trim().length > 0;
}
