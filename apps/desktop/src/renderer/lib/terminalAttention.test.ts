import { describe, expect, it } from "vitest";
import {
  runningSessionNeedsAttention,
  sanitizeTerminalInlineText,
  sessionNeedsChatTabHighlight,
  sessionStatusBucket,
  sessionStatusDot,
} from "./terminalAttention";

describe("terminalAttention", () => {
  it("does not treat a plain shell prompt as awaiting user input", () => {
    expect(runningSessionNeedsAttention("admin@Mac test-4-6a625aeb %")).toBe(false);
    expect(
      sessionStatusBucket({
        status: "running",
        lastOutputPreview: "admin@Mac test-4-6a625aeb %",
      }),
    ).toBe("running");
  });

  it("keeps prompt-text detection separate from lifecycle attention", () => {
    expect(runningSessionNeedsAttention("Confirm continue? (y/n)")).toBe(true);
    expect(
      sessionStatusBucket({
        status: "running",
        lastOutputPreview: "Confirm continue? (y/n)",
      }),
    ).toBe("running");
  });

  it("removes cursor save and restore escapes from inline previews", () => {
    expect(sanitizeTerminalInlineText("\u001b7Claude Code\u001b8 ready")).toBe("Claude Code ready");
  });

  it("removes Kitty graphics protocol controls from inline previews", () => {
    expect(sanitizeTerminalInlineText("\u001b_Gi=31337,s=1,v=1,a=q,t=d,f=24;AAAA\u001b\\opencode ready")).toBe("opencode ready");
  });

  it("treats idle chat sessions as a static ready state", () => {
    const dot = sessionStatusDot({
      status: "running",
      lastOutputPreview: "Completed response",
      runtimeState: "idle",
      toolType: "claude-chat",
    });
    expect(dot.label).toBe("Ready");
    expect(dot.cls).toContain("bg-amber");
  });

  it("treats idle AI CLI sessions as needing attention", () => {
    const dot = sessionStatusDot({
      status: "running",
      lastOutputPreview: "Analyzed project state",
      runtimeState: "idle",
      toolType: "codex",
    });
    expect(dot.label).toBe("Idle");
    expect(dot.cls).toContain("bg-amber");
  });

  it("keeps plain shell sessions active when they simply go idle", () => {
    const dot = sessionStatusDot({
      status: "running",
      lastOutputPreview: "admin@Mac test-4-6a625aeb %",
      runtimeState: "idle",
      toolType: "shell",
    });
    expect(dot.label).toBe("Running");
    expect(dot.cls).toContain("bg-emerald");
  });

  it("treats detached sessions as ended instead of ready chat state", () => {
    expect(
      sessionStatusBucket({
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

    it("highlights only structured or explicitly declared chat requests", () => {
      expect(sessionNeedsChatTabHighlight({
        runtimeState: "waiting-input",
        toolType: "cursor",
      })).toBe(false);
      expect(sessionNeedsChatTabHighlight({
        runtimeState: "idle",
        toolType: "codex-chat",
        pendingInputItemId: "approval-1",
      })).toBe(true);
      expect(sessionNeedsChatTabHighlight({
        runtimeState: "waiting-input",
        toolType: "claude-chat",
        attentionSource: "provider_structured",
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

    it("keeps a prompt-looking running session non-interrupting", () => {
      const dot = sessionStatusDot({
        status: "running",
        lastOutputPreview: "Confirm continue? (y/n)",
      });
      expect(dot.spinning).toBe(false);
      expect(dot.cls).toContain("emerald");
      expect(dot.label).toBe("Running");
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
