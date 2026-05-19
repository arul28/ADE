/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentChatEventEnvelope } from "../../../shared/types";
import type { ChatSubagentSnapshot } from "./chatExecutionSummary";
import { ChatSubagentsPanel, type SubagentSelection } from "./ChatSubagentsPanel";

vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  },
}));

const baseSnapshot: ChatSubagentSnapshot = {
  taskId: "task-1",
  description: "Audit chat renderer",
  agentType: "code-reviewer",
  status: "running",
  startedAt: "2026-05-12T00:00:00.000Z",
  updatedAt: "2026-05-12T00:00:10.000Z",
  summary: "Inspecting the transcript",
  lastToolName: "rg",
  background: true,
  usage: { durationMs: 10_000, toolUses: 2, totalTokens: 1234 },
};

function buildPlanEvent(): AgentChatEventEnvelope {
  return {
    sessionId: "session-1",
    timestamp: "2026-05-12T00:00:00.000Z",
    event: {
      type: "plan",
      steps: [
        { text: "Map theme plumbing", status: "completed" },
        { text: "Identify glass styling", status: "completed" },
        { text: "Implement appearance mode", status: "in_progress" },
        { text: "Apply glass styling app-wide", status: "pending" },
        { text: "Run focused checks", status: "pending" },
      ],
    },
  } as AgentChatEventEnvelope;
}

describe("ChatSubagentsPanel (pane variant)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the Progress section with bar, counter, and checklist", () => {
    render(
      <ChatSubagentsPanel
        snapshots={[]}
        events={[buildPlanEvent()]}
        variant="pane"
      />,
    );

    expect(screen.getByText("Progress")).toBeTruthy();
    expect(screen.getByText("2/5 · 40%")).toBeTruthy();
    expect(screen.getByText("Map theme plumbing")).toBeTruthy();
    expect(screen.getByText("Implement appearance mode")).toBeTruthy();
    expect(screen.getByText("Run focused checks")).toBeTruthy();
  });

  it("splits foreground subagents and background tasks into separate sections", () => {
    const foregroundSnapshot: ChatSubagentSnapshot = {
      ...baseSnapshot,
      taskId: "task-2",
      description: "Inspect codex flow",
      agentType: "Explore",
      background: false,
    };

    render(
      <ChatSubagentsPanel
        snapshots={[baseSnapshot, foregroundSnapshot]}
        events={[]}
        variant="pane"
      />,
    );

    expect(screen.getByText("Subagents")).toBeTruthy();
    expect(screen.getByText("Background tasks")).toBeTruthy();
    expect(screen.getByText("Explore")).toBeTruthy();
    // Background row gets a "bg" suffix (no parentheses in the redesign).
    expect(screen.getByText("bg")).toBeTruthy();
  });

  it("calls onSelectSubagent with the snapshot identity when a row is clicked", () => {
    const onSelectSubagent = vi.fn<[SubagentSelection], void>();

    render(
      <ChatSubagentsPanel
        snapshots={[baseSnapshot]}
        events={[]}
        variant="pane"
        onSelectSubagent={onSelectSubagent}
      />,
    );

    fireEvent.click(screen.getByTitle("Audit chat renderer"));
    expect(onSelectSubagent).toHaveBeenCalledTimes(1);
    const arg = onSelectSubagent.mock.calls[0]![0];
    expect(arg.taskId).toBe("task-1");
    expect(arg.agentType).toBe("code-reviewer");
    expect(arg.status).toBe("running");
    expect(arg.background).toBe(true);
  });

  it("renders the single-agent empty state when no plan and no subagents are present", () => {
    render(
      <ChatSubagentsPanel snapshots={[]} events={[]} variant="pane" />,
    );

    // The redesign splits the empty state onto two lines.
    expect(
      screen.getByText(/No agent activity for this chat\./i),
    ).toBeTruthy();
    expect(
      screen.getByText(/Single-agent mode\./i),
    ).toBeTruthy();
  });

  it("surfaces an interrupt action when at least one subagent is running", () => {
    const onInterruptTurn = vi.fn();
    render(
      <ChatSubagentsPanel
        snapshots={[baseSnapshot]}
        events={[]}
        variant="pane"
        onInterruptTurn={onInterruptTurn}
      />,
    );

    const stop = screen.getByRole("button", { name: /Stop running agents/i });
    fireEvent.click(stop);
    expect(onInterruptTurn).toHaveBeenCalledTimes(1);
  });
});
