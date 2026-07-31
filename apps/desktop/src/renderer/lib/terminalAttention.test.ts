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

  it("collapses separator rules so a preview cannot draw a line across the row", () => {
    // A run of rule characters fills the sidebar row edge to edge and renders
    // as a horizontal line struck through the card — it reads as a broken
    // layout rather than as text.
    expect(sanitizeTerminalInlineText("---------------------------- done")).toBe("- done");
    expect(sanitizeTerminalInlineText("━━━━━━━━ output")).toBe("━ output");
    expect(sanitizeTerminalInlineText("____________ built")).toBe("_ built");
  });

  it("leaves ordinary repeated punctuation alone", () => {
    // Collapsing these would change the tone of a message, not just its
    // geometry — they are speech, not furniture.
    expect(sanitizeTerminalInlineText("done...")).toBe("done...");
    expect(sanitizeTerminalInlineText("really!!!")).toBe("really!!!");
    expect(sanitizeTerminalInlineText("## Heading")).toBe("## Heading");
  });

  it("treats an idle chat as Done — finished, not asking for anything", () => {
    const dot = sessionStatusDot({
      status: "running",
      lastOutputPreview: "Completed response",
      runtimeState: "idle",
      toolType: "claude-chat",
    });
    expect(dot.label).toBe("Done");
    expect(dot.cls).toContain("bg-emerald");
  });

  it("treats an idle AI CLI as Done, on the same emerald as an idle chat", () => {
    const dot = sessionStatusDot({
      status: "running",
      lastOutputPreview: "Analyzed project state",
      runtimeState: "idle",
      toolType: "codex",
    });
    expect(dot.label).toBe("Done");
    expect(dot.cls).toContain("bg-emerald");
  });

  it("leaves a plain shell at its prompt calm — emerald, never amber", () => {
    const dot = sessionStatusDot({
      status: "running",
      lastOutputPreview: "admin@Mac test-4-6a625aeb %",
      runtimeState: "idle",
      toolType: "shell",
    });
    // A shell sitting at a prompt resolves to the `idle` phase, which shares
    // the emerald "Done" presentation with a resting chat. The label is a
    // slightly loose fit for a shell — it is not "done" with anything — but
    // the invariant this test actually guards is that it is NOT amber: the old
    // dot special-cased tool types here, which is how amber ended up meaning
    // five different things. One vocabulary, no per-tool exceptions.
    expect(dot.label).toBe("Done");
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
    it("returns a solid sky dot for a running active session", () => {
      const dot = sessionStatusDot({
        status: "running",
        lastOutputPreview: "building project...",
      });
      expect(dot.spinning).toBe(false);
      expect(dot.cls).toContain("sky");
      expect(dot.label).toBe("Working");
    });

    it("keeps a prompt-looking running session non-interrupting", () => {
      const dot = sessionStatusDot({
        status: "running",
        lastOutputPreview: "Confirm continue? (y/n)",
      });
      expect(dot.spinning).toBe(false);
      expect(dot.cls).toContain("sky");
      expect(dot.label).toBe("Working");
    });

    it("returns a solid emerald dot for an idle chat session", () => {
      const dot = sessionStatusDot({
        status: "running",
        lastOutputPreview: "Completed response",
        runtimeState: "idle",
        toolType: "claude-chat",
      });
      expect(dot.spinning).toBe(false);
      expect(dot.cls).toContain("emerald");
      expect(dot.label).toBe("Done");
    });

    it("returns a solid emerald Done dot for idle AI CLI sessions", () => {
      const dot = sessionStatusDot({
        status: "running",
        lastOutputPreview: "Analyzed project state",
        runtimeState: "idle",
        toolType: "claude",
      });
      expect(dot.spinning).toBe(false);
      expect(dot.cls).toContain("emerald");
      expect(dot.label).toBe("Done");
    });

    it("returns a neutral dot for an ended CLI session", () => {
      const dot = sessionStatusDot({
        status: "completed",
        lastOutputPreview: "Process exited with code 0",
        toolType: "claude",
      });
      expect(dot.spinning).toBe(false);
      expect(dot.cls).toContain("white");
      expect(dot.label).toBe("Ended");
    });

    it("returns a neutral ended dot for a detached session", () => {
      const dot = sessionStatusDot({
        status: "detached",
        lastOutputPreview: "Last preserved output",
        runtimeState: "exited",
        toolType: "codex",
      });
      expect(dot.spinning).toBe(false);
      expect(dot.cls).toContain("white");
      expect(dot.label).toBe("Ended");
    });

    it("returns a neutral stopped dot for a disposed session", () => {
      const dot = sessionStatusDot({
        status: "disposed",
        lastOutputPreview: "Stopped by user",
        runtimeState: "killed",
        toolType: "codex",
      });
      expect(dot.spinning).toBe(false);
      // Neutral, NOT red: exit 130/143 is the user pressing stop. Spending the
      // alarm hue on an outcome the user chose is what trains people to ignore
      // red — see sessionStatusPresentation's header.
      expect(dot.cls).toContain("white");
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

    it("returns an emerald Done dot for a non-running agent chat session", () => {
      const dot = sessionStatusDot({
        status: "completed",
        lastOutputPreview: "Last response preview",
        toolType: "claude-chat",
      });
      expect(dot.spinning).toBe(false);
      expect(dot.cls).toContain("emerald");
      expect(dot.label).toBe("Done");
    });
  });
});
