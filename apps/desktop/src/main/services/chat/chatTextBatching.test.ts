import { describe, expect, it } from "vitest";
import {
  appendBufferedAssistantText,
  canAppendBufferedAssistantText,
  shouldFlushBufferedAssistantTextForEvent,
} from "./chatTextBatching";

describe("chatTextBatching", () => {
  it("appends adjacent text deltas for the same turn and item", () => {
    const buffered = appendBufferedAssistantText(null, {
      type: "text",
      text: "Hello",
      turnId: "turn-1",
      itemId: "item-1",
    });

    expect(canAppendBufferedAssistantText(buffered, {
      type: "text",
      text: " world",
      turnId: "turn-1",
      itemId: "item-1",
    })).toBe(true);

    expect(appendBufferedAssistantText(buffered, {
      type: "text",
      text: " world",
      turnId: "turn-1",
      itemId: "item-1",
    })).toMatchObject({
      text: "Hello world",
      turnId: "turn-1",
      itemId: "item-1",
    });
  });

  it("stops batching when the text identity changes", () => {
    const buffered = appendBufferedAssistantText(null, {
      type: "text",
      text: "Hello",
      turnId: "turn-1",
      itemId: "item-1",
    });

    expect(canAppendBufferedAssistantText(buffered, {
      type: "text",
      text: "Other",
      turnId: "turn-2",
      itemId: "item-1",
    })).toBe(false);

    expect(canAppendBufferedAssistantText(buffered, {
      type: "text",
      text: "Other",
      turnId: "turn-1",
      itemId: "item-2",
    })).toBe(false);
  });

  it("flushes buffered text on structural chat events", () => {
    expect(shouldFlushBufferedAssistantTextForEvent({
      type: "tool_call",
      tool: "functions.exec_command",
      args: { cmd: "pwd" },
      itemId: "tool-1",
      turnId: "turn-1",
    })).toBe(true);

    expect(shouldFlushBufferedAssistantTextForEvent({
      type: "command",
      command: "pwd",
      cwd: "/tmp",
      output: "",
      itemId: "cmd-1",
      turnId: "turn-1",
      status: "running",
    })).toBe(true);

    expect(shouldFlushBufferedAssistantTextForEvent({
      type: "approval_request",
      itemId: "approval-1",
      kind: "command",
      description: "Run shell command",
      turnId: "turn-1",
    })).toBe(true);

    expect(shouldFlushBufferedAssistantTextForEvent({
      type: "done",
      turnId: "turn-1",
      status: "completed",
    })).toBe(true);
  });

  it("does not collapse anonymous text chunks that lack identity", () => {
    const buffered = appendBufferedAssistantText(null, {
      type: "text",
      text: "Hello",
    });

    expect(canAppendBufferedAssistantText(buffered, {
      type: "text",
      text: " world",
    })).toBe(false);
  });

  it("flushes buffered text on discrete UI card events", () => {
    expect(shouldFlushBufferedAssistantTextForEvent({
      type: "todo_update",
      todos: [],
      turnId: "turn-1",
    } as any)).toBe(true);

    expect(shouldFlushBufferedAssistantTextForEvent({
      type: "subagent_started",
      taskId: "task-1",
      turnId: "turn-1",
    } as any)).toBe(true);

    expect(shouldFlushBufferedAssistantTextForEvent({
      type: "web_search",
      query: "test",
      turnId: "turn-1",
    } as any)).toBe(true);
  });

  it("keeps buffered text live across lightweight progress events", () => {
    expect(shouldFlushBufferedAssistantTextForEvent({
      type: "activity",
      activity: "thinking",
      detail: "Reasoning",
      turnId: "turn-1",
    })).toBe(false);

    expect(shouldFlushBufferedAssistantTextForEvent({
      type: "reasoning",
      text: "Thinking through it",
      turnId: "turn-1",
    })).toBe(false);

    expect(shouldFlushBufferedAssistantTextForEvent({
      type: "plan_text",
      text: "- step one",
      turnId: "turn-1",
    })).toBe(false);
  });
});
