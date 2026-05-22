/* @vitest-environment node */
import { describe, expect, it } from "vitest";

import { CURSOR_AVAILABLE_MODE_IDS } from "../../../shared/cursorModes";
import type {
  AgentChatClaudePermissionMode,
  AgentChatCodexApprovalPolicy,
  AgentChatCodexSandbox,
  AgentChatDroidPermissionMode,
  AgentChatOpenCodePermissionMode,
} from "../../../shared/types/chat";

/**
 * Mirrors the per-provider permission profile applied at orchestration spawn
 * time (see `applyOrchestrationPermissionProfile` in registerIpc.ts). The
 * canary test here pins the mode strings to the runtime unions — if a
 * provider's union shifts and these strings stop being valid, this test fails
 * BEFORE silently demoting orchestration workers to a weaker permission tier.
 */
const PROFILE = {
  claude: { claudePermissionMode: "bypassPermissions" as AgentChatClaudePermissionMode },
  codex: {
    codexSandbox: "danger-full-access" as AgentChatCodexSandbox,
    codexApprovalPolicy: "never" as AgentChatCodexApprovalPolicy,
  },
  cursor: { cursorModeId: "full-auto" as const },
  droid: { droidPermissionMode: "auto-high" as AgentChatDroidPermissionMode },
  opencode: { opencodePermissionMode: "full-auto" as AgentChatOpenCodePermissionMode },
};

describe("orchestration permission profile (canary)", () => {
  it("cursor worker mode is full-auto (not 'agent')", () => {
    expect(PROFILE.cursor.cursorModeId).toBe("full-auto");
    expect(CURSOR_AVAILABLE_MODE_IDS).toContain(PROFILE.cursor.cursorModeId);
  });

  it("claude worker mode is bypassPermissions", () => {
    const allowed: AgentChatClaudePermissionMode[] = [
      "default",
      "auto",
      "plan",
      "acceptEdits",
      "bypassPermissions",
    ];
    expect(allowed).toContain(PROFILE.claude.claudePermissionMode);
    expect(PROFILE.claude.claudePermissionMode).toBe("bypassPermissions");
  });

  it("codex worker sandbox is danger-full-access with approvals=never", () => {
    const sandboxes: AgentChatCodexSandbox[] = [
      "read-only",
      "workspace-write",
      "danger-full-access",
    ];
    expect(sandboxes).toContain(PROFILE.codex.codexSandbox);
    expect(PROFILE.codex.codexSandbox).toBe("danger-full-access");
    const policies: AgentChatCodexApprovalPolicy[] = [
      "untrusted",
      "on-request",
      "on-failure",
      "never",
    ];
    expect(policies).toContain(PROFILE.codex.codexApprovalPolicy);
    expect(PROFILE.codex.codexApprovalPolicy).toBe("never");
  });

  it("droid worker mode is auto-high", () => {
    const allowed: AgentChatDroidPermissionMode[] = [
      "read-only",
      "auto-low",
      "auto-medium",
      "auto-high",
    ];
    expect(allowed).toContain(PROFILE.droid.droidPermissionMode);
    expect(PROFILE.droid.droidPermissionMode).toBe("auto-high");
  });

  it("opencode worker mode is full-auto", () => {
    const allowed: AgentChatOpenCodePermissionMode[] = ["plan", "edit", "full-auto"];
    expect(allowed).toContain(PROFILE.opencode.opencodePermissionMode);
    expect(PROFILE.opencode.opencodePermissionMode).toBe("full-auto");
  });
});
