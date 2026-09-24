import { describe, expect, it } from "vitest";
import { isServedModelMismatch, isServedRouteMismatch, modelIdentityKey } from "./servedModelMismatch";

describe("served model mismatch", () => {
  it("treats a spelling, tier, snapshot, or effort variant as the same model", () => {
    const same: Array<[string, string]> = [
      ["claude-opus-5-5", "claude-opus-5-5[1m]"],
      ["anthropic/claude-opus-5-5", "claude-opus-5-5"],
      ["claude-haiku-4-5", "claude-haiku-4-5-20251001"],
      ["opus", "claude-opus-5-5"],
      ["opencode/anthropic/claude-sonnet-4.6", "claude-sonnet-4-6"],
      ["grok-4.5", "grok-4.5-build"],
      ["gpt-5.4", "gpt-5.4-high"],
      ["claude-4.6-sonnet", "claude-4.6-sonnet-thinking"],
      ["custom:claude-sonnet-5", "claude-sonnet-5"],
    ];
    for (const [requested, served] of same) {
      expect(isServedModelMismatch(requested, served), `${requested} vs ${served}`).toBe(false);
    }
  });

  it("flags a different model", () => {
    const different: Array<[string, string]> = [
      ["gpt-5.4", "gpt-5.4-safe"],
      ["gpt-5.4", "gpt-5.4-mini"],
      ["claude-sonnet-5", "claude-haiku-4-5"],
      ["claude-opus-5-5", "claude-opus-5"],
      ["opencode/anthropic/claude-sonnet-5", "opencode/openai/gpt-5.4-mini"],
    ];
    for (const [requested, served] of different) {
      expect(isServedModelMismatch(requested, served), `${requested} vs ${served}`).toBe(true);
    }
  });

  it("never flags a router pick or a missing side", () => {
    expect(isServedModelMismatch("auto", "claude-sonnet-5")).toBe(false);
    expect(isServedModelMismatch("cursor/auto", "gpt-5.4")).toBe(false);
    expect(isServedModelMismatch("openrouter/auto", "gpt-5.4")).toBe(false);
    expect(isServedModelMismatch(null, "gpt-5.4")).toBe(false);
    expect(isServedModelMismatch("gpt-5.4", "  ")).toBe(false);
  });

  it("keeps the model name and drops only spelling", () => {
    expect(modelIdentityKey("Anthropic/Claude-Opus-5-5[1M]")).toBe("claude-opus-5-5");
    expect(modelIdentityKey("gpt-5.4-mini-high")).toBe("gpt-5-4-mini");
    expect(modelIdentityKey("llama3:latest")).toBe("llama3");
  });
});

describe("served route mismatch", () => {
  it("flags another upstream even under the same model name", () => {
    expect(isServedRouteMismatch({
      requested: "claude-sonnet-5",
      served: "openrouter/claude-sonnet-5",
      requestedUpstream: "anthropic",
      servedUpstream: "openrouter",
    })).toBe(true);
    expect(isServedRouteMismatch({
      requested: "claude-sonnet-5",
      served: "claude-sonnet-5",
      requestedUpstream: "Anthropic",
      servedUpstream: " anthropic ",
    })).toBe(false);
  });

  it("falls back to the model names when either upstream is unknown", () => {
    expect(isServedRouteMismatch({ requested: "gpt-5.4", served: "gpt-5.4-high", requestedUpstream: "openai" }))
      .toBe(false);
    expect(isServedRouteMismatch({ requested: "gpt-5.4", served: "gpt-5.4-mini", servedUpstream: "openai" }))
      .toBe(true);
  });
});
