import { describe, expect, it } from "vitest";
import type { AgentChatEvent, AgentChatEventEnvelope } from "./types/chat";
import {
  buildSubagentPaneRows,
  groupPaneSectionItems,
  isEarlierSubagentSnapshot,
  deriveSubagentTimelineRows,
  isBackgroundShellCommand,
  isNonAgentTaskRun,
  isRealSubagent,
  preferSubagentSummary,
  subagentActivitySummaryFromEvents,
  subagentAgentKey,
  subagentIndexForPaneLine,
  subagentSnapshotsFromEvents,
  type SubagentSnapshot,
} from "./chatSubagents";

function paneSnapshot(id: string, status: SubagentSnapshot["status"], overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
  return {
    id,
    name: id,
    kind: "subagent",
    status,
    summary: id,
    ...overrides,
  };
}

describe("chat pane scalability helpers", () => {
  it("keeps a child active after its parent turn ends until the child emits a result", () => {
    const parentDoneEvents: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-07-13T12:00:00.000Z",
        event: {
          type: "subagent_started",
          taskId: "child-1",
          description: "Inspect provider lifecycle",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-07-13T12:00:01.000Z",
        event: {
          type: "done",
          turnId: "turn-1",
          status: "completed",
        },
      },
    ];

    expect(subagentSnapshotsFromEvents(parentDoneEvents)).toEqual([
      expect.objectContaining({ id: "child-1", status: "running" }),
    ]);
    expect(subagentActivitySummaryFromEvents(parentDoneEvents)).toEqual({
      totalCount: 1,
      runningCount: 1,
    });

    const childDoneEvents: AgentChatEventEnvelope[] = [
      ...parentDoneEvents,
      {
        sessionId: "session-1",
        timestamp: "2026-07-13T12:00:02.000Z",
        event: {
          type: "subagent_result",
          taskId: "child-1",
          status: "completed",
          summary: "Lifecycle verified",
          turnId: "turn-1",
        },
      },
    ];

    expect(subagentSnapshotsFromEvents(childDoneEvents)).toEqual([
      expect.objectContaining({ id: "child-1", status: "completed" }),
    ]);
    expect(subagentActivitySummaryFromEvents(childDoneEvents)).toEqual({
      totalCount: 1,
      runningCount: 0,
    });
  });

  it("preserves parentAgentId while deriving nested subagent snapshots", () => {
    const events: AgentChatEventEnvelope[] = [{
      sessionId: "session-nested",
      timestamp: "2026-07-16T12:00:00.000Z",
      event: {
        type: "subagent_started",
        taskId: "nested-task",
        agentId: "nested-agent",
        parentAgentId: "parent-agent",
        description: "Inspect the nested transcript",
      },
    }];

    expect(subagentSnapshotsFromEvents(events)).toEqual([
      expect.objectContaining({
        id: "nested-agent",
        parentAgentId: "parent-agent",
      }),
    ]);
  });

  it("partitions in source order while pins override earlier and cleared membership", () => {
    const running = paneSnapshot("running", "running");
    const completed = paneSnapshot("completed", "completed");
    const stopped = paneSnapshot("stopped", "stopped");
    const failed = paneSnapshot("failed", "failed");

    expect(groupPaneSectionItems([running, completed, stopped, failed], {
      isEarlier: isEarlierSubagentSnapshot,
      isCleared: (item) => item.id === "stopped" || item.id === "completed",
      isPinned: (item) => item.id === "completed",
    })).toEqual({
      active: [running, completed, failed],
      earlier: [],
      clearedCount: 1,
    });
  });

  it("emits grouped disclosure rows with caps, clear state, and tagged targets", () => {
    const snapshots = Array.from({ length: 14 }, (_, index) => paneSnapshot(`running-${index}`, "running"));
    snapshots.splice(4, 0, paneSnapshot("failed", "failed"));
    snapshots.push(paneSnapshot("done", "completed"));

    const rows = buildSubagentPaneRows({ snapshots }, {});
    expect(rows.find((row) => row.kind === "section-header")).toMatchObject({
      activeCount: 15,
      earlierCount: 1,
      collapsible: true,
      hasClear: true,
    });
    expect(rows.filter((row) => row.kind === "snapshot" && row.group === "active")).toHaveLength(12);
    expect(rows.find((row) => row.kind === "show-all")).toMatchObject({ hiddenCount: 3 });
    expect(rows.find((row) => row.kind === "earlier-toggle")).toMatchObject({ count: 1, expanded: false });

    // Lines are anchored at the calibrated TUI preamble baseline (4) — see
    // SUBAGENT_PANE_TABLE_START_LINE in chatSubagents.ts.
    const showAllLine = rows.slice(0, rows.findIndex((row) => row.kind === "show-all"))
      .reduce((line, row) => line + (row.kind === "section-header" || row.kind === "main" ? 2 : 1), 4);
    expect(subagentIndexForPaneLine({ snapshots }, showAllLine, 0, {})).toEqual({
      type: "show-all",
      section: "subagents",
    });

    const clearedRows = buildSubagentPaneRows({ snapshots }, {
      earlierExpanded: { subagents: true },
      cleared: { subagents: ["done"] },
    });
    expect(clearedRows.find((row) => row.kind === "earlier-toggle")).toMatchObject({
      count: 0,
      clearedCount: 1,
    });
    expect(clearedRows.find((row) => row.kind === "restore-cleared")).toMatchObject({ count: 1 });
  });
});

describe("chatSubagents timeline helpers", () => {
  it("normalizes agent keys and prefers meaningful, richer summaries", () => {
    expect(subagentAgentKey({ agentId: "  agent-1  ", taskId: "task-1" })).toBe("agent-1");
    expect(subagentAgentKey({ agentId: " ", taskId: " task-1 " })).toBe("task-1");
    expect(subagentAgentKey({ agentId: "", taskId: " " })).toBeNull();

    expect(preferSubagentSummary("Useful report", "Status: completed")).toBe("Useful report");
    expect(preferSubagentSummary("Task updated", "A real report")).toBe("A real report");
    expect(preferSubagentSummary("short", "a substantially longer report")).toBe("a substantially longer report");
    expect(preferSubagentSummary("Status: running", "Task updated")).toBe("Task updated");
    expect(preferSubagentSummary(" ", "  ")).toBeNull();
  });

  it("distinguishes background shell commands from real background subagents", () => {
    expect(isBackgroundShellCommand({ taskType: "background" })).toBe(true);
    expect(isBackgroundShellCommand({ taskType: "background", agentType: "background" })).toBe(true);
    expect(isRealSubagent({ taskType: "background" })).toBe(false);

    const backgroundSubagent = { taskType: "background", agentType: "Explore" };
    expect(isBackgroundShellCommand(backgroundSubagent)).toBe(false);
    expect(isRealSubagent(backgroundSubagent)).toBe(true);
    expect(isRealSubagent({ taskType: "local_workflow" })).toBe(true);
  });

  it("treats a local_bash run_in_background shell as a background shell, never a subagent", () => {
    // The Claude Agent SDK tags Bash run_in_background with task_type
    // "local_bash"; it must land in the background pane, not the roster.
    expect(isBackgroundShellCommand({ taskType: "local_bash" })).toBe(true);
    expect(isBackgroundShellCommand({ taskType: "local_bash", command: "codex exec …" })).toBe(true);
    expect(isRealSubagent({ taskType: "local_bash" })).toBe(false);
    // A local_bash task that somehow carried a real agent type is still not a
    // background shell (agentType wins), staying available as a real subagent.
    expect(isBackgroundShellCommand({ taskType: "local_bash", agentType: "Explore" })).toBe(false);
    expect(isRealSubagent({ taskType: "local_bash", agentType: "Explore" })).toBe(true);
  });

  it("classifies a task_type 'other' run without agent metadata as a non-agent task run", () => {
    // A plain Claude Code TaskCreate run (e.g. "Re-run affected test files")
    // reports task_type "other" with no agent identity — it must never surface
    // subagent rows. A bare task_started (no task_type) stays a subagent.
    expect(isNonAgentTaskRun({ taskType: "other" })).toBe(true);
    expect(isNonAgentTaskRun({ taskType: "other", agentType: "general-purpose" })).toBe(false);
    expect(isNonAgentTaskRun({ taskType: "other", agentId: "a123" })).toBe(false);
    expect(isNonAgentTaskRun({ taskType: "subagent" })).toBe(false);
    expect(isNonAgentTaskRun({})).toBe(false);
  });

  it("keeps idle and foreground paths aligned by counting a stashed Task-tool input as agent metadata", () => {
    // Regression: the idle-turn task_started handler used to omit the stashed
    // check, so a Task subagent reported as task_type "other" with a stashed
    // tool input was suppressed on idle turns but shown on foreground turns.
    // Both paths now share this predicate — a stashed input means it is a real
    // subagent, not a non-agent task run.
    expect(isNonAgentTaskRun({ taskType: "other", hasStashedToolInput: true })).toBe(false);
    expect(isNonAgentTaskRun({ taskType: "other", hasStashedToolInput: false })).toBe(true);
  });

  it("omits non-agent task runs (no agentType/agentId, non-subagent task type) from the timeline", () => {
    // A plain Claude Code task run like "Re-run affected test files" carries no
    // agent metadata and a non-subagent task type — it must not render as a
    // spawn/result card.
    const rows = deriveSubagentTimelineRows([
      { type: "subagent_started", taskId: "bwguvejv9", description: "Re-run affected test files" },
      { type: "subagent_result", taskId: "bwguvejv9", status: "completed", summary: "done" },
    ]);
    expect(rows).toEqual([]);
  });

  it("coalesces hook and task starts by alias while enriching the first spawn row", () => {
    const events: AgentChatEvent[] = [
      {
        type: "subagent.started",
        agentId: "agent-1",
        agentType: "Explore",
        description: "Scan files",
        background: false,
      },
      {
        type: "subagent_started",
        taskId: "task-1",
        agentId: "agent-1",
        agentType: "Explore",
        description: "Scan all renderer lifecycle files",
        background: true,
        taskType: "subagent",
      },
    ];

    expect(deriveSubagentTimelineRows(events)).toEqual([
      {
        kind: "spawn",
        agentKey: "agent-1",
        description: "Scan all renderer lifecycle files",
        agentType: "Explore",
        background: true,
        status: "running",
        statusLine: "Scan all renderer lifecycle files",
        lastToolName: null,
        toolCount: null,
        startedAtEventIndex: 0,
      },
    ]);
  });

  it("rebinds a task-keyed spawn when a later event supplies its agent id", () => {
    const rows = deriveSubagentTimelineRows([
      {
        type: "subagent_started",
        taskId: "task-1",
        description: "Inspect aliases",
        taskType: "subagent",
      },
      {
        type: "subagent_progress",
        taskId: "task-1",
        agentId: "agent-1",
        summary: "Alias resolved.",
        taskType: "subagent",
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      kind: "spawn",
      agentKey: "agent-1",
      startedAtEventIndex: 0,
      statusLine: "Alias resolved.",
    }));
  });

  it("keeps one spawn through interleaved progress and ignores placeholder regressions", () => {
    const events: AgentChatEvent[] = [
      {
        type: "subagent_started",
        taskId: "task-1",
        agentType: "Explore",
        description: "Inspect lifecycle handling",
        taskType: "subagent",
      },
      {
        type: "subagent_progress",
        taskId: "task-1",
        agentType: "Explore",
        summary: "Found the adapter.",
        lastToolName: "rg",
        usage: { toolUses: 2 },
        taskType: "subagent",
      },
      { type: "text", text: "unrelated parent output" },
      {
        type: "subagent_progress",
        taskId: "task-1",
        agentType: "Explore",
        summary: "Task updated",
        lastToolName: "read_file",
        usage: { toolUses: 4 },
        taskType: "subagent",
      },
      {
        type: "subagent_progress",
        taskId: "task-1",
        agentType: "Explore",
        summary: "Found the exact lifecycle adapter and its regression coverage.",
        usage: { toolUses: 6 },
        taskType: "subagent",
      },
      {
        type: "subagent_progress",
        taskId: "task-1",
        agentType: "Explore",
        summary: "Status: completed",
        taskType: "subagent",
      },
    ];

    const rows = deriveSubagentTimelineRows(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      kind: "spawn",
      status: "running",
      statusLine: "Found the exact lifecycle adapter and its regression coverage.",
      lastToolName: "read_file",
      toolCount: 6,
    }));
  });

  it("merges duplicate results, retains the richer report, and settles the spawn", () => {
    const events: AgentChatEvent[] = [
      {
        type: "subagent_started",
        taskId: "task-1",
        agentType: "Explore",
        description: "Inspect the shared helpers",
        taskType: "subagent",
      },
      {
        type: "subagent_result",
        taskId: "task-1",
        agentType: "Explore",
        status: "stopped",
        summary: "Status: completed",
        taskType: "subagent",
      },
      {
        type: "subagent_result",
        taskId: "task-1",
        agentType: "Explore",
        status: "completed",
        summary: "Verified the shared lifecycle helpers and all focused edge cases.",
        taskType: "subagent",
      },
    ];

    const rows = deriveSubagentTimelineRows(events);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(expect.objectContaining({ kind: "spawn", status: "completed" }));
    expect(rows[1]).toEqual({
      kind: "result",
      agentKey: "task-1",
      status: "completed",
      summary: "Verified the shared lifecycle helpers and all focused edge cases.",
      resultAtEventIndex: 1,
    });
  });

  it("keeps a terminal spawn terminal when late progress arrives", () => {
    const rows = deriveSubagentTimelineRows([
      {
        type: "subagent_started",
        taskId: "task-1",
        agentType: "Explore",
        description: "Inspect lifecycle state",
        taskType: "subagent",
      },
      {
        type: "subagent_result",
        taskId: "task-1",
        agentType: "Explore",
        status: "completed",
        summary: "Lifecycle state verified",
        taskType: "subagent",
      },
      {
        type: "subagent_progress",
        taskId: "task-1",
        agentType: "Explore",
        summary: "Late progress tick",
        lastToolName: "read_file",
        usage: { toolUses: 9 },
        taskType: "subagent",
      },
    ]);

    expect(rows[0]).toEqual(expect.objectContaining({
      kind: "spawn",
      status: "completed",
      statusLine: "Inspect lifecycle state",
      lastToolName: null,
      toolCount: null,
    }));
    expect(rows[1]).toEqual(expect.objectContaining({
      kind: "result",
      status: "completed",
      summary: "Lifecycle state verified",
    }));
  });

  it("turns a terminal background shell into one chip without spawn or result rows", () => {
    const events: AgentChatEvent[] = [
      {
        type: "subagent_started",
        taskId: "shell-1",
        description: "npm run dev",
        background: true,
        taskType: "background",
      },
      {
        type: "subagent_progress",
        taskId: "shell-1",
        summary: "Status: running",
        taskType: "background",
      },
      {
        type: "subagent_result",
        taskId: "shell-1",
        status: "completed",
        summary: "Process exited successfully",
        taskType: "background",
      },
    ];

    expect(deriveSubagentTimelineRows(events)).toEqual([
      {
        kind: "background_chip",
        agentKey: "shell-1",
        label: "npm run dev",
        status: "completed",
        settledAtEventIndex: 2,
      },
    ]);
  });

  it("keeps a real background Explore agent in the spawn and result model", () => {
    const events: AgentChatEvent[] = [
      {
        type: "subagent_started",
        taskId: "task-bg-1",
        agentType: "Explore",
        description: "Research in the background",
        background: true,
        taskType: "background",
      },
      {
        type: "subagent_result",
        taskId: "task-bg-1",
        agentType: "Explore",
        status: "completed",
        summary: "Research complete.",
        taskType: "background",
      },
    ];

    const rows = deriveSubagentTimelineRows(events);
    expect(rows.map((row) => row.kind)).toEqual(["spawn", "result"]);
    expect(rows[0]).toEqual(expect.objectContaining({ background: true, status: "completed" }));
    expect(rows[1]).toEqual(expect.objectContaining({ summary: "Research complete." }));
  });
});
