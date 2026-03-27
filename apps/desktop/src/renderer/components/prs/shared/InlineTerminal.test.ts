/**
 * Tests for InlineTerminal helper logic.
 *
 * The InlineTerminal component has status color/label derivation logic
 * that we test here by re-deriving the same patterns.
 */
import { describe, expect, it } from "vitest";

// Re-derive the status color/label logic from InlineTerminal component
function deriveStatusColor(exitCode: number | null): string {
  const isRunning = exitCode === null;
  if (isRunning) return "text-blue-400";
  if (exitCode === 0) return "text-emerald-400";
  return "text-red-400";
}

function deriveStatusLabel(exitCode: number | null): string {
  if (exitCode === null) return "Running";
  if (exitCode === 0) return "Completed";
  return `Failed (${exitCode})`;
}

describe("InlineTerminal status derivation", () => {
  describe("status color", () => {
    it("returns blue for running (exitCode null)", () => {
      expect(deriveStatusColor(null)).toBe("text-blue-400");
    });

    it("returns green for successful exit (code 0)", () => {
      expect(deriveStatusColor(0)).toBe("text-emerald-400");
    });

    it("returns red for non-zero exit code", () => {
      expect(deriveStatusColor(1)).toBe("text-red-400");
      expect(deriveStatusColor(127)).toBe("text-red-400");
      expect(deriveStatusColor(-1)).toBe("text-red-400");
    });
  });

  describe("status label", () => {
    it("returns Running for exitCode null", () => {
      expect(deriveStatusLabel(null)).toBe("Running");
    });

    it("returns Completed for exit code 0", () => {
      expect(deriveStatusLabel(0)).toBe("Completed");
    });

    it("returns Failed with exit code for non-zero", () => {
      expect(deriveStatusLabel(1)).toBe("Failed (1)");
      expect(deriveStatusLabel(127)).toBe("Failed (127)");
    });
  });
});

describe("InlineTerminal output truncation logic", () => {
  // This mirrors the setOutput logic in the component
  function applyOutput(prev: string, newData: string): string {
    const next = prev + newData;
    if (next.length > 200_000) {
      return "[Output truncated - showing last 200k characters]\n" + next.slice(-200_000);
    }
    return next;
  }

  it("does not truncate small output", () => {
    const result = applyOutput("hello", " world");
    expect(result).toBe("hello world");
  });

  it("truncates output exceeding 200k characters", () => {
    const large = "x".repeat(200_001);
    const result = applyOutput("", large);
    expect(result).toContain("[Output truncated");
    expect(result.length).toBeLessThanOrEqual(200_001 + 60);
  });

  it("preserves the last 200k characters when truncating", () => {
    const marker = "MARKER_END";
    const large = "x".repeat(200_000) + marker;
    const result = applyOutput("", large);
    expect(result).toContain(marker);
  });
});
