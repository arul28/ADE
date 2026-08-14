import { describe, expect, it } from "vitest";

import type { AgentChatEventEnvelope } from "../../../shared/types/chat";
import {
  buildFittedTranscriptReplay,
  buildTranscriptReplayDocument,
  fitTranscriptReplayToBudget,
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
  });
});

describe("buildFittedTranscriptReplay", () => {
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
});
