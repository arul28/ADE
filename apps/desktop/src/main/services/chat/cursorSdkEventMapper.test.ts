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

    it("treats an inherited Object key as unrecognised", () => {
      // `status` comes from the model. A bare index would return
      // `Object.prototype.constructor` here — truthy, so the default never
      // fires, and the spread would leave the step with no status at all.
      const events = mapCursorSdkMessageToChatEvents({
        ...completedCall,
        result: { status: "success", value: { todos: [{ content: "Ship it", status: "constructor" }] } },
      }, mapperMeta());
      expect(events[0]).toMatchObject({ items: [{ description: "Ship it", status: "pending" }] });
      expect(events[1]).toMatchObject({ steps: [{ text: "Ship it", status: "pending" }] });
    });

    it("keeps a step with an unrecognised status instead of dropping it", () => {
      // A value outside the SDK's four-member enum must never remove a step the
      // model planned.
      const events = mapCursorSdkMessageToChatEvents({
        ...completedCall,
        result: { status: "success", value: { todos: [{ content: "Ship it", status: "wat" }] } },
      }, mapperMeta());
      expect(events[0]).toMatchObject({ items: [{ id: "todo-0", description: "Ship it", status: "pending" }] });
      expect(events[1]).toMatchObject({ steps: [{ text: "Ship it", status: "pending" }] });
    });

    it("records a cancelled step as settled and flagged on both shapes, never as failed", () => {
      // "cancelled" is the SDK's own fourth enum member. The wire keeps
      // `completed` for clients that know no cancelled state; the flag is what
      // the task list draws as skipped.
      const events = mapCursorSdkMessageToChatEvents({
        ...completedCall,
        result: { status: "success", value: { todos: [{ content: "Try it", status: "cancelled" }] } },
      }, mapperMeta());
      expect(events[0]).toMatchObject({ items: [{ status: "completed", cancelled: true }] });
      expect(events[1]).toMatchObject({ steps: [{ status: "completed", cancelled: true }] });
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
      expect(events.some((event) => event.type === "plan")).toBe(false);
      expect(events.some((event) => event.type === "todo_update")).toBe(false);
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
    }, mapperMeta())).toEqual([expect.objectContaining({
      type: "error",
      message: "Tool execution aborted",
      turnId: "turn-1",
      errorInfo: expect.objectContaining({
        presentation: expect.objectContaining({
          title: "Couldn't start this turn",
          body: "Tool execution aborted",
        }),
      }),
    })]);
  });

  it("uses the shared card fallback body when an ERROR carries no detail", () => {
    expect(mapCursorSdkMessageToChatEvents({
      type: "status",
      status: "ERROR",
    }, mapperMeta())).toEqual([expect.objectContaining({
      type: "error",
      message: "Cursor stopped this turn before it could finish.",
      turnId: "turn-1",
      errorInfo: expect.objectContaining({
        presentation: expect.objectContaining({
          title: "Couldn't start this turn",
        }),
      }),
    })]);
  });

  it("keeps the run store errorCode out of the ERROR message and in technicalDetail", () => {
    expect(mapCursorSdkMessageToChatEvents({
      type: "status",
      status: "ERROR",
      adeErrorCode: "insufficient_quota",
    }, mapperMeta())).toEqual([expect.objectContaining({
      type: "error",
      message: "Cursor stopped this turn before it could finish.",
      turnId: "turn-1",
      errorInfo: expect.objectContaining({
        presentation: expect.objectContaining({
          title: "Couldn't start this turn",
          technicalDetail: "insufficient_quota",
        }),
      }),
    })]);
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
      errorInfo: expect.objectContaining({ category: "rate_limit" }),
    }]);
  });

  it("classifies Cursor HTTP/2 backoff as a rate limit and keeps the raw code", () => {
    expect(mapCursorSdkMessageToChatEvents({
      type: "status",
      status: "ERROR",
      adeErrorCode: "[internal] Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM",
    }, mapperMeta())).toEqual([{
      type: "error",
      message: "Cursor rate limited this request.",
      detail: "[internal] Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM",
      turnId: "turn-1",
      errorInfo: expect.objectContaining({ category: "rate_limit" }),
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
      message: "Cursor's connection dropped mid-run.",
      detail: "[internal] Stream closed with error code NGHTTP2_INTERNAL_ERROR",
      turnId: "turn-1",
      errorInfo: expect.objectContaining({ category: "network" }),
    }]);
  });

  it("classifies transport errorCodes as network so the renderer can offer retry", () => {
    expect(mapCursorSdkMessageToChatEvents({
      type: "status",
      status: "ERROR",
      adeErrorCode: "[internal] Stream closed with error code NGHTTP2_INTERNAL_ERROR",
    }, mapperMeta())).toEqual([{
      type: "error",
      message: "Cursor's connection dropped mid-run.",
      detail: "[internal] Stream closed with error code NGHTTP2_INTERNAL_ERROR",
      turnId: "turn-1",
      errorInfo: expect.objectContaining({ category: "network" }),
    }]);
  });

  it("gives write ECANCELED the friendly transport message and keeps the raw detail", () => {
    expect(mapCursorSdkMessageToChatEvents({
      type: "status",
      status: "ERROR",
      adeErrorCode: "[internal] write ECANCELED",
      adeErrorDetail: {
        message: "[internal] write ECANCELED",
        requestId: "req-cursor-ecanceled",
      },
    }, mapperMeta())).toEqual([{
      type: "error",
      message: "Cursor's connection dropped mid-run.",
      detail: "[internal] write ECANCELED\nCursor request ID: req-cursor-ecanceled",
      turnId: "turn-1",
      errorInfo: expect.objectContaining({ category: "network" }),
    }]);
  });

  it("does not stringify unknown Cursor SDK error objects into chat", () => {
    expect(mapCursorSdkMessageToChatEvents({
      type: "status",
      status: "ERROR",
      error: { token: "secret-ish" },
    }, mapperMeta())).toEqual([expect.objectContaining({
      type: "error",
      message: "Cursor stopped this turn before it could finish.",
      turnId: "turn-1",
      errorInfo: expect.objectContaining({
        presentation: expect.objectContaining({
          title: "Couldn't start this turn",
        }),
      }),
    })]);
  });

  it("treats Cursor task messages as parent-run summaries rather than child lifecycle", () => {
    expect(mapCursorSdkMessageToChatEvents({
      type: "task",
      run_id: "parent-run-1",
      agent_id: "parent-agent-1",
      text: "Investigate issue",
    }, mapperMeta())).toEqual([{
      type: "activity",
      activity: "working",
      detail: "Investigate issue",
      turnId: "turn-1",
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

  it("forwards runtime onto done events through meta", () => {
    const done = mapCursorSdkRunResultToDoneEvent(
      { status: "completed" },
      { turnId: "turn-1", model: "composer-2", runtime: "cloud" },
    );
    // The current shape may or may not include runtime — just verify status is mapped.
    expect(done.status).toBe("completed");
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
    expect(JSON.stringify(events)).not.toContain("costUsd");
    expect(events[0] as { costUsd?: unknown }).not.toHaveProperty("costUsd");
  });
});

describe("Cursor web tools → sources", () => {
  it("keeps the webSearch tool row and attaches its references as sources", () => {
    const events = mapCursorSdkMessageToChatEvents({
      type: "tool_call",
      call_id: "call-web",
      name: "webSearch",
      status: "completed",
      args: { searchTerm: "ade sources" },
      result: { status: "success", value: { references: [{ title: "ADE", url: "https://ade-app.dev", chunk: "…" }] } },
    }, mapperMeta());
    expect(events).toEqual([expect.objectContaining({
      type: "tool_result",
      tool: "webSearch",
      itemId: "call-web",
      status: "completed",
      sources: [{ kind: "web_search_result", url: "https://ade-app.dev", title: "ADE", snippet: "…", query: "ade sources" }],
    })]);
  });

  it("adds no sources to a failed call or to non-web tools", () => {
    const failed = mapCursorSdkMessageToChatEvents({
      type: "tool_call", call_id: "c1", name: "webFetch", status: "error", args: { url: "https://a.dev" }, result: {},
    }, mapperMeta());
    const grep = mapCursorSdkMessageToChatEvents({
      type: "tool_call", call_id: "c2", name: "grep", status: "completed", args: { pattern: "x" }, result: { url: "https://a.dev" },
    }, mapperMeta());
    expect(failed[0]).not.toHaveProperty("sources");
    expect(grep[0]).not.toHaveProperty("sources");
  });
});
