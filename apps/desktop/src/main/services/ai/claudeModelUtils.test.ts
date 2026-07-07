import { describe, expect, it } from "vitest";
import { resolveClaudeCliModel } from "./claudeModelUtils";

describe("resolveClaudeCliModel", () => {
  it("normalizes Opus 4.8 1M aliases to the exact Opus 4.8 model", () => {
    expect(resolveClaudeCliModel("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(resolveClaudeCliModel("opus-4.8-1m")).toBe("claude-opus-4-8");
    expect(resolveClaudeCliModel("claude-opus-4-8[1m]")).toBe("claude-opus-4-8");
  });

  it("maps removed basic Opus and Sonnet aliases to supported Claude CLI model ids", () => {
    expect(resolveClaudeCliModel("claude-opus-4-7")).toBe("claude-opus-4-8");
    expect(resolveClaudeCliModel("claude-sonnet-4-6")).toBe("claude-sonnet-5");
    expect(resolveClaudeCliModel("sonnet")).toBe("claude-sonnet-5");
  });

  it("keeps Opus 4.7 1M aliases on their explicit 1M CLI id", () => {
    expect(resolveClaudeCliModel("claude-opus-4-7-1m")).toBe("claude-opus-4-7[1m]");
    expect(resolveClaudeCliModel("claude-opus-4-7[1m]")).toBe("claude-opus-4-7[1m]");
    expect(resolveClaudeCliModel("opus-11m")).toBe("claude-opus-4-8");
  });
});
