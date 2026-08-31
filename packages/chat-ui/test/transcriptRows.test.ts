import { describe, expect, it } from "vitest";

import type { AgentChatEvent, AgentChatEventEnvelope } from "../src/sdkTypes";
import {
  buildTranscriptRows,
  collapseTranscriptEvents,
  groupTranscriptRows,
  mergeStreamingText,
  resolveToolName,
  shouldMergeTextRows,
  type ToolChipRow,
} from "../src/transcript/transcriptRows";

let sequence = 0;
function envelope(event: AgentChatEvent, timestamp?: string): AgentChatEventEnvelope {
  sequence += 1;
  return {
    sessionId: "session",
    timestamp: timestamp ?? `2026-01-01T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    sequence,
    event,
  };
}

describe("mergeStreamingText", () => {
  it("replaces when the incoming chunk is a growing snapshot", () => {
    expect(mergeStreamingText("Hel", "Hello")).toBe("Hello");
  });

  it("appends when the incoming chunk is a delta", () => {
    expect(mergeStreamingText("Hel", "lo")).toBe("Hello");
  });

  it("treats an empty side as a no-op", () => {
    expect(mergeStreamingText("", "Hello")).toBe("Hello");
    expect(mergeStreamingText("Hello", "")).toBe("Hello");
  });
});

describe("shouldMergeTextRows", () => {
  it("merges matching message ids", () => {
    expect(
      shouldMergeTextRows({ type: "text", text: "a", messageId: "m1" }, { type: "text", text: "b", messageId: "m1" }),
    ).toBe(true);
  });

  it("refuses to merge different message ids", () => {
    expect(
      shouldMergeTextRows({ type: "text", text: "a", messageId: "m1" }, { type: "text", text: "b", messageId: "m2" }),
    ).toBe(false);
  });

  it("falls back to turn and item when only one side has an id", () => {
    expect(
      shouldMergeTextRows(
        { type: "text", text: "a", messageId: "m1", turnId: "t1", itemId: "i1" },
        { type: "text", text: "b", turnId: "t1", itemId: "i1" },
      ),
    ).toBe(true);
    expect(
      shouldMergeTextRows(
        { type: "text", text: "a", messageId: "m1", turnId: "t1" },
        { type: "text", text: "b", turnId: "t2" },
      ),
    ).toBe(false);
  });

  it("merges identity-free events from providers that send none", () => {
    expect(shouldMergeTextRows({ type: "text", text: "a" }, { type: "text", text: "b" })).toBe(true);
  });
});

describe("collapseTranscriptEvents", () => {
  it("folds a streamed message into one row", () => {
    const rows = collapseTranscriptEvents([
      envelope({ type: "text", text: "Hello", messageId: "m1" }),
      envelope({ type: "text", text: " there", messageId: "m1" }),
      envelope({ type: "text", text: "!", messageId: "m1" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event).toMatchObject({ type: "text", text: "Hello there!" });
  });

  it("keeps distinct messages apart", () => {
    const rows = collapseTranscriptEvents([
      envelope({ type: "text", text: "one", messageId: "m1" }),
      envelope({ type: "text", text: "two", messageId: "m2" }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it("upgrades a tool_call chip in place when its result lands", () => {
    const rows = collapseTranscriptEvents([
      envelope({ type: "tool_call", tool: "search", args: { q: "x" }, itemId: "i1", turnId: "t1" }),
      envelope({
        type: "tool_result",
        tool: "search",
        result: { hits: 2 },
        itemId: "i1",
        turnId: "t1",
        status: "completed",
      }),
    ]);
    expect(rows).toHaveLength(1);
    const chip = rows[0]!.event as ToolChipRow;
    expect(chip).toMatchObject({
      type: "tool_chip",
      tool: "search",
      status: "completed",
      args: { q: "x" },
      result: { hits: 2 },
    });
  });

  it("matches call and result on logicalItemId when the provider renumbers items", () => {
    const rows = collapseTranscriptEvents([
      envelope({ type: "tool_call", tool: "search", args: {}, itemId: "call_1", logicalItemId: "L1", turnId: "t1" }),
      envelope({
        type: "tool_result",
        tool: "search",
        result: "ok",
        itemId: "result_9",
        logicalItemId: "L1",
        turnId: "t1",
      }),
    ]);
    expect(rows).toHaveLength(1);
  });

  it("renders an orphan tool_result as its own chip", () => {
    const rows = collapseTranscriptEvents([
      envelope({ type: "tool_result", tool: "search", result: "ok", itemId: "i1", status: "failed" }),
    ]);
    expect(rows).toHaveLength(1);
    expect((rows[0]!.event as ToolChipRow).status).toBe("failed");
  });

  it("drops event kinds this package does not draw", () => {
    const rows = collapseTranscriptEvents([
      envelope({ type: "text", text: "hi", messageId: "m1" }),
      // No cast: `AgentChatEvent` is open, so an ADE-only kind from a newer
      // runtime type-checks and must be ignored, not rendered as an empty row.
      envelope({ type: "plan", steps: [] }),
    ]);
    expect(rows).toHaveLength(1);
  });

  it("gives each row a stable key across recomputation", () => {
    const events = [
      envelope({ type: "user_message", text: "hi" }),
      envelope({ type: "text", text: "hello", messageId: "m1" }),
    ];
    expect(collapseTranscriptEvents(events).map((row) => row.key)).toEqual(
      collapseTranscriptEvents(events).map((row) => row.key),
    );
  });
});

describe("groupTranscriptRows", () => {
  it("merges consecutive reasoning from the same block", () => {
    const rows = buildTranscriptRows([
      envelope({ type: "reasoning", text: "first", turnId: "t1", itemId: "i1", summaryIndex: 0 }),
      envelope({ type: "reasoning", text: "second", turnId: "t1", itemId: "i1", summaryIndex: 0 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event).toMatchObject({ type: "reasoning", text: "first\n\n---\n\nsecond" });
  });

  it("keeps reasoning from different blocks separate", () => {
    const rows = buildTranscriptRows([
      envelope({ type: "reasoning", text: "a", turnId: "t1", itemId: "i1", summaryIndex: 0 }),
      envelope({ type: "reasoning", text: "b", turnId: "t1", itemId: "i1", summaryIndex: 1 }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it("collapses repeated identical status rows", () => {
    const rows = groupTranscriptRows(
      collapseTranscriptEvents([
        envelope({ type: "status", turnStatus: "started", turnId: "t1" }),
        envelope({ type: "status", turnStatus: "started", turnId: "t1" }),
        envelope({ type: "status", turnStatus: "completed", turnId: "t1" }),
      ]),
    );
    expect(rows).toHaveLength(2);
  });
});

describe("resolveToolName", () => {
  it("prefers a payload title when the provider only said 'tool'", () => {
    expect(resolveToolName("tool", { title: "Search invoices" })).toBe("Search invoices");
    expect(resolveToolName("other", { title: "Search invoices" })).toBe("Search invoices");
  });

  it("keeps a real tool name even when a title exists", () => {
    expect(resolveToolName("Bash", { title: "Search invoices" })).toBe("Bash");
  });

  it("keeps the generic name when there is no title", () => {
    expect(resolveToolName("tool", { q: 1 })).toBe("tool");
  });
});
