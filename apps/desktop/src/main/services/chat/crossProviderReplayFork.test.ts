import { describe, expect, it } from "vitest";

import type { AgentChatEventEnvelope } from "../../../shared/types/chat";
import {
  buildFittedTranscriptReplay,
  buildTranscriptReplayDocument,
  CROSS_PROVIDER_REPLAY_HEADER,
  CODEX_REPLAY_MAX_CHARS,
  fitTranscriptReplayToBudget,
  fitTranscriptReplayTextToBudget,
  replayMaxCharsForProvider,
  replayBudgetChars,
  replayBudgetTokens,
  replayReserveTokens,
  estimateReplayTokens,
  REPLAY_RESERVE_MIN_TOKENS,
} from "./crossProviderReplayFork";

const sessionId = "chat-1";

function envelope(
  sequence: number,
  event: AgentChatEventEnvelope["event"],
): AgentChatEventEnvelope {
  return {
    sessionId,
    sequence,
    timestamp: `2026-08-14T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    event,
  };
}

describe("buildTranscriptReplayDocument", () => {
  it("replays user, assistant, and tool results verbatim, whitespace included", () => {
    const indentedResult = "  line one\n    line two\n";
    const document = buildTranscriptReplayDocument([
      envelope(1, { type: "user_message", text: "  Fix the banner.  " }),
      envelope(2, { type: "text", text: "\n  I'll inspect ChatSubagentTakeoverBanner." }),
      envelope(3, {
        type: "tool_result",
        tool: "Read",
        result: indentedResult,
        itemId: "tool-1",
      }),
      envelope(4, { type: "user_message", text: "Also align the width." }),
      envelope(5, { type: "text", text: "I'll match --chat-column." }),
    ]);

    expect(document.turnCount).toBe(2);
    expect(document.text).toContain("  Fix the banner.  ");
    expect(document.text).toContain("\n  I'll inspect ChatSubagentTakeoverBanner.");
    expect(document.text).toContain(`[tool result: Read]\n${indentedResult}`);
    expect(document.text).toContain("Also align the width.");
  });

  it("drops whitespace-only events instead of replaying blank turns", () => {
    const document = buildTranscriptReplayDocument([
      envelope(1, { type: "user_message", text: "   " }),
      envelope(2, { type: "text", text: "\n\t " }),
    ]);

    expect(document.turnCount).toBe(0);
    expect(document.text).toBe(document.header);
  });
});

describe("buildTranscriptReplayDocument steer rows", () => {
  type State = NonNullable<Extract<AgentChatEventEnvelope["event"], { type: "user_message" }>["deliveryState"]>;
  // The new model must see a steer exactly when the old one did, and once.
  it.each<[label: string, states: State[], replayed: boolean]>([
    ["inline after accepted", ["accepted", "inline"], true],
    ["delivered as its own turn after a refusal", ["accepted", "queued", "delivered"], true],
    ["processed by Codex", ["accepted", "processed"], true],
    ["failed", ["accepted", "failed"], false],
    ["unprocessed when Codex's turn ended", ["accepted", "unprocessed"], false],
    ["still queued", ["queued"], false],
    ["left accepted with no outcome", ["accepted"], false],
  ])("replays a steer only when it reached the model: %s", (_label, states, replayed) => {
    const document = buildTranscriptReplayDocument([
      envelope(1, { type: "user_message", text: "Start the work." }),
      envelope(2, { type: "text", text: "Working on it." }),
      ...states.map((deliveryState, index) => envelope(3 + index, {
        type: "user_message",
        text: "Steer text.",
        steerId: "steer-1",
        turnId: deliveryState === "delivered" ? "turn-2" : "turn-1",
        deliveryState,
      })),
    ]);

    expect(document.text).toContain("Start the work.");
    expect(document.text.split("Steer text.").length - 1).toBe(replayed ? 1 : 0);
    expect(document.turnCount).toBe(replayed ? 2 : 1);
  });
});

describe("fitTranscriptReplayToBudget", () => {
  it("drops oldest turns first and reports how many were truncated", () => {
    const envelopes = Array.from({ length: 8 }, (_, index) => [
      envelope(index * 2 + 1, { type: "user_message", text: `user-turn-${index} ${"x".repeat(80)}` }),
      envelope(index * 2 + 2, { type: "text", text: `assistant-turn-${index} ${"y".repeat(80)}` }),
    ]).flat();
    const document = buildTranscriptReplayDocument(envelopes);
    const fit = fitTranscriptReplayToBudget(document, 900);
    expect(fit.truncated).toBe(true);
    expect(fit.truncatedTurnCount).toBeGreaterThan(0);
    expect(fit.keptTurnCount).toBeGreaterThan(0);
    expect(fit.keptTurnCount + fit.truncatedTurnCount).toBe(document.turnCount);
    expect(fit.text).toContain(`user-turn-${document.turnCount - 1}`);
    expect(fit.text).not.toContain("user-turn-0");
    expect(fit.text.length).toBeLessThanOrEqual(900);
  });

  it("rejects a newest turn that is larger than the whole budget", () => {
    const document = buildTranscriptReplayDocument([
      envelope(1, { type: "user_message", text: "old turn" }),
      envelope(2, { type: "user_message", text: `huge ${"z".repeat(5_000)}` }),
    ]);
    const budget = document.header.length + 64;
    const fit = fitTranscriptReplayToBudget(document, budget);

    expect(fit.text.length).toBeLessThanOrEqual(budget);
    expect(fit.text).not.toContain("zzz");
    expect(fit.truncated).toBe(true);
    expect(fit.keptTurnCount).toBe(0);
    expect(fit.truncatedTurnCount).toBe(document.turnCount);
  });

  it("returns no replay text when even the header cannot fit", () => {
    const document = buildTranscriptReplayDocument([
      envelope(1, { type: "user_message", text: "anything" }),
    ]);
    const fit = fitTranscriptReplayToBudget(document, 8);

    expect(fit.text).toBe("");
    expect(fit.truncated).toBe(true);
    expect(fit.keptTurnCount).toBe(0);
    expect(fit.truncatedTurnCount).toBe(document.turnCount);
  });
});

describe("replay budget", () => {
  // 60% window cap, a reserve of max(32k, 15%), a 4k floor for tiny windows,
  // and a 128k default for an unknown window — all at 3 chars per token.
  it.each([
    [16_000, 4_000],
    [100_000, 60_000],
    [1_000_000, 600_000],
    [null, 76_800],
    [0, 76_800],
  ])("budgets a %s-token window at %i replay tokens", (window, tokens) => {
    expect(replayBudgetTokens(window)).toBe(tokens);
    expect(estimateReplayTokens("x".repeat(replayBudgetChars(window)))).toBe(tokens);
  });

  it("reserves the larger of 32k tokens and 15% of the window", () => {
    expect(replayReserveTokens(100_000)).toBe(REPLAY_RESERVE_MIN_TOKENS);
    expect(replayReserveTokens(1_000_000)).toBe(150_000);
  });
});

describe("buildFittedTranscriptReplay", () => {
  const CODEX_APP_SERVER_INPUT_MAX_CHARS = 1_048_576;

  it("keeps the full transcript when it fits the target window", () => {
    const envelopes = [
      envelope(1, { type: "user_message", text: "hello" }),
      envelope(2, { type: "text", text: "world" }),
    ];
    const fit = buildFittedTranscriptReplay(envelopes, 1_000_000);
    expect(fit).toMatchObject({ truncated: false, keptTurnCount: 1, truncatedTurnCount: 0 });
    expect(fit.text).toBe(buildTranscriptReplayDocument(envelopes).text);
  });

  it("honors a provider input cap below the model context window", () => {
    const fit = buildFittedTranscriptReplay([
      envelope(1, { type: "user_message", text: `oldest ${"o".repeat(600_000)}` }),
      envelope(2, { type: "user_message", text: `newest ${"n".repeat(600_000)}` }),
    ], 1_000_000, replayMaxCharsForProvider("codex"));

    expect(fit.truncated).toBe(true);
    expect(fit.truncatedTurnCount).toBe(1);
    expect(fit.text).toContain("newest");
    expect(fit.text).not.toContain("oldest");
    expect(fit.text.length).toBeLessThanOrEqual(CODEX_REPLAY_MAX_CHARS);
    expect(fit.text.length).toBeLessThanOrEqual(CODEX_APP_SERVER_INPUT_MAX_CHARS);
  });
});

describe("fitTranscriptReplayTextToBudget", () => {
  it("keeps the newest complete turn when a later prompt consumes the budget", () => {
    const document = buildTranscriptReplayDocument([
      envelope(1, { type: "user_message", text: "oldest" }),
      envelope(2, { type: "user_message", text: "newest" }),
    ]);
    const budget = `${document.header}\n\n[user]\nnewest`.length + 2;
    const text = fitTranscriptReplayTextToBudget(document.text, budget);

    expect(text.length).toBeLessThanOrEqual(budget);
    expect(text).toContain("newest");
    expect(text).not.toContain("oldest");
  });

  it("keeps the beginning of a header-only replay for tiny budgets", () => {
    const headerOnlyReplay = buildTranscriptReplayDocument([]).text;
    const budget = 8;

    expect(fitTranscriptReplayTextToBudget(headerOnlyReplay, budget))
      .toBe(CROSS_PROVIDER_REPLAY_HEADER.slice(0, budget));
  });
});
