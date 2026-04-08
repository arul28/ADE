import { describe, expect, it } from "vitest";
import {
  buildTrackedCliResumeCommand,
  buildTrackedCliStartupCommand,
  defaultTrackedCliStartupCommand,
  resolveTrackedCliResumeCommand,
  withCodexNoAltScreen,
} from "./cliLaunch";
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
});

describe("buildTrackedCliStartupCommand", () => {
  describe("claude provider", () => {
    it("adds --dangerously-skip-permissions for full-auto", () => {
      expect(
        buildTrackedCliStartupCommand({ provider: "claude", permissionMode: "full-auto" }),
      ).toBe("claude --dangerously-skip-permissions");
    });

    it("adds --permission-mode acceptEdits for edit", () => {
      expect(
        buildTrackedCliStartupCommand({ provider: "claude", permissionMode: "edit" }),
      ).toBe("claude --permission-mode acceptEdits");
    });

    it("adds --permission-mode default for default", () => {
      expect(
        buildTrackedCliStartupCommand({ provider: "claude", permissionMode: "default" }),
      ).toBe("claude --permission-mode default");
    });

    it("adds --permission-mode plan for plan (else branch)", () => {
      expect(
        buildTrackedCliStartupCommand({ provider: "claude", permissionMode: "plan" }),
      ).toBe("claude --permission-mode plan");
    });

    it("adds --permission-mode plan for config-toml (falls through to else)", () => {
      expect(
        buildTrackedCliStartupCommand({ provider: "claude", permissionMode: "config-toml" }),
      ).toBe("claude --permission-mode plan");
    });
  });

  describe("codex provider", () => {
    it("adds --full-auto for full-auto", () => {
      expect(
        buildTrackedCliStartupCommand({ provider: "codex", permissionMode: "full-auto" }),
      ).toBe("codex --no-alt-screen --full-auto");
    });

    it("passes no extra flags for config-toml", () => {
      expect(
        buildTrackedCliStartupCommand({ provider: "codex", permissionMode: "config-toml" }),
      ).toBe("codex --no-alt-screen");
    });

    it("adds on-failure approval and workspace-write sandbox for edit", () => {
      expect(
        buildTrackedCliStartupCommand({ provider: "codex", permissionMode: "edit" }),
      ).toBe("codex --no-alt-screen -c approval_policy=on-failure -c sandbox_mode=workspace-write");
    });

    it("adds untrusted approval and read-only sandbox for default", () => {
      expect(
        buildTrackedCliStartupCommand({ provider: "codex", permissionMode: "default" }),
      ).toBe("codex --no-alt-screen -c approval_policy=untrusted -c sandbox_mode=read-only");
    });

    it("adds untrusted approval and read-only sandbox for plan (else branch)", () => {
      expect(
        buildTrackedCliStartupCommand({ provider: "codex", permissionMode: "plan" }),
      ).toBe("codex --no-alt-screen -c approval_policy=untrusted -c sandbox_mode=read-only");
    });
  });

  it("covers all AgentChatPermissionMode values for both providers", () => {
    const modes = ["default", "plan", "edit", "full-auto", "config-toml"] as const satisfies readonly AgentChatPermissionMode[];
    for (const mode of modes) {
      const claude = buildTrackedCliStartupCommand({ provider: "claude", permissionMode: mode });
      const codex = buildTrackedCliStartupCommand({ provider: "codex", permissionMode: mode });
      expect(claude.length).toBeGreaterThan(0);
      expect(codex.length).toBeGreaterThan(0);
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
    })).toBe("codex --no-alt-screen -c approval_policy=on-failure -c sandbox_mode=workspace-write resume thread-99");
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

    expect(resolveTrackedCliResumeCommand(session)).toBe("codex --no-alt-screen --full-auto resume thread-99");
  });
});
