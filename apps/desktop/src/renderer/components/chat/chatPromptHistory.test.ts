import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope } from "../../../shared/types";
import { collectAgentChatPromptHistory, promptHistoryEventKey } from "./chatPromptHistory";

function userMessage(
  sessionId: string,
  timestamp: string,
  text: string,
  event: Partial<Extract<AgentChatEventEnvelope["event"], { type: "user_message" }>> = {},
): AgentChatEventEnvelope {
  return {
    sessionId,
    timestamp,
    event: {
      ...event,
      type: "user_message",
      text,
      deliveryState: event.deliveryState ?? "delivered",
    },
  };
}

describe("chat prompt history", () => {
  it("collects only the visible prompts in the selected transcript", () => {
    const selectedChatEvents: AgentChatEventEnvelope[] = [
      userMessage("selected", "2026-08-10T10:00:00.000Z", "First prompt"),
      userMessage("selected", "2026-08-10T10:00:01.000Z", "internal prompt", {
        metadata: { hideFullPrompt: true },
      }),
      userMessage("selected", "2026-08-10T10:00:02.000Z", "queued steer", {
        deliveryState: "queued",
        steerId: "steer-1",
      }),
      userMessage("selected", "2026-08-10T10:00:03.000Z", "full prompt", {
        metadata: { hideFullPrompt: true },
        displayText: "Visible handoff brief",
      }),
    ];

    expect(collectAgentChatPromptHistory(selectedChatEvents).map((entry) => entry.text)).toEqual([
      "First prompt",
      "Visible handoff brief",
    ]);
    expect(collectAgentChatPromptHistory([
      userMessage("other-chat", "2026-08-10T11:00:00.000Z", "Other chat prompt"),
    ]).map((entry) => entry.text)).toEqual(["Other chat prompt"]);
  });

  it("keeps the jump identity when transcript rendering adds display metadata", () => {
    const original = userMessage("selected", "2026-08-10T10:00:00.000Z", "A steer", {
      steerId: "steer-1",
      deliveryState: "unprocessed",
    });
    if (original.event.type !== "user_message") throw new Error("test event must be a user message");
    const originalEvent = original.event;
    const decorated: typeof originalEvent = {
      ...originalEvent,
      metadata: {
        ...(originalEvent.metadata ?? {}),
        unprocessedMessageResolution: {
          action: "run_next" as const,
          state: "completed" as const,
          resolvedAt: "2026-08-10T10:01:00.000Z",
        },
      },
    };

    expect(promptHistoryEventKey({ timestamp: original.timestamp, event: originalEvent }))
      .toBe(promptHistoryEventKey({ timestamp: original.timestamp, event: decorated }));
  });
});
