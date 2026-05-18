import { describe, expect, it } from "vitest";
import {
  buildTrackedCliResumeCommand,
  defaultResumeCommandForTool,
  extractResumeCommandFromOutput,
  parseTrackedCliLaunchConfig,
  parseTrackedCliResumeCommand,
  normalizeResumeCommand,
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

  it("maps OSC 133 prompt markers to waiting-input", () => {
    const marker = "\u001b]133;A\u0007";
    expect(runtimeStateFromOsc133Chunk(marker, "running")).toBe("waiting-input");
  });

  it("maps OSC 133 command markers to running", () => {
    const marker = "\u001b]133;B\u001b\\";
    expect(runtimeStateFromOsc133Chunk(marker, "waiting-input")).toBe("running");
  });

  it("returns default resume command for known tools", () => {
    expect(defaultResumeCommandForTool("claude")).toBe("claude --resume");
    expect(defaultResumeCommandForTool("codex")).toBe("codex resume");
    expect(defaultResumeCommandForTool("cursor-cli")).toBe("cursor-agent --continue");
    expect(defaultResumeCommandForTool("droid")).toBe("droid --resume");
    expect(defaultResumeCommandForTool("opencode")).toBe("opencode --continue");
    expect(defaultResumeCommandForTool("shell")).toBeNull();
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
    expect(parseTrackedCliLaunchConfig("droid --settings /tmp/ade.json", "droid")).toEqual({
      permissionMode: "plan",
    });
    expect(parseTrackedCliLaunchConfig("OPENCODE_CONFIG_CONTENT='{\"permission\":{\"*\":\"ask\",\"edit\":\"allow\"}}' opencode", "opencode")).toEqual({
      permissionMode: "edit",
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
    })).toBe("cursor-agent --mode ask --resume chat-1");

    expect(buildTrackedCliResumeCommand({
      provider: "opencode",
      targetKind: "session",
      targetId: "ses_1",
      launch: { permissionMode: "full-auto" },
    })).toBe("OPENCODE_CONFIG_CONTENT='{\"permission\":\"allow\"}' opencode --session ses_1");
  });

  it("applies resume-time model, reasoning, and permission overrides", () => {
    expect(buildTrackedCliResumeCommand({
      provider: "claude",
      targetKind: "session",
      targetId: "claude-session-1",
      launch: { permissionMode: "default" },
    }, { model: "anthropic/claude-haiku-4-5", reasoningEffort: "low", permissionMode: "auto" })).toBe(
      "claude --permission-mode auto --model haiku --effort low --resume claude-session-1",
    );

    expect(buildTrackedCliResumeCommand({
      provider: "codex",
      targetKind: "thread",
      targetId: "thread-99",
      launch: { permissionMode: "edit" },
    }, { model: "gpt-5.4", reasoningEffort: "high", permissionMode: "plan" })).toBe(
      "codex --no-alt-screen --model gpt-5.4 -c 'model_reasoning_effort=\"high\"' --sandbox read-only --ask-for-approval on-request resume thread-99",
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
  });

  it("extracts Cursor resume commands printed by ADE launch wrappers", () => {
    const chunk = "[ADE] Resume with cursor-agent --resume chat-abc";
    expect(extractResumeCommandFromOutput(chunk, "cursor-cli")).toBe("cursor-agent --resume chat-abc");
  });
});
