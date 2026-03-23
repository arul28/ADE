/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChatSubagentStrip } from "./ChatSubagentStrip";
import type { ChatSubagentSnapshot } from "./chatExecutionSummary";

function renderStrip(snapshots: ChatSubagentSnapshot[]) {
  const onInterruptTurn = vi.fn();
  render(
    <ChatSubagentStrip
      snapshots={snapshots}
      onInterruptTurn={onInterruptTurn}
    />,
  );
  return { onInterruptTurn };
}

describe("ChatSubagentStrip", () => {
  it("starts with a compact summary row and expands into task rows", () => {
    renderStrip([
      {
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
        background: true,
      },
      {
        taskId: "task-2",
        description: "Check Claude warmup lifecycle",
        status: "completed",
        startedAt: "2026-03-10T12:00:00.000Z",
        updatedAt: "2026-03-10T12:00:03.000Z",
        summary: "Warmup completed cleanly.",
      },
    ]);

    expect(screen.getByText("Background agents")).not.toBeNull();
    expect(screen.getByText("1 bg")).not.toBeNull();
    expect(screen.queryByText("Inspect desktop IPC path")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Background agents/i }));

    fireEvent.click(screen.getByRole("button", { name: /Inspect desktop IPC path/ }));

    expect(screen.getByText("Traced the send handler and found the blocking await.")).not.toBeNull();
    expect(screen.getByText("functions.exec_command")).not.toBeNull();
  });

  it("falls back to the last tool when live progress text is unavailable", () => {
    renderStrip([
      {
        taskId: "task-1",
        description: "Check Claude warmup lifecycle",
        status: "running",
        startedAt: "2026-03-10T12:00:00.000Z",
        updatedAt: "2026-03-10T12:00:03.000Z",
        summary: null,
        lastToolName: "functions.exec_command",
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: /Background agents/i }));
    fireEvent.click(screen.getByRole("button", { name: /Check Claude warmup lifecycle/ }));

    expect(screen.getByText("Running. Last tool: functions.exec_command.")).not.toBeNull();
  });
});
