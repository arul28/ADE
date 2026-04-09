/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatSubagentsPanel } from "./ChatSubagentsPanel";
import type { ChatSubagentSnapshot } from "./chatExecutionSummary";
import type { AgentChatEventEnvelope } from "../../../shared/types";

afterEach(cleanup);

function renderPanel(snapshots: ChatSubagentSnapshot[], events: AgentChatEventEnvelope[] = []) {
  const onInterruptTurn = vi.fn();
  render(
    <ChatSubagentsPanel
      snapshots={snapshots}
      events={events}
      onInterruptTurn={onInterruptTurn}
    />,
  );
  return { onInterruptTurn };
}

describe("ChatSubagentsPanel", () => {
  it("starts with a compact summary row and expands into task rows", () => {
    renderPanel([
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

    expect(screen.getByText("Subagents")).not.toBeNull();
    expect(screen.queryByText("Inspect desktop IPC path")).toBeNull();

    // Expand the drawer
    fireEvent.click(screen.getByText("Subagents"));

    // Should see agent descriptions in the list
    expect(screen.getByText("Inspect desktop IPC path")).not.toBeNull();
    expect(screen.getByText("Check Claude warmup lifecycle")).not.toBeNull();
  });

  it("navigates to detail view on click and back to list", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        timestamp: "2026-03-10T12:00:00.000Z",
        sessionId: "session-1",
        event: {
          type: "subagent_started",
          taskId: "task-1",
          description: "Inspect desktop IPC path",
        } as any,
      },
      {
        timestamp: "2026-03-10T12:00:01.000Z",
        sessionId: "session-1",
        event: {
          type: "subagent_progress",
          taskId: "task-1",
          summary: "Reading main.ts",
          lastToolName: "Read",
        } as any,
      },
    ];

    renderPanel(
      [
        {
          taskId: "task-1",
          description: "Inspect desktop IPC path",
          status: "running",
          startedAt: "2026-03-10T12:00:00.000Z",
          updatedAt: "2026-03-10T12:00:01.000Z",
          summary: "Reading main.ts",
          lastToolName: "Read",
        },
      ],
      events,
    );

    // Expand
    fireEvent.click(screen.getByText("Subagents"));

    // Click on the subagent to enter detail view
    fireEvent.click(screen.getByText("Inspect desktop IPC path"));

    // Should see back button and timeline
    expect(screen.getByText("Back")).not.toBeNull();
    expect(screen.getByText("Started")).not.toBeNull();
    expect(screen.getByText("Read")).not.toBeNull();
    expect(screen.getByText("Reading main.ts")).not.toBeNull();

    // Click back
    fireEvent.click(screen.getByText("Back"));

    // Should be back in list view
    expect(screen.getByText("Inspect desktop IPC path")).not.toBeNull();
  });
});
