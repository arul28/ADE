/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorChatMessage } from "../../../shared/types";
import { MissionThreadMessageList } from "./MissionThreadMessageList";

function message(overrides: Partial<OrchestratorChatMessage>): OrchestratorChatMessage {
  return {
    id: overrides.id ?? "msg-1",
    missionId: overrides.missionId ?? "mission-1",
    role: overrides.role ?? "worker",
    content: overrides.content ?? "",
    timestamp: overrides.timestamp ?? "2026-03-06T12:00:00.000Z",
    metadata: overrides.metadata ?? null,
    threadId: overrides.threadId ?? "worker:mission-1:attempt-1",
    attemptId: overrides.attemptId ?? "attempt-1",
    sourceSessionId: overrides.sourceSessionId ?? "session-1",
    runId: overrides.runId ?? "run-1",
    laneId: overrides.laneId ?? "lane-1",
    stepKey: overrides.stepKey ?? "implement-test-tab",
    target: overrides.target,
    visibility: overrides.visibility,
    deliveryState: overrides.deliveryState,
  };
}

describe("MissionThreadMessageList", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders mission thread messages through the shared agent chat renderer", () => {
    render(
      <MissionThreadMessageList
        messages={[
          message({
            role: "user",
            content: "Check on the worker.",
            timestamp: "2026-03-06T12:00:00.000Z",
          }),
          message({
            id: "tool-msg",
            content: "Tool call: Read",
            timestamp: "2026-03-06T12:00:01.000Z",
            metadata: {
              structuredStream: {
                kind: "tool",
                sessionId: "worker-session",
                turnId: "turn-1",
                itemId: "tool-1",
                tool: "Read",
                args: { path: "apps/desktop/src/main/main.ts" },
                result: { ok: true },
                status: "completed",
              },
            },
          }),
        ]}
      />
    );

    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getByText("Check on the worker.")).toBeTruthy();
    expect(screen.getAllByText("Read")).toHaveLength(1);
    expect(screen.getByText(/completed/i)).toBeTruthy();
  });

  it("routes approval actions through the mission chat approval handler", () => {
    const onApproval = vi.fn();

    render(
      <MissionThreadMessageList
        messages={[
          message({
            id: "approval-msg",
            content: "Approval required",
            metadata: {
              structuredStream: {
                kind: "approval_request",
                sessionId: "worker-session",
                turnId: "turn-2",
                itemId: "approval-1",
                requestKind: "command",
                description: "Run command: printf approved",
                detail: { command: "printf approved" },
              },
            },
          }),
        ]}
        onApproval={onApproval}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));

    expect(onApproval).toHaveBeenCalledWith("worker-session", "approval-1", "accept", undefined);
  });

  it("submits ask-user answers through the mission chat question modal", () => {
    const onApproval = vi.fn();

    render(
      <MissionThreadMessageList
        messages={[
          message({
            id: "question-msg",
            content: "Need input",
            metadata: {
              structuredStream: {
                kind: "approval_request",
                sessionId: "worker-session",
                turnId: "turn-3",
                itemId: "approval-ask-user",
                requestKind: "tool_call",
                description: "Which environment should I use?",
                detail: {
                  tool: "askUser",
                  question: "Which environment should I use?",
                },
              },
            },
          }),
        ]}
        onApproval={onApproval}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("Type the answer you want the agent to follow..."), {
      target: { value: "Use staging." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Send Answer/i }));

    expect(onApproval).toHaveBeenCalledWith("worker-session", "approval-ask-user", "accept", "Use staging.");
  });
});
