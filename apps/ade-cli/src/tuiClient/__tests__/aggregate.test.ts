import { describe, expect, it } from "vitest";
import { aggregateChatBlocks, derivePendingSteers, type AggregatedBlock } from "../aggregate";
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

    // Tool calls first, then files (file_changes interrupted the run). Activity
    // phase collapse merges the trailing command back into the first tool group.
    expect(groupKinds).toEqual(["tool-calls-group", "files-changed-group"]);

    const toolGroups = blocks.filter((b) => b.kind === "tool-calls-group") as Array<Extract<AggregatedBlock, { kind: "tool-calls-group" }>>;
    const fileGroup = blocks.find((b) => b.kind === "files-changed-group") as Extract<AggregatedBlock, { kind: "files-changed-group" }> | undefined;

    expect(toolGroups[0]!.entries.map((e) => e.tool)).toEqual(["read", "read", "grep", "shell"]);
    expect(toolGroups).toHaveLength(1);

    expect(fileGroup!.entries).toHaveLength(2);
    expect(fileGroup!.entries[0]).toMatchObject({
      path: "src/app.ts",
      kind: "modify",
      additions: 1,
      deletions: 1,
      diff: "+added line\n-removed line",
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

  it("threads web_search results and resultsTotal onto the aggregated search entry", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", {
        type: "web_search",
        query: "codex app server",
        itemId: "w1",
        turnId: "turn-1",
        status: "running",
      }),
      env("2026-01-01T12:00:01.000Z", {
        type: "web_search",
        query: "codex app server",
        itemId: "w1",
        turnId: "turn-1",
        status: "completed",
        results: [
          { title: "Codex docs", url: "https://www.example.com/codex" },
          { title: "Server guide", url: "https://docs.example.org/server?x=1" },
        ],
        resultsTotal: 5,
      }),
    ];
    const blocks = aggregate(events);
    const toolGroup = blocks.find((b) => b.kind === "tool-calls-group") as Extract<AggregatedBlock, { kind: "tool-calls-group" }> | undefined;
    expect(toolGroup).toBeDefined();
    expect(toolGroup!.entries).toHaveLength(1);
    const entry = toolGroup!.entries[0]!;
    expect(entry).toMatchObject({ itemId: "w1", tool: "search", status: "ok", resultsTotal: 5 });
    expect(entry.results).toEqual([
      { title: "Codex docs", url: "https://www.example.com/codex" },
      { title: "Server guide", url: "https://docs.example.org/server?x=1" },
    ]);
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

  it("bundles subagent lifecycle while still dropping tool-derived activity", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", { type: "activity", activity: "thinking", detail: "Thinking through the answer", turnId: "turn-1" }),
      env("2026-01-01T12:00:01.000Z", { type: "activity", activity: "reading", detail: "apps/ade-cli/src/tuiClient/app.tsx", turnId: "turn-1" }),
      env("2026-01-01T12:00:02.000Z", { type: "activity", activity: "searching", detail: "Grep", turnId: "turn-1" }),
      env("2026-01-01T12:00:03.000Z", { type: "activity", activity: "tool_calling", detail: "Processing tool input", turnId: "turn-1" }),
      env("2026-01-01T12:00:03.500Z", { type: "activity", activity: "spawning_agent", detail: "Repo root: /Users/me/Projects/ADE", turnId: "turn-1" } as unknown as AgentChatEvent),
      env("2026-01-01T12:00:04.000Z", { type: "subagent_started", taskId: "agent-1", parentToolUseId: "spawn-1", description: "child launch spam", turnId: "turn-1" } as unknown as AgentChatEvent),
      env("2026-01-01T12:00:05.000Z", { type: "subagent_progress", taskId: "agent-1", parentToolUseId: "spawn-1", summary: "child progress", turnId: "turn-1" } as unknown as AgentChatEvent),
      env("2026-01-01T12:00:06.000Z", { type: "subagent_result", taskId: "agent-1", parentToolUseId: "spawn-1", status: "completed", summary: "child done", turnId: "turn-1" } as unknown as AgentChatEvent),
    ];

    const blocks = aggregate(events);
    expect(blocks.some((b) => b.kind === "runtime-activity")).toBe(false);
    const activity = blocks.find((b) => b.kind === "activity-bundle") as Extract<AggregatedBlock, { kind: "activity-bundle" }> | undefined;
    expect(activity).toBeDefined();
    expect(activity!.entries).toHaveLength(1);
    expect(activity!.entries[0]).toMatchObject({
      kind: "agent",
      label: "child done",
      detail: "child done",
      status: "ok",
    });
  });

  it("normalizes dotted subagent lifecycle events before activity bundling", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", {
        type: "subagent.started",
        agentId: "agent-canonical",
        parentToolUseId: "call-spawn",
        agentType: "explorer",
        description: "Inspect canonical lifecycle events",
        turnId: "turn-1",
      } as AgentChatEvent),
      env("2026-01-01T12:00:01.000Z", {
        type: "subagent.progress",
        agentId: "agent-canonical",
        parentToolUseId: "call-spawn",
        text: "Reading provider event maps",
        lastToolName: "rg",
        turnId: "turn-1",
      } as AgentChatEvent),
      env("2026-01-01T12:00:02.000Z", {
        type: "subagent.completed",
        agentId: "agent-canonical",
        parentToolUseId: "call-spawn",
        summary: "Canonical lifecycle mapped.",
        status: "completed",
        turnId: "turn-1",
      } as AgentChatEvent),
    ];

    const blocks = aggregate(events);
    const activity = blocks.find((b) => b.kind === "activity-bundle") as Extract<AggregatedBlock, { kind: "activity-bundle" }> | undefined;

    expect(activity).toBeDefined();
    expect(activity!.entries).toHaveLength(1);
    expect(activity!.entries[0]).toMatchObject({
      kind: "agent",
      label: "Canonical lifecycle mapped.",
      detail: "Canonical lifecycle mapped.",
      status: "ok",
    });
  });

  it("folds Codex parent placeholders into the resolved subagent activity row", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", {
        type: "subagent_started",
        taskId: "call-spawn-1",
        parentToolUseId: "call-spawn-1",
        description: "Inspect the placeholder path",
        turnId: "turn-1",
      } as AgentChatEvent),
      env("2026-01-01T12:00:01.000Z", {
        type: "subagent_started",
        taskId: "agent-thread-1",
        agentId: "agent-thread-1",
        parentToolUseId: "call-spawn-1",
        label: "Sagan",
        description: "Inspect the placeholder path",
        turnId: "turn-1",
      } as AgentChatEvent),
    ];

    const blocks = aggregate(events);
    const activity = blocks.find((b) => b.kind === "activity-bundle") as Extract<AggregatedBlock, { kind: "activity-bundle" }> | undefined;

    expect(activity).toBeDefined();
    expect(activity!.entries).toHaveLength(1);
    expect(activity!.entries[0]).toMatchObject({
      label: "Sagan",
      status: "running",
    });
  });

  it("bundles adjacent task and scheduled work updates in the TUI transcript", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", {
        type: "todo_update",
        turnId: "turn-1",
        items: [{ id: "task-1", description: "Review UI parity", status: "in_progress" }],
      }),
      env("2026-01-01T12:00:01.000Z", {
        type: "scheduled_work_update",
        id: "cron-1",
        kind: "cron",
        status: "scheduled",
        title: "CI follow-up",
        turnId: "turn-1",
      } as unknown as AgentChatEvent),
    ];

    const blocks = aggregate(events);
    expect(blocks).toHaveLength(1);
    const activity = blocks[0] as Extract<AggregatedBlock, { kind: "activity-bundle" }>;
    expect(activity.kind).toBe("activity-bundle");
    expect(activity.entries.map((entry) => entry.kind)).toEqual(["task", "schedule"]);
    expect(activity.entries.map((entry) => entry.label)).toEqual(["Review UI parity", "CI follow-up"]);
  });

  it("still surfaces unrecognized activity events as runtime activity", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", { type: "activity", activity: "compacting_memory", detail: "trimming context", turnId: "turn-1" } as unknown as AgentChatEvent),
    ];
    const blocks = aggregate(events);
    const activity = blocks.find((b) => b.kind === "runtime-activity") as Extract<AggregatedBlock, { kind: "runtime-activity" }> | undefined;
    expect(activity).toBeDefined();
    expect(activity!.entries[0]).toMatchObject({ label: "compacting memory", detail: "trimming context" });
  });

  it("compacts PreToolUse hook errors into one failed hook activity row", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", {
        type: "system_notice",
        noticeKind: "hook",
        message: "Hook: PreToolUse: Bash error",
        turnId: "turn-1",
      } as AgentChatEvent),
    ];
    const blocks = aggregate(events);
    const activity = blocks.find((b) => b.kind === "runtime-activity") as Extract<AggregatedBlock, { kind: "runtime-activity" }> | undefined;

    expect(blocks).toHaveLength(1);
    expect(activity?.entries).toEqual([
      {
        id: expect.any(String),
        label: "hook",
        detail: "PreToolUse: Bash error",
        status: "failed",
      },
    ]);
    expect(activity?.live).toBe(false);
  });

  it("collapses a context_compact begin→end into one block that flips live→done", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", { type: "context_compact", trigger: "auto", state: "started", turnId: "turn-1" }),
      env("2026-01-01T12:00:02.000Z", { type: "context_compact", trigger: "auto", state: "completed", preTokens: 120_000, turnId: "turn-1" }),
    ];
    const blocks = aggregate(events).filter((b) => b.kind === "compaction");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "compaction", live: false, trigger: "auto", preTokens: 120_000 });
  });

  it("collapses cross-turn context_compact completion into the live compaction block", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", { type: "context_compact", trigger: "auto", state: "started", turnId: "turn-1" }),
      env("2026-01-01T12:00:02.000Z", { type: "context_compact", trigger: "manual", state: "completed", preTokens: 120_000, turnId: "turn-2" }),
    ];
    const blocks = aggregate(events).filter((b) => b.kind === "compaction");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "compaction", live: false, trigger: "manual", preTokens: 120_000 });
  });

  it("collapses cross-turn codex compaction completion into the live compaction block", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", { type: "codex_context_compaction", trigger: "auto", state: "started", turnId: "turn-1" }),
      env("2026-01-01T12:00:02.000Z", { type: "codex_context_compaction", trigger: "auto", state: "completed", turnId: "turn-2" }),
    ];
    const blocks = aggregate(events).filter((b) => b.kind === "compaction");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "compaction", live: false, trigger: "auto" });
  });

  it("renders a context_compact begin as a live (in-progress) compaction block", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", { type: "context_compact", trigger: "manual", state: "started", turnId: "turn-1" }),
    ];
    const blocks = aggregate(events).filter((b) => b.kind === "compaction");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "compaction", live: true, trigger: "manual" });
  });

  it("routes conversation resets through the compaction-style divider block", () => {
    const blocks = aggregate([
      env("2026-01-01T12:00:00.000Z", { type: "conversation_reset", newConversationId: "conversation-2" }),
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("conversation-reset");
    expect(blocks[0]?.id).toContain("conversation_reset");
  });

  it("clears a staged steer when Claude starts its queued command", () => {
    const events = [
      env("2026-01-01T12:00:00.000Z", { type: "user_message", text: "queued", steerId: "steer-1", deliveryState: "queued" }),
      env("2026-01-01T12:00:01.000Z", {
        type: "command_lifecycle",
        commandUuid: "command-1",
        status: "started",
        steerId: "steer-1",
      }),
    ];

    expect(derivePendingSteers(events)).toEqual([]);
  });

  it("treats a stateless context_compact as a completed (done) block", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", { type: "context_compact", trigger: "auto", turnId: "turn-1" }),
    ];
    const blocks = aggregate(events).filter((b) => b.kind === "compaction");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "compaction", live: false });
  });

  it("keeps one tool-calls-group when activity status events are interleaved", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", { type: "activity", activity: "tool_calling", detail: "Processing tool input", turnId: "turn-1" }),
      env("2026-01-01T12:00:01.000Z", { type: "tool_call", tool: "grep", args: {}, itemId: "t1", turnId: "turn-1" }),
      env("2026-01-01T12:00:02.000Z", { type: "activity", activity: "reading", detail: "Read", turnId: "turn-1" }),
      env("2026-01-01T12:00:03.000Z", { type: "tool_call", tool: "read", args: {}, itemId: "t2", turnId: "turn-1" }),
      env("2026-01-01T12:00:04.000Z", { type: "activity", activity: "searching", detail: "Grep", turnId: "turn-1" }),
      env("2026-01-01T12:00:05.000Z", { type: "tool_call", tool: "grep", args: {}, itemId: "t3", turnId: "turn-1" }),
    ];

    const blocks = aggregate(events);
    const toolGroups = blocks.filter((b) => b.kind === "tool-calls-group") as Array<Extract<AggregatedBlock, { kind: "tool-calls-group" }>>;

    expect(blocks.some((b) => b.kind === "runtime-activity")).toBe(false);
    expect(toolGroups).toHaveLength(1);
    expect(toolGroups[0]!.entries.map((entry) => entry.tool)).toEqual(["grep", "read", "grep"]);
  });

  it("merges assistant text chunks after suppressing interleaved activity", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", { type: "text", text: "Let me look at the sendMessage flow more carefully and what ", turnId: "turn-1", itemId: "msg-1" }),
      env("2026-01-01T12:00:01.000Z", { type: "activity", activity: "reading", detail: "Read", turnId: "turn-1" }),
      env("2026-01-01T12:00:02.000Z", { type: "text", text: "events are emitted when a session is resumed.", turnId: "turn-1", itemId: "msg-1" }),
    ];

    const blocks = aggregate(events);
    const assistantBlocks = blocks.filter((b) => b.kind === "assistant-text") as Array<Extract<AggregatedBlock, { kind: "assistant-text" }>>;

    expect(assistantBlocks).toHaveLength(1);
    expect(assistantBlocks[0]!.line.body).toBe("Let me look at the sendMessage flow more carefully and what events are emitted when a session is resumed.");
  });

  it("does not duplicate the tail when a provider re-emits an overlapping fragment of the same message", () => {
    // Regression (real Codex chat): "…so I can split the review instead of
    // doing it as one giant pass." rendered twice because the provider re-sent
    // the final sentence for the same messageId and the merge was plain concat.
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", { type: "text", text: "I found the entry point so I can split the review instead of doing it as one giant pass.", turnId: "turn-1", messageId: "msg-1" }),
      env("2026-01-01T12:00:01.000Z", { type: "text", text: " so I can split the review instead of doing it as one giant pass.", turnId: "turn-1", messageId: "msg-1" }),
    ];
    const blocks = aggregate(events);
    const assistantBlocks = blocks.filter((b) => b.kind === "assistant-text") as Array<Extract<AggregatedBlock, { kind: "assistant-text" }>>;
    expect(assistantBlocks).toHaveLength(1);
    expect(assistantBlocks[0]!.line.body).toBe("I found the entry point so I can split the review instead of doing it as one giant pass.");
  });

  it("replaces the buffer when a provider re-emits the cumulative message text", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", { type: "text", text: "Hello", turnId: "turn-1", messageId: "msg-1" }),
      env("2026-01-01T12:00:01.000Z", { type: "text", text: "Hello world.", turnId: "turn-1", messageId: "msg-1" }),
    ];
    const blocks = aggregate(events);
    const assistantBlocks = blocks.filter((b) => b.kind === "assistant-text") as Array<Extract<AggregatedBlock, { kind: "assistant-text" }>>;
    expect(assistantBlocks).toHaveLength(1);
    expect(assistantBlocks[0]!.line.body).toBe("Hello world.");
  });

  it("dedupes re-emitted reasoning tails within the same reasoning item", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", { type: "reasoning", text: "Weighing options before refactor.", turnId: "turn-1", itemId: "r1" }),
      env("2026-01-01T12:00:00.500Z", { type: "reasoning", text: " before refactor.", turnId: "turn-1", itemId: "r1" }),
    ];
    const blocks = aggregate(events);
    const reasoning = blocks.filter((b) => b.kind === "reasoning") as Array<Extract<AggregatedBlock, { kind: "reasoning" }>>;
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]!.text).toBe("Weighing options before refactor.");
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

describe("aggregateChatBlocks desktop work-log parity", () => {
  it("derives slug + target arg like the desktop work log instead of dumping raw args JSON", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", {
        type: "tool_call",
        tool: "Read",
        args: { file_path: "apps/desktop/src/main.ts", limit: 40 },
        itemId: "t1",
        turnId: "turn-1",
      }),
      env("2026-01-01T12:00:01.000Z", {
        type: "tool_call",
        tool: "exec_command",
        args: { command: "npm test" },
        itemId: "t2",
        turnId: "turn-1",
      }),
    ];
    const blocks = aggregate(events);
    const group = blocks.find((b) => b.kind === "tool-calls-group") as Extract<AggregatedBlock, { kind: "tool-calls-group" }>;
    expect(group.entries[0]).toMatchObject({ tool: "read", arg: "apps/desktop/src/main.ts" });
    // exec_command normalizes to the shell slug, same as desktop's kind slug.
    expect(group.entries[1]).toMatchObject({ tool: "shell", arg: "npm test" });
    expect(group.entries[0]!.arg).not.toContain("{");
  });

  it("resolves generic tool identifiers from the payload title (desktop readToolTitle parity)", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", {
        type: "tool_call",
        tool: "tool",
        args: { title: "Custom Migration" },
        itemId: "t1",
        turnId: "turn-1",
      }),
    ];
    const blocks = aggregate(events);
    const group = blocks.find((b) => b.kind === "tool-calls-group") as Extract<AggregatedBlock, { kind: "tool-calls-group" }>;
    expect(group.entries[0]!.tool).toBe("custom_migration");
  });

  it("renders MCP calls as connector + target and collapses their lifecycle", () => {
    const mcp = {
      server: "github",
      tool: "search_issues",
      appContext: { appName: "GitHub", actionName: "Search issues" },
    };
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", {
        type: "tool_call",
        tool: "github:search_issues",
        args: { query: "is:open label:bug" },
        mcp,
        itemId: "mcp-1",
        turnId: "turn-1",
      }),
      env("2026-01-01T12:00:01.000Z", {
        type: "tool_result",
        tool: "github:search_issues",
        result: "Issue 1",
        mcp,
        itemId: "mcp-1",
        turnId: "turn-1",
        status: "completed",
      }),
    ];
    const blocks = aggregate(events);
    const group = blocks.find((b) => b.kind === "tool-calls-group") as Extract<AggregatedBlock, { kind: "tool-calls-group" }>;
    expect(group.entries).toEqual([
      expect.objectContaining({
        itemId: "mcp-1",
        tool: "git_hub",
        arg: "is:open label:bug",
        status: "ok",
      }),
    ]);
  });

  it("groups web_search lifecycle events into the tool-calls group keyed by query", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", {
        type: "web_search",
        query: "ink truncate text",
        status: "running",
        turnId: "turn-1",
      } as AgentChatEvent),
      env("2026-01-01T12:00:01.000Z", {
        type: "web_search",
        query: "ink truncate text",
        status: "completed",
        turnId: "turn-1",
      } as AgentChatEvent),
    ];
    const blocks = aggregate(events);
    const group = blocks.find((b) => b.kind === "tool-calls-group") as Extract<AggregatedBlock, { kind: "tool-calls-group" }>;
    expect(group).toBeDefined();
    expect(group.entries).toHaveLength(1);
    expect(group.entries[0]).toMatchObject({ tool: "search", arg: "ink truncate text", status: "ok" });
  });

  it("collapses image generation lifecycle updates into one completed line", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", {
        type: "codex_image_generation",
        itemId: "image-1",
        turnId: "turn-1",
        prompt: "A tiny moon icon",
        status: "running",
      }),
      env("2026-01-01T12:00:01.000Z", {
        type: "codex_image_generation",
        itemId: "image-1",
        turnId: "turn-1",
        prompt: "A tiny moon icon",
        result: "/tmp/moon.png",
        savedPath: "/tmp/moon.png",
        status: "completed",
      }),
    ];
    const imageBlocks = aggregate(events).filter((block) =>
      block.kind === "notice" && block.line.body.includes("image generated")
    );
    expect(imageBlocks).toHaveLength(1);
    expect(imageBlocks[0]).toMatchObject({
      kind: "notice",
      line: expect.objectContaining({ body: expect.stringContaining("A tiny moon icon") }),
    });
  });

  it("merges streamed reasoning into one block and finishes it at turn end", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", { type: "reasoning", text: "part one ", turnId: "turn-1" }),
      env("2026-01-01T12:00:00.500Z", { type: "reasoning", text: "part two", turnId: "turn-1" }),
      env("2026-01-01T12:00:01.000Z", { type: "done", turnId: "turn-1", status: "completed" } as AgentChatEvent),
    ];
    const blocks = aggregate(events);
    const reasoning = blocks.filter((b) => b.kind === "reasoning") as Extract<AggregatedBlock, { kind: "reasoning" }>[];
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]).toMatchObject({ text: "part one part two", live: false });
  });

  it("collapses alternating reasoning and tool bursts into merged activity rows", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", { type: "reasoning", text: "First thought.", itemId: "r1", turnId: "turn-1" }),
      env("2026-01-01T12:00:01.000Z", { type: "tool_call", tool: "Read", args: { path: "a.ts" }, itemId: "t1", turnId: "turn-1" }),
      env("2026-01-01T12:00:02.000Z", { type: "reasoning", text: "Second thought.", itemId: "r2", turnId: "turn-1" }),
      env("2026-01-01T12:00:03.000Z", { type: "tool_call", tool: "Edit", args: { path: "b.ts" }, itemId: "t2", turnId: "turn-1" }),
      env("2026-01-01T12:00:04.000Z", { type: "reasoning", text: "Third thought.", itemId: "r3", turnId: "turn-1" }),
      env("2026-01-01T12:00:05.000Z", { type: "tool_call", tool: "Shell", args: { cmd: "pwd" }, itemId: "t3", turnId: "turn-1" }),
    ];
    const blocks = aggregate(events);
    const reasoning = blocks.filter((b) => b.kind === "reasoning") as Extract<AggregatedBlock, { kind: "reasoning" }>[];
    const toolGroups = blocks.filter((b) => b.kind === "tool-calls-group") as Extract<AggregatedBlock, { kind: "tool-calls-group" }>[];
    expect(reasoning).toHaveLength(1);
    expect(toolGroups).toHaveLength(1);
    expect(reasoning[0]!.text).toContain("First thought.");
    expect(reasoning[0]!.text).toContain("Second thought.");
    expect(reasoning[0]!.text).toContain("Third thought.");
    expect(toolGroups[0]!.entries).toHaveLength(3);
  });
});

// Realistic Claude history-replay shapes (distilled from real ended-session
// transcripts under .ade/transcripts/chat): tool results separated from their
// calls by interleaved assistant text, stream-path tool_calls that arrive with
// empty args and are re-emitted enriched, and un-coalesced text deltas.
describe("aggregateChatBlocks claude history accuracy", () => {
  it("resolves a tool_result into its call's entry across interleaved assistant text", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", { type: "tool_call", tool: "Read", args: { file_path: "a.ts" }, itemId: "toolu_1", turnId: "turn-1" }),
      env("2026-01-01T12:00:01.000Z", { type: "text", text: "Reading that file now.", messageId: "m1", turnId: "turn-1" }),
      env("2026-01-01T12:00:02.000Z", { type: "tool_result", tool: "Read", result: "ok", itemId: "toolu_1", turnId: "turn-1", status: "completed" } as AgentChatEvent),
      env("2026-01-01T12:00:03.000Z", { type: "done", turnId: "turn-1", status: "completed" } as AgentChatEvent),
    ];
    const blocks = aggregate(events);
    const groups = blocks.filter((b) => b.kind === "tool-calls-group") as Extract<AggregatedBlock, { kind: "tool-calls-group" }>[];
    // The result must RESOLVE the original entry, not open a second group with
    // a duplicate "ok" row while the call stays stuck "running".
    expect(groups).toHaveLength(1);
    expect(groups[0]!.entries).toHaveLength(1);
    expect(groups[0]!.entries[0]).toMatchObject({ itemId: "toolu_1", tool: "read", arg: "a.ts", status: "ok" });
  });

  it("backfills empty stream-path args from the enriched tool_call re-emit (same itemId)", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", { type: "tool_call", tool: "Bash", args: {}, itemId: "toolu_2", turnId: "turn-1" }),
      env("2026-01-01T12:00:01.000Z", { type: "tool_call", tool: "Bash", args: { command: "ls -la" }, itemId: "toolu_2", turnId: "turn-1" }),
      env("2026-01-01T12:00:02.000Z", { type: "tool_result", tool: "Bash", result: "total 0", itemId: "toolu_2", turnId: "turn-1", status: "completed" } as AgentChatEvent),
    ];
    const blocks = aggregate(events);
    const groups = blocks.filter((b) => b.kind === "tool-calls-group") as Extract<AggregatedBlock, { kind: "tool-calls-group" }>[];
    expect(groups).toHaveLength(1);
    expect(groups[0]!.entries).toHaveLength(1);
    expect(groups[0]!.entries[0]).toMatchObject({ itemId: "toolu_2", tool: "bash", arg: "ls -la", status: "ok" });
  });

  it("does not duplicate text when un-coalesced deltas of one message replay from history", () => {
    // History replay delivers the raw per-delta envelopes (no live coalescing);
    // renderChatLines fuses them into ONE line owned by the first delta, so the
    // aggregate pass must not append the later deltas' text a second time.
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", { type: "text", text: "Both expl", messageId: "m9", turnId: "turn-1" }),
      env("2026-01-01T12:00:00.400Z", { type: "text", text: "orations are complete — what", messageId: "m9", turnId: "turn-1" }),
      env("2026-01-01T12:00:00.700Z", { type: "activity", activity: "thinking", detail: "Thinking", turnId: "turn-1" } as AgentChatEvent),
      env("2026-01-01T12:00:00.900Z", { type: "text", text: " docs exist.", messageId: "m9", turnId: "turn-1" }),
      env("2026-01-01T12:00:01.000Z", { type: "done", turnId: "turn-1", status: "completed" } as AgentChatEvent),
    ];
    const blocks = aggregate(events);
    const texts = blocks.filter((b) => b.kind === "assistant-text") as Extract<AggregatedBlock, { kind: "assistant-text" }>[];
    expect(texts).toHaveLength(1);
    expect(texts[0]!.line.body).toBe("Both explorations are complete — what docs exist.");
  });

  it("folds a durable resolution into its original unprocessed user block", () => {
    const events: AgentChatEventEnvelope[] = [
      env("2026-01-01T12:00:00.000Z", {
        type: "user_message",
        text: "Continue",
        steerId: "steer-1",
        deliveryState: "unprocessed",
      }),
      env("2026-01-01T12:00:01.000Z", {
        type: "user_message_resolution",
        steerId: "steer-1",
        action: "dismiss",
        state: "completed",
        resolvedAt: "2026-01-01T12:00:01.000Z",
      }),
    ];

    const blocks = aggregate(events);
    expect(blocks).toEqual([expect.objectContaining({
      kind: "user-bubble",
      line: expect.objectContaining({
        header: "not processed · dismissed",
        body: "Continue",
      }),
    })]);
  });
});
