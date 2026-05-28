import { describe, expect, it } from "vitest";
import { resolveClaudeCliModel } from "./claudeModelUtils";

describe("resolveClaudeCliModel", () => {
  it("normalizes Opus 4.8 1M aliases to the exact Opus 4.8 model", () => {
    expect(resolveClaudeCliModel("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(resolveClaudeCliModel("opus-4.8-1m")).toBe("claude-opus-4-8");
    expect(resolveClaudeCliModel("claude-opus-4-8[1m]")).toBe("claude-opus-4-8");
  });

  it("keeps Opus 4.7 and Opus 4.7 1M aliases on their existing CLI aliases", () => {
    expect(resolveClaudeCliModel("claude-opus-4-7")).toBe("opus");
    expect(resolveClaudeCliModel("claude-opus-4-7-1m")).toBe("opus[1m]");
    expect(resolveClaudeCliModel("claude-opus-4-7[1m]")).toBe("opus[1m]");
    expect(resolveClaudeCliModel("opus-11m")).toBe("opus");
  });
});
