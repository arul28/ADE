import { describe, expect, it } from "vitest";
import { resolveClaudeCliModel } from "./claudeModelUtils";

describe("resolveClaudeCliModel", () => {
  it("normalizes the Opus 1M aliases without matching larger numeric suffixes", () => {
    expect(resolveClaudeCliModel("claude-opus-4-6-1m")).toBe("opus[1m]");
    expect(resolveClaudeCliModel("claude-opus-4-6[1m]")).toBe("opus[1m]");
    expect(resolveClaudeCliModel("opus-11m")).toBe("opus");
  });
});
