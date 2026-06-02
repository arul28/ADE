import type {
  AgentChatClaudePermissionMode,
  AgentChatCodexApprovalPolicy,
  AgentChatCodexConfigSource,
  AgentChatCodexSandbox,
  AgentChatCreateArgs,
  AgentChatDroidPermissionMode,
  AgentChatInteractionMode,
  AgentChatOpenCodePermissionMode,
  AgentChatPermissionMode,
  AgentChatProvider,
} from "./types";
import type { OrchestrationRole } from "./types/orchestration";

export type OrchestrationInteractionMode = Extract<
  AgentChatInteractionMode,
  "orchestrator-lead" | "orchestrator-worker" | "orchestrator-validator"
>;

export type OrchestrationRuntimeSessionRef = {
  interactionMode?: AgentChatInteractionMode | null;
  orchestrationRole?: OrchestrationRole | null;
};

export type OrchestrationPermissionProfile = Partial<Pick<
  AgentChatCreateArgs,
  | "claudePermissionMode"
  | "codexApprovalPolicy"
  | "codexSandbox"
  | "codexConfigSource"
  | "cursorModeId"
  | "droidPermissionMode"
  | "opencodePermissionMode"
>>;

export const ORCHESTRATION_LOCKED_PERMISSION_MODE = "full-auto" satisfies AgentChatPermissionMode;

export const ORCHESTRATION_LEAD_DENIED_CLAUDE_TOOLS = [
  "Agent",
  "Bash",
  "Edit",
  "MultiEdit",
  "Task",
  "TodoRead",
  "TodoWrite",
  "Write",
  "NotebookEdit",
] as const;

const ORCHESTRATION_INTERACTION_MODE_TO_ROLE: Record<OrchestrationInteractionMode, OrchestrationRole> = {
  "orchestrator-lead": "lead",
  "orchestrator-worker": "worker",
  "orchestrator-validator": "validator",
};

const ORCHESTRATION_ROLE_TO_INTERACTION_MODE: Record<OrchestrationRole, OrchestrationInteractionMode> = {
  lead: "orchestrator-lead",
  worker: "orchestrator-worker",
  validator: "orchestrator-validator",
};

export function isOrchestrationInteractionMode(
  mode: AgentChatInteractionMode | null | undefined,
): mode is OrchestrationInteractionMode {
  return mode === "orchestrator-lead"
    || mode === "orchestrator-worker"
    || mode === "orchestrator-validator";
}

export function orchestrationRoleForInteractionMode(
  mode: OrchestrationInteractionMode,
): OrchestrationRole {
  return ORCHESTRATION_INTERACTION_MODE_TO_ROLE[mode];
}

export function orchestrationInteractionModeForRole(
  role: OrchestrationRole,
): OrchestrationInteractionMode {
  return ORCHESTRATION_ROLE_TO_INTERACTION_MODE[role];
}

export function resolveOrchestrationRole(
  session: OrchestrationRuntimeSessionRef,
): OrchestrationRole | null {
  if (session.orchestrationRole) return session.orchestrationRole;
  return isOrchestrationInteractionMode(session.interactionMode)
    ? orchestrationRoleForInteractionMode(session.interactionMode)
    : null;
}

export function lockedOrchestrationPermissionMode(
  session: OrchestrationRuntimeSessionRef,
): AgentChatPermissionMode | null {
  return resolveOrchestrationRole(session) ? ORCHESTRATION_LOCKED_PERMISSION_MODE : null;
}

export function isOrchestrationLeadSession(
  session: OrchestrationRuntimeSessionRef,
): boolean {
  return resolveOrchestrationRole(session) === "lead";
}

export function effectiveOrchestrationPermissionMode(args: {
  permissionMode?: AgentChatPermissionMode | null;
  orchestrationRole?: OrchestrationRole | null;
  interactionMode?: AgentChatInteractionMode | null;
}): AgentChatPermissionMode {
  return lockedOrchestrationPermissionMode(args) ?? args.permissionMode ?? "default";
}

export function applyOrchestrationPermissionProfile(
  provider: AgentChatProvider | string,
): OrchestrationPermissionProfile {
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
