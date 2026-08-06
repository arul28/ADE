import { describe, expect, it } from "vitest";
import {
  ORCHESTRATION_LEAD_CURSOR_SETTING_SOURCES,
  ORCHESTRATION_LEAD_DENIED_CLAUDE_TOOLS,
  ORCHESTRATION_LEAD_MCP_ISOLATION,
  applyOrchestrationPermissionProfile,
  codexConfiguredMcpServerNames,
  orchestrationLeadCodexMcpOverrides,
  orchestrationLeadMcpIsolation,
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

  it("registers an MCP isolation mechanism for every provider that receives MCP", () => {
    // A provider added to ADE without an entry here is a compile error; this
    // asserts the runtime shape and pins the one provider that has no mechanism
    // so the gap cannot quietly become "gated" without someone editing a test.
    for (const provider of ["claude", "codex", "cursor", "droid", "opencode"] as const) {
      const isolation = orchestrationLeadMcpIsolation(provider);
      expect(isolation?.mechanism).toBeTruthy();
      expect(isolation?.note.length).toBeGreaterThan(0);
    }
    expect(ORCHESTRATION_LEAD_MCP_ISOLATION.droid.gated).toBe(false);
    for (const provider of ["claude", "codex", "cursor", "opencode"] as const) {
      expect(ORCHESTRATION_LEAD_MCP_ISOLATION[provider].gated).toBe(true);
    }
    expect(orchestrationLeadMcpIsolation("gemini")).toBeNull();
  });

  it("drops Cursor's MCP-carrying setting layers for a lead but keeps the ADE hook layer", () => {
    // `user` carries ADE's own preToolUse tool-gate hook (~/.cursor/hooks.json);
    // dropping it would disable every Cursor lead denial.
    expect(ORCHESTRATION_LEAD_CURSOR_SETTING_SOURCES).toContain("user");
    expect(ORCHESTRATION_LEAD_CURSOR_SETTING_SOURCES).not.toContain("project");
    expect(ORCHESTRATION_LEAD_CURSOR_SETTING_SOURCES).not.toContain("plugins");
    expect(ORCHESTRATION_LEAD_CURSOR_SETTING_SOURCES).not.toContain("all");
  });

  it("reads Codex's configured MCP server names from every config.toml shape", () => {
    expect(codexConfiguredMcpServerNames([
      "model = \"gpt-5.4\"",
      "",
      "[mcp_servers.filesystem]",
      "command = \"npx\"",
      "args = [\"-y\", \"@modelcontextprotocol/server-filesystem\"]",
      "",
      "[mcp_servers.filesystem.env]",
      "TOKEN = \"x\"",
      "",
      "[mcp_servers.\"my shell\"]",
      "command = \"sh\"",
      "",
      "mcp_servers.git.command = \"git-mcp\"",
      "# mcp_servers.commented.command = \"nope\"",
    ].join("\n"))).toEqual(["filesystem", "my shell", "git"]);

    expect(codexConfiguredMcpServerNames(
      "mcp_servers = { linear = { command = \"linear\", args = [\"mcp\"] }, \"pg\" = { url = \"http://x\" } }",
    )).toEqual(["linear", "pg"]);

    expect(codexConfiguredMcpServerNames("model = \"gpt-5.4\"")).toEqual([]);
  });

  it("turns Codex's configured servers into an explicit per-server disable overlay", () => {
    // Codex merges the thread config overlay into config.toml rather than
    // replacing it, so `mcp_servers = {}` would be a no-op — the only honest
    // isolation is naming each server with `enabled = false`.
    expect(orchestrationLeadCodexMcpOverrides(["filesystem", "git", " "])).toEqual({
      filesystem: { enabled: false },
      git: { enabled: false },
    });
    expect(orchestrationLeadCodexMcpOverrides([])).toEqual({});
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
