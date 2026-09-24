import { describe, expect, it } from "vitest";
import {
  type CursorSdkEventMapperMeta,
  createCursorSdkEventMapperState,
  mapCursorSdkMessageToChatEvents,
  mapCursorSdkRunResultToDoneEvent,
  mapTurnEndedTokensToEvent,
} from "./cursorSdkEventMapper";

function mapperMeta(overrides: Partial<CursorSdkEventMapperMeta> = {}): CursorSdkEventMapperMeta {
  return {
    turnId: "turn-1",
    cwd: "/repo",
    state: createCursorSdkEventMapperState(),
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

  // Payloads below are copied from a real `@cursor/sdk` 1.0.31 local run, not
  // invented: `updateTodos` streams the growing list on `running` and repeats
  // the final list with `completed`.
  describe("updateTodos", () => {
    const completedCall = {
      type: "tool_call",
      call_id: "tool_8711b80d",
      name: "updateTodos",
      status: "completed",
      args: {
        todos: [
          { content: "Add subtract(a, b) to math.js", status: "pending" },
          { content: "Add multiply(a, b) to math.js", status: "pending" },
        ],
      },
      result: {
        status: "success",
        value: {
          todos: [
            { content: "Add subtract(a, b) to math.js", status: "completed" },
            // camelCase, as the SDK's own proto-to-string conversion emits it.
            { content: "Add multiply(a, b) to math.js", status: "inProgress" },
          ],
        },
      },
    };

    it("emits nothing while the list is still streaming", () => {
      // One event lands per item added. Mapping them would redraw the plan card
      // once per todo, and the last two carry identical lists.
      expect(mapCursorSdkMessageToChatEvents({
        ...completedCall,
        status: "running",
        result: undefined,
      }, mapperMeta())).toEqual([]);
    });

    it("emits a todo update and a plan from the terminal event", () => {
      // The expectations follow the RESULT, not the arguments: the arguments are
      // what the model asked for, the result is what the tool recorded.
      const events = mapCursorSdkMessageToChatEvents(completedCall, mapperMeta());
      expect(events).toEqual([
        {
          type: "todo_update",
          items: [
            { id: "todo-0", description: "Add subtract(a, b) to math.js", status: "completed" },
            { id: "todo-1", description: "Add multiply(a, b) to math.js", status: "in_progress" },
          ],
          turnId: "turn-1",
        },
        {
          type: "plan",
          steps: [
            { text: "Add subtract(a, b) to math.js", status: "completed" },
            { text: "Add multiply(a, b) to math.js", status: "in_progress" },
          ],
          turnId: "turn-1",
        },
      ]);
    });

    it("falls back to the arguments when the result carries no list", () => {
      const events = mapCursorSdkMessageToChatEvents({
        ...completedCall,
        result: { status: "success", value: {} },
      }, mapperMeta());
      expect(events[0]).toMatchObject({ items: [{ status: "pending" }, { status: "pending" }] });
    });

    // A value outside the SDK's four-member enum must never remove a step the
    // model planned. `constructor` guards against a bare index returning
    // `Object.prototype.constructor`. `todo_update` has no failure state; `plan`
    // does, and "cancelled" is the SDK's own fourth enum member.
    it.each([
      ["wat", "pending", "pending"],
      ["constructor", "pending", "pending"],
      ["cancelled", "pending", "failed"],
    ])("maps todo status %s to todo %s and plan step %s", (status, itemStatus, stepStatus) => {
      const events = mapCursorSdkMessageToChatEvents({
        ...completedCall,
        result: { status: "success", value: { todos: [{ content: "Ship it", status }] } },
      }, mapperMeta());
      expect(events[0]).toMatchObject({ items: [{ id: "todo-0", description: "Ship it", status: itemStatus }] });
      expect(events[1]).toMatchObject({ steps: [{ text: "Ship it", status: stepStatus }] });
    });

    it("keeps a failed call as a failed tool result rather than a plan", () => {
      // `result.value.todos` is absent on an error, so without this the `args`
      // fallback would render the list the model ASKED for as a recorded plan
      // and drop the failure row.
      const events = mapCursorSdkMessageToChatEvents({
        ...completedCall,
        status: "error",
        result: { status: "error", error: "todo write failed" },
      }, mapperMeta());
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "tool_result", status: "failed", itemId: "tool_8711b80d" });
    });

    it("emits nothing when the list is empty", () => {
      expect(mapCursorSdkMessageToChatEvents({
        ...completedCall,
        args: { todos: [] },
        result: { status: "success", value: { todos: [] } },
      }, mapperMeta())).toEqual([]);
    });
  });

  it("drops the user echo of a steered message", () => {
    // `Run.steer()` makes the SDK replay the steered text as a `user` event.
    // `dispatchSteer` already emitted that row with its steer id and delivery
    // state, so mapping this one would print the message twice.
    expect(mapCursorSdkMessageToChatEvents({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "stop and do this instead" }] },
    }, mapperMeta())).toEqual([]);
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
      account: { provider: "cursor", kind: "subscription" },
    });
  });

  it("reads the SDK run total, the login email, and the auto-served model into done", () => {
    const done = mapCursorSdkRunResultToDoneEvent({
      status: "finished",
      // `RunResult.usage` is the SDK's `TokenUsage`: cache writes are `cacheWriteTokens`.
      usage: {
        inputTokens: 1_200,
        outputTokens: 340,
        cacheReadTokens: 9_000,
        cacheWriteTokens: 450,
        totalTokens: 10_990,
        reasoningTokens: 120,
      },
      adeTurnTelemetry: { accountEmail: "dev@example.com", servedModel: "gpt-5.5" },
    }, { turnId: "turn-1", model: "auto" });
    expect(done).toMatchObject({
      status: "completed",
      model: "auto",
      servedModel: "gpt-5.5",
      usage: {
        inputTokens: 1_200,
        outputTokens: 340,
        cacheReadTokens: 9_000,
        cacheCreationTokens: 450,
        reasoningTokens: 120,
      },
      account: { provider: "cursor", kind: "subscription", email: "dev@example.com" },
    });
    expect(done.usage).not.toHaveProperty("contextTokens");
    expect(done).not.toHaveProperty("costUsd");
  });

  describe("preCompact hook compaction", () => {
    it("emits the measured occupancy, then a provider-reported compaction start", () => {
      const events = mapCursorSdkMessageToChatEvents({
        type: "ade_cursor_compaction",
        phase: "started",
        seq: 1,
        trigger: "auto",
        contextTokens: 150_000,
        contextWindowSize: 200_000,
        contextUsagePercent: 75,
        model: "claude-4.6-sonnet",
      }, mapperMeta());
      expect(events).toEqual([
        {
          type: "context_usage",
          origin: "live",
          state: "measured",
          turnId: "turn-1",
          usage: {
            categories: [],
            totalTokens: 150_000,
            maxTokens: 200_000,
            percentage: 75,
            model: "claude-4.6-sonnet",
          },
        },
        {
          type: "context_compact",
          trigger: "auto",
          state: "started",
          turnId: "turn-1",
          compactionId: "turn-1",
          provider: "cursor",
          detection: "provider",
          preTokens: 150_000,
        },
      ]);
    });

    it("skips the occupancy snapshot when the window size is missing", () => {
      const events = mapCursorSdkMessageToChatEvents({
        type: "ade_cursor_compaction",
        phase: "started",
        seq: 1,
        trigger: "manual",
        contextTokens: 150_000,
      }, mapperMeta());
      expect(events.map((event) => event.type)).toEqual(["context_compact"]);
      expect(events[0]).toMatchObject({ trigger: "manual", state: "started" });
    });

    it("closes with a duration and keys a second compaction apart from the first", () => {
      expect(mapCursorSdkMessageToChatEvents({
        type: "ade_cursor_compaction",
        phase: "completed",
        seq: 2,
        trigger: "auto",
        contextTokens: 190_000,
        durationMs: 3_100,
        closedBy: "summary",
      }, mapperMeta())).toEqual([{
        type: "context_compact",
        trigger: "auto",
        state: "completed",
        turnId: "turn-1",
        compactionId: "turn-1:compact-2",
        provider: "cursor",
        detection: "provider",
        preTokens: 190_000,
        durationMs: 3_100,
      }]);
    });

    it("marks a compaction cut off by a cancelled run as interrupted", () => {
      expect(mapCursorSdkMessageToChatEvents({
        type: "ade_cursor_compaction",
        phase: "failed",
        seq: 1,
        trigger: "auto",
        durationMs: 800,
        failReason: "interrupted",
      }, mapperMeta())).toEqual([expect.objectContaining({
        type: "context_compact",
        state: "failed",
        failReason: "interrupted",
        durationMs: 800,
      })]);
    });

    it("keeps the status-text fallback only when the hook did not report", () => {
      const status = { type: "status", status: "RUNNING", message: "Summarizing chat context" };
      expect(mapCursorSdkMessageToChatEvents(status, mapperMeta()).map((event) => event.type))
        .toEqual(["context_compact", "activity"]);
      expect(mapCursorSdkMessageToChatEvents({ ...status, adePreCompactHook: true }, mapperMeta())
        .map((event) => event.type)).toEqual(["activity"]);
    });
  });

  it("pairs a text-signalled compaction across events through the state the service owns", () => {
    const state = createCursorSdkEventMapperState();
    const compacting = { type: "status", status: "RUNNING", message: "Summarizing chat context" };
    const working = { type: "status", status: "RUNNING", message: "Editing files" };
    const compactStates = (message: unknown, turnId = "turn-1") => mapCursorSdkMessageToChatEvents(
      message,
      mapperMeta({ turnId, state }),
    ).flatMap((event) => (event.type === "context_compact" ? [event.state] : []));
    expect(compactStates(compacting)).toEqual(["started"]);
    expect(compactStates(compacting)).toEqual([]);
    expect(compactStates(working)).toEqual(["completed"]);
    expect(state.textCompactionTurnId).toBeNull();
    // A compaction left open by one turn does not close on the next.
    compactStates(compacting);
    expect(compactStates(working, "turn-2")).toEqual([]);
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

  it.each([
    [{ type: "status", status: "RUNNING", message: "going" }, "going"],
    [{ type: "status", status: "RUNNING" }, "Preparing response"],
    [{ type: "status", status: "CREATING" }, "Preparing response"],
    // Task messages are parent-run summaries, not child lifecycle.
    [{ type: "task", run_id: "parent-run-1", agent_id: "parent-agent-1", text: "Investigate issue" }, "Investigate issue"],
  ])("maps local %j to a working activity row", (message, detail) => {
    expect(mapCursorSdkMessageToChatEvents(message, mapperMeta())).toEqual([{
      type: "activity",
      activity: "working",
      detail,
      turnId: "turn-1",
    }]);
  });

  it.each([
    ["the SDK error detail", { error: { message: "Tool execution aborted" } }, "Tool execution aborted", { body: "Tool execution aborted" }],
    // The run store errorCode stays out of the message and lands in technicalDetail.
    ["the fallback body plus the run store code", { adeErrorCode: "insufficient_quota" }, "Cursor stopped this turn before it could finish.", { technicalDetail: "insufficient_quota" }],
    // Unknown error objects are never stringified into chat.
    ["the fallback body for an unknown error object", { error: { token: "secret-ish" } }, "Cursor stopped this turn before it could finish.", {}],
  ])("presents a local ERROR status with %s", (_label, fields, message, presentation) => {
    expect(mapCursorSdkMessageToChatEvents({ type: "status", status: "ERROR", ...fields }, mapperMeta())).toEqual([
      expect.objectContaining({
        type: "error",
        message,
        turnId: "turn-1",
        errorInfo: expect.objectContaining({
          presentation: expect.objectContaining({ title: "Couldn't start this turn", ...presentation }),
        }),
      }),
    ]);
  });

  it.each([
    [
      { adeErrorCode: "resource_exhausted", adeErrorDetail: { message: "[resource_exhausted] Error", requestId: "req-cursor-1" } },
      "Cursor rate limited this request.",
      "[resource_exhausted] Error\nCursor request ID: req-cursor-1",
      "rate_limit",
    ],
    [
      { adeErrorCode: "[internal] Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM" },
      "Cursor rate limited this request.",
      "[internal] Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM",
      "rate_limit",
    ],
    [
      {
        adeErrorCode: "[internal] Stream closed with error code NGHTTP2_INTERNAL_ERROR",
        adeErrorDetail: { message: "[internal] Stream closed with error code NGHTTP2_INTERNAL_ERROR" },
      },
      "Cursor's connection dropped mid-run.",
      "[internal] Stream closed with error code NGHTTP2_INTERNAL_ERROR",
      "network",
    ],
    [
      { adeErrorCode: "[internal] write ECANCELED", adeErrorDetail: { message: "[internal] write ECANCELED", requestId: "req-cursor-ecanceled" } },
      "Cursor's connection dropped mid-run.",
      "[internal] write ECANCELED\nCursor request ID: req-cursor-ecanceled",
      "network",
    ],
  ])("classifies Cursor ERROR %j with the friendly message and keeps the raw detail", (fields, message, detail, category) => {
    expect(mapCursorSdkMessageToChatEvents({ type: "status", status: "ERROR", ...fields }, mapperMeta())).toEqual([{
      type: "error",
      message,
      detail,
      turnId: "turn-1",
      errorInfo: expect.objectContaining({ category }),
    }]);
  });

  it("maps Cursor Task tool calls to subagent lifecycle events", () => {
    const started = mapCursorSdkMessageToChatEvents({
      type: "tool_call",
      call_id: "task-call-1",
      name: "task",
      status: "running",
      args: {
        description: "Investigate issue",
        prompt: "Trace the failure",
        subagentType: { kind: "explore", name: "Explorer" },
        model: "composer-2",
      },
    }, mapperMeta());

    expect(started).toEqual([
      {
        type: "activity",
        activity: "spawning_agent",
        detail: "Investigate issue",
        turnId: "turn-1",
      },
      {
        type: "tool_call",
        tool: "task",
        args: {
          description: "Investigate issue",
          prompt: "Trace the failure",
          subagentType: { kind: "explore", name: "Explorer" },
          model: "composer-2",
        },
        itemId: "task-call-1",
        turnId: "turn-1",
      },
      {
        type: "subagent_started",
        taskId: "task-call-1",
        agentType: "Explorer",
        label: "Explorer",
        model: "composer-2",
        parentToolUseId: "task-call-1",
        description: "Investigate issue",
        turnId: "turn-1",
      },
    ]);

    const completed = mapCursorSdkMessageToChatEvents({
      type: "tool_call",
      call_id: "task-call-1",
      name: "task",
      status: "completed",
      args: {
        description: "Investigate issue",
        prompt: "Trace the failure",
        subagentType: { kind: "explore", name: "Explorer" },
        model: "composer-2",
      },
      result: {
        status: "success",
        value: {
          agentId: "child-agent-1",
          isBackground: false,
          backgroundReason: "unspecified",
          durationMs: 1250,
          resultSuffix: "Found the lifecycle mismatch",
        },
      },
    }, mapperMeta());

    expect(completed).toEqual([
      expect.objectContaining({
        type: "tool_result",
        tool: "task",
        itemId: "task-call-1",
        status: "completed",
      }),
      {
        type: "subagent_result",
        taskId: "task-call-1",
        agentId: "child-agent-1",
        agentType: "Explorer",
        label: "Explorer",
        model: "composer-2",
        parentToolUseId: "task-call-1",
        status: "completed",
        summary: "Found the lifecycle mismatch",
        finalSummary: "Found the lifecycle mismatch",
        usage: { durationMs: 1250 },
        turnId: "turn-1",
      },
    ]);
  });

  it("maps failed Cursor Task tool calls to failed subagent results", () => {
    const events = mapCursorSdkMessageToChatEvents({
      type: "tool_call",
      call_id: "task-call-failed",
      name: "task",
      status: "error",
      args: {
        description: "Inspect the failing check",
        prompt: "Find the root cause",
      },
      result: {
        status: "error",
        error: { message: "Child agent could not start" },
      },
    }, mapperMeta());

    expect(events).toEqual([
      expect.objectContaining({
        type: "tool_result",
        itemId: "task-call-failed",
        status: "failed",
      }),
      expect.objectContaining({
        type: "subagent_result",
        taskId: "task-call-failed",
        status: "failed",
        summary: "Child agent could not start",
        finalSummary: "Child agent could not start",
      }),
    ]);
  });

  it("maps TurnEnded usage updates to a tokens event", () => {
    const ev = mapTurnEndedTokensToEvent(
      { usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, cacheCreationTokens: 5, reasoningTokens: 7 } },
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
      reasoningTokens: 7,
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

  it("maps stream type usage to a tokens event without costUsd", () => {
    const events = mapCursorSdkMessageToChatEvents({
      type: "usage",
      agent_id: "bc-agent-1",
      run_id: "run-1",
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        totalInputTokens: 12,
        totalOutputTokens: 8,
        cost: { rawCostCents: 4.2, chargedCents: 3.1 },
        costUsd: 0.031,
      },
    }, mapperMeta({ runtime: "cloud" }));

    expect(events).toEqual([
      expect.objectContaining({
        type: "tokens",
        turnId: "turn-1",
        itemId: "run-1",
        runtime: "cloud",
        inputTokens: 12,
        outputTokens: 8,
      }),
    ]);
    expect(events[0] as { costUsd?: unknown }).not.toHaveProperty("costUsd");
  });
});
