import { describe, expect, it } from "vitest";
import {
  createDroidSdkEventMapperState,
  mapDroidSdkMessageToChatEvents,
  mapDroidSdkRunResultToDoneEvent,
} from "./droidSdkEventMapper";

function map(message: unknown) {
  return mapDroidSdkMessageToChatEvents(message, {
    turnId: "turn-1",
    cwd: "/work",
    state: createDroidSdkEventMapperState(),
  });
}

describe("mapDroidSdkMessageToChatEvents — AGI mission workers", () => {
  it("maps mission_worker_started to a subagent_started event keyed by worker session id", () => {
    const events = map({ type: "mission_worker_started", workerSessionId: "worker-abc123def" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "subagent_started",
      taskId: "worker-abc123def",
      parentToolUseId: null,
      turnId: "turn-1",
    });
    // Description is derived from the worker id so concurrent workers stay distinct.
    expect((events[0] as { description: string }).description).toContain("Worker");
  });

  it("includes a worker model when the payload reports one", () => {
    const events = map({
      type: "mission_worker_started",
      workerSessionId: "worker-model-1",
      model: "gpt-5.4",
    });
    expect(events[0]).toMatchObject({
      type: "subagent_started",
      taskId: "worker-model-1",
      model: "gpt-5.4",
    });
  });

  it("omits model when the worker payload does not report one", () => {
    const events = map({ type: "mission_worker_started", workerSessionId: "worker-abc123def" });
    expect(events[0]).not.toHaveProperty("model");
  });

  it("maps a clean mission_worker_completed to a completed subagent_result with the exit code", () => {
    const events = map({ type: "mission_worker_completed", workerSessionId: "worker-1", exitCode: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "subagent_result",
      taskId: "worker-1",
      status: "completed",
    });
    expect((events[0] as { summary: string }).summary).toContain("0");
  });

  it("carries derived token usage from the worker settings payload", () => {
    const events = map({
      type: "mission_worker_completed",
      workerSessionId: "worker-usage",
      exitCode: 0,
      tokenUsage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 3,
        cacheCreationTokens: 4,
        thinkingTokens: 5,
      },
    });
    expect(events[0]).toMatchObject({
      type: "subagent_result",
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        reasoningTokens: 5,
        usageConfidence: "derived",
      },
    });
  });

  it("maps a non-zero exit code to a failed subagent_result", () => {
    const events = map({ type: "mission_worker_completed", workerSessionId: "worker-2", exitCode: 1 });
    expect(events[0]).toMatchObject({ type: "subagent_result", taskId: "worker-2", status: "failed" });
  });

  it("ignores heartbeat and malformed worker events", () => {
    expect(map({ type: "mission_heartbeat", timestamp: "2026-06-05T00:00:00Z" })).toEqual([]);
    expect(map({ type: "mission_worker_started" })).toEqual([]); // missing workerSessionId
  });
});

describe("mapDroidSdkMessageToChatEvents — AGI mission control", () => {
  it("maps mission_state_changed to a mission_state event", () => {
    expect(map({ type: "mission_state_changed", state: "running" })).toEqual([
      { type: "mission_state", state: "running", turnId: "turn-1" },
    ]);
  });

  it("maps mission_features_changed to a feature checklist, keeping worker assignment", () => {
    const events = map({
      type: "mission_features_changed",
      features: [
        { id: "f1", description: "Wire the API", status: "in_progress", skillName: "backend", currentWorkerSessionId: "w-1" },
        { id: "f2", description: "Add tests", status: "pending" },
        { bogus: true }, // missing id → skipped
      ],
    });
    expect(events).toHaveLength(1);
    const ev = events[0] as { type: string; features: Array<Record<string, unknown>> };
    expect(ev.type).toBe("mission_features");
    expect(ev.features).toHaveLength(2);
    expect(ev.features[0]).toMatchObject({ id: "f1", status: "in_progress", currentWorkerSessionId: "w-1", skillName: "backend" });
    expect(ev.features[1]).toMatchObject({ id: "f2", status: "pending" });
  });

  it("flattens mission_progress_entry progressLog into readable rows", () => {
    const events = map({
      type: "mission_progress_entry",
      progressLog: [
        { type: "worker_started", workerSessionId: "w-1", featureId: "f1" },
        { type: "worker_completed", workerSessionId: "w-1", featureId: "f1", message: "done" },
      ],
    });
    expect(events).toHaveLength(1);
    const ev = events[0] as { type: string; entries: Array<Record<string, unknown>> };
    expect(ev.type).toBe("mission_progress");
    expect(ev.entries).toHaveLength(2);
    expect(ev.entries[0]).toMatchObject({ type: "worker_started", workerSessionId: "w-1", featureId: "f1" });
    expect(ev.entries[1]).toMatchObject({ type: "worker_completed", text: "done" });
  });

  it("returns mission_state with no rows when state is missing", () => {
    expect(map({ type: "mission_state_changed" })).toEqual([]);
  });
});

describe("mapDroidSdkMessageToChatEvents — structured assistant content", () => {
  it("does not re-emit text a delta already streamed from the completed assistant message", () => {
    // The CLI streams `assistant_text_delta` and then the complete `assistant`
    // message for the same block; the completed message must not duplicate the
    // streamed text (a real 0.9.x regression when block ids are used as keys).
    const state = createDroidSdkEventMapperState();
    const mapWithState = (message: unknown) => mapDroidSdkMessageToChatEvents(message, {
      turnId: "turn-1",
      cwd: "/work",
      state,
    });

    expect(mapWithState({
      type: "assistant_text_delta",
      messageId: "m-1",
      blockIndex: 0,
      text: "Hello",
    })).toEqual([
      { type: "text", text: "Hello", itemId: "m-1:text:0", turnId: "turn-1" },
    ]);

    expect(mapWithState({
      type: "assistant",
      message: {
        id: "m-1",
        role: "assistant",
        content: [{ type: "text", id: "block-uuid-1", text: "Hello" }],
      },
      text: "Hello",
    })).toEqual([]);
  });

  it("maps assistant image blocks to the shared compact image event and dedupes replay", () => {
    const state = createDroidSdkEventMapperState();
    const message = {
      type: "assistant",
      message: {
        id: "message-1",
        role: "assistant",
        content: [
          { type: "text", text: "Here is the diagram." },
          {
            type: "image",
            id: "image-1",
            source: { type: "base64", mediaType: "image/png", data: "AAAA" },
          },
        ],
      },
      text: "Here is the diagram.",
    };
    const mapWithState = () => mapDroidSdkMessageToChatEvents(message, {
      turnId: "turn-1",
      cwd: "/work",
      state,
    });

    expect(mapWithState()).toEqual([
      expect.objectContaining({ type: "text", text: "Here is the diagram." }),
      {
        type: "codex_image_generation",
        itemId: "image-1",
        turnId: "turn-1",
        prompt: "Droid image output",
        result: "data:image/png;base64,AAAA",
        status: "completed",
      },
    ]);
    expect(mapWithState()).toEqual([
      expect.objectContaining({ type: "text", text: "Here is the diagram." }),
    ]);
  });

  it("keeps large inline images intact for the desktop live preview", () => {
    const imageData = "A".repeat(80 * 1024);

    const events = map({
      type: "assistant",
      message: {
        id: "message-large-image",
        role: "assistant",
        content: [{
          type: "image",
          id: "image-large",
          source: { type: "base64", mediaType: "image/png", data: imageData },
        }],
      },
    });

    expect(events).toEqual([{
      type: "codex_image_generation",
      itemId: "image-large",
      turnId: "turn-1",
      prompt: "Droid image output",
      result: `data:image/png;base64,${imageData}`,
      status: "completed",
    }]);
  });

  it("does not infer MCP identity from generic Droid tool names", () => {
    expect(map({
      type: "tool_call",
      toolUseId: "tool-1",
      name: "search_issues",
      input: { query: "bug" },
    })).toEqual([{
      type: "tool_call",
      tool: "search_issues",
      args: { query: "bug" },
      itemId: "tool-1",
      turnId: "turn-1",
    }]);
  });

  it("surfaces a terminal error with its provider message", () => {
    // The worker re-emits the failed `result`'s error as an `error` event so the
    // turn's cause reaches the transcript instead of only the done status.
    expect(map({
      type: "error",
      message: "Usage limit reached",
      errorType: "usage_limit",
      timestamp: "2026-09-21T00:00:00Z",
    })).toEqual([{
      type: "error",
      message: "Usage limit reached",
      turnId: "turn-1",
    }]);
  });
});

describe("mapDroidSdkMessageToChatEvents — Droid telemetry", () => {
  it("maps thinking tokens to reasoning tokens and keeps the latest cumulative update", () => {
    const state = createDroidSdkEventMapperState();
    const mapWithState = (message: unknown) => mapDroidSdkMessageToChatEvents(message, {
      turnId: "turn-1",
      cwd: "/work",
      state,
    });

    expect(mapWithState({
      type: "token_usage_update",
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationTokens: 1,
      cacheReadTokens: 2,
      thinkingTokens: 3,
    })[0]).toMatchObject({
      type: "tokens",
      inputTokens: 10,
      outputTokens: 20,
      cacheWriteTokens: 1,
      cacheReadTokens: 2,
      reasoningTokens: 3,
    });

    mapWithState({
      type: "token_usage_update",
      inputTokens: 30,
      outputTokens: 40,
      cacheCreationTokens: 4,
      cacheReadTokens: 5,
      thinkingTokens: 6,
    });
    expect(mapDroidSdkRunResultToDoneEvent({ success: true }, {
      turnId: "turn-1",
      model: "claude-sonnet-5",
      state,
    })).toMatchObject({
      usage: {
        inputTokens: 30,
        outputTokens: 40,
        cacheCreationTokens: 4,
        cacheReadTokens: 5,
        reasoningTokens: 6,
      },
      account: { provider: "droid", kind: "subscription" },
    });
  });

  it("maps provider context stats to a live measured context_usage event", () => {
    expect(map({
      type: "context_stats",
      contextStats: {
        used: 900,
        remaining: 1_100,
        limit: 2_000,
        accuracy: "estimated",
        updatedAt: "2026-09-23T12:00:00.000Z",
      },
    })).toEqual([{
      type: "context_usage",
      usage: {
        categories: [
          { name: "Used", tokens: 900, percentage: 45, kind: "used" },
          { name: "Free", tokens: 1_100, percentage: 55, kind: "free" },
        ],
        totalTokens: 900,
        maxTokens: 2_000,
        rawMaxTokens: 2_000,
        percentage: 45,
      },
      origin: "live",
      state: "measured",
      capturedAt: "2026-09-23T12:00:00.000Z",
      turnId: "turn-1",
    }]);
  });

  it("recognizes Droid's compaction enum and keeps the tagged start sample as the pre-size", () => {
    const state = createDroidSdkEventMapperState();
    const mapWithState = (message: unknown) => mapDroidSdkMessageToChatEvents(message, {
      turnId: "turn-1",
      cwd: "/work",
      state,
    });
    const stats = (used: number, updatedAt: string) => ({
      used,
      remaining: 2_000 - used,
      limit: 2_000,
      accuracy: "exact",
      updatedAt,
    });
    expect(mapWithState({ type: "working_state_changed", state: "compacting_conversation" })).toContainEqual(
      expect.objectContaining({ type: "context_compact", state: "started", provider: "droid", detection: "provider" }),
    );
    // The start sample lands mid-compaction: it is the pre-size, not a meter reading.
    expect(mapWithState({
      type: "context_stats",
      phase: "compaction_start",
      contextStats: stats(1_800, "2026-09-23T12:00:00.000Z"),
    })).toEqual([]);

    const completed = mapWithState({ type: "working_state_changed", state: "idle" });
    expect(completed).toEqual([expect.objectContaining({
      type: "context_compact",
      state: "completed",
      provider: "droid",
      detection: "provider",
      preTokens: 1_800,
    })]);
    expect(completed[0]).not.toHaveProperty("postTokens");
    // The post sample arrives after the marker and moves the meter.
    expect(mapWithState({ type: "context_stats", contextStats: stats(700, "2026-09-23T12:00:01.000Z") })).toEqual([
      expect.objectContaining({ type: "context_usage", usage: expect.objectContaining({ totalTokens: 700 }) }),
    ]);
  });

  it("drops a compaction start sample that lands after the compaction closed", () => {
    const state = createDroidSdkEventMapperState();
    const mapWithState = (message: unknown) => mapDroidSdkMessageToChatEvents(message, {
      turnId: "turn-1",
      cwd: "/work",
      state,
    });
    mapWithState({ type: "working_state_changed", state: "compacting_conversation" });
    mapWithState({ type: "working_state_changed", state: "streaming_assistant_message" });
    expect(mapWithState({
      type: "context_stats",
      phase: "compaction_start",
      contextStats: { used: 1_800, remaining: 200, limit: 2_000, accuracy: "exact", updatedAt: "2026-09-23T12:00:00.000Z" },
    })).toEqual([]);
    expect(state.compactionPreTokens).toBeUndefined();
  });

  it("keeps a trailing sample on the turn that took it, even after the next turn started", () => {
    const state = createDroidSdkEventMapperState();
    const mapTurnTwo = (message: unknown) => mapDroidSdkMessageToChatEvents(message, {
      turnId: "turn-2",
      cwd: "/work",
      state,
    });
    const stats = { used: 900, remaining: 1_100, limit: 2_000, accuracy: "exact", updatedAt: "2026-09-23T12:00:00.000Z" };
    expect(mapTurnTwo({ type: "context_stats", contextStats: stats, turnId: "turn-1" })).toEqual([
      expect.objectContaining({ type: "context_usage", turnId: "turn-1" }),
    ]);
    // An unstamped sample (an older worker) still takes the current turn.
    expect(mapTurnTwo({ type: "context_stats", contextStats: stats })).toEqual([
      expect.objectContaining({ type: "context_usage", turnId: "turn-2" }),
    ]);
    // Turn one's compaction-start sample never seeds turn two's compaction.
    mapTurnTwo({ type: "working_state_changed", state: "compacting_conversation" });
    expect(mapTurnTwo({ type: "context_stats", phase: "compaction_start", contextStats: stats, turnId: "turn-1" }))
      .toEqual([]);
    expect(state.compactionPreTokens).toBeUndefined();
    mapTurnTwo({ type: "context_stats", phase: "compaction_start", contextStats: stats, turnId: "turn-2" });
    expect(state.compactionPreTokens).toBe(900);
  });

  it("closes a compaction on any non-compacting state, once", () => {
    const state = createDroidSdkEventMapperState();
    const mapWithState = (message: unknown) => mapDroidSdkMessageToChatEvents(message, {
      turnId: "turn-1",
      cwd: "/work",
      state,
    });
    mapWithState({ type: "working_state_changed", state: "compacting_conversation" });
    const closed = mapWithState({ type: "working_state_changed", state: "streaming_assistant_message" });
    expect(closed.filter((event) => event.type === "context_compact")).toEqual([
      expect.objectContaining({ state: "completed" }),
    ]);
    expect(mapWithState({ type: "working_state_changed", state: "idle" })).toEqual([]);
  });

  it("does not put context occupancy on done", () => {
    const state = createDroidSdkEventMapperState();
    mapDroidSdkMessageToChatEvents({
      type: "context_stats",
      contextStats: { used: 900, remaining: 1_100, limit: 2_000, accuracy: "exact", updatedAt: "2026-09-23T12:00:00.000Z" },
    }, { turnId: "turn-1", cwd: "/work", state });
    const done = mapDroidSdkRunResultToDoneEvent({ success: true, tokenUsage: { inputTokens: 5 } }, {
      turnId: "turn-1",
      model: "claude-sonnet-5",
      state,
    });
    expect(done.usage).toEqual({ inputTokens: 5 });
  });

  it("reports a served model only when the provider changed it beyond custom prefix normalization", () => {
    const state = createDroidSdkEventMapperState();
    expect(mapDroidSdkRunResultToDoneEvent({
      success: true,
      modelId: "claude-opus-5",
    }, {
      turnId: "turn-1",
      model: "custom:claude-sonnet-5",
      requestedModel: "custom:claude-sonnet-5",
      state,
    })).toMatchObject({ servedModel: "claude-opus-5" });
    expect(mapDroidSdkRunResultToDoneEvent({
      success: true,
      modelId: "claude-sonnet-5",
    }, {
      turnId: "turn-1",
      model: "custom:claude-sonnet-5",
      requestedModel: "custom:claude-sonnet-5",
      state,
    })).not.toHaveProperty("servedModel");
  });

  it("reports the model the assistant message names, not the settings read back", () => {
    // Droid SDK 0.9.1: an `auto` router slot picks the model per turn and
    // stamps it on the assistant message; the run result's `modelId` is only
    // the session setting.
    const state = createDroidSdkEventMapperState();
    mapDroidSdkMessageToChatEvents({
      type: "assistant",
      text: "Done.",
      message: {
        id: "msg-1",
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        modelId: "gpt-6-astra",
        routerId: "auto",
        reasoningEffort: "high",
      },
    }, { turnId: "turn-1", cwd: "/work", state });
    expect(mapDroidSdkRunResultToDoneEvent({ success: true, modelId: "claude-sonnet-5" }, {
      turnId: "turn-1",
      model: "claude-sonnet-5",
      requestedModel: "claude-sonnet-5",
      state,
    })).toMatchObject({ servedModel: "gpt-6-astra" });

    const sameModel = createDroidSdkEventMapperState();
    mapDroidSdkMessageToChatEvents({
      type: "assistant",
      message: { id: "msg-2", role: "assistant", content: [], modelId: "claude-sonnet-5" },
    }, { turnId: "turn-2", cwd: "/work", state: sameModel });
    expect(mapDroidSdkRunResultToDoneEvent({ success: true }, {
      turnId: "turn-2",
      model: "claude-sonnet-5",
      requestedModel: "claude-sonnet-5",
      state: sameModel,
    })).not.toHaveProperty("servedModel");
  });

  it("names a bring-your-own-key custom model's account api_key", () => {
    const state = createDroidSdkEventMapperState();
    expect(mapDroidSdkRunResultToDoneEvent({ success: true }, {
      turnId: "turn-1",
      model: "Claude Sonnet 5 (BYOK)",
      requestedModel: "custom:claude-sonnet-5",
      state,
    }).account).toEqual({ provider: "droid", kind: "api_key" });
    expect(mapDroidSdkRunResultToDoneEvent({ success: true }, {
      turnId: "turn-1",
      model: "claude-sonnet-5",
      state,
    }).account).toEqual({ provider: "droid", kind: "subscription" });
  });
});
