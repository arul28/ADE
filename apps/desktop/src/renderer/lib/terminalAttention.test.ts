import { describe, expect, it } from "vitest";
import { runningSessionNeedsAttention, sessionIndicatorState, sessionStatusDot } from "./terminalAttention";

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

  describe("sessionStatusDot", () => {
    it("returns a spinning emerald dot for a running active session", () => {
      const dot = sessionStatusDot({
        status: "running",
        lastOutputPreview: "building project...",
      });
      expect(dot.spinning).toBe(true);
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

    it("returns a solid red dot for an ended session", () => {
      const dot = sessionStatusDot({
        status: "completed",
        lastOutputPreview: "Process exited with code 0",
      });
      expect(dot.spinning).toBe(false);
      expect(dot.cls).toContain("red");
      expect(dot.label).toBe("Ended");
    });
  });
});
