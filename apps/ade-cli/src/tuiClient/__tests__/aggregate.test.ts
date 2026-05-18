import { describe, expect, it } from "vitest";
import { aggregateChatBlocks, type AggregatedBlock } from "../aggregate";
import type { AgentChatEvent, AgentChatEventEnvelope } from "../../../../desktop/src/shared/types/chat";

let sequenceCounter = 0;
function env(timestamp: string, event: AgentChatEvent): AgentChatEventEnvelope {
  sequenceCounter += 1;
  return { sessionId: "s1", timestamp, sequence: sequenceCounter, event };
}

function aggregate(events: AgentChatEventEnvelope[]): AggregatedBlock[] {
  return aggregateChatBlocks({
    events,
    notices: [],
    activeSession: null,
  });
}

describe("aggregateChatBlocks typed groups", () => {
  it("groups tool_calls + commands together and keeps file_changes as a separate group", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", { type: "tool_call", tool: "read", args: { path: "a.ts" }, itemId: "t1", turnId: "turn-1" }),
      env("2026-01-01T12:00:01.000Z", { type: "tool_call", tool: "read", args: { path: "b.ts" }, itemId: "t2", turnId: "turn-1" }),
      env("2026-01-01T12:00:02.000Z", { type: "tool_call", tool: "grep", args: { pattern: "foo" }, itemId: "t3", turnId: "turn-1" }),
      env("2026-01-01T12:00:03.000Z", {
        type: "file_change",
        path: "src/app.ts",
        kind: "modify",
        diff: "+added line\n-removed line",
        itemId: "f1",
        turnId: "turn-1",
        status: "completed",
      }),
      env("2026-01-01T12:00:04.000Z", {
        type: "file_change",
        path: "src/util.ts",
        kind: "create",
        diff: "+brand new\n+second new",
        itemId: "f2",
        turnId: "turn-1",
        status: "completed",
      }),
      env("2026-01-01T12:00:05.000Z", {
        type: "command",
        command: "npm test",
        cwd: "/tmp",
        output: "",
        itemId: "c1",
        turnId: "turn-1",
        status: "completed",
        exitCode: 0,
        durationMs: 1500,
      }),
    ];

    const blocks = aggregate(events);
    const groupKinds = blocks
      .filter((b) => b.kind === "tool-calls-group" || b.kind === "files-changed-group")
      .map((b) => b.kind);

    // Tool calls first, then files (file_changes interrupted the run), then a fresh
    // tool-calls-group continues with the trailing command.
    expect(groupKinds).toEqual(["tool-calls-group", "files-changed-group", "tool-calls-group"]);

    const toolGroups = blocks.filter((b) => b.kind === "tool-calls-group") as Array<Extract<AggregatedBlock, { kind: "tool-calls-group" }>>;
    const fileGroup = blocks.find((b) => b.kind === "files-changed-group") as Extract<AggregatedBlock, { kind: "files-changed-group" }> | undefined;

    expect(toolGroups[0]!.entries.map((e) => e.tool)).toEqual(["read", "read", "grep"]);
    // The trailing command event lands in a fresh tool-calls-group as tool="shell".
    expect(toolGroups[1]!.entries).toHaveLength(1);
    expect(toolGroups[1]!.entries[0]).toMatchObject({
      tool: "shell",
      arg: "npm test",
      status: "ok",
      durationMs: 1500,
    });

    expect(fileGroup!.entries).toHaveLength(2);
    expect(fileGroup!.entries[0]).toMatchObject({
      path: "src/app.ts",
      kind: "modify",
      additions: 1,
      deletions: 1,
      status: "ok",
    });
    expect(fileGroup!.entries[1]).toMatchObject({
      path: "src/util.ts",
      kind: "create",
      additions: 2,
      deletions: 0,
      status: "ok",
    });
  });

  it("folds consecutive tool_calls and a command into one tool-calls-group", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", { type: "tool_call", tool: "read", args: {}, itemId: "t1", turnId: "turn-1" }),
      env("2026-01-01T12:00:01.000Z", { type: "command", command: "ls", cwd: "/tmp", output: "", itemId: "c1", turnId: "turn-1", status: "completed", exitCode: 0 }),
      env("2026-01-01T12:00:02.000Z", { type: "tool_call", tool: "grep", args: {}, itemId: "t2", turnId: "turn-1" }),
    ];
    const blocks = aggregate(events);
    const toolGroups = blocks.filter((b) => b.kind === "tool-calls-group") as Array<Extract<AggregatedBlock, { kind: "tool-calls-group" }>>;
    expect(toolGroups).toHaveLength(1);
    expect(toolGroups[0]!.entries.map((e) => e.tool)).toEqual(["read", "shell", "grep"]);
  });

  it("propagates failed tool_result status to the matching entry", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", { type: "tool_call", tool: "read", args: { path: "a.ts" }, itemId: "t1", turnId: "turn-1" }),
      env("2026-01-01T12:00:01.000Z", { type: "tool_result", tool: "read", result: "boom", itemId: "t1", turnId: "turn-1", status: "failed" }),
    ];
    const blocks = aggregate(events);
    const toolGroup = blocks.find((b) => b.kind === "tool-calls-group") as Extract<AggregatedBlock, { kind: "tool-calls-group" }> | undefined;
    expect(toolGroup).toBeDefined();
    expect(toolGroup!.entries).toHaveLength(1);
    expect(toolGroup!.entries[0]).toMatchObject({ itemId: "t1", status: "failed" });
  });

  it("separates events with different turnIds into new group blocks per turn", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", { type: "tool_call", tool: "read", args: {}, itemId: "t1", turnId: "turn-1" }),
      env("2026-01-01T12:00:01.000Z", { type: "user_message", text: "next" }),
      env("2026-01-01T12:00:02.000Z", { type: "tool_call", tool: "read", args: {}, itemId: "t2", turnId: "turn-2" }),
    ];
    const blocks = aggregate(events);
    const toolGroups = blocks.filter((b) => b.kind === "tool-calls-group") as Array<Extract<AggregatedBlock, { kind: "tool-calls-group" }>>;
    expect(toolGroups).toHaveLength(2);
    expect(toolGroups[0]!.turnId).toBe("turn-1");
    expect(toolGroups[1]!.turnId).toBe("turn-2");
    expect(toolGroups[0]!.entries.map((e) => e.itemId)).toEqual(["t1"]);
    expect(toolGroups[1]!.entries.map((e) => e.itemId)).toEqual(["t2"]);
  });

  it("filters out subagent-child work events", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", {
        type: "subagent_started",
        sessionId: "sub-1",
        teammateId: "tm-1",
        name: "child",
        parentToolUseId: "parent-1",
      } as unknown as AgentChatEvent),
      env("2026-01-01T12:00:01.000Z", { type: "tool_call", tool: "read", args: {}, itemId: "child-1", parentItemId: "parent-1", turnId: "turn-1" }),
      env("2026-01-01T12:00:02.000Z", { type: "tool_call", tool: "read", args: {}, itemId: "kept-1", turnId: "turn-1" }),
    ];
    const blocks = aggregate(events);
    const toolGroup = blocks.find((b) => b.kind === "tool-calls-group") as Extract<AggregatedBlock, { kind: "tool-calls-group" }> | undefined;
    expect(toolGroup).toBeDefined();
    expect(toolGroup!.entries.map((e) => e.itemId)).toEqual(["kept-1"]);
  });

  it("groups meaningful runtime activity while suppressing generic thinking heartbeats", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", { type: "activity", activity: "thinking", detail: "Thinking through the answer", turnId: "turn-1" }),
      env("2026-01-01T12:00:01.000Z", { type: "activity", activity: "reading", detail: "apps/ade-cli/src/tuiClient/app.tsx", turnId: "turn-1" }),
      env("2026-01-01T12:00:02.000Z", { type: "subagent_started", taskId: "agent-1", parentToolUseId: "spawn-1", description: "child launch spam", turnId: "turn-1" }),
    ];

    const blocks = aggregate(events);
    const activity = blocks.find((b) => b.kind === "runtime-activity") as Extract<AggregatedBlock, { kind: "runtime-activity" }> | undefined;

    expect(activity).toBeDefined();
    expect(activity!.entries[0]).toMatchObject({ label: "reading", detail: "apps/ade-cli/src/tuiClient/app.tsx" });
    expect(activity!.entries[1]).toMatchObject({ label: "subagent started" });
    expect(activity!.entries[1]).not.toHaveProperty("detail");
  });

  it("marks tool-calls-group and files-changed-group as not-live without stamping turn duration", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", { type: "tool_call", tool: "read", args: {}, itemId: "t1", turnId: "turn-1" }),
      env("2026-01-01T12:00:01.000Z", {
        type: "file_change",
        path: "src/a.ts",
        kind: "modify",
        diff: "+x",
        itemId: "f1",
        turnId: "turn-1",
        status: "completed",
      }),
      env("2026-01-01T12:00:02.000Z", { type: "command", command: "ls", cwd: "/tmp", output: "", itemId: "c1", turnId: "turn-1", status: "completed", exitCode: 0 }),
      env("2026-01-01T12:00:05.000Z", { type: "done", turnId: "turn-1", status: "completed" }),
    ];
    const blocks = aggregate(events);
    const groupBlocks = blocks.filter((b) =>
      b.kind === "tool-calls-group" || b.kind === "files-changed-group",
    ) as Array<Extract<AggregatedBlock, { kind: "tool-calls-group" | "files-changed-group" }>>;
    expect(groupBlocks.length).toBeGreaterThanOrEqual(2);
    for (const g of groupBlocks) {
      expect(g.live).toBe(false);
      expect(g.durationMs).toBeUndefined();
    }
  });

  it("emits an error passthrough on failed status and stops live for all groups", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", { type: "tool_call", tool: "read", args: {}, itemId: "t1", turnId: "turn-1" }),
      env("2026-01-01T12:00:05.000Z", { type: "status", turnStatus: "failed", turnId: "turn-1" }),
    ];
    const blocks = aggregate(events);
    const toolGroup = blocks.find((b) => b.kind === "tool-calls-group") as Extract<AggregatedBlock, { kind: "tool-calls-group" }> | undefined;
    expect(toolGroup).toBeDefined();
    expect(toolGroup!.live).toBe(false);
    expect(toolGroup!.durationMs).toBeUndefined();
    const errorBlock = blocks.find((b) => b.kind === "error");
    expect(errorBlock).toBeDefined();
  });

  it("derives per-tool duration from matching tool_call and tool_result timestamps", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", { type: "tool_call", tool: "read", args: { path: "a.ts" }, itemId: "t1", turnId: "turn-1" }),
      env("2026-01-01T12:00:01.250Z", { type: "tool_result", tool: "read", result: "ok", itemId: "t1", turnId: "turn-1", status: "completed" }),
      env("2026-01-01T12:12:00.000Z", { type: "done", turnId: "turn-1", status: "completed" }),
    ];

    const blocks = aggregate(events);
    const toolGroup = blocks.find((b) => b.kind === "tool-calls-group") as Extract<AggregatedBlock, { kind: "tool-calls-group" }> | undefined;

    expect(toolGroup).toBeDefined();
    expect(toolGroup!.durationMs).toBeUndefined();
    expect(toolGroup!.entries[0]).toMatchObject({ itemId: "t1", status: "ok", durationMs: 1250 });
  });

  it("derives command duration from running and completed command events when provider duration is missing", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", { type: "command", command: "npm test", cwd: "/tmp", output: "", itemId: "c1", turnId: "turn-1", status: "running" }),
      env("2026-01-01T12:00:02.400Z", { type: "command", command: "npm test", cwd: "/tmp", output: "", itemId: "c1", turnId: "turn-1", status: "completed", exitCode: 0 }),
    ];

    const blocks = aggregate(events);
    const toolGroup = blocks.find((b) => b.kind === "tool-calls-group") as Extract<AggregatedBlock, { kind: "tool-calls-group" }> | undefined;

    expect(toolGroup).toBeDefined();
    expect(toolGroup!.entries[0]).toMatchObject({ itemId: "c1", status: "ok", durationMs: 2400 });
  });

  it("sets precededByHeavy on assistant-text that follows a tool or file group", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", { type: "tool_call", tool: "read", args: {}, itemId: "t1", turnId: "turn-1" }),
      env("2026-01-01T12:00:01.000Z", { type: "text", text: "after tools", turnId: "turn-1" }),
    ];
    const blocks = aggregate(events);
    const assistantText = blocks.find((b) => b.kind === "assistant-text") as Extract<AggregatedBlock, { kind: "assistant-text" }> | undefined;
    expect(assistantText).toBeDefined();
    expect(assistantText!.precededByHeavy).toBe(true);

    const events2: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:10.000Z", {
        type: "file_change",
        path: "src/x.ts",
        kind: "modify",
        diff: "+y",
        itemId: "f1",
        turnId: "turn-2",
        status: "completed",
      }),
      env("2026-01-01T12:00:11.000Z", { type: "text", text: "after files", turnId: "turn-2" }),
    ];
    const blocks2 = aggregate(events2);
    const assistantText2 = blocks2.find((b) => b.kind === "assistant-text") as Extract<AggregatedBlock, { kind: "assistant-text" }> | undefined;
    expect(assistantText2).toBeDefined();
    expect(assistantText2!.precededByHeavy).toBe(true);
  });

  it("marks file_change as deleted when diff is empty and kind is delete", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", {
        type: "file_change",
        path: "src/gone.ts",
        kind: "delete",
        diff: "",
        itemId: "f1",
        turnId: "turn-1",
        status: "completed",
      }),
    ];
    const blocks = aggregate(events);
    const fileGroup = blocks.find((b) => b.kind === "files-changed-group") as Extract<AggregatedBlock, { kind: "files-changed-group" }> | undefined;
    expect(fileGroup).toBeDefined();
    expect(fileGroup!.entries[0]).toMatchObject({
      path: "src/gone.ts",
      kind: "delete",
      additions: 0,
      deletions: 0,
      deleted: true,
    });
  });
});
