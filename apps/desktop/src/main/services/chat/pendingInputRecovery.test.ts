import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope, PendingInputRequest } from "../../../shared/types/chat";
import { isQuestionShapedPendingInput, readPendingInputRecord } from "./pendingInputRecovery";

const question = (overrides: Partial<PendingInputRequest> = {}): PendingInputRequest => ({
  requestId: "req-1",
  itemId: "item-1",
  source: "opencode",
  kind: "question",
  questions: [{ id: "q1", question: "Which branch?" }],
  allowsFreeform: true,
  blocking: true,
  canProceedWithoutAnswer: false,
  ...overrides,
});

let sequence = 0;
function envelope(event: AgentChatEventEnvelope["event"]): AgentChatEventEnvelope {
  sequence += 1;
  return { sessionId: "chat-1", timestamp: `2026-09-23T00:00:${String(sequence).padStart(2, "0")}Z`, event } as AgentChatEventEnvelope;
}

function asked(itemId: string, request: unknown): AgentChatEventEnvelope {
  return envelope({
    type: "approval_request",
    itemId,
    kind: "tool_call",
    description: "A question",
    detail: { request },
  } as AgentChatEventEnvelope["event"]);
}

function resolved(itemId: string, resolution: "accepted" | "declined" | "cancelled"): AgentChatEventEnvelope {
  return envelope({ type: "pending_input_resolved", itemId, resolution } as AgentChatEventEnvelope["event"]);
}

describe("readPendingInputRecord", () => {
  it("reads the card and its receipt, matched by the request's own item id", () => {
    const record = readPendingInputRecord([
      asked("tool-call-9", question()),
      asked("item-2", question({ requestId: "req-2", itemId: "item-2" })),
      resolved("item-1", "accepted"),
    ], "item-1");

    expect(record.request?.requestId).toBe("req-1");
    expect(record.resolvedAs).toBe("accepted");
  });

  it("lets a re-raised card supersede its own earlier receipt", () => {
    const record = readPendingInputRecord([
      asked("item-1", question()),
      resolved("item-1", "cancelled"),
      asked("item-1", question({ requestId: "req-1b", description: "Asked again" })),
    ], "item-1");

    expect(record.request?.requestId).toBe("req-1b");
    expect(record.resolvedAs).toBeNull();
  });

  it("drops a request record that is not a pending-input request instead of casting it", () => {
    const record = readPendingInputRecord([
      asked("item-1", { itemId: "item-1", kind: "question" }),
    ], "item-1");

    expect(record.request).toBeNull();
  });

  it("finds nothing for a card the transcript never held", () => {
    expect(readPendingInputRecord([asked("item-1", question())], "item-404")).toEqual({
      request: null,
      resolvedAs: null,
    });
  });
});

describe("isQuestionShapedPendingInput", () => {
  it("accepts questions and structured questions", () => {
    expect(isQuestionShapedPendingInput(question())).toBe(true);
    expect(isQuestionShapedPendingInput(question({ kind: "structured_question" }))).toBe(true);
  });

  it("refuses approvals, a missing request, and any card with a secret question", () => {
    expect(isQuestionShapedPendingInput(question({ kind: "approval" }))).toBe(false);
    expect(isQuestionShapedPendingInput(null)).toBe(false);
    expect(isQuestionShapedPendingInput(question({
      questions: [
        { id: "q1", question: "Which branch?" },
        { id: "q2", question: "API key?", isSecret: true },
      ],
    }))).toBe(false);
  });
});
