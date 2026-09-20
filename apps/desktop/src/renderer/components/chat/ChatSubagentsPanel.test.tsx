/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentChatEventEnvelope } from "../../../shared/types";
import { SUBAGENT_CAPABILITIES } from "../../../shared/subagentCapabilities";
import type { ChatScheduledWorkSnapshot, ChatSubagentSnapshot } from "./chatExecutionSummary";
import { ChatSubagentsPanel, type SubagentSelection } from "./ChatSubagentsPanel";
import { deriveChatWorkflowRuns } from "./ChatWorkflowActiveCard";
import { ChatTaskList } from "./ChatTasksPanel";

function scheduledSnapshot(overrides: Partial<ChatScheduledWorkSnapshot>): ChatScheduledWorkSnapshot {
  return {
    id: "sched-1",
    kind: "cron",
    status: "scheduled",
    title: "Scheduled task",
    summary: null,
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
    ...overrides,
  };
}

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
    vi.useRealTimers();
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

  it("opens workflow details from the active card with phases and agent telemetry", () => {
    const workflow: ChatSubagentSnapshot = {
      ...baseSnapshot,
      taskId: "workflow-1",
      description: "Run the review workflow",
      status: "running",
      taskType: "local_workflow",
      workflowName: "CodeReview",
      workflowProgress: {
        phases: [
          { index: 0, title: "Foundation" },
          { index: 1, title: "CodeReview" },
        ],
        agents: [
          {
            key: "agent-1",
            index: 0,
            name: "cloud:security",
            status: "running",
            summary: "CodeReview · running rg",
            agentId: "agent-1",
            agentType: "security",
            phaseTitle: "CodeReview",
            tokens: 4_200,
            toolCalls: 12,
            lastToolName: "rg",
          },
        ],
        queuedCount: 2,
        runningCount: 1,
        doneCount: 3,
        failedCount: 0,
      },
    };
    const workflowAgent: ChatSubagentSnapshot = {
      ...baseSnapshot,
      taskId: "workflow-1::a0",
      agentId: "agent-1",
      description: "cloud:security",
      agentType: "security",
      workflowName: "CodeReview",
      taskType: "subagent",
      parentToolUseId: null,
      status: "running",
      model: "claude-opus-5",
    };
    const stopWorkflow = vi.fn();

    render(
      <ChatSubagentsPanel
        snapshots={[workflow, workflowAgent]}
        events={[]}
        variant="pane"
        onStopSubagent={stopWorkflow}
      />,
    );

    fireEvent.click(screen.getByTestId("chat-workflow-active-card"));

    expect(screen.getByTestId("chat-workflow-details-dialog")).toBeTruthy();
    expect(screen.getByText("Foundation")).toBeTruthy();
    expect(screen.getAllByText("CodeReview").length).toBeGreaterThan(0);
    expect(screen.getAllByText("cloud:security").length).toBeGreaterThan(0);
    expect(screen.getByText("2 agents queued behind the current phase")).toBeTruthy();
    expect(screen.getByText("1,234 total tokens reported by the workflow")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop cloud:security" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop workflow" }));
    expect(stopWorkflow).toHaveBeenCalledWith(workflow);

    fireEvent.keyDown(screen.getByTestId("chat-workflow-details-dialog"), { key: "Escape" });
    expect(screen.queryByTestId("chat-workflow-details-dialog")).toBeNull();
  });

  it("keeps a running workflow duration ticking past a stale provider sample", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T00:00:10.000Z"));
    const workflow: ChatSubagentSnapshot = {
      ...baseSnapshot,
      taskId: "workflow-duration",
      description: "Track workflow duration",
      taskType: "local_workflow",
      workflowName: "Duration check",
      workflowProgress: {
        phases: [],
        agents: [],
        queuedCount: 0,
        runningCount: 0,
        doneCount: 0,
        failedCount: 0,
      },
      // This is an interim provider sample, not the live elapsed duration.
      usage: { durationMs: 1_000, toolUses: 1, totalTokens: 10 },
    };

    render(<ChatSubagentsPanel snapshots={[workflow]} events={[]} variant="pane" />);
    fireEvent.click(screen.getByTestId("chat-workflow-active-card"));
    const dialog = within(screen.getByTestId("chat-workflow-details-dialog"));

    expect(dialog.getByText("10s")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(dialog.getByText("11s")).toBeTruthy();
  });

  it("reveals older workflow runs through the Show all control", () => {
    const workflows = Array.from({ length: 4 }, (_, index): ChatSubagentSnapshot => ({
      ...baseSnapshot,
      taskId: "workflow-" + index,
      description: "Workflow " + index,
      updatedAt: "2026-05-12T00:00:" + String(index).padStart(2, "0") + ".000Z",
      taskType: "local_workflow",
      workflowName: "Workflow " + index,
      workflowProgress: {
        phases: [],
        agents: [{
          key: "workflow-" + index + "::a0",
          index: 0,
          name: "agent-" + index,
          status: "completed",
          summary: "Finished",
        }],
        queuedCount: 0,
        runningCount: 0,
        doneCount: 1,
        failedCount: 0,
      },
    }));

    render(
      <ChatSubagentsPanel
        snapshots={workflows}
        events={[]}
        variant="pane"
      />,
    );

    expect(screen.getAllByTestId("chat-workflow-active-card")).toHaveLength(3);
    fireEvent.click(screen.getByTestId("chat-workflow-show-all"));
    expect(screen.getAllByTestId("chat-workflow-active-card")).toHaveLength(4);
    fireEvent.click(screen.getAllByTestId("chat-workflow-active-card")[0]!);
    expect(screen.getByTestId("chat-workflow-details-dialog")).toBeTruthy();
  });

  it("keeps same-named legacy workflow lineage separate from a rich workflow", () => {
    const richParent: ChatSubagentSnapshot = {
      ...baseSnapshot,
      taskId: "rich-workflow",
      description: "Rich workflow",
      status: "completed",
      taskType: "local_workflow",
      workflowName: "CodeReview",
      workflowProgress: {
        phases: [],
        agents: [],
        queuedCount: 0,
        runningCount: 0,
        doneCount: 0,
        failedCount: 0,
      },
    };
    const legacyParent: ChatSubagentSnapshot = {
      ...baseSnapshot,
      taskId: "legacy-workflow",
      description: "Legacy workflow",
      taskType: "local_workflow",
      workflowName: "CodeReview",
    };
    const legacyAgent = (taskId: string, status: ChatSubagentSnapshot["status"]): ChatSubagentSnapshot => ({
      ...baseSnapshot,
      taskId,
      description: taskId,
      taskType: "subagent",
      workflowName: "CodeReview",
      status,
    });

    const runs = deriveChatWorkflowRuns([
      richParent,
      legacyParent,
      legacyAgent("legacy-workflow::a0", "running"),
      legacyAgent("legacy-workflow::a1", "completed"),
    ]);
    const legacyRun = runs.find((run) => run.id === "workflow:legacy-workflow");

    expect(runs).toHaveLength(2);
    expect(legacyRun).toEqual(expect.objectContaining({
      name: "CodeReview",
      parent: legacyParent,
    }));
    expect(legacyRun?.members.map((member) => member.taskId)).toEqual([
      "legacy-workflow::a0",
      "legacy-workflow::a1",
    ]);
  });

  it("does not promote an orphaned synthetic workflow agent to a stoppable parent", () => {
    const orphanedAgent: ChatSubagentSnapshot = {
      ...baseSnapshot,
      taskId: "review-42::a0",
      description: "cloud:security",
      taskType: "subagent",
      workflowName: "CodeReview",
      status: "running",
    };

    expect(deriveChatWorkflowRuns([orphanedAgent])).toEqual([]);
  });

  it("settles a provider-running workflow row when the parent has ended", () => {
    const workflow: ChatSubagentSnapshot = {
      ...baseSnapshot,
      taskId: "workflow-ended",
      description: "Run the review workflow",
      status: "completed",
      taskType: "local_workflow",
      workflowName: "CodeReview",
      workflowProgress: {
        phases: [{ index: 0, title: "CodeReview" }],
        agents: [{
          key: "workflow-ended::a0",
          index: 0,
          name: "cloud:security",
          status: "running",
          summary: "CodeReview · running rg",
        }],
        queuedCount: 0,
        runningCount: 1,
        doneCount: 0,
        failedCount: 0,
      },
    };
    const workflowAgent: ChatSubagentSnapshot = {
      ...baseSnapshot,
      taskId: "workflow-ended::a0",
      agentId: "workflow-agent-0",
      description: "cloud:security",
      taskType: "subagent",
      parentToolUseId: null,
      workflowName: "CodeReview",
      status: "stopped",
      finalSummary: "Workflow ended before this agent finished.",
    };

    render(
      <ChatSubagentsPanel
        snapshots={[workflow, workflowAgent]}
        events={[]}
        variant="pane"
      />,
    );

    fireEvent.click(screen.getByTestId("chat-workflow-active-card"));

    expect(screen.getByText("0/1 agents complete · 1 stopped")).toBeTruthy();
    expect(screen.getByText("1 stopped when the workflow ended")).toBeTruthy();
    expect(screen.getByText("Workflow ended before this agent finished.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop workflow" })).toBeNull();
  });

  it("merges foreground and background-run agents into one Subagents list with a background chip", () => {
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

    // Both agents live under the single Subagents section now.
    expect(screen.getByText("Subagents")).toBeTruthy();
    expect(screen.getByText("Explore")).toBeTruthy();
    expect(screen.getByTitle("Audit chat renderer")).toBeTruthy();
    // The background-run agent carries an inline "background" chip.
    expect(screen.getByText("background")).toBeTruthy();
    // No command-task Background section without backgroundItems.
    expect(screen.queryByText("Background")).toBeNull();
  });

  it("shows a reported subagent model chip instead of the parent session model", () => {
    render(
      <ChatSubagentsPanel
        snapshots={[{ ...baseSnapshot, background: false, model: "opus" }]}
        events={[]}
        variant="pane"
        sessionModelLabel="Fable 5"
      />,
    );
    expect(screen.getByText(/opus/i)).toBeTruthy();
    expect(screen.queryByText(/inherited/i)).toBeNull();
  });

  it("shows the parent session model as inherited when the envelope has no model", () => {
    render(
      <ChatSubagentsPanel
        snapshots={[{ ...baseSnapshot, background: false, model: null }]}
        events={[]}
        variant="pane"
        sessionModelLabel="Fable 5"
      />,
    );
    expect(screen.getByText(/Fable 5/)).toBeTruthy();
    expect(screen.getByText(/inherited/i)).toBeTruthy();
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

  it("stops a running native subagent without taking over the row", () => {
    const onStopSubagent = vi.fn();
    const onSelectSubagent = vi.fn();
    render(
      <ChatSubagentsPanel
        snapshots={[baseSnapshot]}
        events={[]}
        variant="pane"
        capability={CLAUDE_CAP}
        onSelectSubagent={onSelectSubagent}
        onStopSubagent={onStopSubagent}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stop code-reviewer" }));
    expect(onStopSubagent).toHaveBeenCalledTimes(1);
    expect(onStopSubagent.mock.calls[0]![0].taskId).toBe("task-1");
    expect(onSelectSubagent).not.toHaveBeenCalled();
  });

  it("does not offer per-task stop on a spawned ADE chat row", () => {
    const onStopSubagent = vi.fn();
    render(
      <ChatSubagentsPanel
        snapshots={[{
          ...baseSnapshot,
          taskId: "chat:child-1",
          childSessionId: "child-1",
          description: "Codex Chat",
        }]}
        events={[]}
        variant="pane"
        onStopSubagent={onStopSubagent}
      />,
    );

    expect(screen.queryByRole("button", { name: "Stop Codex Chat" })).toBeNull();
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

    fireEvent.click(screen.getByRole("button", { name: /Completed \(1\)/i }));
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

  it("renders sections in order Subagents → Background → Schedule with chips and labels", () => {
    const foregroundAgent: ChatSubagentSnapshot = {
      ...baseSnapshot,
      taskId: "agent-fg",
      description: "Explore the router",
      agentType: "Explore",
      background: false,
    };
    const backgroundAgent: ChatSubagentSnapshot = {
      ...baseSnapshot,
      taskId: "agent-bg",
      description: "Tail the dev server",
      agentType: "Explore",
      background: true,
    };
    const backgroundItems: ChatScheduledWorkSnapshot[] = [
      scheduledSnapshot({
        id: "bg-run",
        kind: "background_task",
        status: "running",
        title: "cd /x && npx vitest run t",
      }),
      scheduledSnapshot({
        id: "bg-done",
        kind: "background_task",
        status: "completed",
        title: "npm run build",
      }),
    ];
    const scheduleItems: ChatScheduledWorkSnapshot[] = [
      scheduledSnapshot({ id: "cron-1", kind: "cron", status: "scheduled", title: "Nightly sweep", cron: "0 9 * * *" }),
    ];

    const { container } = render(
      <ChatSubagentsPanel
        snapshots={[foregroundAgent, backgroundAgent]}
        events={[]}
        variant="pane"
        backgroundItems={backgroundItems}
        scheduleItems={scheduleItems}
      />,
    );

    // Section headers present and ordered.
    const text = container.textContent ?? "";
    const subagentsIdx = text.indexOf("Subagents");
    const backgroundIdx = text.indexOf("Background");
    const scheduleIdx = text.indexOf("Schedule");
    expect(subagentsIdx).toBeGreaterThanOrEqual(0);
    expect(backgroundIdx).toBeGreaterThan(subagentsIdx);
    expect(scheduleIdx).toBeGreaterThan(backgroundIdx);

    // Both agents in the merged Subagents list; the background one has a chip.
    expect(screen.getByTitle("Explore the router")).toBeTruthy();
    expect(screen.getByTitle("Tail the dev server")).toBeTruthy();
    expect(screen.getByText("background")).toBeTruthy();

    // Background section shows smart labels (cwd stripped from the collapsed row).
    expect(screen.getByText("npx vitest run t")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Completed \(1\)/i }));
    expect(screen.getByText("npm run build")).toBeTruthy();

    // Schedule row present.
    expect(screen.getByText("Nightly sweep")).toBeTruthy();
  });

  it("expands a background command to show the full command and cwd chip", () => {
    render(
      <ChatSubagentsPanel
        snapshots={[]}
        events={[]}
        variant="pane"
        backgroundItems={[
          scheduledSnapshot({
            id: "bg-run",
            kind: "background_task",
            status: "running",
            title: "cd /x && npx vitest run t",
          }),
        ]}
      />,
    );

    // Collapsed: smart label only.
    expect(screen.getByText("npx vitest run t")).toBeTruthy();
    expect(screen.queryByText("/x")).toBeNull();

    fireEvent.click(screen.getByText("npx vitest run t"));

    // Expanded: full command + cwd chip.
    expect(screen.getByText("/x")).toBeTruthy();
    expect(screen.getByText("cd /x && npx vitest run t")).toBeTruthy();
  });

  it("never renders background_task rows in the Schedule section and hides empty sections", () => {
    render(
      <ChatSubagentsPanel
        snapshots={[]}
        events={[]}
        variant="pane"
        scheduleItems={[
          scheduledSnapshot({ id: "cron-1", kind: "cron", status: "scheduled", title: "Nightly" }),
        ]}
      />,
    );

    // Schedule renders; Background + Subagents headers are absent (no rows).
    expect(screen.getByText("Schedule")).toBeTruthy();
    expect(screen.queryByText("Background")).toBeNull();
    expect(screen.queryByText("Subagents")).toBeNull();
  });

  it("pauses and resumes the chat schedule from the Schedule header", () => {
    const onToggleSchedulesPaused = vi.fn();
    const scheduleItems = [
      scheduledSnapshot({ id: "cron-1", kind: "cron", title: "Nightly" }),
    ];
    const { rerender } = render(
      <ChatSubagentsPanel
        snapshots={[]}
        events={[]}
        variant="pane"
        scheduleItems={scheduleItems}
        onToggleSchedulesPaused={onToggleSchedulesPaused}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Pause scheduled work for this chat" }));
    expect(onToggleSchedulesPaused).toHaveBeenCalledTimes(1);

    rerender(
      <ChatSubagentsPanel
        snapshots={[]}
        events={[]}
        variant="pane"
        scheduleItems={scheduleItems}
        schedulesPaused
        onToggleSchedulesPaused={onToggleSchedulesPaused}
      />,
    );
    expect(screen.getByRole("button", { name: "Resume scheduled work for this chat" })).toBeTruthy();
  });

  it("cancels one active schedule from its row", () => {
    const onCancelScheduledWork = vi.fn();
    const item = scheduledSnapshot({ id: "cron-1", kind: "cron", title: "Nightly", cancellable: true });
    render(
      <ChatSubagentsPanel
        snapshots={[]}
        events={[]}
        variant="pane"
        scheduleItems={[item]}
        onCancelScheduledWork={onCancelScheduledWork}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel Nightly" }));
    expect(onCancelScheduledWork).toHaveBeenCalledWith(item);
  });

  it("renders and cancels an action-created providerless schedule", () => {
    const onCancelScheduledWork = vi.fn();
    const item = scheduledSnapshot({
      id: "action:session-1:job-1",
      kind: "cron",
      origin: "action",
      title: "Check CI",
      prompt: "Inspect the latest CI run",
      reason: "Keep the PR moving",
      cron: "*/20 * * * *",
      durable: true,
      cancellable: true,
    });
    render(
      <ChatSubagentsPanel
        snapshots={[]}
        events={[]}
        variant="pane"
        scheduleItems={[item]}
        onCancelScheduledWork={onCancelScheduledWork}
      />,
    );

    expect(screen.getByText("Check CI")).toBeTruthy();
    expect(screen.getByText("cron")).toBeTruthy();
    expect(screen.getByText("*/20 * * * * · Keep the PR moving")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel Check CI" }));
    expect(onCancelScheduledWork).toHaveBeenCalledWith(item);
  });

  it("does not offer ADE cancellation for a provider-only schedule", () => {
    render(
      <ChatSubagentsPanel
        snapshots={[]}
        events={[]}
        variant="pane"
        scheduleItems={[scheduledSnapshot({ id: "cron-native", kind: "cron", title: "Native cron" })]}
        onCancelScheduledWork={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Cancel Native cron" })).toBeNull();
  });

  it("dims active schedule rows and labels them paused when the chat schedule is paused", () => {
    render(
      <ChatSubagentsPanel
        snapshots={[]}
        events={[]}
        variant="pane"
        schedulesPaused
        scheduleItems={[
          scheduledSnapshot({ id: "wake-1", kind: "wakeup", title: "Check PR CI" }),
        ]}
      />,
    );

    const row = screen.getByTitle("Check PR CI");
    expect(row.getAttribute("data-paused")).toBe("true");
    expect(row.className).toContain("opacity-45");
    expect(screen.getByText("paused")).toBeTruthy();
  });

  it("moves fired one-shot wakeups into the collapsed Completed group and marks late fires", () => {
    const firedAt = new Date(2026, 4, 12, 8, 41).toISOString();
    render(
      <ChatSubagentsPanel
        snapshots={[]}
        events={[]}
        variant="pane"
        scheduleItems={[
          scheduledSnapshot({
            id: "wake-recurring",
            kind: "wakeup",
            status: "fired",
            recurring: true,
            title: "Recurring CI check",
          }),
          scheduledSnapshot({
            id: "wake-history-1",
            kind: "wakeup",
            status: "completed",
            title: "Check PR CI",
            firedAt,
            late: true,
          }),
        ]}
      />,
    );

    expect(screen.getByTitle("Recurring CI check")).toBeTruthy();
    const earlierToggle = screen.getByRole("button", { name: "Completed (1)" });
    expect(earlierToggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("✓ Check PR CI · fired 8:41 AM · late")).toBeNull();

    fireEvent.click(earlierToggle);

    expect(earlierToggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("✓ Check PR CI · fired 8:41 AM · late")).toBeTruthy();
    expect(screen.queryByText("done")).toBeNull();
  });

  it("shows a cron's last run and next fire on one timing line", () => {
    const now = new Date(2026, 4, 12, 12, 0);
    vi.spyOn(Date, "now").mockReturnValue(now.getTime());

    render(
      <ChatSubagentsPanel
        snapshots={[]}
        events={[]}
        variant="pane"
        scheduleItems={[
          scheduledSnapshot({
            id: "cron-timing",
            kind: "cron",
            title: "Daily sweep",
            cron: "0 9 * * *",
            lastRunAt: new Date(2026, 4, 12, 9, 0).toISOString(),
            nextRunAt: new Date(2026, 4, 13, 9, 0).toISOString(),
          }),
        ]}
      />,
    );

    expect(screen.getByText("last ran 9:00 AM · next in 21h · 9:00 AM")).toBeTruthy();
  });

  it("does not show a running status for a terminal background command", () => {
    render(
      <ChatSubagentsPanel
        snapshots={[]}
        events={[]}
        variant="pane"
        backgroundItems={[
          scheduledSnapshot({
            id: "bg-done",
            kind: "background_task",
            status: "completed",
            title: "npm run build",
          }),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Completed \(1\)/i }));
    expect(screen.getByText("done")).toBeTruthy();
    expect(screen.queryByText("running")).toBeNull();
  });

  it("keeps live subagent and background durations ticking past one minute", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T00:01:05.000Z"));

    render(
      <ChatSubagentsPanel
        snapshots={[baseSnapshot]}
        events={[]}
        variant="pane"
        backgroundItems={[
          scheduledSnapshot({
            id: "bg-running",
            kind: "background_task",
            status: "running",
            title: "sleep 90",
          }),
        ]}
      />,
    );

    expect(screen.getAllByText("1m 5s")).toHaveLength(2);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(screen.getAllByText("1m 6s")).toHaveLength(2);
  });

  it("keeps the small case free of collapse, Completed, Show all, and Clear chrome", () => {
    render(
      <ChatSubagentsPanel
        snapshots={[baseSnapshot]}
        events={[]}
        variant="pane"
      />,
    );

    expect(screen.queryByRole("button", { name: /Subagents/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Completed/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Show all/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("caps active rows, exempts failed rows, and reveals all rows once", () => {
    const snapshots = Array.from({ length: 14 }, (_, index): ChatSubagentSnapshot => ({
      ...baseSnapshot,
      taskId: `running-${index}`,
      description: `Running ${index}`,
      background: false,
    }));
    snapshots.push({
      ...baseSnapshot,
      taskId: "failed-beyond-cap",
      description: "Failed beyond cap",
      status: "failed",
      background: false,
    });

    render(<ChatSubagentsPanel snapshots={snapshots} events={[]} variant="pane" />);

    expect(screen.getByTitle("Failed beyond cap")).toBeTruthy();
    expect(screen.queryByTitle("Running 13")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show all (2 running)" }));
    expect(screen.getByTitle("Running 13")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show all/i })).toBeNull();
  });

  it("clears and restores Completed rows with the normalized per-session storage shape", () => {
    const sessionId = "pane-persistence";
    window.localStorage.removeItem(`ade.chat.paneUi.v1:${sessionId}`);
    window.localStorage.removeItem(`ade.chat.paneCleared.v1:${sessionId}`);
    const completed = ["done-1", "done-2"].map((taskId): ChatSubagentSnapshot => ({
      ...baseSnapshot,
      taskId,
      description: taskId,
      status: "completed",
      background: false,
    }));

    render(
      <ChatSubagentsPanel
        sessionId={sessionId}
        snapshots={completed}
        events={[]}
        variant="pane"
      />,
    );

    // Clear lives inline on the Completed row, only once the bucket is expanded.
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Completed (2)" }));

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByText("Subagents · all clear")).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem(`ade.chat.paneCleared.v1:${sessionId}`) ?? "null")).toEqual({
      subagents: ["done-1", "done-2"],
      background: [],
      schedule: [],
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Restore (2)" })[0]);
    expect(screen.getByRole("button", { name: "Completed (2)" })).toBeTruthy();
  });

  // A spawned ADE child chat row navigates to that chat instead of taking over
  // the transcript / opening the inline drawer. The click is gated on either a
  // `chat:`-prefixed taskId OR a `spawnKind` (the latter survives the dot-twin
  // that can strip the `chat:` prefix — see chatExecutionSummary preservation).
  describe("spawned-chat row navigation", () => {
    const spawnedChatSnapshot = (overrides: Partial<ChatSubagentSnapshot> = {}): ChatSubagentSnapshot => ({
      taskId: "chat:child-1",
      childSessionId: "child-1",
      agentId: "child-1",
      agentType: "codex",
      description: "Codex Chat",
      status: "running",
      startedAt: "2026-07-18T04:10:54.789Z",
      updatedAt: "2026-07-18T04:10:54.789Z",
      summary: null,
      spawnKind: "subagent",
      ...overrides,
    });

    function withSelectSessionSpy(run: (selectSession: ReturnType<typeof vi.fn>) => void): void {
      const selectSession = vi.fn();
      const listener = (event: Event) => selectSession((event as CustomEvent).detail);
      window.addEventListener("ade:work:select-session", listener);
      try {
        run(selectSession);
      } finally {
        window.removeEventListener("ade:work:select-session", listener);
      }
    }

    it("navigates to the child chat (chat:-prefixed taskId) instead of drawer/takeover", () => {
      withSelectSessionSpy((selectSession) => {
        const onSelectSubagent = vi.fn<[SubagentSelection], void>();
        const probeSubagentTranscript = vi.fn().mockResolvedValue(true);
        render(
          <ChatSubagentsPanel
            sessionId="parent-1"
            snapshots={[spawnedChatSnapshot()]}
            events={[]}
            variant="pane"
            capability={CLAUDE_CAP}
            onSelectSubagent={onSelectSubagent}
            probeSubagentTranscript={probeSubagentTranscript}
          />,
        );

        fireEvent.click(screen.getByTitle("Open the spawned chat"));

        expect(selectSession).toHaveBeenCalledWith({ sessionId: "child-1", laneId: null });
        expect(onSelectSubagent).not.toHaveBeenCalled();
        expect(probeSubagentTranscript).not.toHaveBeenCalled();
        expect(screen.queryByText(/Transcript not ready yet/)).toBeNull();
      });
    });

    it("navigates when the taskId is bare but spawnKind is set (post-dot-twin corruption shape)", () => {
      withSelectSessionSpy((selectSession) => {
        const onSelectSubagent = vi.fn<[SubagentSelection], void>();
        render(
          <ChatSubagentsPanel
            sessionId="parent-1"
            snapshots={[spawnedChatSnapshot({ taskId: "child-1" })]}
            events={[]}
            variant="pane"
            capability={CLAUDE_CAP}
            onSelectSubagent={onSelectSubagent}
          />,
        );

        fireEvent.click(screen.getByTitle("Open the spawned chat"));

        expect(selectSession).toHaveBeenCalledWith({ sessionId: "child-1", laneId: null });
        expect(onSelectSubagent).not.toHaveBeenCalled();
        expect(screen.queryByText(/Transcript not ready yet/)).toBeNull();
      });
    });

    it("shows the resolved live chat title instead of the runtime agentType", () => {
      render(
        <ChatSubagentsPanel
          sessionId="parent-1"
          snapshots={[spawnedChatSnapshot()]}
          events={[]}
          variant="pane"
          capability={CLAUDE_CAP}
          resolveSpawnedChatTitle={(id) => (id === "child-1" ? "Investigate flaky CI" : null)}
        />,
      );

      // Resolved title is the row label; the runtime name stays as the small chip.
      expect(screen.getByText("Investigate flaky CI")).toBeTruthy();
      expect(screen.getByText("codex")).toBeTruthy();
    });

    it("falls back to the snapshot description when no live title resolves", () => {
      render(
        <ChatSubagentsPanel
          sessionId="parent-1"
          snapshots={[spawnedChatSnapshot()]}
          events={[]}
          variant="pane"
          capability={CLAUDE_CAP}
          resolveSpawnedChatTitle={() => null}
        />,
      );

      expect(screen.getByText("Codex Chat")).toBeTruthy();
      expect(screen.getByText("codex")).toBeTruthy();
    });
  });

  it("owns the pane scroller and uses sticky opaque section headers", () => {
    render(<ChatSubagentsPanel snapshots={[baseSnapshot]} events={[]} variant="pane" />);

    const scroller = screen.getByTestId("chat-subagents-pane-scroll");
    expect(scroller.className).toContain("overflow-y-auto");
    const header = screen.getByText("Subagents").closest("div");
    expect(header?.className).toContain("sticky");
    expect(header?.className).toContain("--work-sidebar-bg");
  });

  it("indents nested agents with connector glyphs and a collapsible files-returned row", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const parent: ChatSubagentSnapshot = {
      ...baseSnapshot,
      taskId: "root",
      agentId: "root",
      description: "typecheck desktop",
      background: false,
    };
    const child: ChatSubagentSnapshot = {
      ...baseSnapshot,
      taskId: "child",
      agentId: "child",
      parentAgentId: "root",
      description: "explore chat tests",
      background: false,
      spawnDepth: 1,
      resourceLinks: [{ path: "apps/desktop/src/foo.ts" }, { path: "apps/desktop/src/bar.ts" }],
    };

    render(
      <ChatSubagentsPanel
        snapshots={[parent, child]}
        events={[]}
        variant="pane"
      />,
    );

    expect(screen.getByText(/└/)).toBeTruthy();
    expect(screen.getByText("2 files returned")).toBeTruthy();
    expect(screen.queryByText("apps/desktop/src/foo.ts")).toBeNull();

    fireEvent.click(screen.getByText("2 files returned"));
    expect(screen.getByText("apps/desktop/src/foo.ts")).toBeTruthy();
    expect(screen.getByText("apps/desktop/src/bar.ts")).toBeTruthy();

    fireEvent.click(screen.getByTitle("Copy all paths"));
    expect(writeText).toHaveBeenCalledWith("apps/desktop/src/foo.ts\napps/desktop/src/bar.ts");
  });

  it("keeps the expand caret as a sibling button, not nested inside the row", () => {
    const parent: ChatSubagentSnapshot = {
      ...baseSnapshot,
      taskId: "parent",
      agentId: "parent",
      description: "Finished parent",
      status: "completed",
      background: false,
    };
    const child: ChatSubagentSnapshot = {
      ...baseSnapshot,
      taskId: "child",
      agentId: "child",
      parentAgentId: "parent",
      description: "Finished child",
      status: "completed",
      background: false,
    };

    render(
      <ChatSubagentsPanel
        snapshots={[parent, child]}
        events={[]}
        variant="pane"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Completed (1)" }));
    const caret = screen.getByRole("button", { name: "Show nested agents" });
    const row = screen.getByTitle("Finished parent");
    expect(caret.tagName).toBe("BUTTON");
    expect(row.tagName).toBe("BUTTON");
    expect(row.contains(caret)).toBe(false);
    expect(screen.queryByTitle("Finished child")).toBeNull();
  });

  it("keeps a selected finished descendant visible while auto-collapsing the rest", () => {
    const parent: ChatSubagentSnapshot = {
      ...baseSnapshot,
      taskId: "parent",
      agentId: "parent",
      description: "Finished parent",
      status: "completed",
      background: false,
    };
    const child: ChatSubagentSnapshot = {
      ...baseSnapshot,
      taskId: "child",
      agentId: "child",
      parentAgentId: "parent",
      description: "Finished child",
      status: "completed",
      background: false,
    };

    render(
      <ChatSubagentsPanel
        snapshots={[parent, child]}
        events={[]}
        variant="pane"
        selectedTaskId="child"
      />,
    );

    expect(screen.getByTitle("Finished child")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show nested agents" })).toBeNull();
  });
});

/**
 * The 17-24 hour "running" rows: the SDK emits no terminal event for a
 * subagent or a background command when the parent process exits, so the pane
 * has to stop believing the stream once the host says the runtime is gone.
 */
describe("ChatSubagentsPanel stale-run self-heal", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const orphanAgent: ChatSubagentSnapshot = {
    ...baseSnapshot,
    taskId: "orphan-1",
    description: "Audit chat renderer",
    summary: null,
    background: false,
    status: "running",
  };

  it("still says running while the host reports a live runtime", () => {
    render(
      <ChatSubagentsPanel
        snapshots={[orphanAgent]}
        backgroundItems={[scheduledSnapshot({ id: "bg-1", kind: "background_task", status: "running", title: "npm run dev" })]}
        events={[]}
        variant="pane"
        runtimeAlive
      />,
    );

    expect(screen.getAllByText("running").length).toBeGreaterThan(0);
  });

  it("renders a dead-runtime subagent row as halted with the plain reason, never running", () => {
    render(
      <ChatSubagentsPanel
        snapshots={[orphanAgent]}
        events={[]}
        variant="pane"
        runtimeAlive={false}
      />,
    );

    expect(screen.queryByText("running")).toBeNull();
    // Terminal rows file under the section's Earlier group, like every other
    // settled row — the point is that nothing claims to be running any more.
    fireEvent.click(screen.getByRole("button", { name: "Completed (1)" }));
    expect(screen.getByText("halted")).toBeTruthy();
    // ...and the row keeps its age frozen at the last thing it reported,
    // instead of a counter that had been climbing for 17 hours.
    expect(screen.getByText("10s")).toBeTruthy();
  });

  it("renders a dead-runtime background command as stopped, never running", () => {
    render(
      <ChatSubagentsPanel
        snapshots={[]}
        backgroundItems={[scheduledSnapshot({ id: "bg-1", kind: "background_task", status: "running", title: "npm run dev" })]}
        events={[]}
        variant="pane"
        runtimeAlive={false}
      />,
    );

    expect(screen.queryByText("running")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Completed (1)" }));
    expect(screen.getByText("stopped")).toBeTruthy();
  });

  it("keeps a delegate running when its own subagent chat is still active", () => {
    render(
      <ChatSubagentsPanel
        snapshots={[{ ...orphanAgent, taskId: "chat:child-1", childSessionId: "child-1" }]}
        events={[]}
        variant="pane"
        runtimeAlive={false}
        childChatStatuses={new Map([["child-1", "active" as const]])}
      />,
    );

    expect(screen.getByText("running")).toBeTruthy();
  });

  // A delegate reads "idle" for the seconds its own runtime takes to launch, so
  // an idle child while the parent is alive is not evidence that it stopped.
  it("keeps a just-spawned idle delegate running while the parent runtime is alive", () => {
    render(
      <ChatSubagentsPanel
        snapshots={[{ ...orphanAgent, taskId: "chat:child-1", childSessionId: "child-1" }]}
        events={[]}
        variant="pane"
        runtimeAlive
        childChatStatuses={new Map([["child-1", "idle" as const]])}
      />,
    );

    expect(screen.getByText("running")).toBeTruthy();
  });

  it("halts a delegate whose subagent chat ended, even with the parent runtime alive", () => {
    render(
      <ChatSubagentsPanel
        snapshots={[{ ...orphanAgent, taskId: "chat:child-1", childSessionId: "child-1" }]}
        events={[]}
        variant="pane"
        runtimeAlive
        childChatStatuses={new Map([["child-1", "ended" as const]])}
      />,
    );

    expect(screen.queryByText("running")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Completed (1)" }));
    expect(screen.getByText("halted")).toBeTruthy();
  });
});
