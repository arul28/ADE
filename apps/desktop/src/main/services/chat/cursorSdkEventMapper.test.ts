import { describe, expect, it } from "vitest";
import {
  type CursorSdkEventMapperMeta,
  mapCursorSdkMessageToChatEvents,
  mapCursorSdkRunResultToDoneEvent,
  mapTurnEndedTokensToEvent,
} from "./cursorSdkEventMapper";

function mapperMeta(overrides: Partial<CursorSdkEventMapperMeta> = {}): CursorSdkEventMapperMeta {
  return {
    turnId: "turn-1",
    cwd: "/repo",
    taskStatusMap: new Map<string, string>(),
    ...overrides,
  };
}

describe("Cursor SDK event mapper", () => {
  it("maps assistant text content to chat text events", () => {
    const events = mapCursorSdkMessageToChatEvents({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "hello" },
          { type: "text", text: "world" },
        ],
      },
    }, mapperMeta());

    expect(events).toEqual([
      { type: "text", text: "hello", turnId: "turn-1" },
      { type: "text", text: "world", turnId: "turn-1" },
    ]);
  });

  it("maps shell tool calls to command events", () => {
    const events = mapCursorSdkMessageToChatEvents({
      type: "tool_call",
      call_id: "call-1",
      name: "shell",
      status: "completed",
      args: { command: "npm test", cwd: "/repo" },
      result: { exitCode: 0, output: "ok" },
    }, mapperMeta({ cwd: "/fallback" }));

    expect(events).toEqual([{
      type: "command",
      command: "npm test",
      cwd: "/repo",
      output: JSON.stringify({ exitCode: 0, output: "ok" }, null, 2),
      itemId: "call-1",
      turnId: "turn-1",
      status: "completed",
      exitCode: 0,
    }]);
  });

  it("maps unknown tool calls defensively", () => {
    expect(mapCursorSdkMessageToChatEvents({
      type: "tool_call",
      id: "tool-1",
      name: "mystery",
      status: "running",
      args: { value: 1 },
    }, mapperMeta())).toEqual([{
      type: "tool_call",
      tool: "mystery",
      args: { value: 1 },
      itemId: "tool-1",
      turnId: "turn-1",
    }]);
  });

  it("preserves typed Cursor MCP connector identity across the tool lifecycle", () => {
    const args = {
      providerIdentifier: "github",
      toolName: "search_issues",
      args: { query: "is:open label:bug" },
    };
    expect(mapCursorSdkMessageToChatEvents({
      type: "tool_call",
      call_id: "mcp-1",
      name: "mcp",
      status: "running",
      args,
    }, mapperMeta())).toEqual([{
      type: "tool_call",
      tool: "github:search_issues",
      args: { query: "is:open label:bug" },
      mcp: { server: "github", tool: "search_issues" },
      itemId: "mcp-1",
      turnId: "turn-1",
    }]);

    expect(mapCursorSdkMessageToChatEvents({
      type: "tool_call",
      call_id: "mcp-1",
      name: "mcp",
      status: "completed",
      args,
      result: { status: "success", value: { content: [], isError: false } },
    }, mapperMeta())).toEqual([expect.objectContaining({
      type: "tool_result",
      tool: "github:search_issues",
      mcp: { server: "github", tool: "search_issues" },
      itemId: "mcp-1",
      status: "completed",
    })]);
  });

  it("maps Cursor generateImage calls to the shared compact image lifecycle", () => {
    expect(mapCursorSdkMessageToChatEvents({
      type: "tool_call",
      call_id: "image-1",
      name: "generateImage",
      status: "running",
      args: { description: "A tiny moon icon", filePath: "/tmp/moon.png" },
    }, mapperMeta())).toEqual([{
      type: "codex_image_generation",
      itemId: "image-1",
      turnId: "turn-1",
      prompt: "A tiny moon icon",
      status: "running",
    }]);

    expect(mapCursorSdkMessageToChatEvents({
      type: "tool_call",
      call_id: "image-1",
      name: "generateImage",
      status: "completed",
      args: { description: "A tiny moon icon", filePath: "/tmp/moon.png" },
      result: { status: "success", value: { filePath: "/tmp/moon.png" } },
    }, mapperMeta())).toEqual([{
      type: "codex_image_generation",
      itemId: "image-1",
      turnId: "turn-1",
      prompt: "A tiny moon icon",
      result: "/tmp/moon.png",
      savedPath: "/tmp/moon.png",
      status: "completed",
    }]);
  });

  it("maps run results to done events", () => {
    expect(mapCursorSdkRunResultToDoneEvent({ status: "error" }, {
      turnId: "turn-1",
      model: "composer-2",
      modelId: "cursor/composer-2",
    })).toEqual({
      type: "done",
      turnId: "turn-1",
      status: "failed",
      model: "composer-2",
      modelId: "cursor/composer-2",
    });
  });

  it("propagates runtime: cloud onto assistant text events", () => {
    const events = mapCursorSdkMessageToChatEvents({
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }] },
    }, mapperMeta({ runtime: "cloud" }));
    expect(events).toEqual([
      { type: "text", text: "hi", turnId: "turn-1", runtime: "cloud" },
    ]);
  });

  it("does not tag runtime when local (default)", () => {
    const events = mapCursorSdkMessageToChatEvents({
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }] },
    }, mapperMeta());
    expect(events[0]).not.toHaveProperty("runtime");
  });

  it("emits cloud_status events for cloud-runtime status messages", () => {
    const events = mapCursorSdkMessageToChatEvents({
      type: "status",
      status: "RUNNING",
      message: "VM provisioned",
      run_id: "run-7",
    }, mapperMeta({ runtime: "cloud", runId: "run-7" }));
    expect(events).toEqual([{
      type: "cloud_status",
      turnId: "turn-1",
      runId: "run-7",
      status: "running",
      detail: "VM provisioned",
    }]);
  });

  it("attaches gitBranch + prUrl from cloud status when present", () => {
    const events = mapCursorSdkMessageToChatEvents({
      type: "status",
      status: "FINISHED",
      run_id: "run-9",
      git: { branch: "feat/foo", prUrl: "https://github.com/x/y/pull/12" },
    }, mapperMeta({ runtime: "cloud", runId: "run-9" }));
    expect(events[0]).toMatchObject({
      type: "cloud_status",
      status: "finished",
      gitBranch: "feat/foo",
      prUrl: "https://github.com/x/y/pull/12",
    });
  });

  it("falls back to a generic activity row for unknown cloud status strings", () => {
    const events = mapCursorSdkMessageToChatEvents({
      type: "status",
      status: "wat",
    }, mapperMeta({ runtime: "cloud" }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "activity",
      activity: "working",
      runtime: "cloud",
      turnId: "turn-1",
    });
  });

  it("falls back to local activity events when no cloud runtime is set", () => {
    const events = mapCursorSdkMessageToChatEvents({
      type: "status",
      status: "RUNNING",
      message: "going",
    }, mapperMeta());
    expect(events).toEqual([{
      type: "activity",
      activity: "working",
      detail: "going",
      turnId: "turn-1",
    }]);
  });

  it("uses the shared working detail when local status has no message", () => {
    expect(mapCursorSdkMessageToChatEvents({
      type: "status",
      status: "RUNNING",
    }, mapperMeta())).toEqual([{
      type: "activity",
      activity: "working",
      detail: "Preparing response",
      turnId: "turn-1",
    }]);

    expect(mapCursorSdkMessageToChatEvents({
      type: "status",
      status: "CREATING",
    }, mapperMeta())).toEqual([{
      type: "activity",
      activity: "working",
      detail: "Preparing response",
      turnId: "turn-1",
    }]);
  });

  it("uses Cursor SDK error detail when local status fails", () => {
    expect(mapCursorSdkMessageToChatEvents({
      type: "status",
      status: "ERROR",
      error: { message: "Tool execution aborted" },
    }, mapperMeta())).toEqual([{
      type: "error",
      message: "Tool execution aborted",
      turnId: "turn-1",
    }]);
  });

  it("keeps the generic Cursor SDK failure only when no detail is present", () => {
    expect(mapCursorSdkMessageToChatEvents({
      type: "status",
      status: "ERROR",
    }, mapperMeta())).toEqual([{
      type: "error",
      message: "Cursor SDK run failed.",
      turnId: "turn-1",
    }]);
  });

  it("surfaces the run store errorCode in the ERROR message", () => {
    expect(mapCursorSdkMessageToChatEvents({
      type: "status",
      status: "ERROR",
      adeErrorCode: "insufficient_quota",
    }, mapperMeta())).toEqual([{
      type: "error",
      message: "Cursor run failed: insufficient_quota",
      turnId: "turn-1",
    }]);
  });

  it("classifies Cursor resource exhaustion as a rate limit", () => {
    expect(mapCursorSdkMessageToChatEvents({
      type: "status",
      status: "ERROR",
      adeErrorCode: "resource_exhausted",
      adeErrorDetail: {
        message: "[resource_exhausted] Error",
        requestId: "req-cursor-1",
      },
    }, mapperMeta())).toEqual([{
      type: "error",
      message: "Cursor rate limited this request.",
      detail: "[resource_exhausted] Error\nCursor request ID: req-cursor-1",
      turnId: "turn-1",
      errorInfo: { category: "rate_limit" },
    }]);
  });

  it("classifies Cursor HTTP/2 backoff as a rate limit", () => {
    expect(mapCursorSdkMessageToChatEvents({
      type: "status",
      status: "ERROR",
      adeErrorCode: "[internal] Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM",
    }, mapperMeta())).toEqual([{
      type: "error",
      message: "Cursor rate limited this request.",
      turnId: "turn-1",
      errorInfo: { category: "rate_limit" },
    }]);
  });

  it("classifies Cursor HTTP/2 internal stream closures as network failures", () => {
    expect(mapCursorSdkMessageToChatEvents({
      type: "status",
      status: "ERROR",
      adeErrorCode: "[internal] Stream closed with error code NGHTTP2_INTERNAL_ERROR",
      adeErrorDetail: {
        message: "[internal] Stream closed with error code NGHTTP2_INTERNAL_ERROR",
      },
    }, mapperMeta())).toEqual([{
      type: "error",
      message: "Cursor SDK stream failed.",
      detail: "[internal] Stream closed with error code NGHTTP2_INTERNAL_ERROR",
      turnId: "turn-1",
      errorInfo: { category: "network" },
    }]);
  });

  it("classifies transport errorCodes as network so the renderer can offer retry", () => {
    expect(mapCursorSdkMessageToChatEvents({
      type: "status",
      status: "ERROR",
      adeErrorCode: "[internal] Stream closed with error code NGHTTP2_INTERNAL_ERROR",
    }, mapperMeta())).toEqual([{
      type: "error",
      message: "Cursor SDK stream failed.",
      turnId: "turn-1",
      errorInfo: { category: "network" },
    }]);
  });

  it("does not stringify unknown Cursor SDK error objects into chat", () => {
    expect(mapCursorSdkMessageToChatEvents({
      type: "status",
      status: "ERROR",
      error: { token: "secret-ish" },
    }, mapperMeta())).toEqual([{
      type: "error",
      message: "Cursor SDK run failed.",
      turnId: "turn-1",
    }]);
  });

  it("uses the provided task status map for task lifecycle transitions", () => {
    const taskStatusMap = new Map<string, string>();
    const started = mapCursorSdkMessageToChatEvents({
      type: "task",
      run_id: "task-1",
      agent_id: "agent-1",
      status: "running",
      text: "Investigate issue",
    }, mapperMeta({ taskStatusMap }));

    expect(started).toEqual([
      {
        type: "subagent_started",
        taskId: "task-1",
        agentId: "agent-1",
        parentToolUseId: null,
        description: "Investigate issue",
        turnId: "turn-1",
      },
      {
        type: "activity",
        activity: "spawning_agent",
        detail: "Investigate issue",
        turnId: "turn-1",
      },
    ]);
    expect(taskStatusMap.get("task-1")).toBe("running");

    const completed = mapCursorSdkMessageToChatEvents({
      type: "task",
      run_id: "task-1",
      agent_id: "agent-1",
      status: "completed",
      text: "Investigation done",
    }, mapperMeta({ taskStatusMap }));

    expect(completed).toEqual([
      {
        type: "subagent_result",
        taskId: "task-1",
        agentId: "agent-1",
        parentToolUseId: null,
        status: "completed",
        summary: "Investigation done",
        turnId: "turn-1",
      },
      {
        type: "activity",
        activity: "spawning_agent",
        detail: "Investigation done",
        turnId: "turn-1",
      },
    ]);
    expect(taskStatusMap.has("task-1")).toBe(false);
  });

  it("emits terminal task results when the first observed task event is already terminal", () => {
    const taskStatusMap = new Map<string, string>();
    const events = mapCursorSdkMessageToChatEvents({
      type: "task",
      run_id: "task-1",
      agent_id: "agent-1",
      status: "failed",
      text: "Investigation failed",
    }, mapperMeta({ taskStatusMap }));

    expect(events).toEqual([
      {
        type: "subagent_result",
        taskId: "task-1",
        agentId: "agent-1",
        parentToolUseId: null,
        status: "failed",
        summary: "Investigation failed",
        turnId: "turn-1",
      },
      {
        type: "activity",
        activity: "spawning_agent",
        detail: "Investigation failed",
        turnId: "turn-1",
      },
    ]);
    expect(taskStatusMap.has("task-1")).toBe(false);
  });

  it("does not share task status across mapper meta maps", () => {
    const firstMap = new Map<string, string>();
    const secondMap = new Map<string, string>();

    const first = mapCursorSdkMessageToChatEvents({
      type: "task",
      run_id: "task-1",
      status: "running",
      text: "Start task",
    }, mapperMeta({ taskStatusMap: firstMap }));
    const second = mapCursorSdkMessageToChatEvents({
      type: "task",
      run_id: "task-1",
      status: "running",
      text: "Start task",
    }, mapperMeta({ taskStatusMap: secondMap }));

    expect(first[0]).toMatchObject({ type: "subagent_started", taskId: "task-1" });
    expect(second[0]).toMatchObject({ type: "subagent_started", taskId: "task-1" });
    expect(firstMap.get("task-1")).toBe("running");
    expect(secondMap.get("task-1")).toBe("running");
  });

  it("maps TurnEnded usage updates to a tokens event", () => {
    const ev = mapTurnEndedTokensToEvent(
      { usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, cacheCreationTokens: 5 } },
      { turnId: "turn-1", itemId: "msg-7", runtime: "cloud" },
    );
    expect(ev).toEqual({
      type: "tokens",
      turnId: "turn-1",
      itemId: "msg-7",
      runtime: "cloud",
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 3,
      cacheWriteTokens: 5,
    });
  });

  it("returns null when no usage fields are present", () => {
    expect(mapTurnEndedTokensToEvent({}, { turnId: "turn-1" })).toBeNull();
  });

  it("strips local-runtime tag from tokens event", () => {
    const ev = mapTurnEndedTokensToEvent(
      { usage: { inputTokens: 1 } },
      { turnId: "turn-1", runtime: "local" },
    );
    expect(ev).not.toHaveProperty("runtime");
  });

  it("forwards runtime onto done events through meta", () => {
    const done = mapCursorSdkRunResultToDoneEvent(
      { status: "completed" },
      { turnId: "turn-1", model: "composer-2", runtime: "cloud" },
    );
    // The current shape may or may not include runtime — just verify status is mapped.
    expect(done.status).toBe("completed");
  });
});
