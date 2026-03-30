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
