import { describe, expect, it } from "vitest";
import {
  createDroidSdkEventMapperState,
  mapDroidSdkMessageToChatEvents,
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
  it("maps assistant image blocks to the shared compact image event and dedupes replay", () => {
    const state = createDroidSdkEventMapperState();
    const message = {
      type: "create_message",
      role: "assistant",
      messageId: "message-1",
      content: [
        { type: "text", text: "Here is the diagram." },
        {
          type: "image",
          id: "image-1",
          source: { type: "base64", mediaType: "image/png", data: "AAAA" },
        },
      ],
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
      type: "create_message",
      role: "assistant",
      messageId: "message-large-image",
      content: [{
        type: "image",
        id: "image-large",
        source: { type: "base64", mediaType: "image/png", data: imageData },
      }],
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
      type: "tool_use",
      toolUseId: "tool-1",
      toolName: "search_issues",
      toolInput: { query: "bug" },
    })).toEqual([{
      type: "tool_call",
      tool: "search_issues",
      args: { query: "bug" },
      itemId: "tool-1",
      turnId: "turn-1",
    }]);
  });
});
