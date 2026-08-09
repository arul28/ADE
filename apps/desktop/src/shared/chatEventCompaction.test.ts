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

  /**
   * The wire compacts events that already came off disk compacted (hydration
   * and the replay ring), so a second pass has to be a no-op. It was not: the
   * wrapper's newline-dense preview re-serialized with JSON escaping and came
   * back over the cap, so each pass made the payload BIGGER while overwriting
   * `originalBytes` with the previous pass's size.
   */
  it("is idempotent for an object result, and keeps the true original size", () => {
    const huge = { rows: Array.from({ length: 3_000 }, (_, i) => `row ${i} ${"x".repeat(60)}`) };
    const first = compactChatEventForStorage(toolResult({ result: huge })) as Extract<AgentChatEvent, { type: "tool_result" }>;
    const second = compactChatEventForStorage(first) as Extract<AgentChatEvent, { type: "tool_result" }>;
    const third = compactChatEventForStorage(second) as Extract<AgentChatEvent, { type: "tool_result" }>;

    expect(bytes(second.result)).toBe(bytes(first.result));
    expect(bytes(third.result)).toBe(bytes(first.result));
    // The size reported to the user stays the size of what they actually ran.
    expect(second.resultOriginalBytes).toBe(first.resultOriginalBytes);
    expect(first.resultOriginalBytes).toBeGreaterThan(200_000);
  });

  it("puts no bookkeeping key into a payload users read", () => {
    // Every surface renders an object tool result as a JSON dump — the desktop
    // card and its collapsed preview, the TUI one-liner, the iOS Result block —
    // so a marker key would be the first line the user sees.
    const huge = { rows: Array.from({ length: 3_000 }, (_, i) => `row ${i} ${"x".repeat(60)}`) };
    const stored = compactChatEventForStorage(toolResult({ result: huge })) as Extract<AgentChatEvent, { type: "tool_result" }>;

    expect(Object.keys(stored.result as Record<string, unknown>)).toEqual([
      "summary",
      "originalBytes",
      "omittedBytes",
      "preview",
    ]);
  });

  it("recognizes a wrapper written before this check existed", () => {
    // Transcripts on disk predate the idempotence fix; re-wrapping one would
    // report the wrapper's size as the original and nest the preview.
    const legacy = {
      summary: "[ADE] Large tool result was shortened to keep this chat fast.",
      originalBytes: 229_908,
      omittedBytes: 214_219,
      preview: "x".repeat(16_000),
    };
    const event = toolResult({ result: legacy, resultOriginalBytes: 229_908 });

    expect(compactChatEventForStorage(event)).toBe(event);
  });

  it("does not let a wrapper-shaped payload smuggle an unbounded result through", () => {
    // Recognizing our own output must not become a cap bypass a provider
    // payload could trip by coincidence.
    const forged = {
      summary: "[ADE] Large tool result was shortened to keep this chat fast.",
      originalBytes: 1,
      omittedBytes: 1,
      preview: "p",
      rows: Array.from({ length: 3_000 }, (_, i) => `row ${i} ${"x".repeat(60)}`),
    };

    const stored = compactChatEventForStorage(toolResult({ result: forged })) as Extract<AgentChatEvent, { type: "tool_result" }>;

    expect(bytes(stored.result)).toBeLessThan(40 * 1024);
  });

  it("is idempotent on the text branches too", () => {
    // These carry no wrapper to recognize; they are stable only because the
    // compacted output lands under the cap. Shrinking that headroom would
    // silently restart the growth loop.
    const cases: AgentChatEvent[] = [
      { type: "command", command: "ls", output: "o".repeat(500_000), itemId: "c1", status: "completed" } as AgentChatEvent,
      { type: "file_change", path: "a.ts", diff: "d".repeat(500_000), kind: "modify", itemId: "f1" } as AgentChatEvent,
      { type: "reasoning", text: "r".repeat(500_000), itemId: "r1" } as AgentChatEvent,
    ];

    for (const event of cases) {
      const once = compactChatEventForStorage(event);
      expect(compactChatEventForStorage(once)).toBe(once);
    }
  });

  it("is idempotent for a string result", () => {
    const event = toolResult({ result: "y".repeat(300_000) });
    const first = compactChatEventForStorage(event);
    expect(compactChatEventForStorage(first)).toBe(first);
  });

  it("keeps a live push byte-identical to the same event replayed from disk", () => {
    const event = toolResult({
      result: { log: Array.from({ length: 2_000 }, (_, i) => `line ${i}`) },
      structured: { raw: "z".repeat(120_000) },
    });

    const live = compactChatEventForWire(event);
    const replayed = compactChatEventForWire(compactChatEventForStorage(event));

    expect(JSON.stringify(replayed)).toBe(JSON.stringify(live));
  });

  it("does not restate result byte counts when only structured was capped", () => {
    // Writing them unconditionally zeroed a real prior measurement, reporting
    // 0 bytes for a result that had been shortened from megabytes.
    const event = toolResult({
      result: "small",
      resultOriginalBytes: 5_000_000,
      resultOmittedBytes: 4_900_000,
      structured: { raw: "z".repeat(120_000) },
    });

    const stored = compactChatEventForStorage(event) as Extract<AgentChatEvent, { type: "tool_result" }>;

    expect(stored.resultOriginalBytes).toBe(5_000_000);
    expect(stored.resultOmittedBytes).toBe(4_900_000);
    expect(bytes(stored.structured)).toBeLessThan(32 * 1024);
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
