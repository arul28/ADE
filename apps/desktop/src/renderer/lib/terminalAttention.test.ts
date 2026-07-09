import { describe, expect, it } from "vitest";
import {
  runningSessionNeedsAttention,
  sanitizeTerminalInlineText,
  sessionIndicatorState,
  sessionNeedsChatTabHighlight,
  sessionNeedsUserInput,
  sessionStatusBucket,
  sessionStatusDot,
} from "./terminalAttention";

describe("terminalAttention", () => {
  it("does not treat a plain shell prompt as awaiting user input", () => {
    expect(runningSessionNeedsAttention("admin@Mac test-4-6a625aeb %")).toBe(false);
    expect(
      sessionIndicatorState({
        status: "running",
        lastOutputPreview: "admin@Mac test-4-6a625aeb %",
      }),
    ).toBe("running-active");
  });

  it("still detects explicit confirmation prompts", () => {
    expect(runningSessionNeedsAttention("Confirm continue? (y/n)")).toBe(true);
    expect(
      sessionIndicatorState({
        status: "running",
        lastOutputPreview: "Confirm continue? (y/n)",
      }),
    ).toBe("running-needs-attention");
  });

  it("removes cursor save and restore escapes from inline previews", () => {
    expect(sanitizeTerminalInlineText("\u001b7Claude Code\u001b8 ready")).toBe("Claude Code ready");
  });

  it("removes Kitty graphics protocol controls from inline previews", () => {
    expect(sanitizeTerminalInlineText("\u001b_Gi=31337,s=1,v=1,a=q,t=d,f=24;AAAA\u001b\\opencode ready")).toBe("opencode ready");
  });

  it("treats idle chat sessions as a static ready state", () => {
    expect(
      sessionIndicatorState({
        status: "running",
        lastOutputPreview: "Completed response",
        runtimeState: "idle",
        toolType: "claude-chat",
      }),
    ).toBe("running-needs-attention");
  });

  it("treats idle AI CLI sessions as needing attention", () => {
    expect(
      sessionIndicatorState({
        status: "running",
        lastOutputPreview: "Analyzed project state",
        runtimeState: "idle",
        toolType: "codex",
      }),
    ).toBe("running-needs-attention");
  });

  it("keeps plain shell sessions active when they simply go idle", () => {
    expect(
      sessionIndicatorState({
        status: "running",
        lastOutputPreview: "admin@Mac test-4-6a625aeb %",
        runtimeState: "idle",
        toolType: "shell",
      }),
    ).toBe("running-active");
  });

  it("treats detached sessions as ended instead of ready chat state", () => {
    expect(
      sessionIndicatorState({
        status: "detached",
        lastOutputPreview: "Last preserved output",
        runtimeState: "exited",
        toolType: "codex-chat",
      }),
    ).toBe("ended");
  });

  describe("sessionNeedsChatTabHighlight", () => {
    it("does not highlight idle agent chats or any CLI sessions", () => {
      expect(sessionNeedsChatTabHighlight({
        runtimeState: "idle",
        toolType: "claude-chat",
      })).toBe(false);
      expect(sessionNeedsChatTabHighlight({
        runtimeState: "waiting-input",
        toolType: "claude",
      })).toBe(false);
    });

    it("highlights agent chats blocked on approval or questions", () => {
      expect(sessionNeedsChatTabHighlight({
        runtimeState: "waiting-input",
        toolType: "cursor",
      })).toBe(true);
      expect(sessionNeedsChatTabHighlight({
        runtimeState: "idle",
        toolType: "codex-chat",
        pendingInputItemId: "approval-1",
      })).toBe(true);
    });
  });

  describe("sessionNeedsUserInput", () => {
    it("keeps idle agent chats out of CLI-style prompt detection", () => {
      expect(sessionNeedsUserInput({
        status: "running",
        lastOutputPreview: "Completed response",
        runtimeState: "idle",
        toolType: "claude-chat",
      })).toBe(false);
    });

    it("still detects CLI confirmation prompts for CLI headers", () => {
      expect(sessionNeedsUserInput({
        status: "running",
        lastOutputPreview: "Confirm continue? (y/n)",
        runtimeState: "running",
        toolType: "claude",
      })).toBe(true);
    });
  });

  describe("sessionStatusBucket", () => {
    it("keeps idle ready agent chats in the awaiting-input bucket for dots and filters", () => {
      expect(sessionStatusBucket({
        status: "running",
        lastOutputPreview: "Completed response",
        runtimeState: "idle",
        toolType: "claude-chat",
      })).toBe("awaiting-input");
    });
  });

  describe("sessionStatusDot", () => {
    it("returns a solid emerald dot for a running active session", () => {
      const dot = sessionStatusDot({
        status: "running",
        lastOutputPreview: "building project...",
      });
      expect(dot.spinning).toBe(false);
      expect(dot.cls).toContain("emerald");
      expect(dot.label).toBe("Running");
    });

    it("returns a solid (non-spinning) amber dot for a running needs-attention session", () => {
      const dot = sessionStatusDot({
        status: "running",
        lastOutputPreview: "Confirm continue? (y/n)",
      });
      expect(dot.spinning).toBe(false);
      expect(dot.cls).toContain("amber");
      expect(dot.label).toBe("Awaiting input");
    });

    it("returns a solid amber dot for an idle chat session", () => {
      const dot = sessionStatusDot({
        status: "running",
        lastOutputPreview: "Completed response",
        runtimeState: "idle",
        toolType: "claude-chat",
      });
      expect(dot.spinning).toBe(false);
      expect(dot.cls).toContain("amber");
      expect(dot.label).toBe("Ready");
    });

    it("returns a solid amber dot with an idle label for idle AI CLI sessions", () => {
      const dot = sessionStatusDot({
        status: "running",
        lastOutputPreview: "Analyzed project state",
        runtimeState: "idle",
        toolType: "claude",
      });
      expect(dot.spinning).toBe(false);
      expect(dot.cls).toContain("amber");
      expect(dot.label).toBe("Idle");
    });

    it("returns a solid red dot for an ended CLI session", () => {
      const dot = sessionStatusDot({
        status: "completed",
        lastOutputPreview: "Process exited with code 0",
        toolType: "claude",
      });
      expect(dot.spinning).toBe(false);
      expect(dot.cls).toContain("red");
      expect(dot.label).toBe("Ended");
    });

    it("returns a solid red ended dot for a detached session", () => {
      const dot = sessionStatusDot({
        status: "detached",
        lastOutputPreview: "Last preserved output",
        runtimeState: "exited",
        toolType: "codex",
      });
      expect(dot.spinning).toBe(false);
      expect(dot.cls).toContain("red");
      expect(dot.label).toBe("Ended");
    });

    it("returns a stopped red dot for a disposed session", () => {
      const dot = sessionStatusDot({
        status: "disposed",
        lastOutputPreview: "Stopped by user",
        runtimeState: "killed",
        toolType: "codex",
      });
      expect(dot.spinning).toBe(false);
      expect(dot.cls).toContain("red");
      expect(dot.label).toBe("Stopped");
    });

    it("returns a failed red dot for an explicit failed status", () => {
      const dot = sessionStatusDot({
        status: "failed",
        lastOutputPreview: "Launch failed",
        runtimeState: "exited",
        toolType: "codex",
      });
      expect(dot.spinning).toBe(false);
      expect(dot.cls).toContain("red");
      expect(dot.label).toBe("Failed");
    });

    it("returns a ready amber dot for a non-running agent chat session", () => {
      const dot = sessionStatusDot({
        status: "completed",
        lastOutputPreview: "Last response preview",
        toolType: "claude-chat",
      });
      expect(dot.spinning).toBe(false);
      expect(dot.cls).toContain("amber");
      expect(dot.label).toBe("Ready");
    });
  });
});
