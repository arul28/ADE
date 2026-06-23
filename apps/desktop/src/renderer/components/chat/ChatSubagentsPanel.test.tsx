/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentChatEventEnvelope } from "../../../shared/types";
import { SUBAGENT_CAPABILITIES } from "../../../shared/subagentCapabilities";
import type { ChatSubagentSnapshot } from "./chatExecutionSummary";
import { ChatSubagentsPanel, type SubagentSelection } from "./ChatSubagentsPanel";
import { ChatTaskList } from "./ChatTasksPanel";

// Real per-runtime descriptors so the tests exercise the actual capability
// matrix: codex = takeover + immediate-for-running; claude = takeover via probe;
// cursor = drawer-only (no transcript, no probe, never takeover).
const CODEX_CAP = SUBAGENT_CAPABILITIES.codex;
const CLAUDE_CAP = SUBAGENT_CAPABILITIES.claude;
const CURSOR_CAP = SUBAGENT_CAPABILITIES.cursor;

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
    expect(screen.getByText("Background")).toBeTruthy();
    expect(screen.getByText("Explore")).toBeTruthy();
    expect(screen.getByTitle("Audit chat renderer")).toBeTruthy();
  });

  it("takes over the chat with the snapshot identity when the agent has a pullable transcript", async () => {
    const onSelectSubagent = vi.fn<[SubagentSelection], void>();
    const probeSubagentTranscript = vi.fn().mockResolvedValue(true);

    render(
      <ChatSubagentsPanel
        snapshots={[baseSnapshot]}
        events={[]}
        variant="pane"
        capability={CLAUDE_CAP}
        onSelectSubagent={onSelectSubagent}
        probeSubagentTranscript={probeSubagentTranscript}
      />,
    );

    fireEvent.click(screen.getByTitle("Audit chat renderer"));

    await waitFor(() => expect(onSelectSubagent).toHaveBeenCalledTimes(1));
    expect(probeSubagentTranscript).toHaveBeenCalledWith({ taskId: "task-1", agentId: null });
    const arg = onSelectSubagent.mock.calls[0]![0];
    expect(arg.taskId).toBe("task-1");
    expect(arg.agentType).toBe("code-reviewer");
    expect(arg.status).toBe("running");
    expect(arg.background).toBe(true);
  });

  it("takes over immediately without probing for running agents on a rich-metadata runtime (codex)", () => {
    const onSelectSubagent = vi.fn<[SubagentSelection], void>();
    const probeSubagentTranscript = vi.fn().mockResolvedValue(false);

    render(
      <ChatSubagentsPanel
        snapshots={[baseSnapshot]}
        events={[]}
        variant="pane"
        capability={CODEX_CAP}
        onSelectSubagent={onSelectSubagent}
        probeSubagentTranscript={probeSubagentTranscript}
      />,
    );

    fireEvent.click(screen.getByTitle("Audit chat renderer"));

    expect(probeSubagentTranscript).not.toHaveBeenCalled();
    expect(onSelectSubagent).toHaveBeenCalledTimes(1);
    expect(onSelectSubagent.mock.calls[0]![0]).toMatchObject({
      taskId: "task-1",
      agentType: "code-reviewer",
      status: "running",
      background: true,
    });
  });

  it("probes completed live subagents before takeover so old empty transcripts stay inline", async () => {
    const onSelectSubagent = vi.fn<[SubagentSelection], void>();
    const probeSubagentTranscript = vi.fn().mockResolvedValue(false);
    const completedSnapshot: ChatSubagentSnapshot = {
      ...baseSnapshot,
      status: "completed",
      background: false,
    };

    render(
      <ChatSubagentsPanel
        snapshots={[completedSnapshot]}
        events={[]}
        variant="pane"
        capability={CODEX_CAP}
        onSelectSubagent={onSelectSubagent}
        probeSubagentTranscript={probeSubagentTranscript}
      />,
    );

    fireEvent.click(screen.getByTitle("Audit chat renderer"));

    await waitFor(() => expect(probeSubagentTranscript).toHaveBeenCalledTimes(1));
    expect(onSelectSubagent).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/No transcript recorded for this agent\./i),
    ).toBeTruthy();
  });

  it("clears the selected subagent when the selected row is clicked again", () => {
    const onSelectSubagent = vi.fn<[SubagentSelection], void>();
    const onClearSelectedSubagent = vi.fn();
    const probeSubagentTranscript = vi.fn().mockResolvedValue(false);

    render(
      <ChatSubagentsPanel
        snapshots={[baseSnapshot]}
        events={[]}
        variant="pane"
        selectedTaskId="task-1"
        capability={CODEX_CAP}
        onSelectSubagent={onSelectSubagent}
        onClearSelectedSubagent={onClearSelectedSubagent}
        probeSubagentTranscript={probeSubagentTranscript}
      />,
    );

    fireEvent.click(screen.getByTitle("Audit chat renderer"));

    expect(onClearSelectedSubagent).toHaveBeenCalledTimes(1);
    expect(onSelectSubagent).not.toHaveBeenCalled();
    expect(probeSubagentTranscript).not.toHaveBeenCalled();
  });

  it("opens an inline details drawer (no takeover) when a transcript-capable runtime has nothing to pull yet", async () => {
    const onSelectSubagent = vi.fn<[SubagentSelection], void>();
    const probeSubagentTranscript = vi.fn().mockResolvedValue(false);

    render(
      <ChatSubagentsPanel
        snapshots={[baseSnapshot]}
        events={[]}
        variant="pane"
        capability={CLAUDE_CAP}
        onSelectSubagent={onSelectSubagent}
        probeSubagentTranscript={probeSubagentTranscript}
      />,
    );

    fireEvent.click(screen.getByTitle("Audit chat renderer"));

    // baseSnapshot is still running → the capable-runtime footer says the
    // transcript can still appear on a later poll.
    expect(
      await screen.findByText(/Transcript not ready yet\./i),
    ).toBeTruthy();
    expect(onSelectSubagent).not.toHaveBeenCalled();
  });

  it("never probes or takes over for a runtime with no transcript capability (cursor)", async () => {
    const onSelectSubagent = vi.fn<[SubagentSelection], void>();
    const probeSubagentTranscript = vi.fn().mockResolvedValue(true);

    render(
      <ChatSubagentsPanel
        snapshots={[baseSnapshot]}
        events={[]}
        variant="pane"
        capability={CURSOR_CAP}
        onSelectSubagent={onSelectSubagent}
        probeSubagentTranscript={probeSubagentTranscript}
      />,
    );

    fireEvent.click(screen.getByTitle("Audit chat renderer"));

    // Drawer opens immediately; the transcript probe is never even attempted,
    // and the chat is never taken over.
    expect(
      await screen.findByText(/Live details only/i),
    ).toBeTruthy();
    expect(probeSubagentTranscript).not.toHaveBeenCalled();
    expect(onSelectSubagent).not.toHaveBeenCalled();
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

  it("renders task snapshots in the agents pane even when no subagents exist", () => {
    render(
      <ChatSubagentsPanel
        snapshots={[]}
        events={[]}
        variant="pane"
        todoItems={[
          { id: "todo-1", description: "Inspect model catalog", status: "completed" },
          { id: "todo-2", description: "Wire task pane", status: "in_progress" },
          { id: "todo-3", description: "Run focused checks", status: "pending" },
        ]}
      />,
    );

    expect(screen.getByText("Tasks")).toBeTruthy();
    expect(screen.getByText("1/3 complete · 1 active")).toBeTruthy();
    expect(screen.getByText("Wire task pane")).toBeTruthy();
    expect(screen.getByText("Run focused checks")).toBeTruthy();
    expect(screen.queryByText(/No agent activity/i)).toBeNull();
  });

  it("preserves task order within each status group", () => {
    const { container } = render(
      <ChatTaskList
        items={[
          { id: "todo-1", description: "Write docs", status: "pending" },
          { id: "todo-2", description: "Audit API", status: "pending" },
          { id: "todo-3", description: "Ship old item", status: "completed" },
          { id: "todo-4", description: "Implement fix", status: "in_progress" },
        ]}
      />,
    );

    const rows = Array.from(container.querySelectorAll(".ade-chat-task-row"))
      .map((row) => row.textContent?.trim());
    expect(rows).toEqual([
      "Implement fix",
      "Write docs",
      "Audit API",
      "Ship old item",
    ]);
  });

  it("toggles the inline drawer closed on a second click of the same row", async () => {
    const probeSubagentTranscript = vi.fn().mockResolvedValue(false);
    render(
      <ChatSubagentsPanel
        snapshots={[baseSnapshot]}
        events={[]}
        variant="pane"
        capability={CURSOR_CAP}
        probeSubagentTranscript={probeSubagentTranscript}
      />,
    );

    const row = screen.getByTitle("Audit chat renderer");
    fireEvent.click(row);
    expect(
      await screen.findByText(/Live details only/i),
    ).toBeTruthy();

    // Second click closes the drawer.
    fireEvent.click(row);
    await waitFor(() =>
      expect(screen.queryByText(/Live details only/i)).toBeNull(),
    );
  });
});
