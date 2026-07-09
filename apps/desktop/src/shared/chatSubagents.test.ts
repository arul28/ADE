import { describe, expect, it } from "vitest";
import type { AgentChatEvent } from "./types/chat";
import {
  deriveSubagentTimelineRows,
  isBackgroundShellCommand,
  isRealSubagent,
  preferSubagentSummary,
  subagentAgentKey,
} from "./chatSubagents";

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
