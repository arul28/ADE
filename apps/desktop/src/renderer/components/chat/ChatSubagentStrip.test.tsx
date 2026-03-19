/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChatSubagentStrip } from "./ChatSubagentStrip";
import type { ChatSubagentSnapshot } from "./chatExecutionSummary";

function renderStrip(snapshot: ChatSubagentSnapshot) {
  const onInterruptTurn = vi.fn();
  render(
    <ChatSubagentStrip
      snapshots={[snapshot]}
      onInterruptTurn={onInterruptTurn}
    />,
  );
  return { onInterruptTurn };
}

describe("ChatSubagentStrip", () => {
  it("shows running progress summaries when they are available", () => {
    renderStrip({
      taskId: "task-1",
      description: "Inspect desktop IPC path",
      status: "running",
      startedAt: "2026-03-10T12:00:00.000Z",
      updatedAt: "2026-03-10T12:00:02.000Z",
      summary: "Traced the send handler and found the blocking await.",
      usage: {
        totalTokens: 800,
        toolUses: 2,
      },
      lastToolName: "functions.exec_command",
    });

    fireEvent.click(screen.getByRole("button", { name: /Inspect desktop IPC path/ }));

    expect(screen.getByText("Traced the send handler and found the blocking await.")).not.toBeNull();
    expect(screen.getByText("Tool functions.exec_command")).not.toBeNull();
  });

  it("falls back to the last tool when live progress text is unavailable", () => {
    renderStrip({
      taskId: "task-2",
      description: "Check Claude warmup lifecycle",
      status: "running",
      startedAt: "2026-03-10T12:00:00.000Z",
      updatedAt: "2026-03-10T12:00:03.000Z",
      summary: null,
      lastToolName: "functions.exec_command",
    });

    fireEvent.click(screen.getByRole("button", { name: /Check Claude warmup lifecycle/ }));

    expect(screen.getByText("Running. Last tool: functions.exec_command.")).not.toBeNull();
  });
});
