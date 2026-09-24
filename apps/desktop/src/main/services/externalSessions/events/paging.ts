import fs from "node:fs";
import type { AgentChatEventEnvelope } from "../../../../shared/types";

/**
 * Paging model.
 *
 * A JSONL store is read in byte windows that end on a line boundary. A window
 * is converted whole, and pages are cut from its events newest-first. The
 * cursor names the window (`end`, an absolute byte offset, and `bytes`, its
 * size) and the first event already shown from it (`index`). When `index`
 * reaches 0 the next cursor names the window that ends where this one started
 * (`index: null` = from its end).
 *
 * Offsets are absolute, so appends to a live file never shift an older page.
 * Limits: a line longer than the window is skipped; a tool call and its result
 * that fall on either side of a window edge render as two rows.
 *
 * A non-file source (OpenCode export) pages by `index` alone (`end: null`).
 */
export type EventsCursor = { end: number | null; index: number | null; bytes?: number | null };

export function encodeEventsCursor(cursor: EventsCursor): string {
  return Buffer.from(
    JSON.stringify({ v: 1, e: cursor.end, i: cursor.index, ...(cursor.bytes ? { b: cursor.bytes } : {}) }),
    "utf8",
  ).toString("base64url");
}

export function decodeEventsCursor(raw: string | null | undefined): EventsCursor | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw.trim(), "base64url").toString("utf8")) as Record<string, unknown>;
    if (!parsed || parsed.v !== 1) return null;
    const end = typeof parsed.e === "number" && Number.isInteger(parsed.e) && parsed.e >= 0 ? parsed.e : null;
    const index = typeof parsed.i === "number" && Number.isInteger(parsed.i) && parsed.i >= 0 ? parsed.i : null;
    const bytes = typeof parsed.b === "number" && Number.isInteger(parsed.b) && parsed.b > 0 ? parsed.b : null;
    if (end === null && index === null) return null;
    return { end, index, bytes };
  } catch {
    return null;
  }
}

export type JsonlWindow = {
  /** Parsed lines, oldest first (lines that do not parse are left out). */
  records: unknown[];
  /** Absolute byte offset of each line's start. */
  offsets: number[];
  /** Byte offset of the first whole line in the window. */
  start: number;
  /** Byte offset just past the last whole line in the window. */
  end: number;
  /**
   * The `end` the window was read up to. A cursor into this window re-reads
   * `[readEnd - maxBytes, readEnd)`, which yields the same leading lines even
   * after the file has grown.
   */
  readEnd: number;
};

/**
 * The whole lines in `[end - maxBytes, end)` of a JSONL file (`end` defaults
 * to the file size). A partial line at either edge is left out: the leading
 * one belongs to the previous window, a trailing one is still being written.
 * Async so a large read never blocks the Electron main thread.
 */
export async function readJsonlWindow(
  filePath: string,
  args: { end?: number | null; maxBytes: number },
): Promise<JsonlWindow | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(filePath, "r");
    const size = (await handle.stat()).size;
    const end = Math.min(size, Math.max(0, args.end ?? size));
    const windowStart = Math.max(0, end - Math.max(1, Math.floor(args.maxBytes)));
    if (end - windowStart <= 0) return { records: [], offsets: [], start: 0, end: 0, readEnd: end };
    // Read one byte before the window: when it is a newline, the window's
    // first line is whole and is kept.
    const readStart = windowStart > 0 ? windowStart - 1 : 0;
    const length = end - readStart;
    const buffer = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, readStart + filled);
      if (bytesRead <= 0) break;
      filled += bytesRead;
    }
    const bytes = buffer.subarray(0, filled);
    let first = 0;
    if (readStart > 0 || windowStart > 0) {
      const newline = bytes.indexOf(0x0a);
      // No newline at all: the window is the inside of one oversized line.
      // Skip it whole so paging still moves backwards.
      if (newline < 0) return { records: [], offsets: [], start: windowStart, end: windowStart, readEnd: end };
      first = newline + 1;
    }
    const lastNewline = bytes.lastIndexOf(0x0a);
    // At end of file, a last line without a trailing newline is complete when
    // it parses; any other trailing fragment is dropped.
    const tailEnd = lastNewline >= first ? lastNewline + 1 : first;
    const records: unknown[] = [];
    const offsets: number[] = [];
    let cursor = first;
    while (cursor < tailEnd) {
      let next = bytes.indexOf(0x0a, cursor);
      if (next < 0 || next >= tailEnd) next = tailEnd - 1;
      pushLine(bytes.subarray(cursor, next), readStart + cursor, records, offsets);
      cursor = next + 1;
    }
    let windowEnd = readStart + tailEnd;
    if (tailEnd < bytes.length && readStart + bytes.length === size) {
      const trailing = bytes.subarray(tailEnd);
      if (pushLine(trailing, readStart + tailEnd, records, offsets)) windowEnd = size;
    }
    return { records, offsets, start: readStart + first, end: windowEnd, readEnd: end };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Adds a line that parses; reports whether it did. */
function pushLine(line: Buffer, offset: number, records: unknown[], offsets: number[]): boolean {
  const text = line.toString("utf8").trim();
  if (!text) return false;
  try {
    records.push(JSON.parse(text));
    offsets.push(offset);
    return true;
  } catch {
    return false;
  }
}

export type PageCut = {
  page: AgentChatEventEnvelope[];
  /** Events of this source before the page (same window / same list). */
  earlier: AgentChatEventEnvelope[];
  olderCursor: string | null;
};

/**
 * Cuts the newest `maxEvents` events before `index` (all when null), and
 * names the cursor for the page before them. `windowStart`/`windowEnd`/
 * `windowBytes` describe a file window; they are `null` for an in-memory list.
 */
export function cutPage(
  events: AgentChatEventEnvelope[],
  args: {
    maxEvents: number;
    index: number | null;
    windowStart: number | null;
    windowEnd: number | null;
    windowBytes: number | null;
  },
): PageCut {
  const limit = args.index === null ? events.length : Math.min(args.index, events.length);
  const available = events.slice(0, limit);
  const pageStart = Math.max(0, available.length - args.maxEvents);
  let olderCursor: string | null = null;
  if (pageStart > 0) {
    olderCursor = encodeEventsCursor({ end: args.windowEnd, index: pageStart, bytes: args.windowBytes });
  } else if (args.windowStart !== null && args.windowStart > 0) {
    olderCursor = encodeEventsCursor({ end: args.windowStart, index: null });
  }
  return {
    page: available.slice(pageStart),
    earlier: available.slice(0, pageStart),
    olderCursor,
  };
}
