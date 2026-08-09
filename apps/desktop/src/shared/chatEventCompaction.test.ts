import { describe, expect, it } from "vitest";
import type { AgentChatEvent } from "./types/chat";
import { compactChatEventForStorage, compactChatEventForWire } from "./chatEventCompaction";

function toolResult(overrides: Partial<Extract<AgentChatEvent, { type: "tool_result" }>> = {}) {
  return {
    type: "tool_result",
    tool: "Grep",
    itemId: "tool-1",
    result: { matches: 3 },
    status: "completed",
    ...overrides,
  } as AgentChatEvent;
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");

describe("chat event compaction", () => {
  /**
   * The defect this module exists to prevent: `structured` was added to
   * `tool_result` and to neither cap table, so it grew to 56.6% of a real 8 MB
   * transcript — ten times larger than `result`, the field that IS capped.
   */
  it("bounds a huge structured payload on the stored path", () => {
    const huge = { rows: Array.from({ length: 4_000 }, (_, i) => `row ${i} ${"x".repeat(80)}`) };
    const event = toolResult({ structured: huge });

    const stored = compactChatEventForStorage(event) as Extract<AgentChatEvent, { type: "tool_result" }>;

    expect(bytes(stored.structured)).toBeLessThan(bytes(huge) / 10);
    expect(bytes(stored.structured)).toBeLessThan(32 * 1024);
  });

  it("leaves a small structured payload untouched", () => {
    const structured = { totalFiles: 2, totalLines: 9 };
    const stored = compactChatEventForStorage(toolResult({ structured }));

    expect((stored as { structured?: unknown }).structured).toEqual(structured);
  });

  it("drops structured and toolResultMeta from the wire entirely", () => {
    // No client decodes either one — `structured` is not even a coding key in
    // the iOS model, and `toolResultMeta` is written once and never read.
    const event = toolResult({
      structured: { totalFiles: 2, totalLines: 9 },
      toolResultMeta: { provider: "claude" },
    });

    const wire = compactChatEventForWire(event) as Record<string, unknown>;

    expect(wire).not.toHaveProperty("structured");
    expect(wire).not.toHaveProperty("toolResultMeta");
    expect(wire).toMatchObject({ type: "tool_result", tool: "Grep", result: { matches: 3 } });
  });

  it("keeps the fields projected out of structured at construction time", () => {
    // `grepTotals` and friends are what ADE actually reads; they live on the
    // event itself, so dropping the raw payload must not take them with it.
    const event = toolResult({
      structured: { totalFiles: 2, totalLines: 9 },
      grepTotals: { files: 2, lines: 9 },
      timedOutAfterMs: 1_500,
    });

    const wire = compactChatEventForWire(event) as Record<string, unknown>;

    expect(wire.grepTotals).toEqual({ files: 2, lines: 9 });
    expect(wire.timedOutAfterMs).toBe(1_500);
  });

  it("sends the same bytes live as a reconnecting client gets from the transcript", () => {
    // The observable bug: an event went out multi-megabyte on live push and
    // came back small after reconnect hydration. Live push now applies storage
    // compaction first, so a replayed event and a live one agree.
    const event = toolResult({
      result: { log: "y".repeat(200_000) },
      structured: { raw: "z".repeat(200_000) },
    });

    const liveWire = compactChatEventForWire(event);
    const hydratedWire = compactChatEventForWire(compactChatEventForStorage(event));

    expect(liveWire).toEqual(hydratedWire);
  });

  it("caps an oversized tool result on the wire", () => {
    const event = toolResult({ result: { log: "y".repeat(500_000) } });

    const wire = compactChatEventForWire(event) as Extract<AgentChatEvent, { type: "tool_result" }>;

    expect(bytes(wire.result)).toBeLessThan(64 * 1024);
    expect(wire.resultOmittedBytes ?? 0).toBeGreaterThan(0);
  });

  it("returns the same object when there is nothing to compact", () => {
    // Identity matters: callers use it to skip rebuilding the envelope.
    const event = toolResult();
    expect(compactChatEventForWire(event)).toBe(event);
    expect(compactChatEventForStorage(event)).toBe(event);
  });

  it("does not mutate the caller's event", () => {
    const structured = { raw: "z".repeat(200_000) };
    const event = toolResult({ structured });

    compactChatEventForWire(event);

    expect((event as { structured?: unknown }).structured).toBe(structured);
  });

  it("leaves non-tool-result events to their own caps", () => {
    const reasoning = { type: "reasoning", text: "r".repeat(100_000), itemId: "r1" } as AgentChatEvent;
    const wire = compactChatEventForWire(reasoning) as Extract<AgentChatEvent, { type: "reasoning" }>;

    expect(Buffer.byteLength(wire.text, "utf8")).toBeLessThan(16 * 1024);
    expect(wire.textOmittedBytes ?? 0).toBeGreaterThan(0);
  });
});
