import { describe, expect, it } from "vitest";
import {
  ORCHESTRATION_LEAD_DENIED_CLAUDE_TOOLS,
  applyOrchestrationPermissionProfile,
  effectiveOrchestrationPermissionMode,
  isOrchestrationInteractionMode,
  isOrchestrationLeadSession,
  lockedOrchestrationPermissionMode,
  orchestrationInteractionModeForRole,
  orchestrationRoleForInteractionMode,
} from "./orchestrationRuntimePolicy";
import type { AgentChatCliLaunchProvider } from "./types/chat";
import type { OrchestrationRole } from "./types/orchestration";

const PROVIDER_PROFILE_EXPECTATIONS: Record<AgentChatCliLaunchProvider, Record<string, unknown>> = {
  claude: { claudePermissionMode: "bypassPermissions" },
  codex: {
    codexApprovalPolicy: "never",
    codexSandbox: "danger-full-access",
    codexConfigSource: "flags",
  },
  cursor: { cursorModeId: "full-auto" },
  droid: { droidPermissionMode: "auto-high" },
  opencode: { opencodePermissionMode: "full-auto" },
};

describe("orchestrationRuntimePolicy", () => {
  it("maps orchestration roles and interaction modes consistently", () => {
    const roles: OrchestrationRole[] = ["lead", "worker", "validator"];
    for (const role of roles) {
      const mode = orchestrationInteractionModeForRole(role);
      expect(isOrchestrationInteractionMode(mode)).toBe(true);
      expect(orchestrationRoleForInteractionMode(mode)).toBe(role);
      expect(lockedOrchestrationPermissionMode({ orchestrationRole: role })).toBe("full-auto");
      expect(lockedOrchestrationPermissionMode({ interactionMode: mode })).toBe("full-auto");
      expect(isOrchestrationLeadSession({ orchestrationRole: role })).toBe(role === "lead");
    }

    expect(isOrchestrationInteractionMode("default")).toBe(false);
    expect(lockedOrchestrationPermissionMode({ interactionMode: "plan" })).toBeNull();
  });

  it("forces orchestration launches to full-auto before provider-specific adapters run", () => {
    expect(effectiveOrchestrationPermissionMode({
      permissionMode: "plan",
      orchestrationRole: "lead",
    })).toBe("full-auto");
    expect(effectiveOrchestrationPermissionMode({
      permissionMode: "edit",
      interactionMode: "orchestrator-worker",
    })).toBe("full-auto");
    expect(effectiveOrchestrationPermissionMode({ permissionMode: "plan" })).toBe("plan");
    expect(effectiveOrchestrationPermissionMode({})).toBe("default");
  });

  it("defines a permission profile for every chat and CLI provider ADE launches", () => {
    for (const [provider, expected] of Object.entries(PROVIDER_PROFILE_EXPECTATIONS)) {
      expect(applyOrchestrationPermissionProfile(provider)).toEqual(expected);
    }
  });

  it("denies Claude-native direct-work tools for orchestrator leads", () => {
    expect(ORCHESTRATION_LEAD_DENIED_CLAUDE_TOOLS).toEqual(expect.arrayContaining([
      "Agent",
      "Bash",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "Task",
      "TodoRead",
      "TodoWrite",
      "Write",
    ]));
  });
});
