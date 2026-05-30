import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope, PendingInputRequest } from "../../../../desktop/src/shared/types/chat";
import { buildPendingInputAnswers, latestPendingApproval } from "../pendingInput";

const baseRequest: PendingInputRequest = {
  requestId: "req-1",
  source: "codex",
  kind: "structured_question",
  title: "Pick path",
  questions: [{
    id: "path",
    question: "Which path?",
    options: [
      { label: "Recommended", value: "recommended" },
      { label: "Manual", value: "manual" },
    ],
    allowsFreeform: true,
  }],
  allowsFreeform: true,
  blocking: true,
  canProceedWithoutAnswer: false,
};

describe("pendingInput", () => {
  it("maps option numbers to structured answers", () => {
    expect(buildPendingInputAnswers(baseRequest, "2")).toEqual({ path: "manual" });
  });

  it("keeps multi-select answers as arrays", () => {
    const request: PendingInputRequest = {
      ...baseRequest,
      questions: [{
        ...baseRequest.questions[0]!,
        multiSelect: true,
      }],
    };
    expect(buildPendingInputAnswers(request, "1, Manual")).toEqual({ path: ["recommended", "manual"] });
  });

  it("returns the latest unresolved pending input request", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "s1",
        timestamp: "2026-01-01T00:00:00.000Z",
        sequence: 1,
        event: {
          type: "approval_request",
          itemId: "item-1",
          kind: "tool_call",
          description: "Need input",
          detail: { request: { ...baseRequest, itemId: "item-1" } },
        },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T00:00:01.000Z",
        sequence: 2,
        event: {
          type: "pending_input_resolved",
          itemId: "item-1",
          resolution: "accepted",
        },
      },
    ];
    expect(latestPendingApproval(events)).toBeNull();

    events.push({
      sessionId: "s1",
      timestamp: "2026-01-01T00:00:02.000Z",
      sequence: 3,
      event: {
        type: "approval_request",
        itemId: "item-2",
        kind: "tool_call",
        description: "Need input",
        detail: { request: { ...baseRequest, requestId: "req-2", itemId: "item-2" } },
      },
    });
    expect(latestPendingApproval(events)).toEqual(expect.objectContaining({
      itemId: "item-2",
      mode: "question",
      highStakes: false,
    }));
  });

  it("flags destructive or external-impact approvals as high stakes", () => {
    const events: AgentChatEventEnvelope[] = [{
      sessionId: "s1",
      timestamp: "2026-01-01T00:00:00.000Z",
      sequence: 1,
      event: {
        type: "approval_request",
        itemId: "item-1",
        kind: "tool_call",
        description: "Force-push the main branch to production",
        detail: { command: "git push --force origin main" },
      },
    }];

    expect(latestPendingApproval(events)).toEqual(expect.objectContaining({
      itemId: "item-1",
      mode: "approval",
      highStakes: true,
    }));
  });

  it("keeps plan approvals on the one-key approval path", () => {
    const request: PendingInputRequest = {
      ...baseRequest,
      kind: "plan_approval",
      title: "Approve plan",
      questions: [],
      allowsFreeform: false,
    };
    const events: AgentChatEventEnvelope[] = [{
      sessionId: "s1",
      timestamp: "2026-01-01T00:00:00.000Z",
      sequence: 1,
      event: {
        type: "approval_request",
        itemId: "item-plan",
        kind: "tool_call",
        description: "Approve plan",
        detail: { request },
      },
    }];

    expect(latestPendingApproval(events)).toEqual(expect.objectContaining({
      itemId: "item-plan",
      mode: "approval",
      highStakes: false,
    }));
  });
});
