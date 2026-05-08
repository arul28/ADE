import { describe, expect, it } from "vitest";
import {
  buildTrackedCliLaunchCommand,
  buildTrackedCliResumeCommand,
  buildTrackedCliStartupCommand,
  defaultTrackedCliStartupCommand,
  resolveTrackedCliResumeCommand,
  withCodexNoAltScreen,
} from "./cliLaunch";
import { ADE_CLI_AGENT_GUIDANCE, ADE_CLI_INLINE_GUIDANCE } from "../../../shared/adeCliGuidance";
import type { AgentChatPermissionMode, TerminalSessionSummary } from "../../../shared/types";

describe("withCodexNoAltScreen", () => {
  it("returns non-codex commands unchanged", () => {
    expect(withCodexNoAltScreen("claude")).toBe("claude");
    expect(withCodexNoAltScreen("  claude --help  ")).toBe("claude --help");
  });

  it("adds --no-alt-screen to bare 'codex'", () => {
    expect(withCodexNoAltScreen("codex")).toBe("codex --no-alt-screen");
  });

  it("adds --no-alt-screen to 'codex' with arguments", () => {
    expect(withCodexNoAltScreen("codex --full-auto")).toBe("codex --no-alt-screen --full-auto");
  });

  it("does not add flag if already present", () => {
    expect(withCodexNoAltScreen("codex --no-alt-screen")).toBe("codex --no-alt-screen");
    expect(withCodexNoAltScreen("codex --no-alt-screen --full-auto")).toBe("codex --no-alt-screen --full-auto");
  });

  it("trims whitespace from input", () => {
    expect(withCodexNoAltScreen("  codex  ")).toBe("codex --no-alt-screen");
  });

  it("does not match codex as a substring", () => {
    expect(withCodexNoAltScreen("mycodex")).toBe("mycodex");
    expect(withCodexNoAltScreen("codex-fork --arg")).toBe("codex-fork --arg");
  });
});

describe("defaultTrackedCliStartupCommand", () => {
  it("returns 'claude' for claude provider", () => {
    expect(defaultTrackedCliStartupCommand("claude")).toBe("claude");
  });

  it("returns 'codex --no-alt-screen' for codex provider", () => {
    expect(defaultTrackedCliStartupCommand("codex")).toBe("codex --no-alt-screen");
  });

  it("returns launch binaries for the other tracked CLI providers", () => {
    expect(defaultTrackedCliStartupCommand("cursor")).toBe("cursor-agent");
    expect(defaultTrackedCliStartupCommand("droid")).toBe("droid");
    expect(defaultTrackedCliStartupCommand("opencode")).toBe("opencode");
  });
});

describe("buildTrackedCliStartupCommand", () => {
  describe("claude provider", () => {
    it("adds --dangerously-skip-permissions for full-auto", () => {
      const command = buildTrackedCliStartupCommand({ provider: "claude", permissionMode: "full-auto" });
      expect(command).toContain("claude --append-system-prompt");
      expect(command).toContain("only normal reason to skip ADE CLI");
      expect(command).toContain("--dangerously-skip-permissions");
    });

    it("adds --permission-mode acceptEdits for edit", () => {
      const command = buildTrackedCliStartupCommand({ provider: "claude", permissionMode: "edit" });
      expect(command).toContain("--append-system-prompt");
      expect(command).toContain("--permission-mode acceptEdits");
    });

    it("adds --permission-mode default for default", () => {
      const command = buildTrackedCliStartupCommand({ provider: "claude", permissionMode: "default" });
      expect(command).toContain("--append-system-prompt");
      expect(command).toContain("--permission-mode default");
    });

    it("adds --permission-mode plan for plan (else branch)", () => {
      const command = buildTrackedCliStartupCommand({ provider: "claude", permissionMode: "plan" });
      expect(command).toContain("--append-system-prompt");
      expect(command).toContain("--permission-mode plan");
    });

    it("rejects config-toml before building unsupported Claude commands", () => {
      expect(() => buildTrackedCliStartupCommand({ provider: "claude", permissionMode: "config-toml" })).toThrow(
        "config-toml is only supported for Codex",
      );
    });

    it("uses Claude's system-prompt hook for ADE guidance", () => {
      const launch = buildTrackedCliLaunchCommand({
        provider: "claude",
        permissionMode: "default",
        sessionId: "00000000-0000-0000-0000-000000000001",
      });
      expect(launch.command).toBe("claude");
      expect(launch.args).toEqual(expect.arrayContaining([
        "--session-id",
        "00000000-0000-0000-0000-000000000001",
        "--append-system-prompt",
        ADE_CLI_AGENT_GUIDANCE,
        "--permission-mode",
        "default",
      ]));
      expect(launch.startupCommand).toContain("--append-system-prompt");
      expect(launch.startupCommand).toContain(ADE_CLI_AGENT_GUIDANCE.split("\n")[0]!);
      expect(launch.startupCommand).toContain("clean up old, stale, or finished processes");
    });
  });

  describe("codex provider", () => {
    it("adds the dangerous bypass flag for full-auto", () => {
      const command = buildTrackedCliStartupCommand({ provider: "codex", permissionMode: "full-auto" });
      expect(command).toContain("codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox");
      expect(command).toContain("only normal reason to skip ADE CLI");
    });

    it("adds Codex's auto preset for default", () => {
      const command = buildTrackedCliStartupCommand({ provider: "codex", permissionMode: "default" });
      expect(command).toContain("codex --no-alt-screen --full-auto");
      expect(command).toContain("only normal reason to skip ADE CLI");
    });

    it("passes no extra flags for config-toml", () => {
      const command = buildTrackedCliStartupCommand({ provider: "codex", permissionMode: "config-toml" });
      expect(command).toContain("codex --no-alt-screen");
      expect(command).not.toContain("--full-auto");
      expect(command).toContain("only normal reason to skip ADE CLI");
    });

    it("adds untrusted approval and workspace-write sandbox for edit", () => {
      const command = buildTrackedCliStartupCommand({ provider: "codex", permissionMode: "edit" });
      expect(command).toContain("codex --no-alt-screen --sandbox workspace-write --ask-for-approval untrusted");
      expect(command).toContain("only normal reason to skip ADE CLI");
    });

    it("adds on-request approval and read-only sandbox for plan", () => {
      const command = buildTrackedCliStartupCommand({ provider: "codex", permissionMode: "plan" });
      expect(command).toContain("codex --no-alt-screen --sandbox read-only --ask-for-approval on-request");
      expect(command).toContain("only normal reason to skip ADE CLI");
    });

    it("seeds Codex with ADE guidance as the initial prompt", () => {
      const launch = buildTrackedCliLaunchCommand({ provider: "codex", permissionMode: "default" });
      expect(launch.command).toBe("codex");
      expect(launch.args[0]).toBe("--no-alt-screen");
      expect(launch.args.at(-1)).toContain("ADE session guidance");
      expect(ADE_CLI_INLINE_GUIDANCE).toContain("default control plane");
      expect(launch.args.at(-1)).toContain("default control plane");
      expect(launch.args.at(-1)).toContain("clean up old, stale, or finished processes");
      expect(launch.startupCommand).toContain("ADE session guidance");
    });
  });

  describe("additional CLI providers", () => {
    it("launches Cursor through a pre-created resumable chat", () => {
      const launch = buildTrackedCliLaunchCommand({ provider: "cursor", permissionMode: "plan" });
      expect(launch.command).toBeUndefined();
      expect(launch.startupCommand).toContain("cursor-agent create-chat");
      expect(launch.startupCommand).toContain("cursor-agent --mode plan --resume \"$ADE_CURSOR_CHAT_ID\"");
      expect(launch.startupCommand).toContain("Resume with cursor-agent --resume");
    });

    it("launches Droid with process-local autonomy settings", () => {
      const launch = buildTrackedCliLaunchCommand({ provider: "droid", permissionMode: "edit" });
      expect(launch.command).toBeUndefined();
      expect(launch.startupCommand).toContain("ade-droid-settings");
      expect(launch.startupCommand).toContain("\\\"autonomyLevel\\\":\\\"low\\\"");
      expect(launch.startupCommand).toContain("droid --settings \"$ADE_DROID_SETTINGS\"");
    });

    it("launches OpenCode with inline permission config", () => {
      const launch = buildTrackedCliLaunchCommand({ provider: "opencode", permissionMode: "full-auto" });
      expect(launch.command).toBe("opencode");
      expect(launch.env?.OPENCODE_CONFIG_CONTENT).toBe("{\"permission\":\"allow\"}");
      expect(launch.startupCommand).toContain("OPENCODE_CONFIG_CONTENT=\"{\\\"permission\\\":\\\"allow\\\"}\" opencode");
    });

    it("rejects config-toml for providers that do not support it", () => {
      expect(() => buildTrackedCliLaunchCommand({ provider: "cursor", permissionMode: "config-toml" })).toThrow(
        "config-toml is only supported for Codex",
      );
      expect(() => buildTrackedCliLaunchCommand({ provider: "droid", permissionMode: "config-toml" })).toThrow(
        "config-toml is only supported for Codex",
      );
      expect(() => buildTrackedCliLaunchCommand({ provider: "opencode", permissionMode: "config-toml" })).toThrow(
        "config-toml is only supported for Codex",
      );
    });
  });

  it("covers supported AgentChatPermissionMode values for each provider", () => {
    const modes = ["default", "plan", "edit", "full-auto", "config-toml"] as const satisfies readonly AgentChatPermissionMode[];
    for (const mode of modes) {
      const codex = buildTrackedCliStartupCommand({ provider: "codex", permissionMode: mode });
      expect(codex.length).toBeGreaterThan(0);
      if (mode === "config-toml") continue;
      expect(buildTrackedCliStartupCommand({ provider: "claude", permissionMode: mode }).length).toBeGreaterThan(0);
      expect(buildTrackedCliStartupCommand({ provider: "cursor", permissionMode: mode }).length).toBeGreaterThan(0);
      expect(buildTrackedCliStartupCommand({ provider: "droid", permissionMode: mode }).length).toBeGreaterThan(0);
      expect(buildTrackedCliStartupCommand({ provider: "opencode", permissionMode: mode }).length).toBeGreaterThan(0);
    }
  });
});

describe("tracked CLI resume helpers", () => {
  it("rebuilds permission-aware resume commands from metadata", () => {
    expect(buildTrackedCliResumeCommand({
      provider: "claude",
      targetKind: "session",
      targetId: "claude-session-1",
      launch: { permissionMode: "default" },
    })).toBe("claude --permission-mode default --resume claude-session-1");

    expect(buildTrackedCliResumeCommand({
      provider: "codex",
      targetKind: "thread",
      targetId: "thread-99",
      launch: { permissionMode: "edit" },
    })).toBe("codex --no-alt-screen --sandbox workspace-write --ask-for-approval untrusted resume thread-99");

    expect(buildTrackedCliResumeCommand({
      provider: "cursor",
      targetKind: "session",
      targetId: "chat-99",
      launch: { permissionMode: "full-auto" },
    })).toBe("cursor-agent --force --resume chat-99");

    expect(buildTrackedCliResumeCommand({
      provider: "opencode",
      targetKind: "session",
      targetId: "ses_99",
      launch: { permissionMode: "plan" },
    })).toContain("opencode --agent plan --session ses_99");
  });

  it("falls back to the provider resume picker when the concrete target is missing", () => {
    expect(buildTrackedCliResumeCommand({
      provider: "claude",
      targetKind: "session",
      targetId: null,
      launch: { permissionMode: "default" },
    })).toBe("claude --permission-mode default --resume");

    expect(buildTrackedCliResumeCommand({
      provider: "codex",
      targetKind: "thread",
      targetId: null,
      launch: { permissionMode: "full-auto" },
    })).toBe("codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox resume");

    expect(buildTrackedCliResumeCommand({
      provider: "cursor",
      targetKind: "session",
      targetId: null,
      launch: { permissionMode: "plan" },
    })).toBe("cursor-agent --mode plan --continue");

    expect(buildTrackedCliResumeCommand({
      provider: "droid",
      targetKind: "session",
      targetId: null,
      launch: { permissionMode: "default" },
    })).toContain("droid --settings \"$ADE_DROID_SETTINGS\" --resume");
  });

  it("rejects unsupported resume permission/provider combinations", () => {
    expect(() => buildTrackedCliResumeCommand({
      provider: "claude",
      targetKind: "session",
      targetId: "claude-session-1",
      launch: { permissionMode: "config-toml" },
    })).toThrow("config-toml is only supported for Codex");
  });

  it("prefers structured metadata over the legacy resume command string", () => {
    const session = {
      resumeCommand: "codex resume picker",
      resumeMetadata: {
        provider: "codex",
        targetKind: "thread",
        targetId: "thread-99",
        launch: { permissionMode: "full-auto" },
      },
    } satisfies Pick<TerminalSessionSummary, "resumeCommand" | "resumeMetadata">;

    expect(resolveTrackedCliResumeCommand(session)).toBe("codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox resume thread-99");
  });
});
