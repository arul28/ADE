import { describe, expect, it } from "vitest";
import {
  buildPtyContinuationLaunchFields,
  buildTrackedCliLaunchCommand,
  buildTrackedCliResumeCommand,
  buildTrackedCliStartupCommand,
  buildOpenCodeReplayResumeCommand,
  defaultTrackedCliStartupCommand,
  deriveTrackedCliInitialInputSessionMeta,
  mergeContinuationLaunch,
  resolveCleanShellLaunchFields,
  resolveTrackedCliResumeCommand,
  withCodexNoAltScreen,
} from "./cliLaunch";
import { ADE_CLI_AGENT_GUIDANCE } from "../../../shared/adeCliGuidance";
import { ADE_AGENT_SKILLS_DIRS_ENV } from "../../../shared/agentSkillRoots";
import type { AgentChatPermissionMode, TerminalSessionSummary } from "../../../shared/types";

const originalPlatform = process.platform;

function withProcessPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
}

describe("buildPtyContinuationLaunchFields", () => {
  it("forwards trimmed continuation controls and preserves explicit false fast mode", () => {
    expect(buildPtyContinuationLaunchFields({
      model: "  openai/gpt-5.4  ",
      reasoningEffort: " high ",
      fastMode: false,
      codexFastMode: true,
      permissionMode: "plan",
      codexApprovalPolicy: "on-request",
      codexSandbox: "read-only",
      codexConfigSource: "flags",
    })).toEqual({
      model: "openai/gpt-5.4",
      reasoningEffort: "high",
      fastMode: false,
      permissionMode: "plan",
      codexApprovalPolicy: "on-request",
      codexSandbox: "read-only",
      codexConfigSource: "flags",
    });
  });

  it("uses the legacy fast-mode field and omits empty continuation controls", () => {
    expect(buildPtyContinuationLaunchFields({
      model: "  ",
      reasoningEffort: null,
      fastMode: null,
      codexFastMode: true,
      permissionMode: null,
      codexApprovalPolicy: null,
      codexSandbox: null,
      codexConfigSource: null,
    })).toEqual({ fastMode: true });
    expect(buildPtyContinuationLaunchFields(null)).toEqual({});
  });
});

describe("mergeContinuationLaunch", () => {
  it("prefers stored launch choices while filling missing exact controls", () => {
    expect(mergeContinuationLaunch({
      model: "recovered-model",
      reasoningEffort: "high",
      fastMode: true,
      codexApprovalPolicy: "on-request",
      codexSandbox: "workspace-write",
      codexConfigSource: "flags",
    }, {
      model: " stored-model ",
      reasoningEffort: null,
      fastMode: false,
      permissionMode: null,
      codexApprovalPolicy: null,
      codexSandbox: null,
      codexConfigSource: null,
    })).toMatchObject({
      model: "stored-model",
      reasoningEffort: "high",
      fastMode: false,
      codexApprovalPolicy: "on-request",
      codexSandbox: "workspace-write",
      codexConfigSource: "flags",
    });
  });

  it("does not mix recovered granular Codex controls with a stored coarse permission", () => {
    expect(mergeContinuationLaunch({
      codexApprovalPolicy: "on-request",
      codexSandbox: "workspace-write",
      codexConfigSource: "flags",
    }, {
      permissionMode: "full-auto",
    })).toMatchObject({
      permissionMode: "full-auto",
      codexApprovalPolicy: null,
      codexSandbox: null,
      codexConfigSource: null,
    });
  });
});

describe("withCodexNoAltScreen", () => {
  it("returns non-codex commands unchanged", () => {
    expect(withCodexNoAltScreen("claude")).toBe("claude");
    expect(withCodexNoAltScreen("  claude --help  ")).toBe("claude --help");
  });

  it("adds --no-alt-screen to bare 'codex'", () => {
    expect(withCodexNoAltScreen("codex")).toBe("codex --no-alt-screen");
  });

  it("adds --no-alt-screen to 'codex' with arguments", () => {
    expect(withCodexNoAltScreen("codex --sandbox workspace-write")).toBe("codex --no-alt-screen --sandbox workspace-write");
  });

  it("does not add flag if already present", () => {
    expect(withCodexNoAltScreen("codex --no-alt-screen")).toBe("codex --no-alt-screen");
    expect(withCodexNoAltScreen("codex --no-alt-screen --sandbox workspace-write")).toBe("codex --no-alt-screen --sandbox workspace-write");
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
    expect(defaultTrackedCliStartupCommand("cursor")).toBe("cursor-agent --model auto");
    expect(defaultTrackedCliStartupCommand("droid")).toBe("droid");
    expect(defaultTrackedCliStartupCommand("opencode")).toBe("opencode");
  });
});

describe("orchestration CLI launch policy", () => {
  it("forces orchestration roles to full-auto for every tracked CLI runtime", () => {
    const claude = buildTrackedCliLaunchCommand({
      provider: "claude",
      permissionMode: "plan",
      orchestrationRole: "worker",
    });
    expect(claude.args).toContain("--dangerously-skip-permissions");
    expect(claude.args).not.toEqual(expect.arrayContaining(["--permission-mode", "plan"]));

    const codex = buildTrackedCliLaunchCommand({
      provider: "codex",
      permissionMode: "plan",
      orchestrationRole: "worker",
    });
    expect(codex.args).toEqual(expect.arrayContaining(["--dangerously-bypass-approvals-and-sandbox"]));
    expect(codex.args).not.toEqual(expect.arrayContaining(["--sandbox", "read-only"]));

    const cursor = buildTrackedCliLaunchCommand({
      provider: "cursor",
      permissionMode: "plan",
      orchestrationRole: "validator",
    });
    expect(cursor.args).toContain("--force");
    expect(cursor.args).not.toEqual(expect.arrayContaining(["--mode", "plan"]));

    const droid = buildTrackedCliLaunchCommand({
      provider: "droid",
      permissionMode: "plan",
      orchestrationRole: "worker",
    });
    expect(droid.startupCommand).toContain('\\"autonomyLevel\\":\\"high\\"');
    expect(droid.startupCommand).not.toContain('\\"interactionMode\\":\\"spec\\"');

    const opencode = buildTrackedCliLaunchCommand({
      provider: "opencode",
      permissionMode: "plan",
      orchestrationRole: "validator",
    });
    expect(opencode.args).not.toEqual(expect.arrayContaining(["--agent", "plan"]));
    expect(opencode.env?.OPENCODE_CONFIG_CONTENT).toContain('"permission":"allow"');
  });
});

describe("resolveCleanShellLaunchFields", () => {
  it("starts zsh without reading user startup files", () => {
    expect(resolveCleanShellLaunchFields({ platform: "darwin", shell: "/bin/zsh" })).toEqual({
      command: "/bin/zsh",
      args: ["-f"],
      env: { ZDOTDIR: "/var/empty" },
    });
  });

  it("starts bash without profile or rc files", () => {
    expect(resolveCleanShellLaunchFields({ platform: "linux", shell: "/bin/bash" })).toEqual({
      command: "/bin/bash",
      args: ["--noprofile", "--norc"],
      env: { BASH_ENV: "" },
    });
  });

  it("starts Windows PowerShell without profile scripts", () => {
    expect(resolveCleanShellLaunchFields({ platform: "win32", comSpec: "cmd.exe" })).toEqual({
      command: "powershell.exe",
      args: ["-NoLogo", "-NoProfile"],
    });
  });
});

describe("buildTrackedCliStartupCommand", () => {
  describe("claude provider", () => {
    it("adds --dangerously-skip-permissions for full-auto", () => {
      const command = buildTrackedCliStartupCommand({ provider: "claude", permissionMode: "full-auto" });
      expect(command).toContain("--dangerously-skip-permissions");
      expect(command).not.toContain("--append-system-prompt");
    });

    it("adds --permission-mode acceptEdits for edit", () => {
      const command = buildTrackedCliStartupCommand({ provider: "claude", permissionMode: "edit" });
      expect(command).toContain("--permission-mode acceptEdits");
      expect(command).not.toContain("--append-system-prompt");
    });

    it("adds --permission-mode default for default", () => {
      const command = buildTrackedCliStartupCommand({ provider: "claude", permissionMode: "default" });
      expect(command).toContain("--permission-mode default");
      expect(command).not.toContain("--append-system-prompt");
    });

    it("adds --permission-mode auto for Claude auto", () => {
      const command = buildTrackedCliStartupCommand({ provider: "claude", permissionMode: "auto" });
      expect(command).toContain("--permission-mode auto");
      expect(command).not.toContain("--append-system-prompt");
    });

    it("adds --permission-mode plan for plan (else branch)", () => {
      const command = buildTrackedCliStartupCommand({ provider: "claude", permissionMode: "plan" });
      expect(command).toContain("--permission-mode plan");
      expect(command).not.toContain("--append-system-prompt");
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
      expect(launch.startupCommand).not.toContain("--append-system-prompt");
      expect(launch.args).toContain("--append-system-prompt");
      expect(launch.args).toContain(ADE_CLI_AGENT_GUIDANCE);
      expect(launch.env?.[ADE_AGENT_SKILLS_DIRS_ENV]).toContain("agent-skills");
    });

    it("keeps Claude Code in interactive TUI mode", () => {
      const launch = buildTrackedCliLaunchCommand({
        provider: "claude",
        permissionMode: "default",
        sessionId: "00000000-0000-0000-0000-000000000001",
      });
      expect(launch.command).toBe("claude");
      expect(launch.args).not.toContain("--print");
      expect(launch.args).not.toContain("-p");
      expect(launch.args).not.toContain("--output-format");
      expect(launch.args).not.toContain("stream-json");
      expect(launch.startupCommand).not.toContain("--print");
      expect(launch.startupCommand).not.toContain("--output-format");
      expect(launch.startupCommand).not.toContain("stream-json");
    });

    it("passes an optional Claude Code model alias for fresh launches", () => {
      const launch = buildTrackedCliLaunchCommand({
        provider: "claude",
        permissionMode: "default",
        sessionId: "00000000-0000-0000-0000-000000000001",
        model: "anthropic/claude-opus-4-8",
      });
      expect(launch.args).toEqual(expect.arrayContaining(["--model", "claude-opus-4-8"]));
      expect(launch.startupCommand).toContain("--model");
      expect(launch.startupCommand).toContain("claude-opus-4-8");
    });

    it("passes Claude fast mode as per-session settings for fresh launches", () => {
      const fastLaunch = buildTrackedCliLaunchCommand({
        provider: "claude",
        permissionMode: "default",
        sessionId: "00000000-0000-0000-0000-000000000001",
        model: "anthropic/claude-opus-4-8",
        fastMode: true,
      });
      expect(fastLaunch.args).toEqual(expect.arrayContaining([
        "--settings",
        JSON.stringify({ fastMode: true }),
      ]));
      expect(fastLaunch.startupCommand).toContain("fastMode");
      expect(fastLaunch.startupCommand).toContain("true");

      const standardLaunch = buildTrackedCliLaunchCommand({
        provider: "claude",
        permissionMode: "default",
        sessionId: "00000000-0000-0000-0000-000000000001",
        model: "anthropic/claude-opus-4-8",
        fastMode: false,
      });
      expect(standardLaunch.args).toEqual(expect.arrayContaining([
        "--settings",
        JSON.stringify({ fastMode: false }),
      ]));
      expect(standardLaunch.startupCommand).toContain("fastMode");
      expect(standardLaunch.startupCommand).toContain("false");
    });

    it("translates Claude ultracode to xhigh effort plus per-session settings", () => {
      const launch = buildTrackedCliLaunchCommand({
        provider: "claude",
        permissionMode: "default",
        sessionId: "00000000-0000-0000-0000-000000000001",
        model: "anthropic/claude-fable-5",
        reasoningEffort: "ultracode",
        fastMode: true,
      });

      expect(launch.args).toEqual(expect.arrayContaining([
        "--model",
        "claude-fable-5",
        "--effort",
        "xhigh",
        "--settings",
        JSON.stringify({ fastMode: true, ultracode: true }),
      ]));
      expect(launch.args).not.toEqual(expect.arrayContaining(["--effort", "ultracode"]));
      expect(launch.startupCommand).toContain("--model claude-fable-5");
      expect(launch.startupCommand).toContain("--effort xhigh");
      expect(launch.startupCommand).toContain("ultracode");
    });
  });

  describe("codex provider", () => {
    it("adds the dangerous bypass flag for full-auto", () => {
      const command = buildTrackedCliStartupCommand({ provider: "codex", permissionMode: "full-auto" });
      expect(command).toContain("codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox");
      expect(command).not.toContain("control plane for ADE state");
    });

    it("adds supported workspace-write defaults for default", () => {
      const command = buildTrackedCliStartupCommand({ provider: "codex", permissionMode: "default" });
      expect(command).toContain("codex --no-alt-screen --sandbox workspace-write --ask-for-approval on-request");
      expect(command).not.toContain("mcp_servers.linear");
      expect(command).not.toContain("control plane for ADE state");
    });

    it("does not synthesize Codex MCP server config for any permission preset", () => {
      const modes = ["default", "plan", "edit", "full-auto", "config-toml"] as const;
      for (const permissionMode of modes) {
        const launch = buildTrackedCliLaunchCommand({ provider: "codex", permissionMode });
        expect(launch.args.join("\n")).not.toContain("mcp_servers.");
        expect(launch.startupCommand).not.toContain("mcp_servers.");
      }
    });

    it("injects the signed Computer Use MCP client only when main selects it", () => {
      const command = "/Users/test/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient";
      const launch = buildTrackedCliLaunchCommand({
        provider: "codex",
        permissionMode: "default",
        codexComputerUse: { command, args: ["mcp"] },
      });
      expect(launch.args).toEqual(expect.arrayContaining([
        "-c",
        `mcp_servers.computer_use.command=${JSON.stringify(command)}`,
        "-c",
        'mcp_servers.computer_use.args=["mcp"]',
        "-c",
        "mcp_servers.computer_use.enabled=true",
      ]));
      expect(launch.startupCommand).toContain("mcp_servers.computer_use.command");
      expect(launch.startupCommand).not.toContain("mcp_servers.computer-use");

      const resumed = buildTrackedCliResumeCommand({
        provider: "codex",
        targetKind: "thread",
        targetId: "thread-cu",
        launch: { permissionMode: "default" },
      }, { codexComputerUse: { command, args: ["mcp"] } });
      expect(resumed).toContain("mcp_servers.computer_use.command");
      expect(resumed).toContain("resume thread-cu");
    });

    it("keeps empty Codex CLI launches waiting for the next user task", () => {
      const launch = buildTrackedCliLaunchCommand({ provider: "codex", permissionMode: "default" });

      expect(launch.initialInput).toContain("ADE session guidance");
      expect(launch.initialInput).toContain("wait for the user's next instruction before taking action");
      expect(launch.initialInput).not.toContain("User prompt:");
    });

    it("passes no extra flags for config-toml", () => {
      const command = buildTrackedCliStartupCommand({ provider: "codex", permissionMode: "config-toml" });
      expect(command).toContain("codex --no-alt-screen");
      expect(command).not.toContain("--full-auto");
      expect(command).not.toContain("mcp_servers.linear");
      expect(command).not.toContain("control plane for ADE state");
    });

    it("adds untrusted approval and workspace-write sandbox for edit", () => {
      const command = buildTrackedCliStartupCommand({ provider: "codex", permissionMode: "edit" });
      expect(command).toContain("codex --no-alt-screen --sandbox workspace-write --ask-for-approval untrusted");
      expect(command).not.toContain("control plane for ADE state");
    });

    it("adds on-request approval and read-only sandbox for plan", () => {
      const command = buildTrackedCliStartupCommand({ provider: "codex", permissionMode: "plan" });
      expect(command).toContain("codex --no-alt-screen --sandbox read-only --ask-for-approval on-request");
      expect(command).not.toContain("control plane for ADE state");
    });

    it("uses the selected lane worktree to seed skill roots", () => {
      const launch = buildTrackedCliLaunchCommand({
        provider: "codex",
        permissionMode: "default",
        initialPrompt: "Check this lane.",
        laneWorktreePath: "/repo/.ade/worktrees/chat-lane",
      });

      expect(launch.initialInput).toContain("/repo/.ade/worktrees/chat-lane/.claude/skills");
      expect(launch.initialInput).toContain("/repo/.ade/worktrees/chat-lane/.agents/skills");
      expect(launch.initialInput).toContain("/repo/.ade/worktrees/chat-lane/apps/desktop/resources/agent-skills");
      expect(launch.startupCommand).not.toContain("/repo/.ade/worktrees/chat-lane/.claude/skills");
      expect(launch.env?.[ADE_AGENT_SKILLS_DIRS_ENV]?.startsWith(
        "/repo/.ade/worktrees/chat-lane/.cursor/skills",
      )).toBe(true);
    });

    it("submits the first user prompt without dropping ADE guidance, model, or reasoning effort", () => {
      const launch = buildTrackedCliLaunchCommand({
        provider: "codex",
        permissionMode: "plan",
        model: "gpt-5.4",
        reasoningEffort: "medium",
        initialPrompt: "Fix the failing Work tests.",
      });
      expect(launch.args).toEqual(expect.arrayContaining([
        "--model",
        "gpt-5.4",
        "-c",
        "model_reasoning_effort=\"medium\"",
      ]));
      expect(launch.args.join("\n")).not.toContain("ADE session guidance");
      expect(launch.initialInput).toContain("ADE session guidance");
      expect(launch.initialInput).toContain("Start working on that user prompt immediately.");
      expect(launch.initialInput).not.toContain("wait for the user's next instruction before taking action");
      expect(launch.initialInput).toContain("User prompt:");
      expect(launch.initialInput).toContain("Fix the failing Work tests.");
      expect(launch.startupCommand).toContain("model_reasoning_effort");
      expect(launch.startupCommand).not.toContain("Fix the failing Work tests.");
    });

    it("derives initial metadata from the user task inside ADE guidance", () => {
      const meta = deriveTrackedCliInitialInputSessionMeta({
        provider: "codex",
        title: "Codex",
        initialInput: [
          "ADE session guidance. Treat this as operating guidance for the CLI session.",
          "Start working on that user prompt immediately.",
          "",
          "User prompt:",
          "You are working in ADE lane:",
          "/repo/.ade/worktrees/context-iphone-17-simulator",
          "",
          "Edits and mutating commands must stay inside that worktree.",
          "",
          "The user is debugging the ADE iOS Work chat scroll/layout bugs.",
        ].join("\n"),
      });

      expect(meta.goal).toBe("The user is debugging the ADE iOS Work chat scroll/layout bugs.");
      expect(meta.title).toBe("The user is debugging the ADE iOS Work chat scroll/layout bugs");
      expect(meta.promptTitle).toBe("The user is debugging the ADE iOS Work chat scroll/layout bugs");
    });

    it("derives metadata from ADE lane guidance without a blank separator", () => {
      const meta = deriveTrackedCliInitialInputSessionMeta({
        provider: "codex",
        title: "Codex",
        initialInput: [
          "You are working in ADE lane:",
          "/repo/.ade/worktrees/context-iphone-17-simulator",
          "Redesign the ADE mobile project hub.",
        ].join("\n"),
      });

      expect(meta.goal).toBe("Redesign the ADE mobile project hub.");
      expect(meta.title).toBe("Redesign the ADE mobile project hub");
      expect(meta.promptTitle).toBe("Redesign the ADE mobile project hub");
    });

    it("does not unwrap ordinary prompts that mention ADE guidance text", () => {
      const meta = deriveTrackedCliInitialInputSessionMeta({
        provider: "codex",
        title: "Codex",
        initialInput: "Explain why docs say Start working on that user prompt immediately.",
      });

      expect(meta.goal).toBe("Explain why docs say Start working on that user prompt immediately.");
      expect(meta.title).toBe("Explain why docs say Start working on that user prompt immediately");
      expect(meta.promptTitle).toBe("Explain why docs say Start working on that user prompt immediately");
    });

    it("passes explicit Codex service tier overrides for fast mode", () => {
      const fastLaunch = buildTrackedCliLaunchCommand({
        provider: "codex",
        permissionMode: "default",
        fastMode: true,
      });
      expect(fastLaunch.args).toEqual(expect.arrayContaining([
        "-c",
        "service_tier=\"fast\"",
        "-c",
        "features.fast_mode=true",
      ]));
      expect(fastLaunch.startupCommand).toContain("service_tier");
      expect(fastLaunch.startupCommand).toContain("features.fast_mode");

      const defaultLaunch = buildTrackedCliLaunchCommand({
        provider: "codex",
        permissionMode: "default",
        fastMode: false,
      });
      expect(defaultLaunch.args).toEqual(expect.arrayContaining([
        "-c",
        "service_tier=\"default\"",
      ]));
      expect(defaultLaunch.args).not.toContain("features.fast_mode=true");

      const inheritedLaunch = buildTrackedCliLaunchCommand({
        provider: "codex",
        permissionMode: "default",
      });
      expect(inheritedLaunch.args.join("\n")).not.toContain("service_tier");
    });

    it("keeps legacy Codex migration-prompt models on the argv prompt path", () => {
      const launch = buildTrackedCliLaunchCommand({
        provider: "codex",
        permissionMode: "default",
        model: "gpt-5.3-codex",
        initialPrompt: "Use the legacy model.",
      });
      expect(launch.args.at(-1)).toContain("Use the legacy model.");
      expect(launch.initialInput).toBeUndefined();
    });
  });

  describe("additional CLI providers", () => {
    it("launches Cursor with initial prompts submitted through PTY input", () => {
      const launch = buildTrackedCliLaunchCommand({ provider: "cursor", permissionMode: "plan", model: "cursor-fast", initialPrompt: "Review this lane." });
      expect(launch.command).toBe("cursor-agent");
      expect(launch.args).toEqual(["--mode", "plan", "--model", "cursor-fast"]);
      expect(launch.startupCommand).toContain("cursor-agent --mode plan --model cursor-fast");
      expect(launch.startupCommand).not.toContain("Review this lane.");
      expect(launch.startupCommand).not.toContain("ADE session guidance");
      expect(launch.startupCommand).not.toContain("cursor-agent create-chat");
      expect(launch.startupCommand).not.toContain("--resume");
      expect(launch.initialInput).toContain("ADE session guidance");
      expect(launch.initialInput).toContain("Review this lane.");
      expect(launch.initialInputDelayMs).toBe(750);
      expect(launch.env?.[ADE_AGENT_SKILLS_DIRS_ENV]).toContain("agent-skills");
    });

    it("keeps empty Cursor launches idle instead of submitting ADE guidance as work", () => {
      const launch = buildTrackedCliLaunchCommand({ provider: "cursor", permissionMode: "default", model: "cursor-fast" });
      expect(launch.command).toBe("cursor-agent");
      expect(launch.args).toEqual(["--model", "cursor-fast"]);
      expect(launch.startupCommand).toBe("cursor-agent --model cursor-fast");
      expect(launch.initialInput).toBeUndefined();
      expect(launch.initialInputDelayMs).toBeUndefined();
    });

    it("launches Cursor edit mode through the default edit-capable agent mode", () => {
      const launch = buildTrackedCliLaunchCommand({ provider: "cursor", permissionMode: "edit", model: "cursor-fast" });
      expect(launch.command).toBe("cursor-agent");
      expect(launch.args).toEqual(["--model", "cursor-fast"]);
      expect(launch.startupCommand).toBe("cursor-agent --model cursor-fast");
    });

    it("normalizes Cursor registry model ids and forces full-auto interactive workspaces", () => {
      const launch = buildTrackedCliLaunchCommand({
        provider: "cursor",
        permissionMode: "full-auto",
        model: "cursor/composer-2.5",
        initialPrompt: "Review this lane.",
      });

      expect(launch.startupCommand).toContain("cursor-agent --force --model composer-2.5");
      expect(launch.startupCommand).not.toContain("--trust");
      expect(launch.startupCommand).not.toContain("--model cursor/composer-2.5");
      expect(launch.args).toEqual(expect.arrayContaining(["--force", "--model", "composer-2.5"]));
      expect(launch.args).not.toContain("--trust");
      expect(launch.args).not.toContain(expect.stringContaining("Review this lane."));
      expect(launch.initialInput).toContain("Review this lane.");
    });

    it("keeps Cursor launch direct on Windows", () => {
      withProcessPlatform("win32", () => {
        const launch = buildTrackedCliLaunchCommand({ provider: "cursor", permissionMode: "plan", model: "cursor-fast", initialPrompt: "Review this lane." });
        expect(launch.command).toBe("cursor-agent");
        expect(launch.args).toEqual(["--mode", "plan", "--model", "cursor-fast"]);
        expect(launch.initialInput).toContain("Review this lane.");
        expect(launch.initialInputDelayMs).toBe(750);
      });
    });

    it("launches Droid as an interactive CLI with model, reasoning, autonomy, guidance, and prompt", () => {
      const launch = buildTrackedCliLaunchCommand({
        provider: "droid",
        permissionMode: "edit",
        model: "droid/claude-sonnet-5",
        reasoningEffort: "high",
        initialPrompt: "Run the Droid path.",
      });
      expect(launch.command).toBe("/bin/bash");
      expect(launch.args).toEqual(["-lc", launch.startupCommand]);
      expect(launch.startupCommand).toContain("droid --settings \"$ADE_DROID_SETTINGS\"");
      expect(launch.startupCommand).toContain("Run the Droid path.");
      expect(launch.startupCommand).toContain("ADE session guidance");
      expect(launch.startupCommand).toContain("\\\"model\\\":\\\"claude-sonnet-5\\\"");
      expect(launch.startupCommand).toContain("\\\"reasoningEffort\\\":\\\"high\\\"");
      expect(launch.startupCommand).toContain("\\\"autonomyLevel\\\":\\\"low\\\"");
      expect(launch.env?.[ADE_AGENT_SKILLS_DIRS_ENV]).toContain("agent-skills");
    });

    it("launches Droid through PowerShell on Windows", () => {
      withProcessPlatform("win32", () => {
        const launch = buildTrackedCliLaunchCommand({
          provider: "droid",
          permissionMode: "edit",
          model: "droid/claude-sonnet-5",
          reasoningEffort: "high",
          initialPrompt: "Run the Droid path.",
        });
        expect(launch.command).toBe("powershell.exe");
        expect(launch.args).toEqual(["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", launch.startupCommand]);
        expect(launch.startupCommand).toContain("$env:ADE_DROID_SETTINGS");
        expect(launch.startupCommand).toContain("& 'droid' '--settings' $env:ADE_DROID_SETTINGS");
        expect(launch.startupCommand).toContain("Run the Droid path.");
        expect(launch.startupCommand).toContain("\"model\":\"claude-sonnet-5\"");
      });
    });

    it("launches OpenCode with inline permission config", () => {
      const launch = buildTrackedCliLaunchCommand({
        provider: "opencode",
        permissionMode: "full-auto",
        model: "github-copilot/gpt-5.4",
        initialPrompt: "Use OpenCode.",
      });
      expect(launch.command).toBe("opencode");
      expect(launch.args).toEqual(expect.arrayContaining(["--model", "github-copilot/gpt-5.4", "--prompt"]));
      expect(launch.env?.OPENCODE_CONFIG_CONTENT).toBe("{\"permission\":\"allow\"}");
      expect(launch.env?.[ADE_AGENT_SKILLS_DIRS_ENV]).toContain("agent-skills");
      expect(launch.startupCommand).toContain("OPENCODE_CONFIG_CONTENT=\"{\\\"permission\\\":\\\"allow\\\"}\" opencode");
      expect(launch.startupCommand).toContain("Use OpenCode.");
    });

    it("launches OpenCode fast mode through the interactive run variant flag", () => {
      const launch = buildTrackedCliLaunchCommand({
        provider: "opencode",
        permissionMode: "full-auto",
        model: "opencode/openai/gpt-5.4",
        reasoningEffort: "high",
        fastMode: true,
        initialPrompt: "Use OpenCode fast mode.",
      });
      expect(launch.command).toBe("opencode");
      expect(launch.args).toEqual(expect.arrayContaining([
        "run",
        "--interactive",
        "--model",
        "openai/gpt-5.4",
        "--variant",
        "fast",
      ]));
      expect(launch.args).not.toEqual(expect.arrayContaining(["--prompt"]));
      expect(launch.startupCommand).toContain("opencode run --interactive");
      expect(launch.startupCommand).toContain("--variant fast");
      expect(launch.startupCommand).toContain("Use OpenCode fast mode.");
    });

    it("launches OpenCode reasoning through the interactive run variant flag when fast is off", () => {
      const launch = buildTrackedCliLaunchCommand({
        provider: "opencode",
        permissionMode: "full-auto",
        model: "opencode/openai/gpt-5.4",
        reasoningEffort: "high",
        fastMode: false,
        initialPrompt: "Use OpenCode high reasoning.",
      });
      expect(launch.args).toEqual(expect.arrayContaining([
        "run",
        "--interactive",
        "--variant",
        "high",
      ]));
      expect(launch.args).not.toEqual(expect.arrayContaining(["--variant", "fast"]));
    });

    it("normalizes ADE OpenCode registry model ids before launching the CLI", () => {
      const launch = buildTrackedCliLaunchCommand({
        provider: "opencode",
        permissionMode: "full-auto",
        model: "opencode/opencode/big-pickle",
        initialPrompt: "Use OpenCode.",
      });
      expect(launch.args).toEqual(expect.arrayContaining(["--model", "opencode/big-pickle"]));
      expect(launch.startupCommand).toContain("--model \"opencode/big-pickle\"");
      expect(launch.startupCommand).not.toContain("opencode/opencode/big-pickle");

      const encoded = buildTrackedCliLaunchCommand({
        provider: "opencode",
        permissionMode: "full-auto",
        model: `opencode/lmstudio/${encodeURIComponent("openai/gpt-oss-20b")}`,
        initialPrompt: "Use OpenCode.",
      });
      expect(encoded.args).toEqual(expect.arrayContaining(["--model", "lmstudio/openai/gpt-oss-20b"]));
    });

    it("launches OpenCode config mode without inline permission config", () => {
      const launch = buildTrackedCliLaunchCommand({
        provider: "opencode",
        permissionMode: "config-toml",
        model: "github-copilot/gpt-5.4",
        initialPrompt: "Use OpenCode config.",
      });
      expect(launch.args).toEqual(expect.arrayContaining(["--model", "github-copilot/gpt-5.4", "--prompt"]));
      expect(launch.env?.OPENCODE_CONFIG_CONTENT).toBeUndefined();
      expect(launch.startupCommand).not.toContain("OPENCODE_CONFIG_CONTENT=");
    });

    it("rejects config-toml for providers that do not support it", () => {
      expect(() => buildTrackedCliLaunchCommand({ provider: "cursor", permissionMode: "config-toml" })).toThrow(
        "config-toml is only supported for Codex and OpenCode",
      );
      expect(() => buildTrackedCliLaunchCommand({ provider: "droid", permissionMode: "config-toml" })).toThrow(
        "config-toml is only supported for Codex and OpenCode",
      );
    });

    it("rejects auto for non-Claude CLI providers", () => {
      expect(() => buildTrackedCliLaunchCommand({ provider: "codex", permissionMode: "auto" })).toThrow(
        "auto is only supported for Claude",
      );
      expect(() => buildTrackedCliLaunchCommand({ provider: "cursor", permissionMode: "auto" })).toThrow(
        "auto is only supported for Claude",
      );
      expect(() => buildTrackedCliLaunchCommand({ provider: "droid", permissionMode: "auto" })).toThrow(
        "auto is only supported for Claude",
      );
      expect(() => buildTrackedCliLaunchCommand({ provider: "opencode", permissionMode: "auto" })).toThrow(
        "auto is only supported for Claude",
      );
    });
  });

  it("covers supported AgentChatPermissionMode values for each provider", () => {
    const modes = ["default", "auto", "plan", "edit", "full-auto", "config-toml"] as const satisfies readonly AgentChatPermissionMode[];
    for (const mode of modes) {
      if (mode === "auto") {
        expect(buildTrackedCliStartupCommand({ provider: "claude", permissionMode: mode }).length).toBeGreaterThan(0);
        continue;
      }
      const codex = buildTrackedCliStartupCommand({ provider: "codex", permissionMode: mode });
      expect(codex.length).toBeGreaterThan(0);
      if (mode !== "config-toml") {
        expect(buildTrackedCliStartupCommand({ provider: "claude", permissionMode: mode }).length).toBeGreaterThan(0);
        expect(buildTrackedCliStartupCommand({ provider: "cursor", permissionMode: mode }).length).toBeGreaterThan(0);
        expect(buildTrackedCliStartupCommand({ provider: "droid", permissionMode: mode }).length).toBeGreaterThan(0);
      }
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
      launch: { permissionMode: "edit" },
    })).toBe("cursor-agent --resume chat-99");

    expect(buildTrackedCliResumeCommand({
      provider: "cursor",
      targetKind: "session",
      targetId: "chat-99",
      launch: { permissionMode: "full-auto" },
    })).toBe("cursor-agent --force --resume chat-99");

    expect(buildTrackedCliResumeCommand({
      provider: "cursor",
      targetKind: "session",
      targetId: "chat-99",
      launch: { permissionMode: "default", model: "cursor/composer-2.5" },
    })).toBe("cursor-agent --model composer-2.5 --resume chat-99");

    expect(buildTrackedCliResumeCommand({
      provider: "opencode",
      targetKind: "session",
      targetId: "ses_99",
      launch: { permissionMode: "plan" },
    }, { model: "opencode/opencode/big-pickle" })).toContain("--agent plan --model \"opencode/big-pickle\" --session ses_99");
  });

  it("preserves Codex native approval and sandbox pairs without escalating access", () => {
    expect(buildTrackedCliResumeCommand({
      provider: "codex",
      targetKind: "thread",
      targetId: "thread-danger-on-request",
      launch: {
        permissionMode: "full-auto",
        codexApprovalPolicy: "on-request",
        codexSandbox: "danger-full-access",
        codexConfigSource: "flags",
      },
    })).toBe(
      "codex --no-alt-screen --sandbox danger-full-access --ask-for-approval on-request resume thread-danger-on-request",
    );

    expect(buildTrackedCliResumeCommand({
      provider: "codex",
      targetKind: "thread",
      targetId: "thread-workspace-on-request",
      launch: {
        codexApprovalPolicy: "on-request",
        codexSandbox: "workspace-write",
        codexConfigSource: "flags",
      },
    })).toBe(
      "codex --no-alt-screen --sandbox workspace-write --ask-for-approval on-request resume thread-workspace-on-request",
    );
  });

  it("adds provider model overrides to resumable CLI commands", () => {
    expect(buildTrackedCliResumeCommand({
      provider: "claude",
      targetKind: "session",
      targetId: "claude-session-1",
      launch: { permissionMode: "default" },
    }, { model: "anthropic/claude-haiku-4-5", reasoningEffort: "low", permissionMode: "auto" })).toBe(
      "claude --permission-mode auto --model claude-haiku-4-5 --effort low --resume claude-session-1",
    );

    expect(buildTrackedCliResumeCommand({
      provider: "claude",
      targetKind: "session",
      targetId: "claude-session-1",
      launch: { permissionMode: "default", model: "anthropic/claude-opus-4-8", fastMode: true },
    })).toBe(
      "claude --permission-mode default --model claude-opus-4-8 --settings \"{\\\"fastMode\\\":true}\" --resume claude-session-1",
    );

    expect(buildTrackedCliResumeCommand({
      provider: "claude",
      targetKind: "session",
      targetId: "claude-session-1",
      launch: { permissionMode: "default", model: "anthropic/claude-opus-4-8", fastMode: false },
    })).toBe(
      "claude --permission-mode default --model claude-opus-4-8 --settings \"{\\\"fastMode\\\":false}\" --resume claude-session-1",
    );

    expect(buildTrackedCliResumeCommand({
      provider: "claude",
      targetKind: "session",
      targetId: "claude-session-1",
      launch: {
        permissionMode: "default",
        model: "anthropic/claude-fable-5",
        reasoningEffort: "ultracode",
      },
    })).toBe(
      "claude --permission-mode default --model claude-fable-5 --effort xhigh --settings \"{\\\"ultracode\\\":true}\" --resume claude-session-1",
    );

    expect(buildTrackedCliResumeCommand({
      provider: "codex",
      targetKind: "thread",
      targetId: "thread-99",
      launch: { permissionMode: "edit" },
    }, { model: "gpt-5.4", reasoningEffort: "high", permissionMode: "plan" })).toBe(
      "codex --no-alt-screen --model gpt-5.4 -c \"model_reasoning_effort=\\\"high\\\"\" --sandbox read-only --ask-for-approval on-request resume thread-99",
    );

    const droidResume = buildTrackedCliResumeCommand({
      provider: "droid",
      targetKind: "session",
      targetId: "droid-session-1",
      launch: { permissionMode: "default" },
    }, { model: "droid/gpt-5.4", reasoningEffort: "xhigh", permissionMode: "full-auto" });
    expect(droidResume).toContain("droid --settings \"$ADE_DROID_SETTINGS\" --resume droid-session-1");
    expect(droidResume).toContain("\\\"model\\\":\\\"gpt-5.4\\\"");
    expect(droidResume).toContain("\\\"reasoningEffort\\\":\\\"xhigh\\\"");
    expect(droidResume).toContain("\\\"autonomyLevel\\\":\\\"high\\\"");
  });

  it("adds provider prompt overrides to resumable CLI commands", () => {
    expect(buildTrackedCliResumeCommand({
      provider: "codex",
      targetKind: "thread",
      targetId: "thread-99",
      launch: { permissionMode: "plan" },
    }, { prompt: "fix failing tests" })).toBe(
      "codex --no-alt-screen --sandbox read-only --ask-for-approval on-request resume thread-99 \"fix failing tests\"",
    );

    expect(buildTrackedCliResumeCommand({
      provider: "opencode",
      targetKind: "session",
      targetId: "ses_99",
      launch: { permissionMode: "default" },
    }, { prompt: "continue from here" })).toContain("--session ses_99 --prompt \"continue from here\"");
  });

  it("preserves stored model and reasoning when resuming tracked CLI sessions without overrides", () => {
    expect(buildTrackedCliResumeCommand({
      provider: "codex",
      targetKind: "thread",
      targetId: "thread-99",
      launch: { permissionMode: "edit", model: "gpt-5.4", reasoningEffort: "medium", fastMode: true },
    })).toBe(
      "codex --no-alt-screen --model gpt-5.4 -c \"model_reasoning_effort=\\\"medium\\\"\" -c \"service_tier=\\\"fast\\\"\" -c features.fast_mode=true --sandbox workspace-write --ask-for-approval untrusted resume thread-99",
    );

    expect(buildTrackedCliResumeCommand({
      provider: "codex",
      targetKind: "thread",
      targetId: "thread-99",
      launch: { permissionMode: "edit", model: "gpt-5.4", reasoningEffort: "medium", fastMode: false },
    })).toContain("-c \"service_tier=\\\"default\\\"\"");

    expect(buildTrackedCliResumeCommand({
      provider: "opencode",
      targetKind: "session",
      targetId: "ses_99",
      launch: { permissionMode: "plan", model: "opencode/openai/gpt-5.4", fastMode: true },
    })).toContain("opencode run --interactive --agent plan --model \"openai/gpt-5.4\" --variant fast --session ses_99");
  });

  it("builds OpenCode interactive replay resume commands for freeze-frame continuation", () => {
    const command = buildOpenCodeReplayResumeCommand({
      permissionMode: "plan",
      model: `opencode/openai/${encodeURIComponent("gpt-5.4")}`,
      fastMode: true,
      resumeTarget: "ses_99",
      prompt: "continue from the snapshot",
      replayLimit: 12,
    });

    expect(command).toContain("OPENCODE_CONFIG_CONTENT=");
    expect(command).toContain("opencode run --interactive --agent plan --model \"openai/gpt-5.4\" --variant fast --session ses_99 --replay --replay-limit 12 --");
    expect(command).toContain("continue from the snapshot");
    expect(command).toContain("\\\"question\\\":\\\"allow\\\"");
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
