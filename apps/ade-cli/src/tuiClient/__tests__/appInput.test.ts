import { describe, expect, it } from "vitest";
import {
  clampChatScrollOffsetRows,
  deletePreviousPromptLine,
  deletePreviousPromptWord,
  encodeTerminalPromptSubmit,
  footerControlsForAvailability,
  isPromptLineBackspace,
  isPromptWordBackspace,
  isTerminalControlToggle,
  isTerminalMouseTrackingEnabled,
  parseTerminalMouseInput,
  promptDisplayRows,
  resolveChatWrapWidth,
  resolveTerminalPaneWidth,
  splitTerminalControlInput,
  subagentSnapshotsFromEvents,
} from "../app";
import { clampTerminalPaneCols } from "../components/TerminalPane";

describe("parseTerminalMouseInput", () => {
  it("parses SGR mouse wheel events from Ink input", () => {
    expect(parseTerminalMouseInput("\x1b[<64;42;12M")).toEqual({
      kind: "wheel",
      direction: "up",
      x: 42,
      y: 12,
    });
    expect(parseTerminalMouseInput("[<64;42;12M")).toEqual({
      kind: "wheel",
      direction: "up",
      x: 42,
      y: 12,
    });
    expect(parseTerminalMouseInput("[<65;42;12M")).toEqual({
      kind: "wheel",
      direction: "down",
      x: 42,
      y: 12,
    });
  });

  it("parses rxvt mouse wheel events from terminals that do not emit SGR", () => {
    expect(parseTerminalMouseInput("[64;42;12M")).toEqual({
      kind: "wheel",
      direction: "up",
      x: 42,
      y: 12,
    });
  });

  it("parses X10 mouse wheel events from legacy terminal packets", () => {
    expect(parseTerminalMouseInput("\x1b[M`J,")).toEqual({
      kind: "wheel",
      direction: "up",
      x: 42,
      y: 12,
    });
  });

  it("parses primary clicks so panes can opt into mouse selection", () => {
    expect(parseTerminalMouseInput("[<0;5;6M")).toEqual({
      kind: "click",
      x: 5,
      y: 6,
    });
  });

  it("parses primary drags and releases for chat text selection", () => {
    expect(parseTerminalMouseInput("[<32;7;8M")).toEqual({
      kind: "drag",
      x: 7,
      y: 8,
    });
    expect(parseTerminalMouseInput("[<0;7;8m")).toEqual({
      kind: "release",
      x: 7,
      y: 8,
    });
  });

  it("swallows batched SGR mouse events from fast scrolling", () => {
    expect(parseTerminalMouseInput("[<64;104;32M[<64;104;32M[<65;104;31M")).toEqual({
      kind: "wheel",
      direction: "up",
      x: 104,
      y: 32,
    });
  });

  it("ignores normal keyboard input", () => {
    expect(parseTerminalMouseInput("hello")).toBeNull();
  });
});

describe("footer control ordering", () => {
  it("puts agents first only when the active chat has subagent history", () => {
    expect(footerControlsForAvailability(true)).toEqual(["agents", "drawer", "details"]);
    expect(footerControlsForAvailability(false)).toEqual(["drawer", "details"]);
  });
});

describe("terminal control toggle", () => {
  it("recognizes ctrl-t from Ink key data and raw terminal bytes", () => {
    expect(isTerminalControlToggle("t", { ctrl: true })).toBe(true);
    expect(isTerminalControlToggle("T", { ctrl: true })).toBe(true);
    expect(isTerminalControlToggle("\x14", {})).toBe(true);
    expect(isTerminalControlToggle("t", {})).toBe(false);
  });

  it("detaches from terminal control while preserving other raw input bytes", () => {
    expect(splitTerminalControlInput("a\x14b\x1dc")).toEqual({
      detach: true,
      forwarded: "abc",
    });
    expect(splitTerminalControlInput("\x1b[A")).toEqual({
      detach: false,
      forwarded: "\x1b[A",
    });
  });
});

describe("pane width helpers", () => {
  it("caps prose chat width but lets embedded terminals use the full center pane", () => {
    expect(resolveChatWrapWidth(180, false, 0)).toBe(110);
    expect(resolveChatWrapWidth(Number.NaN, false, 0)).toBe(24);
    expect(resolveTerminalPaneWidth(180)).toBe(180);
    expect(resolveTerminalPaneWidth(Number.NaN)).toBe(24);
    expect(clampTerminalPaneCols(360)).toBe(360);
    expect(clampTerminalPaneCols(999)).toBe(400);
    expect(clampTerminalPaneCols(Number.POSITIVE_INFINITY)).toBe(20);
  });

  it("does not further cap chat text when both side panes already narrow the center", () => {
    expect(resolveChatWrapWidth(72, true, 34)).toBe(72);
  });
});

describe("subagentSnapshotsFromEvents", () => {
  it("uses agentId as the stable row id when runtimes provide both ids", () => {
    const snapshots = subagentSnapshotsFromEvents([
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: {
          type: "subagent_started",
          taskId: "task-1",
          agentId: "agent-1",
          parentToolUseId: null,
          description: "Investigate issue",
        },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:01.000Z",
        sequence: 2,
        event: {
          type: "subagent_result",
          taskId: "task-1",
          agentId: "agent-1",
          parentToolUseId: null,
          status: "completed",
          summary: "done",
        },
      },
    ]);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      id: "agent-1",
      name: "Investigate issue",
      status: "completed",
      summary: "done",
    });
  });

  it("adopts the resolved task id when a runtime placeholder has the same parent tool id", () => {
    const snapshots = subagentSnapshotsFromEvents([
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: {
          type: "subagent_started",
          taskId: "spawn-1",
          parentToolUseId: "spawn-1",
          description: "Parallel agent",
        },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:01.000Z",
        sequence: 2,
        event: {
          type: "subagent_progress",
          taskId: "thread-1",
          parentToolUseId: "spawn-1",
          summary: "working",
        },
      },
    ]);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      id: "thread-1",
      name: "Parallel agent",
      parentToolUseId: "spawn-1",
      status: "running",
      summary: "working",
    });
  });

  it("stops foreground subagents when their parent turn has ended", () => {
    const snapshots = subagentSnapshotsFromEvents([
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: {
          type: "subagent_started",
          taskId: "agent-1",
          description: "Foreground agent",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:01.000Z",
        sequence: 2,
        event: {
          type: "subagent_started",
          taskId: "agent-bg",
          description: "Background agent",
          background: true,
          turnId: "turn-1",
        },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:02.000Z",
        sequence: 3,
        event: { type: "done", turnId: "turn-1", status: "completed" },
      },
    ]);

    expect(snapshots.find((snapshot) => snapshot.id === "agent-1")).toMatchObject({
      status: "stopped",
      summary: "Parent turn ended before ADE received a final subagent status",
    });
    expect(snapshots.find((snapshot) => snapshot.id === "agent-bg")).toMatchObject({
      status: "running",
      background: true,
    });
  });
});

describe("clampChatScrollOffsetRows", () => {
  it("clamps overscroll immediately so downward input can recover from the oldest rows", () => {
    const top = clampChatScrollOffsetRows(Number.MAX_SAFE_INTEGER, 12);
    expect(top).toBe(12);
    expect(clampChatScrollOffsetRows(top - 3, 12)).toBe(9);
  });

  it("clamps negative and invalid offsets to the bottom", () => {
    expect(clampChatScrollOffsetRows(-5, 12)).toBe(0);
    expect(clampChatScrollOffsetRows(Number.NaN, 12)).toBe(0);
  });
});

describe("prompt editing helpers", () => {
  it("deletes the previous whitespace-delimited word", () => {
    expect(deletePreviousPromptWord("hello world")).toBe("hello ");
    expect(deletePreviousPromptWord("hello world   ")).toBe("hello ");
    expect(deletePreviousPromptWord("single")).toBe("");
    expect(deletePreviousPromptWord("")).toBe("");
  });

  it("recognizes common word-backspace key encodings", () => {
    expect(isPromptWordBackspace("w", { ctrl: true })).toBe(true);
    expect(isPromptWordBackspace("", { ctrl: true, backspace: true })).toBe(true);
    expect(isPromptWordBackspace("", { meta: true, backspace: true })).toBe(true);
    expect(isPromptWordBackspace("\x1b\u007f", { meta: true })).toBe(true);
    expect(isPromptWordBackspace("x", {})).toBe(false);
  });

  it("deletes the current prompt line from the end", () => {
    expect(deletePreviousPromptLine("one two")).toBe("");
    expect(deletePreviousPromptLine("one\ntwo")).toBe("one\n");
    expect(deletePreviousPromptLine("one\ntwo\n")).toBe("one\ntwo");
    expect(deletePreviousPromptLine("")).toBe("");
  });

  it("recognizes common line-backspace key encodings", () => {
    expect(isPromptLineBackspace("u", { ctrl: true })).toBe(true);
    expect(isPromptLineBackspace("", { meta: true, backspace: true })).toBe(false);
    expect(isPromptLineBackspace("", { meta: true, delete: true })).toBe(false);
    expect(isPromptLineBackspace("\x1b\u007f", { meta: true })).toBe(false);
    expect(isPromptLineBackspace("\x1b[3;3~", { meta: true })).toBe(false);
    expect(isPromptLineBackspace("", { ctrl: true, backspace: true } as { ctrl: boolean; backspace: boolean })).toBe(false);
  });

  it("caps prompt display rows at the newest visual lines", () => {
    expect(promptDisplayRows("one\ntwo", 20)).toEqual(["one", "two"]);
    expect(promptDisplayRows("abcdef", 2, 5)).toEqual(["ab", "cd", "ef"]);
    expect(promptDisplayRows("1\n2\n3\n4\n5\n6", 20, 5)).toEqual(["2", "3", "4", "5", "6"]);
  });
});

describe("terminal mouse tracking", () => {
  it("is enabled by default for pane-safe chat selection and can be disabled", () => {
    expect(isTerminalMouseTrackingEnabled(undefined)).toBe(true);
    expect(isTerminalMouseTrackingEnabled("")).toBe(true);
    expect(isTerminalMouseTrackingEnabled("0")).toBe(false);
    expect(isTerminalMouseTrackingEnabled("false")).toBe(false);
    expect(isTerminalMouseTrackingEnabled("1")).toBe(true);
    expect(isTerminalMouseTrackingEnabled("yes")).toBe(true);
  });
});

describe("encodeTerminalPromptSubmit", () => {
  it("submits single-line prompts with return", () => {
    expect(encodeTerminalPromptSubmit("hello")).toBe("hello\r");
  });

  it("uses bracketed paste for multiline prompts", () => {
    expect(encodeTerminalPromptSubmit("one\r\ntwo")).toBe("\x1b[200~one\ntwo\x1b[201~\r");
  });
});
