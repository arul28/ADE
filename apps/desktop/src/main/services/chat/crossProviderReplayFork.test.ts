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
  it("replays user, assistant, and tool results verbatim without summarizing", () => {
    const document = buildTranscriptReplayDocument([
      envelope(1, { type: "user_message", text: "Fix the banner." }),
      envelope(2, { type: "text", text: "I'll inspect ChatSubagentTakeoverBanner." }),
      envelope(3, {
        type: "tool_result",
        tool: "Read",
        result: "export function ChatSubagentTakeoverBanner",
        itemId: "tool-1",
      }),
      envelope(4, { type: "user_message", text: "Also align the width." }),
      envelope(5, { type: "text", text: "I'll match --chat-column." }),
    ]);

    expect(document.turnCount).toBe(2);
    expect(document.text).toContain("Fix the banner.");
    expect(document.text).toContain("I'll inspect ChatSubagentTakeoverBanner.");
    expect(document.text).toContain("[tool result: Read]");
    expect(document.text).toContain("export function ChatSubagentTakeoverBanner");
    expect(document.text).toContain("Also align the width.");
    expect(document.text).not.toMatch(/\bsummariz(?:e|ed|ing)\b/i);
  });

  it("regression: preserves leading and trailing whitespace in replayed text and tool results", () => {
    const indentedResult = "  line one\n    line two\n";
    const document = buildTranscriptReplayDocument([
      envelope(1, { type: "user_message", text: "  keep my indentation  " }),
      envelope(2, { type: "text", text: "\n  reply with leading newline" }),
      envelope(3, {
        type: "tool_result",
        tool: "Read",
        result: indentedResult,
        itemId: "tool-1",
      }),
    ]);

    expect(document.text).toContain("  keep my indentation  ");
    expect(document.text).toContain("\n  reply with leading newline");
    expect(document.text).toContain(`[tool result: Read]\n${indentedResult}`);
  });

  it("regression: drops whitespace-only events instead of replaying blank turns", () => {
    const document = buildTranscriptReplayDocument([
      envelope(1, { type: "user_message", text: "   " }),
      envelope(2, { type: "text", text: "\n\t " }),
    ]);

    expect(document.turnCount).toBe(0);
    expect(document.text).toBe(document.header);
  });
});

describe("fitTranscriptReplayToBudget", () => {
  it("keeps the full transcript when it fits", () => {
    const document = buildTranscriptReplayDocument([
      envelope(1, { type: "user_message", text: "one" }),
      envelope(2, { type: "text", text: "two" }),
    ]);
    const fit = fitTranscriptReplayToBudget(document, 10_000);
    expect(fit.truncated).toBe(false);
    expect(fit.truncatedTurnCount).toBe(0);
    expect(fit.text).toBe(document.text);
  });

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

  it("regression: rejects a newest turn that is larger than the whole budget", () => {
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

  it("regression: returns no replay text when even the header cannot fit", () => {
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

describe("buildFittedTranscriptReplay", () => {
  const CODEX_APP_SERVER_INPUT_MAX_CHARS = 1_048_576;

  it("uses the target context window to decide truncation", () => {
    expect(replayBudgetChars(16_000)).toBeLessThan(replayBudgetChars(200_000));
    const envelopes = [
      envelope(1, { type: "user_message", text: "hello" }),
      envelope(2, { type: "text", text: "world" }),
    ];
    const fit = buildFittedTranscriptReplay(envelopes, 1_000_000);
    expect(fit.truncated).toBe(false);
    expect(fit.keptTurnCount).toBe(1);
  });

  it("regression: honors a provider input cap below the model context window", () => {
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
