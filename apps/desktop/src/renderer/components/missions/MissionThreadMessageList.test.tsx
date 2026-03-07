/* @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
});
