import { describe, expect, it } from "vitest";
import {
  PI_APPROVAL_ALLOW,
  PI_APPROVAL_ALLOW_SESSION,
  PI_UI_ANSWER_ID,
  createPiSdkEventMapperState,
  mapPiSdkEventToChatEvents,
  mapPiSdkRunResultToDoneEvent,
  piExtensionLoadNotice,
  piUiNoticeToChatEvents,
  piUiRequestToPendingInput,
  piUiResponseFromAnswer,
  resetPiSdkEventMapperTurn,
} from "./piSdkEventMapper";
import type { PiSdkUiRequestPayload } from "./piSdkProtocol";

const question: PiSdkUiRequestPayload = {
  origin: "tool",
  kind: "select",
  title: "Database",
  message: "Which database?",
  options: [{ value: "0", label: "Postgres", description: "Managed" }, { value: "1", label: "SQLite" }],
};
const freeform: PiSdkUiRequestPayload = { origin: "tool", kind: "text", title: "Why", message: "Why that one?" };
const approval: PiSdkUiRequestPayload = { origin: "approval", kind: "confirm", title: "Run bash?", message: "npm test" };

describe("piUiRequestToPendingInput", () => {
  it("builds a pick-only card for a choice prompt", () => {
    const request = piUiRequestToPendingInput("req-1", question, "turn-1");
    expect(request).toMatchObject({ requestId: "req-1", itemId: "req-1", source: "pi", kind: "structured_question", turnId: "turn-1" });
    // Free text cannot map back to an option id, which is what Pi expects.
    expect(request.allowsFreeform).toBe(false);
    expect(request.questions[0]).toMatchObject({ id: PI_UI_ANSWER_ID, header: "Database", allowsFreeform: false });
    expect(request.questions[0]!.options).toEqual([
      { label: "Postgres", value: "0", description: "Managed" },
      { label: "SQLite", value: "1" },
    ]);
  });

  it("builds freeform, editor, secret, and approval cards", () => {
    const text = piUiRequestToPendingInput("req-2", freeform, null);
    expect(text).toMatchObject({ kind: "question", allowsFreeform: true });
    expect(text.questions[0]!.options).toBeUndefined();
    // A Pi extension's `editor` prefill is the document being edited.
    expect(piUiRequestToPendingInput("req-5", { ...freeform, defaultValue: "existing draft" }, null).questions[0]!.defaultAssumption)
      .toBe("existing draft");
    expect(piUiRequestToPendingInput("req-3", { ...freeform, kind: "secret" }, null).questions[0]!.isSecret).toBe(true);
    expect(piUiRequestToPendingInput("req-4", approval, null).kind).toBe("approval");
  });
});

describe("piUiResponseFromAnswer", () => {
  it.each([
    ["the chosen option", question, { decision: "accept", answers: { [PI_UI_ANSWER_ID]: "1" } }, { ok: true, value: "1" }],
    ["an unwrapped multi-select", question, { decision: "accept", answers: { [PI_UI_ANSWER_ID]: ["0"] } }, { ok: true, value: "0" }],
    ["free text", freeform, { decision: "accept", responseText: "because it is simple" }, { ok: true, value: "because it is simple" }],
    ["a dismissed card", question, { decision: "cancel" }, { ok: false }],
    ["a declined card", question, { decision: "decline" }, { ok: false }],
    // An approval stays an allow even when the surface attaches a comment.
    ["an approval with a comment", approval, { decision: "accept", responseText: "looks fine" }, { ok: true, value: PI_APPROVAL_ALLOW }],
    ["an approval", approval, { decision: "accept" }, { ok: true, value: PI_APPROVAL_ALLOW }],
    ["a session approval", approval, { decision: "accept_for_session" }, { ok: true, value: PI_APPROVAL_ALLOW_SESSION }],
    // An approval with no decision at all is a denial, never a silent allow.
    ["an approval without a decision", approval, {}, { ok: false }],
  ] as const)("maps %s", (_name, payload, answer, expected) => {
    expect(piUiResponseFromAnswer(payload, answer as Parameters<typeof piUiResponseFromAnswer>[1])).toEqual(expected);
  });
});

describe("piUiNoticeToChatEvents", () => {
  it("renders progress as transient activity and anything else as a notice", () => {
    expect(piUiNoticeToChatEvents({ origin: "extension", level: "progress", message: "indexing" }, "turn-1"))
      .toEqual([{ type: "activity", activity: "working", detail: "indexing", turnId: "turn-1" }]);
    expect(piUiNoticeToChatEvents({ origin: "extension", level: "warn", message: "skipped" }))
      .toEqual([{ type: "system_notice", noticeKind: "warning", message: "skipped" }]);
  });

  it("drops an empty message rather than emitting a blank row", () => {
    expect(piUiNoticeToChatEvents({ origin: "tool", level: "info", message: "   " })).toEqual([]);
  });
});

describe("mapPiSdkEventToChatEvents", () => {
  it("normalizes Pi auto retries into compact activity copy", () => {
    expect(mapPiSdkEventToChatEvents({
      type: "auto_retry_start",
      errorMessage: "request timed out",
      attempt: 2,
      maxAttempts: 5,
      retryDelayMs: 4_000,
    }, "turn-1", null, createPiSdkEventMapperState())).toEqual([{
      type: "activity",
      activity: "working",
      providerRetry: true,
      detail: "Reconnecting to Pi · attempt 2 of 5 · retrying in 4s",
      turnId: "turn-1",
    }]);
  });

  it("accumulates assistant message usage across a turn", () => {
    const state = createPiSdkEventMapperState();
    const first = mapPiSdkEventToChatEvents({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet",
        responseId: "response-1",
        usage: {
          input: 100,
          output: 40,
          cacheRead: 20,
          cacheWrite: 5,
          cacheWrite1h: 2,
          reasoning: 10,
          cost: { total: 0.25 },
        },
      },
    }, "turn-1", null, state);
    const second = mapPiSdkEventToChatEvents({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet",
        responseModel: "claude-opus-served",
        responseId: "response-2",
        account: { kind: "subscription", upstream: "anthropic" },
        usage: {
          input: 200,
          output: 60,
          cacheRead: 30,
          cacheWrite: 7,
          cacheWrite1h: 3,
          reasoning: 12,
          cost: { total: 0.5 },
        },
      },
    }, "turn-1", null, state);

    expect(first[0]).toMatchObject({ type: "tokens", itemId: "response-1", inputTokens: 100, outputTokens: 40, cacheReadTokens: 20, cacheWriteTokens: 5, reasoningTokens: 10 });
    expect(second[0]).toMatchObject({ type: "tokens", itemId: "response-2", inputTokens: 200, outputTokens: 60, cacheReadTokens: 30, cacheWriteTokens: 7, reasoningTokens: 12 });
    const done = mapPiSdkRunResultToDoneEvent({
      turnId: "turn-1",
      model: "Pi Chat",
      modelId: "pi/claude-sonnet",
      requestedModel: "claude-sonnet",
      state,
      status: "completed",
    });
    expect(done).toMatchObject({
      type: "done",
      usage: {
        inputTokens: 300,
        outputTokens: 100,
        cacheReadTokens: 50,
        cacheCreationTokens: 12,
        cacheWrite1hTokens: 5,
        reasoningTokens: 22,
        contextTokens: 237,
        requestCount: 2,
      },
      costUsd: 0.75,
      costSource: "list_price",
      servedModel: "claude-opus-served",
      account: { provider: "pi", kind: "subscription", upstream: "anthropic" },
    });
    // The cost is on `done.costUsd`, not in `usage`, and `usage` is a snapshot:
    // clearing the live state for the next turn leaves this done intact.
    expect(done.usage).not.toHaveProperty("costUsd");
    expect(done.usage).not.toBe(state.usage);
    resetPiSdkEventMapperTurn(state);
    expect(done.usage).toMatchObject({ inputTokens: 300, requestCount: 2 });
  });

  // A Pi route is provider + model: the same model id from another provider is
  // another paid route, so it is the route that answered, not a spelling of it.
  it("reports a turn served by another provider even when the model id matches", () => {
    const answeredBy = (provider: string, model: string) => {
      const state = createPiSdkEventMapperState();
      mapPiSdkEventToChatEvents({
        type: "message_end",
        message: { role: "assistant", provider, model, usage: { input: 1, output: 1 } },
      }, "turn-1", null, state);
      return mapPiSdkRunResultToDoneEvent({
        turnId: "turn-1",
        model: "Pi Chat",
        requestedModel: "gpt-5",
        provider: "openai",
        state,
        status: "completed",
      });
    };

    expect(answeredBy("openrouter", "gpt-5").servedModel).toBe("openrouter/gpt-5");
    expect(answeredBy("openrouter", "gpt-5-mini").servedModel).toBe("openrouter/gpt-5-mini");
    expect(answeredBy("openai", "gpt-5-mini").servedModel).toBe("gpt-5-mini");
    expect(answeredBy("openai", "gpt-5")).not.toHaveProperty("servedModel");
  });

  it("reports nothing from the previous turn on a turn that failed before any event", () => {
    // The host resets the state as the turn starts, before anything that can
    // throw, so an early failure's `done` is built from an empty state.
    const state = createPiSdkEventMapperState();
    mapPiSdkEventToChatEvents({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "anthropic",
        responseModel: "claude-opus-served",
        account: { kind: "subscription", upstream: "anthropic" },
        usage: { input: 100, output: 40, cost: { total: 0.25 } },
      },
    }, "turn-1", null, state);
    resetPiSdkEventMapperTurn(state);
    const failed = mapPiSdkRunResultToDoneEvent({
      turnId: "turn-2",
      model: "Pi Chat",
      requestedModel: "claude-sonnet",
      provider: "anthropic",
      state,
      status: "failed",
    });
    expect(failed).not.toHaveProperty("usage");
    expect(failed).not.toHaveProperty("costUsd");
    expect(failed).not.toHaveProperty("servedModel");
    expect(failed.account).toEqual({ provider: "pi", kind: "unknown", upstream: "anthropic" });
  });

  it("names the account for the upstream that ran, preferring the turn's own report", () => {
    const state = createPiSdkEventMapperState();
    const meta = {
      turnId: "turn-1",
      model: "Pi Chat",
      provider: "openai-codex",
      account: { kind: "api_key" as const, upstream: "anthropic" },
      state,
      status: "interrupted" as const,
    };
    expect(mapPiSdkRunResultToDoneEvent(meta)).toMatchObject({
      status: "interrupted",
      account: { provider: "pi", kind: "unknown", upstream: "openai-codex" },
    });
    expect(mapPiSdkRunResultToDoneEvent({
      ...meta,
      account: { kind: "api_key", upstream: "openai-codex", accountId: "acct-worker" },
    }).account).toEqual({ provider: "pi", kind: "api_key", upstream: "openai-codex", accountId: "acct-worker" });
    state.account = { kind: "subscription", upstream: "openai-codex", accountId: "acct-turn" };
    expect(mapPiSdkRunResultToDoneEvent({
      ...meta,
      account: { kind: "api_key", upstream: "openai-codex", accountId: "acct-worker" },
    }).account).toEqual({ provider: "pi", kind: "subscription", upstream: "openai-codex", accountId: "acct-turn" });
  });

  it("ignores an account with an unknown kind", () => {
    const state = createPiSdkEventMapperState();
    mapPiSdkEventToChatEvents({
      type: "message_end",
      message: { role: "assistant", provider: "anthropic", account: { kind: "sponsor", upstream: "anthropic" } },
    }, "turn-1", null, state);
    expect(state.account).toBeUndefined();
  });

  it("carries Pi compaction sizes and leaves the session count to the shared emitter", () => {
    const state = createPiSdkEventMapperState();
    mapPiSdkEventToChatEvents({ type: "compaction_start" }, "turn-1", "compact-1", state);
    const first = mapPiSdkEventToChatEvents({
      type: "compaction_end",
      result: { tokensBefore: 1_000, estimatedTokensAfter: 400 },
    }, "turn-1", "compact-1", state);
    expect(first[0]).toMatchObject({ type: "context_compact", state: "completed", preTokens: 1_000, postTokens: 400 });
    expect(first[0]).not.toHaveProperty("sessionCompactionCount");
  });
});

describe("piExtensionLoadNotice", () => {
  it("names loaded extensions, ungated tools, and a load failure, and stays quiet on a clean empty list", () => {
    expect(piExtensionLoadNotice([{ id: "/x/git-info/index.ts", name: "git-info" }], null)[0])
      .toMatchObject({ type: "system_notice", noticeKind: "info", message: expect.stringContaining("git-info") });
    expect(piExtensionLoadNotice(undefined, null, ["bash", "write"])[0])
      .toMatchObject({ noticeKind: "warning", message: expect.stringContaining("bash, write") });
    expect(piExtensionLoadNotice([], null)).toEqual([]);
    const failed = piExtensionLoadNotice([], "bad.ts: boom");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ noticeKind: "warning" });
  });
});
