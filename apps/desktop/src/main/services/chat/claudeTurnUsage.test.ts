import { describe, expect, it } from "vitest";
import {
  createClaudeTurnRequestTally,
  pickClaudeLeadingModelUsage,
  recordClaudeRequestStart,
  resolveClaudeServedModel,
  withClaudeTurnRequestUsage,
} from "./claudeTurnUsage";

describe("Claude turn request tally", () => {
  it("counts requests and keeps the last request's whole input side", () => {
    const tally = createClaudeTurnRequestTally();
    recordClaudeRequestStart(tally, { input_tokens: 10, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 50 });
    recordClaudeRequestStart(tally, { input_tokens: 4, cache_read_input_tokens: 1_050, cache_creation_input_tokens: 120 });
    expect(tally).toEqual({ requestCount: 2, contextTokens: 1_174 });
  });

  it("counts a request whose usage is missing without losing the last context size", () => {
    const tally = createClaudeTurnRequestTally();
    recordClaudeRequestStart(tally, { input_tokens: 7 });
    recordClaudeRequestStart(tally, null);
    expect(tally).toEqual({ requestCount: 2, contextTokens: 7 });
  });

  it("adds the tally and context window to done usage", () => {
    const tally = createClaudeTurnRequestTally();
    recordClaudeRequestStart(tally, { input_tokens: 3, cache_read_input_tokens: 97 });
    expect(withClaudeTurnRequestUsage({ inputTokens: 3, outputTokens: 9 }, tally, 1_000_000)).toEqual({
      inputTokens: 3,
      outputTokens: 9,
      contextTokens: 100,
      requestCount: 1,
      contextWindow: 1_000_000,
    });
  });

  it("invents no usage for a turn that made no request", () => {
    expect(withClaudeTurnRequestUsage(undefined, createClaudeTurnRequestTally(), 200_000)).toBeUndefined();
    expect(withClaudeTurnRequestUsage({ inputTokens: 1 }, createClaudeTurnRequestTally(), null)).toEqual({ inputTokens: 1 });
  });
});

describe("the model that answered a Claude turn", () => {
  it("names the model that wrote the most output, and no one on a tie", () => {
    expect(pickClaudeLeadingModelUsage({ "claude-opus-5-5": { outputTokens: 10, contextWindow: 1_000_000 } }))
      .toEqual({ model: "claude-opus-5-5", contextWindow: 1_000_000 });
    expect(pickClaudeLeadingModelUsage({
      "claude-opus-5-5": { output_tokens: 90 },
      "claude-haiku-4-5": { output_tokens: 10, context_window: 200_000 },
    })).toEqual({ model: "claude-opus-5-5", contextWindow: null });
    expect(pickClaudeLeadingModelUsage({ a: { outputTokens: 5 }, b: { outputTokens: 5 } })).toBeUndefined();
    expect(pickClaudeLeadingModelUsage({ a: {}, b: {} })).toBeUndefined();
    expect(pickClaudeLeadingModelUsage({})).toBeUndefined();
  });

  it("reports a served model only when it resolves to another model than the session's", () => {
    const table: Record<string, string> = {
      "claude-opus-5-5[1m]": "anthropic/claude-opus-5-5",
      "claude-haiku-4-5": "anthropic/claude-haiku-4-5",
    };
    const base = {
      sessionModel: "opus",
      sessionModelId: "anthropic/claude-opus-5-5",
      resolveModelId: (served: string) => table[served],
    };
    expect(resolveClaudeServedModel({ ...base, candidate: "claude-opus-5-5[1m]" })).toBeNull();
    expect(resolveClaudeServedModel({ ...base, candidate: " claude-haiku-4-5 " })).toBe("claude-haiku-4-5");
    expect(resolveClaudeServedModel({ ...base, candidate: "  " })).toBeNull();
    // A name the table does not know is compared by its Claude CLI model.
    expect(resolveClaudeServedModel({ ...base, sessionModel: "sonnet", sessionModelId: null, candidate: "sonnet" }))
      .toBeNull();
  });
});
