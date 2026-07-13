import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentChatEventEnvelope } from "../../../shared/types/chat";
import {
  CHAT_EVENT_HISTORY_PAGE_DEFAULT_BYTES,
  CHAT_EVENT_HISTORY_PAGE_MAX_BYTES,
  CHAT_EVENT_HISTORY_PAGE_MIN_BYTES,
  clampHistoryPageBytes,
  readTranscriptHistoryPage,
} from "./chatTranscriptHistoryPager";

const SESSION_ID = "session-pager";

let tmpRoot = "";
let transcriptPath = "";

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-transcript-pager-"));
  transcriptPath = path.join(tmpRoot, `${SESSION_ID}.chat.jsonl`);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function envelopeLine(args: {
  text: string;
  sessionId?: string;
  sequence?: number;
  /** Pad `text` with "x" until the serialized line (incl. trailing \n) is exactly this many BYTES. */
  exactLineBytes?: number;
}): string {
  const envelope: AgentChatEventEnvelope = {
    sessionId: args.sessionId ?? SESSION_ID,
    timestamp: "2026-06-10T10:00:00.000Z",
    event: { type: "text", text: args.text } as AgentChatEventEnvelope["event"],
    ...(args.sequence != null ? { sequence: args.sequence } : {}),
  };
  let line = `${JSON.stringify(envelope)}\n`;
  if (args.exactLineBytes != null) {
    const padding = args.exactLineBytes - Buffer.byteLength(line, "utf8");
    if (padding < 0) throw new Error(`fixture line already exceeds ${args.exactLineBytes} bytes`);
    envelope.event = { type: "text", text: args.text + "x".repeat(padding) } as AgentChatEventEnvelope["event"];
    line = `${JSON.stringify(envelope)}\n`;
    expect(Buffer.byteLength(line, "utf8")).toBe(args.exactLineBytes);
  }
  return line;
}

function writeTranscript(lines: string[]): { size: number; lineOffsets: number[] } {
  const lineOffsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += Buffer.byteLength(line, "utf8");
  }
  fs.writeFileSync(transcriptPath, lines.join(""), "utf8");
  expect(fs.statSync(transcriptPath).size).toBe(offset);
  return { size: offset, lineOffsets };
}

function eventText(envelope: AgentChatEventEnvelope): string {
  return envelope.event.type === "text" ? envelope.event.text : "";
}

describe("clampHistoryPageBytes", () => {
  it("defaults, clamps low, and clamps high", () => {
    expect(clampHistoryPageBytes(undefined)).toBe(CHAT_EVENT_HISTORY_PAGE_DEFAULT_BYTES);
    expect(clampHistoryPageBytes(null)).toBe(CHAT_EVENT_HISTORY_PAGE_DEFAULT_BYTES);
    expect(clampHistoryPageBytes(Number.NaN)).toBe(CHAT_EVENT_HISTORY_PAGE_DEFAULT_BYTES);
    expect(clampHistoryPageBytes(1)).toBe(CHAT_EVENT_HISTORY_PAGE_MIN_BYTES);
    expect(clampHistoryPageBytes(10_000_000)).toBe(CHAT_EVENT_HISTORY_PAGE_MAX_BYTES);
    expect(clampHistoryPageBytes(500_000)).toBe(500_000);
  });
});

describe("readTranscriptHistoryPage", () => {
  it("returns identical events from a compressed transcript", () => {
    const { size } = writeTranscript([
      envelopeLine({ text: "compressed first", sequence: 1 }),
      envelopeLine({ text: "compressed second", sequence: 2 }),
    ]);
    const compressedPath = `${transcriptPath}.gz`;
    fs.writeFileSync(compressedPath, gzipSync(fs.readFileSync(transcriptPath)));
    fs.unlinkSync(transcriptPath);

    const page = readTranscriptHistoryPage({
      transcriptPath: compressedPath,
      sessionId: SESSION_ID,
      beforeOffset: size,
    });

    expect(page.envelopes.map(eventText)).toEqual(["compressed first", "compressed second"]);
  });

  it("reuses a valid compressed snapshot across pages", () => {
    const { size } = writeTranscript([
      envelopeLine({ text: "compressed first", sequence: 1, exactLineBytes: 40_000 }),
      envelopeLine({ text: "compressed second", sequence: 2, exactLineBytes: 40_000 }),
      envelopeLine({ text: "compressed third", sequence: 3, exactLineBytes: 40_000 }),
    ]);
    const compressedPath = `${transcriptPath}.gz`;
    fs.writeFileSync(compressedPath, gzipSync(fs.readFileSync(transcriptPath)));
    fs.unlinkSync(transcriptPath);
    const readFile = vi.spyOn(fs, "readFileSync");

    const first = readTranscriptHistoryPage({
      transcriptPath: compressedPath,
      sessionId: SESSION_ID,
      beforeOffset: size,
      maxBytes: CHAT_EVENT_HISTORY_PAGE_MIN_BYTES,
    });
    readTranscriptHistoryPage({
      transcriptPath: compressedPath,
      sessionId: SESSION_ID,
      beforeOffset: first.startOffset,
      maxBytes: CHAT_EVENT_HISTORY_PAGE_MIN_BYTES,
    });

    expect(readFile.mock.calls.filter(([filePath]) => filePath === compressedPath)).toHaveLength(1);
  });

  it("returns an empty head-reached page for beforeOffset <= 0", () => {
    writeTranscript([envelopeLine({ text: "a" })]);
    for (const beforeOffset of [0, -1, Number.NaN]) {
      const page = readTranscriptHistoryPage({ transcriptPath, sessionId: SESSION_ID, beforeOffset });
      expect(page.envelopes).toEqual([]);
      expect(page.startOffset).toBe(0);
      expect(page.hasMore).toBe(false);
    }
  });

  it("clamps beforeOffset beyond the file size to the file size", () => {
    const { size } = writeTranscript([
      envelopeLine({ text: "first", sequence: 1 }),
      envelopeLine({ text: "second", sequence: 2 }),
    ]);
    const page = readTranscriptHistoryPage({
      transcriptPath,
      sessionId: SESSION_ID,
      beforeOffset: size + 50_000,
    });
    expect(page.envelopes.map(eventText)).toEqual(["first", "second"]);
    expect(page.startOffset).toBe(0);
    expect(page.hasMore).toBe(false);
  });

  it("throws when the transcript file is missing (caller decides the fallback)", () => {
    expect(() => readTranscriptHistoryPage({
      transcriptPath: path.join(tmpRoot, "missing.jsonl"),
      sessionId: SESSION_ID,
      beforeOffset: 100,
    })).toThrow();
  });

  it("walks the whole transcript backwards with strictly decreasing line-start cursors and no gaps or overlaps", () => {
    // ~40KB lines so the (min-clamped) 64KB window holds ~1 complete line per page.
    const lines = Array.from({ length: 12 }, (_, index) =>
      envelopeLine({ text: `line-${index}-`, sequence: index, exactLineBytes: 40_000 }));
    const { size, lineOffsets } = writeTranscript(lines);

    const collectedTexts: string[] = [];
    const cursors: number[] = [];
    let beforeOffset = size;
    for (let guard = 0; guard < 100 && beforeOffset > 0; guard += 1) {
      const page = readTranscriptHistoryPage({
        transcriptPath,
        sessionId: SESSION_ID,
        beforeOffset,
        maxBytes: 1, // clamped up to 64k
      });
      expect(page.startOffset).toBeLessThan(beforeOffset);
      expect(page.startOffset).toBeGreaterThanOrEqual(0);
      // Cursors always land on a line start.
      expect(lineOffsets.includes(page.startOffset) || page.startOffset === 0).toBe(true);
      cursors.push(page.startOffset);
      collectedTexts.unshift(...page.envelopes.map(eventText));
      expect(page.hasMore).toBe(page.startOffset > 0);
      beforeOffset = page.startOffset;
    }

    expect(beforeOffset).toBe(0);
    expect(collectedTexts.map((text) => text.slice(0, text.indexOf("-", 5) + 1)))
      .toEqual(Array.from({ length: 12 }, (_, index) => `line-${index}-`));
    // Strictly decreasing cursor sequence.
    for (let index = 1; index < cursors.length; index += 1) {
      expect(cursors[index]!).toBeLessThan(cursors[index - 1]!);
    }
  });

  it("keeps a complete first line when the window boundary lands exactly on a line start", () => {
    const headLine = envelopeLine({ text: "head", sequence: 0, exactLineBytes: 10_000 });
    // Tail line sized so `end - pageBytes` lands exactly at its first byte.
    const tailLine = envelopeLine({ text: "tail", sequence: 1, exactLineBytes: CHAT_EVENT_HISTORY_PAGE_MIN_BYTES });
    const { size, lineOffsets } = writeTranscript([headLine, tailLine]);

    const page = readTranscriptHistoryPage({
      transcriptPath,
      sessionId: SESSION_ID,
      beforeOffset: size,
      maxBytes: CHAT_EVENT_HISTORY_PAGE_MIN_BYTES,
    });
    // The window is exactly the tail line — it must be returned, not dropped.
    expect(page.envelopes).toHaveLength(1);
    expect(eventText(page.envelopes[0]!).startsWith("tail")).toBe(true);
    expect(page.startOffset).toBe(lineOffsets[1]);
    expect(page.hasMore).toBe(true);
  });

  it("pages past a single line larger than the window with strictly decreasing empty pages", () => {
    const before = envelopeLine({ text: "before-giant", sequence: 0, exactLineBytes: 5_000 });
    const giant = envelopeLine({ text: "giant", sequence: 1, exactLineBytes: 3 * CHAT_EVENT_HISTORY_PAGE_MIN_BYTES });
    const after = envelopeLine({ text: "after-giant", sequence: 2, exactLineBytes: 5_000 });
    const { size } = writeTranscript([before, giant, after]);

    const seenTexts: string[] = [];
    let beforeOffset = size;
    let sawEmptyPage = false;
    for (let guard = 0; guard < 100 && beforeOffset > 0; guard += 1) {
      const page = readTranscriptHistoryPage({
        transcriptPath,
        sessionId: SESSION_ID,
        beforeOffset,
        maxBytes: CHAT_EVENT_HISTORY_PAGE_MIN_BYTES,
      });
      // Never loops: the cursor strictly decreases even for empty pages.
      expect(page.startOffset).toBeLessThan(beforeOffset);
      if (!page.envelopes.length && page.hasMore) sawEmptyPage = true;
      seenTexts.unshift(...page.envelopes.map(eventText));
      beforeOffset = page.startOffset;
    }

    expect(beforeOffset).toBe(0);
    expect(sawEmptyPage).toBe(true);
    // The giant line itself is unrecoverable within a single window, but both
    // neighbours are reachable and ordered.
    expect(seenTexts.some((text) => text.startsWith("before-giant"))).toBe(true);
    expect(seenTexts.some((text) => text.startsWith("after-giant"))).toBe(true);
    expect(
      seenTexts.findIndex((text) => text.startsWith("before-giant")),
    ).toBeLessThan(seenTexts.findIndex((text) => text.startsWith("after-giant")));
  });

  it("keeps byte cursors on line boundaries when lines contain multi-byte UTF-8", () => {
    // Multi-byte payloads make byte length != char length; offsets must stay
    // byte-accurate or pages would split codepoints / skip lines.
    const emoji = "🚀汉字Ωé".repeat(1_000);
    const lines = [
      envelopeLine({ text: `early-${emoji}`, sequence: 0, exactLineBytes: 45_000 }),
      envelopeLine({ text: `multibyte-${emoji}`, sequence: 1 }),
      envelopeLine({ text: "tail-ascii", sequence: 2, exactLineBytes: 50_000 }),
    ];
    const { size, lineOffsets } = writeTranscript(lines);

    const collected: string[] = [];
    let beforeOffset = size;
    for (let guard = 0; guard < 50 && beforeOffset > 0; guard += 1) {
      const page = readTranscriptHistoryPage({
        transcriptPath,
        sessionId: SESSION_ID,
        beforeOffset,
        maxBytes: CHAT_EVENT_HISTORY_PAGE_MIN_BYTES,
      });
      expect(page.startOffset).toBeLessThan(beforeOffset);
      expect(lineOffsets.includes(page.startOffset) || page.startOffset === 0).toBe(true);
      collected.unshift(...page.envelopes.map(eventText));
      beforeOffset = page.startOffset;
    }

    expect(collected).toHaveLength(3);
    expect(collected[0]!.startsWith("early-🚀汉字Ωé")).toBe(true);
    expect(collected[1]).toBe(`multibyte-${emoji}`);
    expect(collected[2]!.startsWith("tail-ascii")).toBe(true);
  });

  it("filters envelopes to the requested session while still advancing the cursor", () => {
    const { size } = writeTranscript([
      envelopeLine({ text: "mine-1", sequence: 1 }),
      envelopeLine({ text: "other", sessionId: "someone-else", sequence: 2 }),
      envelopeLine({ text: "mine-2", sequence: 3 }),
    ]);
    const page = readTranscriptHistoryPage({ transcriptPath, sessionId: SESSION_ID, beforeOffset: size });
    expect(page.envelopes.map(eventText)).toEqual(["mine-1", "mine-2"]);
    expect(page.startOffset).toBe(0);
    expect(page.hasMore).toBe(false);
  });

  it("returns identical pages for the same cursor while the file is concurrently appended", () => {
    const lines = Array.from({ length: 4 }, (_, index) =>
      envelopeLine({ text: `stable-${index}`, sequence: index, exactLineBytes: 30_000 }));
    const { size } = writeTranscript(lines);

    const first = readTranscriptHistoryPage({
      transcriptPath,
      sessionId: SESSION_ID,
      beforeOffset: size,
      maxBytes: CHAT_EVENT_HISTORY_PAGE_MIN_BYTES,
    });
    // Concurrent append after the cursor was issued.
    fs.appendFileSync(transcriptPath, envelopeLine({ text: "appended-later", sequence: 99 }), "utf8");
    const second = readTranscriptHistoryPage({
      transcriptPath,
      sessionId: SESSION_ID,
      beforeOffset: size,
      maxBytes: CHAT_EVENT_HISTORY_PAGE_MIN_BYTES,
    });

    expect(second.startOffset).toBe(first.startOffset);
    expect(second.hasMore).toBe(first.hasMore);
    expect(second.envelopes.map(eventText)).toEqual(first.envelopes.map(eventText));
    expect(second.envelopes.map(eventText)).not.toContain("appended-later");
  });
});
