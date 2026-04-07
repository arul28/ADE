import { describe, expect, it } from "vitest";
import {
  appendBufferedAssistantText,
  canAppendBufferedAssistantText,
  shouldFlushBufferedAssistantTextForEvent,
  type BufferedAssistantText,
} from "./chatTextBatching";

describe("chatTextBatching", () => {
  // ── canAppendBufferedAssistantText ────────────────────────────────

  describe("canAppendBufferedAssistantText", () => {
    it("returns false when buffered is null", () => {
      expect(canAppendBufferedAssistantText(null, {
        type: "text",
        text: "hello",
        turnId: "turn-1",
        itemId: "item-1",
      })).toBe(false);
    });

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
    });

    it("stops batching when the turn changes", () => {
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
    });

    it("stops batching when the item changes", () => {
      const buffered = appendBufferedAssistantText(null, {
        type: "text",
        text: "Hello",
        turnId: "turn-1",
        itemId: "item-1",
      });

      expect(canAppendBufferedAssistantText(buffered, {
        type: "text",
        text: "Other",
        turnId: "turn-1",
        itemId: "item-2",
      })).toBe(false);
    });

    it("keeps batching when the logical message id stays stable across scope changes", () => {
      const buffered = appendBufferedAssistantText(null, {
        type: "text",
        text: "Hello",
        messageId: "assistant-message-1",
        turnId: "turn-1",
        itemId: "item-1",
      });

      expect(canAppendBufferedAssistantText(buffered, {
        type: "text",
        text: " world",
        messageId: "assistant-message-1",
        turnId: "turn-1",
      })).toBe(true);
    });

    it("stops batching when messageId diverges", () => {
      const buffered = appendBufferedAssistantText(null, {
        type: "text",
        text: "Hello",
        messageId: "msg-1",
        turnId: "turn-1",
        itemId: "item-1",
      });

      expect(canAppendBufferedAssistantText(buffered, {
        type: "text",
        text: " world",
        messageId: "msg-2",
        turnId: "turn-1",
        itemId: "item-1",
      })).toBe(false);
    });

    it("coalesces anonymous text chunks that lack identity", () => {
      const buffered = appendBufferedAssistantText(null, {
        type: "text",
        text: "Hello",
      });

      expect(canAppendBufferedAssistantText(buffered, {
        type: "text",
        text: " world",
      })).toBe(true);
    });

    it("allows batching with only turnId (no itemId) on both sides", () => {
      const buffered: BufferedAssistantText = {
        text: "Hello",
        turnId: "turn-1",
      };

      expect(canAppendBufferedAssistantText(buffered, {
        type: "text",
        text: " world",
        turnId: "turn-1",
      })).toBe(true);
    });

    it("handles mismatched messageId: one has messageId and the other does not, same turnId and itemId", () => {
      const buffered: BufferedAssistantText = {
        text: "Hello",
        messageId: "msg-1",
        turnId: "turn-1",
        itemId: "item-1",
      };

      // Event has no messageId but matching turnId+itemId
      expect(canAppendBufferedAssistantText(buffered, {
        type: "text",
        text: " more",
        turnId: "turn-1",
        itemId: "item-1",
      })).toBe(true);
    });

    it("returns false when one has messageId, other does not, and turnIds differ", () => {
      const buffered: BufferedAssistantText = {
        text: "Hello",
        messageId: "msg-1",
        turnId: "turn-1",
      };

      expect(canAppendBufferedAssistantText(buffered, {
        type: "text",
        text: " more",
        turnId: "turn-2",
      })).toBe(false);
    });

    it("handles whitespace-only messageId as empty", () => {
      const buffered: BufferedAssistantText = {
        text: "Hello",
        messageId: "   ",
        turnId: "turn-1",
        itemId: "item-1",
      };

      expect(canAppendBufferedAssistantText(buffered, {
        type: "text",
        text: " world",
        messageId: "   ",
        turnId: "turn-1",
        itemId: "item-1",
      })).toBe(true);
    });
  });

  // ── appendBufferedAssistantText ──────────────────────────────────

  describe("appendBufferedAssistantText", () => {
    it("creates a new buffer from null with all event fields", () => {
      const result = appendBufferedAssistantText(null, {
        type: "text",
        text: "Hello",
        messageId: "msg-1",
        turnId: "turn-1",
        itemId: "item-1",
      });

      expect(result).toEqual({
        text: "Hello",
        messageId: "msg-1",
        turnId: "turn-1",
        itemId: "item-1",
      });
    });

    it("creates a new buffer from null with minimal event", () => {
      const result = appendBufferedAssistantText(null, {
        type: "text",
        text: "Hello",
      });

      expect(result).toEqual({
        text: "Hello",
      });
    });

    it("concatenates text when appending to compatible buffer", () => {
      const buffered = appendBufferedAssistantText(null, {
        type: "text",
        text: "Hello",
        turnId: "turn-1",
        itemId: "item-1",
      });

      const result = appendBufferedAssistantText(buffered, {
        type: "text",
        text: " world",
        turnId: "turn-1",
        itemId: "item-1",
      });

      expect(result).toMatchObject({
        text: "Hello world",
        turnId: "turn-1",
        itemId: "item-1",
      });
    });

    it("replaces buffer when identity changes", () => {
      const buffered = appendBufferedAssistantText(null, {
        type: "text",
        text: "Hello",
        turnId: "turn-1",
        itemId: "item-1",
      });

      const result = appendBufferedAssistantText(buffered, {
        type: "text",
        text: "New",
        turnId: "turn-2",
        itemId: "item-2",
      });

      expect(result).toEqual({
        text: "New",
        turnId: "turn-2",
        itemId: "item-2",
      });
    });

    it("accumulates multiple appends", () => {
      let buf = appendBufferedAssistantText(null, {
        type: "text",
        text: "A",
        turnId: "t",
        itemId: "i",
      });
      buf = appendBufferedAssistantText(buf, {
        type: "text",
        text: "B",
        turnId: "t",
        itemId: "i",
      });
      buf = appendBufferedAssistantText(buf, {
        type: "text",
        text: "C",
        turnId: "t",
        itemId: "i",
      });

      expect(buf.text).toBe("ABC");
    });

    it("preserves original buffer identity on append (does not mutate)", () => {
      const original = appendBufferedAssistantText(null, {
        type: "text",
        text: "Hello",
        turnId: "turn-1",
        itemId: "item-1",
      });

      const appended = appendBufferedAssistantText(original, {
        type: "text",
        text: " world",
        turnId: "turn-1",
        itemId: "item-1",
      });

      expect(original.text).toBe("Hello");
      expect(appended.text).toBe("Hello world");
    });

    it("does not carry messageId when event has none", () => {
      const result = appendBufferedAssistantText(null, {
        type: "text",
        text: "Hello",
        turnId: "turn-1",
      });

      expect(result.messageId).toBeUndefined();
    });
  });

  // ── shouldFlushBufferedAssistantTextForEvent ─────────────────────

  describe("shouldFlushBufferedAssistantTextForEvent", () => {
    it("does not flush for text events", () => {
      expect(shouldFlushBufferedAssistantTextForEvent({
        type: "text",
        text: "streaming...",
        turnId: "turn-1",
      })).toBe(false);
    });

    it("does not flush for reasoning events", () => {
      expect(shouldFlushBufferedAssistantTextForEvent({
        type: "reasoning",
        text: "Thinking through it",
        turnId: "turn-1",
      })).toBe(false);
    });

    it("does not flush for activity events", () => {
      expect(shouldFlushBufferedAssistantTextForEvent({
        type: "activity",
        activity: "thinking",
        detail: "Reasoning",
        turnId: "turn-1",
      })).toBe(false);
    });

    it("does not flush for plan_text events", () => {
      expect(shouldFlushBufferedAssistantTextForEvent({
        type: "plan_text",
        text: "- step one",
        turnId: "turn-1",
      })).toBe(false);
    });

    it("does not flush for subagent lifecycle events", () => {
      expect(shouldFlushBufferedAssistantTextForEvent({
        type: "subagent_started",
        taskId: "task-1",
        turnId: "turn-1",
      } as any)).toBe(false);

      expect(shouldFlushBufferedAssistantTextForEvent({
        type: "subagent_progress",
        taskId: "task-1",
        summary: "Subagent is still working",
        turnId: "turn-1",
      })).toBe(false);
    });

    it("flushes for tool_call events", () => {
      expect(shouldFlushBufferedAssistantTextForEvent({
        type: "tool_call",
        tool: "functions.exec_command",
        args: { cmd: "pwd" },
        itemId: "tool-1",
        turnId: "turn-1",
      })).toBe(true);
    });

    it("flushes for tool_result events", () => {
      expect(shouldFlushBufferedAssistantTextForEvent({
        type: "tool_result",
        tool: "functions.exec_command",
        result: { output: "test" },
        itemId: "tool-1",
        turnId: "turn-1",
      })).toBe(true);
    });

    it("flushes for command events", () => {
      expect(shouldFlushBufferedAssistantTextForEvent({
        type: "command",
        command: "pwd",
        cwd: "/tmp",
        output: "",
        itemId: "cmd-1",
        turnId: "turn-1",
        status: "running",
      })).toBe(true);
    });

    it("flushes for file_change events", () => {
      expect(shouldFlushBufferedAssistantTextForEvent({
        type: "file_change",
        path: "src/foo.ts",
        diff: "+line",
        kind: "modify",
        itemId: "fc-1",
        turnId: "turn-1",
      })).toBe(true);
    });

    it("flushes for approval_request events", () => {
      expect(shouldFlushBufferedAssistantTextForEvent({
        type: "approval_request",
        itemId: "approval-1",
        kind: "command",
        description: "Run shell command",
        turnId: "turn-1",
      })).toBe(true);
    });

    it("flushes for done events", () => {
      expect(shouldFlushBufferedAssistantTextForEvent({
        type: "done",
        turnId: "turn-1",
        status: "completed",
      })).toBe(true);
    });

    it("flushes for user_message events", () => {
      expect(shouldFlushBufferedAssistantTextForEvent({
        type: "user_message",
        text: "Hello",
        turnId: "turn-1",
      })).toBe(true);
    });

    it("flushes buffered text on discrete UI card events", () => {
      expect(shouldFlushBufferedAssistantTextForEvent({
        type: "todo_update",
        todos: [],
        turnId: "turn-1",
      } as any)).toBe(true);

      expect(shouldFlushBufferedAssistantTextForEvent({
        type: "web_search",
        query: "test",
        turnId: "turn-1",
      } as any)).toBe(true);
    });

    it("flushes for error events", () => {
      expect(shouldFlushBufferedAssistantTextForEvent({
        type: "error",
        message: "Something failed",
        turnId: "turn-1",
      } as any)).toBe(true);
    });
  });
});
