import { describe, expect, it } from "vitest";
import {
  runningSessionNeedsAttention,
  sanitizeTerminalInlineText,
  sessionNeedsChatTabHighlight,
  sessionStatusBucket,
  sessionStatusDisplay,
  sessionStatusDot,
  summarizeTerminalAttention,
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

  describe("sessionStatusDisplay", () => {
    it("shows Planning only while an ADE chat has an active plan-mode turn", () => {
      const active = sessionStatusDisplay({
        status: "running",
        runtimeState: "running",
        toolType: "codex-chat",
        lastOutputPreview: "Inspecting the repository",
        chatActivityMode: "planning",
      });
      const idle = sessionStatusDisplay({
        status: "running",
        runtimeState: "idle",
        toolType: "codex-chat",
        lastOutputPreview: "Plan ready",
        chatActivityMode: "planning",
      });

      expect(active).toMatchObject({
        label: "Planning",
        tone: "violet",
        glyph: "planning",
        showsElapsed: true,
      });
      expect(idle?.label).toBe("Done");
      expect(idle?.tone).toBe("emerald");
    });

    it("names and times background work on an idle chat, and outranks a pending wake", () => {
      const presentation = sessionStatusDisplay({
        status: "running",
        runtimeState: "idle",
        toolType: "claude-chat",
        lastOutputPreview: "Foreground turn complete",
        activeBackgroundTaskCount: 2,
        nextWakeAt: "2026-08-01T12:00:00.000Z",
        nowMs: Date.parse("2026-08-01T10:00:00.000Z"),
      });

      // Not a bare "Working": the foreground turn has ENDED, so claiming the
      // model is working — with no duration to judge it by — reads exactly like
      // a turn that has hung. Name the state and show how long it has run.
      expect(presentation).toMatchObject({
        label: "Background work ×2",
        tone: "blue",
        glyph: "working",
      });
      expect(presentation?.showsElapsed).toBe(true);
    });

    it("says Monitoring when watch loops are the only live work", () => {
      const presentation = sessionStatusDisplay({
        status: "running",
        runtimeState: "idle",
        toolType: "claude-chat",
        lastOutputPreview: "Foreground turn complete",
        activeBackgroundTaskCount: 2,
        backgroundWork: { workingCount: 0, monitoringCount: 2 },
      });

      // "Monitoring" answers a different question than "Background work":
      // a watch loop will not finish on its own, so the row is telling you it
      // is safe to walk away.
      expect(presentation).toMatchObject({
        label: "Monitoring ×2",
        tone: "blue",
        glyph: "monitoring",
      });
    });

    it("keeps a live turn's Planning label off a background-promoted row", () => {
      const planningTurn = sessionStatusDisplay({
        status: "running",
        runtimeState: "running",
        toolType: "claude-chat",
        lastOutputPreview: "thinking",
        chatActivityMode: "planning",
      });
      expect(planningTurn?.label).toBe("Planning");

      // The turn is over; plan mode was how it ran, not what is happening now.
      const backgroundOnly = sessionStatusDisplay({
        status: "running",
        runtimeState: "idle",
        toolType: "claude-chat",
        lastOutputPreview: "Plan delivered",
        chatActivityMode: "planning",
        backgroundWork: { workingCount: 1, monitoringCount: 0 },
      });
      expect(backgroundOnly?.label).toBe("Background work");
    });

    it("shows Waiting only for an idle chat with a valid future wake", () => {
      const base = {
        status: "running" as const,
        runtimeState: "idle" as const,
        toolType: "codex-chat" as const,
        lastOutputPreview: "Current turn complete",
        nowMs: Date.parse("2026-08-01T10:00:00.000Z"),
      };
      const future = sessionStatusDisplay({
        ...base,
        nextWakeAt: "2026-08-01T12:00:00.000Z",
      });
      const elapsed = sessionStatusDisplay({
        ...base,
        nextWakeAt: "2026-08-01T09:00:00.000Z",
      });

      expect(future).toMatchObject({
        label: "Waiting",
        tone: "neutral",
        glyph: "waiting",
      });
      expect(elapsed?.label).toBe("Done");
      expect(elapsed?.tone).toBe("emerald");
    });

    it("preserves attention and stale states over informational chat modes", () => {
      const needsYou = sessionStatusDisplay({
        status: "running",
        runtimeState: "waiting-input",
        toolType: "codex-chat",
        pendingInputItemId: "approval-1",
        lastOutputPreview: "Approve?",
        chatActivityMode: "planning",
      });
      const stale = sessionStatusDisplay({
        status: "running",
        runtimeState: "running",
        toolType: "claude-chat",
        lastOutputPreview: "Still running",
        lastActivityAt: "2026-08-01T06:00:00.000Z",
        activeBackgroundTaskCount: 1,
        nowMs: Date.parse("2026-08-01T10:00:00.000Z"),
      });

      expect(needsYou?.label).toBe("Needs you");
      expect(needsYou?.tone).toBe("amber");
      expect(stale?.label).toBe("Stale");
      expect(stale?.tone).toBe("neutral");
    });
  });
});

describe("summarizeTerminalAttention", () => {
  const base = {
    id: "s-1",
    laneId: "lane-1",
    status: "running" as const,
    runtimeState: "idle" as const,
    toolType: "claude-chat" as const,
    lastOutputPreview: "Foreground turn complete",
    startedAt: "2026-08-01T10:00:00.000Z",
  };

  it("counts a session whose only live work is in the background", () => {
    // The Work-tab dot, the TopBar rollup and the dock badge all read this
    // rollup. Before background work reached the canonical phase they showed
    // nothing at all while agents were mid-run.
    const quiet = summarizeTerminalAttention([base as never]);
    expect(quiet.runningCount).toBe(0);
    expect(quiet.indicator).toBe("none");

    const busy = summarizeTerminalAttention([
      { ...base, backgroundWork: { workingCount: 2, monitoringCount: 0 }, activeBackgroundTaskCount: 2 } as never,
    ]);
    expect(busy.runningCount).toBe(1);
    expect(busy.activeCount).toBe(1);
    expect(busy.needsAttentionCount).toBe(0);
    expect(busy.indicator).toBe("running-active");
  });

  it("counts a monitoring-only session as running, not as needing you", () => {
    const summary = summarizeTerminalAttention([
      { ...base, backgroundWork: { workingCount: 0, monitoringCount: 1 }, activeBackgroundTaskCount: 1 } as never,
    ]);
    expect(summary.runningCount).toBe(1);
    expect(summary.needsAttentionCount).toBe(0);
  });
});
