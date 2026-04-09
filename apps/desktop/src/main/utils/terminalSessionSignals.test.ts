import { describe, expect, it } from "vitest";
import {
  buildTrackedCliResumeCommand,
  defaultResumeCommandForTool,
  extractResumeCommandFromOutput,
  parseTrackedCliLaunchConfig,
  parseTrackedCliResumeCommand,
  normalizeResumeCommand,
  runtimeStateFromOsc133Chunk
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
    expect(defaultResumeCommandForTool("shell")).toBeNull();
  });

  it("parses tracked Claude and Codex launch configs from startup commands", () => {
    expect(parseTrackedCliLaunchConfig("claude --permission-mode default", "claude")).toEqual({
      permissionMode: "default",
      claudePermissionMode: "default",
    });
    expect(parseTrackedCliLaunchConfig("codex --no-alt-screen -c approval_policy=on-failure -c sandbox_mode=workspace-write", "codex")).toEqual({
      permissionMode: "edit",
      codexApprovalPolicy: "on-failure",
      codexSandbox: "workspace-write",
      codexConfigSource: "flags",
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
    })).toBe("codex --no-alt-screen -c approval_policy=on-failure -c sandbox_mode=workspace-write resume thread-99");

    expect(buildTrackedCliResumeCommand({
      provider: "codex",
      targetKind: "thread",
      targetId: null,
      launch: { permissionMode: "full-auto" },
    })).toBe("codex --no-alt-screen --full-auto resume");
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
    expect(parseTrackedCliResumeCommand("codex --no-alt-screen --full-auto resume thread_abc123", "codex")).toEqual({
      provider: "codex",
      targetId: "thread_abc123",
    });
    expect(parseTrackedCliResumeCommand("codex --no-alt-screen --full-auto resume", "codex")).toEqual({
      provider: "codex",
      targetId: null,
    });
  });
});
