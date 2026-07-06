import { describe, expect, it } from "vitest";
import { chunkTerminalTranscript, sanitizeIndexedText } from "./terminalChunking";

describe("sanitizeIndexedText", () => {
  it("replaces control chars but keeps newlines and tabs", () => {
    expect(sanitizeIndexedText("a\u0001b\u0007c\nd\te\u007f")).toBe("a b c\nd\te ");
  });
});

describe("chunkTerminalTranscript", () => {
  it("consumes complete lines and defers a partial tail", () => {
    const raw = Buffer.from("line one\nline two\npartial", "utf8");
    const { chunks, consumedBytes } = chunkTerminalTranscript(raw, 0);
    expect(consumedBytes).toBe(Buffer.byteLength("line one\nline two\n"));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe("line one\nline two");
    expect(chunks[0]!.startOffset).toBe(0);
    expect(chunks[0]!.endOffset).toBe(consumedBytes);
  });

  it("consumes the partial tail when forced", () => {
    const raw = Buffer.from("done\ntail without newline", "utf8");
    const { chunks, consumedBytes } = chunkTerminalTranscript(raw, 100, { force: true });
    expect(consumedBytes).toBe(raw.length);
    expect(chunks.map((c) => c.text).join("|")).toContain("tail without newline");
    expect(chunks[0]!.startOffset).toBe(100);
    expect(chunks.at(-1)!.endOffset).toBe(100 + raw.length);
  });

  it("splits oversized input at newline boundaries", () => {
    const line = `${"x".repeat(50)}\n`;
    const raw = Buffer.from(line.repeat(10), "utf8");
    const { chunks, consumedBytes } = chunkTerminalTranscript(raw, 0, { maxChunkRawBytes: 128 });
    expect(consumedBytes).toBe(raw.length);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.endOffset - chunk.startOffset).toBeLessThanOrEqual(128);
      expect(raw.subarray(chunk.startOffset, chunk.endOffset).at(-1)).toBe(0x0a);
    }
    // Chunks tile the input exactly.
    expect(chunks[0]!.startOffset).toBe(0);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.startOffset).toBe(chunks[i - 1]!.endOffset);
    }
  });

  it("never splits a UTF-8 codepoint on hard cuts", () => {
    const raw = Buffer.from("é".repeat(200), "utf8"); // 2 bytes each, no newlines
    const { chunks } = chunkTerminalTranscript(raw, 0, { force: true, maxChunkRawBytes: 65 });
    for (const chunk of chunks) {
      const roundTrip = raw.subarray(chunk.startOffset, chunk.endOffset).toString("utf8");
      expect(roundTrip).not.toContain("�");
    }
  });

  it("strips ANSI sequences from indexed text", () => {
    const raw = Buffer.from("\u001b[31mred error\u001b[0m plain\n", "utf8");
    const { chunks } = chunkTerminalTranscript(raw, 0);
    expect(chunks[0]!.text).toBe("red error plain");
  });

  it("is deterministic for the same input", () => {
    const raw = Buffer.from("a\n".repeat(5000), "utf8");
    const a = chunkTerminalTranscript(raw, 0, { maxChunkRawBytes: 256 });
    const b = chunkTerminalTranscript(raw, 0, { maxChunkRawBytes: 256 });
    expect(a).toEqual(b);
  });
});
