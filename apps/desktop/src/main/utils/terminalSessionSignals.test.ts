import { describe, expect, it } from "vitest";
import {
  buildOpenCodeReplayResumeCommand,
  buildTrackedCliResumeCommand,
  codexComposerHoldsPendingInput,
  defaultResumeCommandForTool,
  extractResumeCommandFromOutput,
  parseTrackedCliLaunchConfig,
  parseTrackedCliResumeCommand,
  normalizeResumeCommand,
  providerFromTool,
  runtimeStateFromOsc133Chunk,
  sanitizeResumeTargetId,
} from "./terminalSessionSignals";

describe("terminalSessionSignals", () => {
  it("extracts and normalizes concrete Claude resume commands from backticks", () => {
    const chunk = "Resume with `claude resume 01HF4F5J1A3R8NBV3K` whenever needed.";
    expect(extractResumeCommandFromOutput(chunk, "claude")).toBe("claude --resume 01HF4F5J1A3R8NBV3K");
  });

  it("extracts plain resume command lines", () => {
    const chunk = "codex resume session_abc123 --last";
    expect(extractResumeCommandFromOutput(chunk, "codex")).toBe("codex resume session_abc123 --last");
  });

  it("extracts resume commands from shell-prompted lines", () => {
    const chunk = "arul@host project % codex resume thread_abc123";
    expect(extractResumeCommandFromOutput(chunk, "codex")).toBe("codex resume thread_abc123");
  });

  it("does not extract resume-looking words from user prompts", () => {
    const chunk = "ADE dev resume verification for codex. Reply exactly: codex resume ok";
    expect(extractResumeCommandFromOutput(chunk, "codex")).toBeNull();
  });

  it("does not treat terminal CSI replies as Codex resume targets", () => {
    const chunk = "codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox resume \u001b[>7u";
    expect(parseTrackedCliResumeCommand(chunk, "codex")).toBeNull();
    expect(extractResumeCommandFromOutput(chunk, "codex")).toBe(
      "codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox resume",
    );
  });

  it("sanitizes resume target ids through the shared CLI launch helper", () => {
    expect(sanitizeResumeTargetId(" thread_abc123 ")).toBe("thread_abc123");
    expect(sanitizeResumeTargetId("-dangerous")).toBeNull();
    expect(sanitizeResumeTargetId("bad\nid")).toBeNull();
  });

  it("does not treat Codex prompt glyphs as resume targets", () => {
    const chunk = "codex --no-alt-screen --sandbox workspace-write --ask-for-approval on-request resume ›";
    expect(parseTrackedCliResumeCommand(chunk, "codex")).toBeNull();
    expect(extractResumeCommandFromOutput(chunk, "codex")).toBeNull();
  });

  it("respects preferred tool when both tools appear", () => {
    const chunk = [
      "claude --resume abc",
      "codex resume def"
    ].join("\n");
    expect(extractResumeCommandFromOutput(chunk, "codex")).toBe("codex resume def");
  });

  it("normalizes legacy Claude resume commands stored in older sessions", () => {
    expect(normalizeResumeCommand("claude resume abc123", "claude")).toBe("claude --resume abc123");
    expect(normalizeResumeCommand("claude -r abc123", "claude")).toBe("claude --resume abc123");
  });

  it("does not infer waiting-input from OSC 133 prompt markers", () => {
    const marker = "\u001b]133;A\u0007";
    expect(runtimeStateFromOsc133Chunk(marker, "running")).toBe("running");
  });

  it("maps OSC 133 command markers to running", () => {
    const marker = "\u001b]133;B\u001b\\";
    expect(runtimeStateFromOsc133Chunk(marker, "waiting-input")).toBe("running");
  });

  it("returns default resume command for known tools", () => {
    expect(defaultResumeCommandForTool("claude")).toBe("claude --resume");
    expect(defaultResumeCommandForTool("codex")).toBe("codex resume");
    expect(defaultResumeCommandForTool("cursor-cli")).toBe("cursor-agent --model auto --continue");
    expect(defaultResumeCommandForTool("droid")).toBe("droid --resume");
    expect(defaultResumeCommandForTool("opencode")).toBe("opencode --continue");
    expect(defaultResumeCommandForTool("opencode-orchestrated")).toBe("opencode --continue");
    expect(defaultResumeCommandForTool("shell")).toBeNull();
  });

  it("treats orchestrated OpenCode terminals as OpenCode resume sessions", () => {
    expect(providerFromTool("opencode-orchestrated")).toBe("opencode");
    expect(normalizeResumeCommand("opencode --session open-1", "opencode-orchestrated")).toBe("opencode --session open-1");
  });

  it("parses tracked Claude and Codex launch configs from startup commands", () => {
    expect(parseTrackedCliLaunchConfig("claude --permission-mode default", "claude")).toEqual({
      permissionMode: "default",
      claudePermissionMode: "default",
    });
    expect(parseTrackedCliLaunchConfig("claude --permission-mode auto", "claude")).toEqual({
      permissionMode: "auto",
      claudePermissionMode: "auto",
    });
    expect(parseTrackedCliLaunchConfig("codex --no-alt-screen --sandbox workspace-write --ask-for-approval untrusted", "codex")).toEqual({
      permissionMode: "edit",
      codexApprovalPolicy: "untrusted",
      codexSandbox: "workspace-write",
      codexConfigSource: "flags",
    });
    expect(parseTrackedCliLaunchConfig("cursor-agent --mode plan", "cursor-cli")).toEqual({
      permissionMode: "plan",
    });
    expect(parseTrackedCliLaunchConfig("cursor-agent --mode plan --model auto", "cursor-cli")).toEqual({
      permissionMode: "plan",
      model: "auto",
    });
    expect(parseTrackedCliLaunchConfig("cursor-agent --mode ask", "cursor-cli")).toEqual({
      permissionMode: "plan",
    });
    expect(parseTrackedCliLaunchConfig(
      "claude --permission-mode default --model claude-opus-4-8 --settings '{\"fastMode\":true}'",
      "claude",
    )).toEqual({
      permissionMode: "default",
      model: "claude-opus-4-8",
      fastMode: true,
      claudePermissionMode: "default",
    });
    expect(parseTrackedCliLaunchConfig(
      "claude --permission-mode default --model claude-opus-4-8 --settings '{\"fastMode\":false}'",
      "claude",
    )).toEqual({
      permissionMode: "default",
      model: "claude-opus-4-8",
      fastMode: false,
      claudePermissionMode: "default",
    });
    expect(parseTrackedCliLaunchConfig("droid --settings /tmp/ade.json", "droid")).toEqual({
      permissionMode: "plan",
    });
    expect(parseTrackedCliLaunchConfig(
      "ADE_DROID_SETTINGS=\"$(mktemp \"${TMPDIR:-/tmp}/ade-droid-settings.XXXXXX.json\")\" && printf %s \"{\\\"sessionDefaultSettings\\\":{\\\"interactionMode\\\":\\\"auto\\\",\\\"autonomyLevel\\\":\\\"low\\\"},\\\"model\\\":\\\"gpt-5.4\\\",\\\"reasoningEffort\\\":\\\"xhigh\\\"}\" > \"$ADE_DROID_SETTINGS\" && droid --settings \"$ADE_DROID_SETTINGS\"",
      "droid",
    )).toEqual({
      permissionMode: "edit",
      model: "gpt-5.4",
      reasoningEffort: "xhigh",
    });
    expect(parseTrackedCliLaunchConfig(
      "ADE_DROID_SETTINGS=\"$(mktemp \"${TMPDIR:-/tmp}/ade-droid-settings.XXXXXX.json\")\" && printf %s \"{\\\"sessionDefaultSettings\\\":{\\\"interactionMode\\\":\\\"spec\\\",\\\"autonomyLevel\\\":\\\"off\\\",\\\"specModeModel\\\":\\\"claude-sonnet-5\\\",\\\"specModeReasoningEffort\\\":\\\"high\\\"}}\" > \"$ADE_DROID_SETTINGS\" && droid --settings \"$ADE_DROID_SETTINGS\"",
      "droid",
    )).toEqual({
      permissionMode: "plan",
      model: "claude-sonnet-5",
      reasoningEffort: "high",
    });
    expect(parseTrackedCliLaunchConfig("OPENCODE_CONFIG_CONTENT='{\"permission\":{\"*\":\"ask\",\"edit\":\"allow\"}}' opencode", "opencode")).toEqual({
      permissionMode: "edit",
    });
    expect(parseTrackedCliLaunchConfig("opencode run --interactive --model openai/gpt-5.4 --variant fast", "opencode")).toEqual({
      permissionMode: "config-toml",
      model: "openai/gpt-5.4",
      fastMode: true,
    });
    expect(parseTrackedCliLaunchConfig("opencode run --interactive --model openai/gpt-5.4 --variant high", "opencode")).toEqual({
      permissionMode: "config-toml",
      model: "openai/gpt-5.4",
      reasoningEffort: "high",
    });
  });

  it("builds permission-aware resume commands with or without a concrete target", () => {
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
      provider: "codex",
      targetKind: "thread",
      targetId: null,
      launch: { permissionMode: "full-auto" },
    })).toBe("codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox resume");

    expect(buildTrackedCliResumeCommand({
      provider: "cursor",
      targetKind: "session",
      targetId: "chat-1",
      launch: { permissionMode: "edit" },
    })).toBe("cursor-agent --resume chat-1");

    expect(buildTrackedCliResumeCommand({
      provider: "cursor",
      targetKind: "session",
      targetId: "chat-2",
      launch: { permissionMode: "full-auto", model: "cursor/composer-2.5" },
    })).toBe("cursor-agent --force --model composer-2.5 --resume chat-2");

    expect(buildTrackedCliResumeCommand({
      provider: "opencode",
      targetKind: "session",
      targetId: "ses_1",
      launch: { permissionMode: "full-auto", fastMode: true },
    })).toBe("OPENCODE_CONFIG_CONTENT=\"{\\\"permission\\\":\\\"allow\\\"}\" opencode run --interactive --variant fast --session ses_1");
  });

  it("applies resume-time model, reasoning, and permission overrides", () => {
    expect(buildTrackedCliResumeCommand({
      provider: "claude",
      targetKind: "session",
      targetId: "claude-session-1",
      launch: { permissionMode: "default" },
    }, { model: "anthropic/claude-haiku-4-5", reasoningEffort: "low", permissionMode: "auto", prompt: "keep going" })).toBe(
      "claude --permission-mode auto --model claude-haiku-4-5 --effort low --resume claude-session-1 \"keep going\"",
    );

    expect(buildTrackedCliResumeCommand({
      provider: "codex",
      targetKind: "thread",
      targetId: "thread-99",
      launch: { permissionMode: "edit" },
    }, { model: "gpt-5.4", reasoningEffort: "high", permissionMode: "plan", prompt: "fix tests" })).toBe(
      "codex --no-alt-screen --model gpt-5.4 -c \"model_reasoning_effort=\\\"high\\\"\" --sandbox read-only --ask-for-approval on-request resume thread-99 \"fix tests\"",
    );

    const droidModelOnly = buildTrackedCliResumeCommand({
      provider: "droid",
      targetKind: "session",
      targetId: "droid-session-1",
      launch: {},
    }, { model: "droid/gpt-5.4" });
    expect(droidModelOnly).toContain("\\\"model\\\":\\\"gpt-5.4\\\"");
    expect(droidModelOnly).not.toContain("sessionDefaultSettings");
  });

  it("preserves parsed model and reasoning when resuming without overrides", () => {
    expect(parseTrackedCliLaunchConfig(
      "codex --no-alt-screen --model gpt-5.4 -c 'model_reasoning_effort=\"medium\"' --sandbox workspace-write --ask-for-approval untrusted",
      "codex",
    )).toEqual({
      permissionMode: "edit",
      model: "gpt-5.4",
      reasoningEffort: "medium",
      codexApprovalPolicy: "untrusted",
      codexSandbox: "workspace-write",
      codexConfigSource: "flags",
    });
    expect(parseTrackedCliLaunchConfig(
      "codex --no-alt-screen -c 'service_tier=\"fast\"' -c features.fast_mode=true --sandbox workspace-write --ask-for-approval on-request",
      "codex",
    )).toEqual({
      permissionMode: "default",
      fastMode: true,
      codexApprovalPolicy: "on-request",
      codexSandbox: "workspace-write",
      codexConfigSource: "flags",
    });
    expect(parseTrackedCliLaunchConfig(
      "codex --no-alt-screen -c 'service_tier=\"default\"' --sandbox workspace-write --ask-for-approval on-request",
      "codex",
    )).toEqual({
      permissionMode: "default",
      fastMode: false,
      codexApprovalPolicy: "on-request",
      codexSandbox: "workspace-write",
      codexConfigSource: "flags",
    });

    expect(buildTrackedCliResumeCommand({
      provider: "codex",
      targetKind: "thread",
      targetId: "thread-99",
      launch: { permissionMode: "edit", model: "gpt-5.4", reasoningEffort: "medium", fastMode: true },
    })).toBe(
      "codex --no-alt-screen --model gpt-5.4 -c \"model_reasoning_effort=\\\"medium\\\"\" -c \"service_tier=\\\"fast\\\"\" -c features.fast_mode=true --sandbox workspace-write --ask-for-approval untrusted resume thread-99",
    );
  });

  it("resumes pre-rename sessions that only stored the deprecated codexFastMode", () => {
    expect(buildTrackedCliResumeCommand({
      provider: "codex",
      targetKind: "thread",
      targetId: "thread-99",
      launch: { permissionMode: "edit", codexFastMode: true },
    })).toBe(
      "codex --no-alt-screen -c \"service_tier=\\\"fast\\\"\" -c features.fast_mode=true --sandbox workspace-write --ask-for-approval untrusted resume thread-99",
    );
  });

  it("parses codex --full-auto as default permission mode", () => {
    expect(parseTrackedCliLaunchConfig("codex --no-alt-screen --full-auto", "codex")).toEqual({
      permissionMode: "default",
      codexApprovalPolicy: "on-request",
      codexSandbox: "workspace-write",
      codexConfigSource: "flags",
    });
  });

  it("parses codex plan mode flags", () => {
    expect(
      parseTrackedCliLaunchConfig("codex --no-alt-screen --sandbox read-only --ask-for-approval on-request", "codex"),
    ).toEqual({
      permissionMode: "plan",
      codexApprovalPolicy: "on-request",
      codexSandbox: "read-only",
      codexConfigSource: "flags",
    });
  });

  it("builds codex resume command with default permission mode", () => {
    expect(
      buildTrackedCliResumeCommand({
        provider: "codex",
        targetKind: "thread",
        targetId: null,
        launch: { permissionMode: "default" },
      }),
    ).toBe("codex --no-alt-screen --sandbox workspace-write --ask-for-approval on-request resume");
  });

  it("parses legacy codex approval_policy=untrusted sandbox_mode=read-only as plan", () => {
    const parsed = parseTrackedCliLaunchConfig(
      "codex -c approval_policy=untrusted -c sandbox_mode=read-only",
      "codex",
    );
    expect(parsed?.permissionMode).toBe("plan");
  });

  it("extracts resume targets from Claude and Codex picker commands", () => {
    expect(parseTrackedCliResumeCommand("claude --resume 01HF4F5J1A3R8NBV3K", "claude")).toEqual({
      provider: "claude",
      targetId: "01HF4F5J1A3R8NBV3K",
    });
    expect(parseTrackedCliResumeCommand("claude --permission-mode default --resume 01HF4F5J1A3R8NBV3K", "claude")).toEqual({
      provider: "claude",
      targetId: "01HF4F5J1A3R8NBV3K",
    });
    expect(parseTrackedCliResumeCommand("codex resume thread_abc123", "codex")).toEqual({
      provider: "codex",
      targetId: "thread_abc123",
    });
    expect(parseTrackedCliResumeCommand("codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox resume thread_abc123", "codex")).toEqual({
      provider: "codex",
      targetId: "thread_abc123",
    });
    expect(parseTrackedCliResumeCommand("codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox resume", "codex")).toEqual({
      provider: "codex",
      targetId: null,
    });
    expect(parseTrackedCliResumeCommand("cursor-agent --force --resume chat-abc", "cursor-cli")).toEqual({
      provider: "cursor",
      targetId: "chat-abc",
    });
    expect(parseTrackedCliResumeCommand("droid --resume 29f8d3bf-6620-4c89-a72e-5327670acc69", "droid")).toEqual({
      provider: "droid",
      targetId: "29f8d3bf-6620-4c89-a72e-5327670acc69",
    });
    expect(parseTrackedCliResumeCommand("OPENCODE_CONFIG_CONTENT='{\"permission\":\"allow\"}' opencode --session ses_abc", "opencode")).toEqual({
      provider: "opencode",
      targetId: "ses_abc",
    });
    expect(parseTrackedCliResumeCommand("opencode run --interactive --session ses_abc --replay --replay-limit 40 -- continue", "opencode")).toEqual({
      provider: "opencode",
      targetId: "ses_abc",
    });
  });

  it("preserves Codex resume targets after quoted Computer Use config values with spaces", () => {
    const command = buildTrackedCliResumeCommand({
      provider: "codex",
      targetKind: "thread",
      targetId: "thread_computer_use_123",
      launch: { permissionMode: "default" },
    }, {
      codexComputerUse: {
        command: "/Applications/Codex Computer Use.app/Contents/MacOS/Sky Computer Use Client",
        args: ["mcp", "--profile", "ADE Computer Use"],
      },
    });

    expect(command).toContain("Codex Computer Use.app");
    expect(parseTrackedCliResumeCommand(command, "codex")).toEqual({
      provider: "codex",
      targetId: "thread_computer_use_123",
    });
  });

  it("builds OpenCode run replay resume commands with question tool enabled", () => {
    const command = buildOpenCodeReplayResumeCommand({
      permissionMode: "edit",
      targetId: "ses_abc",
      model: "openai/gpt-5.4",
      fastMode: true,
      prompt: "continue from here",
    });

    expect(command).toContain("opencode run --interactive --model \"openai/gpt-5.4\" --variant fast --session ses_abc --replay --replay-limit 40 -- \"continue from here\"");
    expect(command).toContain("\\\"question\\\":\\\"allow\\\"");
  });

  it("normalizes ADE OpenCode registry IDs in replay resume commands", () => {
    const command = buildOpenCodeReplayResumeCommand({
      permissionMode: "plan",
      targetId: "ses_abc",
      model: "opencode/lmstudio/openai%2Fgpt-oss-20b",
      prompt: "continue from here",
    });

    expect(command).toContain("--model \"lmstudio/openai/gpt-oss-20b\"");
  });

  it("extracts Cursor resume commands printed by ADE launch wrappers", () => {
    const chunk = "[ADE] Resume with cursor-agent --resume chat-abc";
    expect(extractResumeCommandFromOutput(chunk, "cursor-cli")).toBe("cursor-agent --resume chat-abc");
  });

  it("detects a Codex composer still holding a collapsed pasted prompt", () => {
    const visible = [
      "OpenAI Codex (v0.146.0)",
      "  Tip: use the OpenAI docs MCP",
      "› [Pasted Content 4827 chars]",
      "  gpt-5.6-terra low",
    ].join("\n");
    expect(codexComposerHoldsPendingInput(visible, "a".repeat(4827))).toBe(true);
  });

  it("detects a Codex composer still holding a short literal prompt", () => {
    const visible = "OpenAI Codex\nmodel: gpt-5.6-terra\n› Reply exactly AUTO_SUBMIT_FIXED.";
    expect(codexComposerHoldsPendingInput(visible, "Reply exactly AUTO_SUBMIT_FIXED. Do not use tools.")).toBe(true);
  });

  it("treats an empty Codex composer and its placeholder hint as submitted", () => {
    const empty = "OpenAI Codex\nmodel: gpt-5.6-terra\n› ";
    const hint = "OpenAI Codex\nmodel: gpt-5.6-terra\n› Implement {feature}";
    expect(codexComposerHoldsPendingInput(empty, "Reply exactly AUTO_SUBMIT_FIXED.")).toBe(false);
    expect(codexComposerHoldsPendingInput(hint, "Reply exactly AUTO_SUBMIT_FIXED.")).toBe(false);
  });

  it("reads the bottom-most prompt glyph so submitted history does not look pending", () => {
    const visible = [
      "› Reply exactly AUTO_SUBMIT_FIXED.",
      "• Working (3s)",
      "› ",
    ].join("\n");
    expect(codexComposerHoldsPendingInput(visible, "Reply exactly AUTO_SUBMIT_FIXED.")).toBe(false);
  });

  it("returns false when no Codex composer is on screen yet", () => {
    expect(codexComposerHoldsPendingInput("Starting MCP servers (1/2)", "anything")).toBe(false);
  });
});
