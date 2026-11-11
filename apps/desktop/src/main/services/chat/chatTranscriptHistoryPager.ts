import { parseAgentChatTranscript } from "../../../shared/chatTranscript";
import type { AgentChatEventEnvelope } from "../../../shared/types/chat";
import {
  readHistoryFileRange,
  readHistoryFileSize,
} from "../storage/historyCompression";

/**
 * Byte-window pager for chat transcript JSONL files.
 *
 * `getChatEventHistory` hydrates only the LAST ~2MB of a transcript; this
 * module reads bounded windows of OLDER bytes so clients can scroll back
 * through arbitrarily large transcripts. Cursors are byte offsets that always
 * land on line starts: a page covers `[startOffset, beforeOffset)` and the
 * next older page is requested with `beforeOffset = startOffset`. Because the
 * transcript is append-only and cursors only move toward 0, concurrent
 * appends never affect already-issued pages.
 */

export const CHAT_EVENT_HISTORY_PAGE_DEFAULT_BYTES = 256 * 1024;
export const CHAT_EVENT_HISTORY_PAGE_MIN_BYTES = 64 * 1024;
export const CHAT_EVENT_HISTORY_PAGE_MAX_BYTES = 2_000_000;

export function clampHistoryPageBytes(maxBytes: number | null | undefined): number {
  const requested = typeof maxBytes === "number" && Number.isFinite(maxBytes)
    ? Math.floor(maxBytes)
    : CHAT_EVENT_HISTORY_PAGE_DEFAULT_BYTES;
  return Math.max(
    CHAT_EVENT_HISTORY_PAGE_MIN_BYTES,
    Math.min(CHAT_EVENT_HISTORY_PAGE_MAX_BYTES, requested),
  );
}

export type TranscriptHistoryPageRead = {
  envelopes: AgentChatEventEnvelope[];
  /** Logical byte offset of each corresponding envelope's JSONL row. */
  envelopeStartOffsets: number[];
  /**
   * Byte offset where this page begins (always on a line start). 0 means the
   * head of the file was reached. Guaranteed to be strictly less than the
   * requested `beforeOffset` whenever `beforeOffset > 0` and the file is
   * non-empty, so cursor loops always terminate.
   */
  startOffset: number;
  hasMore: boolean;
};

const EMPTY_PAGE: TranscriptHistoryPageRead = {
  envelopes: [],
  envelopeStartOffsets: [],
  startOffset: 0,
  hasMore: false,
};

/**
 * Read one page of transcript history ending (exclusively) at `beforeOffset`.
 *
 * - `beforeOffset <= 0` → empty page, head reached.
 * - `beforeOffset > file size` → clamped to the file size.
 * - When the window does not start at the head of the file, the first partial
 *   line is dropped and `startOffset` points at the byte right AFTER its
 *   terminating newline, so pages never overlap or skip lines.
 * - If the boundary lands inside one oversized row, the read expands up to
 *   the service's 2 MB page ceiling. A row larger than that is never loaded:
 *   the page is that one row, `startOffset` is the row's own start, and in
 *   its place the page carries a `system_notice` with status
 *   `HISTORY_ROW_OMITTED_NOTICE_STATUS` (see `readOmittedRowPage`). The
 *   cursor still never moves past a row without telling the client.
 *
 * Throws on filesystem errors (missing file, etc.) — callers decide how to
 * surface that.
 */
export async function readTranscriptHistoryPage(args: {
  transcriptPath: string;
  sessionId: string;
  beforeOffset: number;
  maxBytes?: number | null;
  signal?: AbortSignal;
}): Promise<TranscriptHistoryPageRead> {
  const { transcriptPath, sessionId } = args;
  const beforeOffset = Number.isFinite(args.beforeOffset) ? Math.floor(args.beforeOffset) : 0;
  if (beforeOffset <= 0) return { ...EMPTY_PAGE };

  const pageBytes = clampHistoryPageBytes(args.maxBytes);
  const size = await readHistoryFileSize(transcriptPath);
  const end = Math.min(beforeOffset, size);
  if (end <= 0) return { ...EMPTY_PAGE };

  let readBytes = pageBytes;
  let slice: Awaited<ReturnType<typeof readHistoryFileRange>>;
  let startOffset = 0;
  while (true) {
    const start = Math.max(0, end - readBytes);
    // Read one extra byte before the window (when possible) so we can tell
    // whether `start` itself sits on a line start (previous byte is "\n").
    const readStart = Math.max(0, start - 1);
    slice = await readHistoryFileRange(
      transcriptPath,
      readStart,
      end - readStart,
      args.signal,
    );
    startOffset = readStart;
    if (readStart === 0) break;

    const firstNewline = slice.indexOf(0x0a);
    const lineStart = firstNewline >= 0 ? readStart + firstNewline + 1 : -1;
    if (lineStart >= 0 && lineStart < end) {
      startOffset = lineStart;
      slice = slice.subarray(firstNewline + 1);
      break;
    }
    if (readBytes >= CHAT_EVENT_HISTORY_PAGE_MAX_BYTES) {
      return await readOmittedRowPage({
        transcriptPath,
        sessionId,
        searchBefore: readStart,
        end,
        ...(args.signal ? { signal: args.signal } : {}),
      });
    }
    readBytes = Math.min(CHAT_EVENT_HISTORY_PAGE_MAX_BYTES, readBytes * 2);
  }

  const raw = slice.toString("utf8");
  const envelopes = parseAgentChatTranscript(raw)
    .filter((entry) => entry.sessionId === sessionId);
  const parsedLineOffsets: number[] = [];
  let lineStart = 0;
  while (lineStart < slice.length) {
    const newline = slice.indexOf(0x0a, lineStart);
    const lineEnd = newline >= 0 ? newline : slice.length;
    const rawLine = slice.subarray(lineStart, lineEnd).toString("utf8").trim();
    if (rawLine.length > 0) {
      try {
        const parsed = JSON.parse(rawLine) as Partial<AgentChatEventEnvelope>;
        if (
          typeof parsed.sessionId === "string"
          && parsed.sessionId.trim() === sessionId
          && parsed.event
          && typeof parsed.event === "object"
        ) {
          parsedLineOffsets.push(startOffset + lineStart);
        }
      } catch {
        // Keep offset discovery aligned with the transcript parser: malformed
        // JSONL rows are ignored.
      }
    }
    if (newline < 0) break;
    lineStart = newline + 1;
  }
  // Production parsing yields one envelope per valid JSONL row. Keep a safe
  // fallback for tests/custom parser shims whose output is not line-derived.
  const envelopeStartOffsets = parsedLineOffsets.length === envelopes.length
    ? parsedLineOffsets
    : envelopes.map(() => startOffset);
  return {
    envelopes,
    envelopeStartOffsets,
    startOffset,
    hasMore: startOffset > 0,
  };
}

/**
 * `system_notice.status` of the stand-in for a row too large to page. Every
 * client already draws a `system_notice` (a quiet info line), so an older
 * desktop, the web client or the phone shows it without knowing this status.
 */
const HISTORY_ROW_OMITTED_NOTICE_STATUS = "history_row_omitted";

/** True for the display-only stand-in a page carries for a row too large to page. */
export function isOmittedHistoryRowNotice(envelope: AgentChatEventEnvelope): boolean {
  return envelope.event.type === "system_notice"
    && envelope.event.status === HISTORY_ROW_OMITTED_NOTICE_STATUS
    && envelope.sequence === undefined;
}

/** Chunk size of the bounded scans over one oversized row. */
const OMITTED_ROW_SCAN_CHUNK_BYTES = 1024 * 1024;
/**
 * The forward read for the omitted row's own fields stops here: the largest
 * row the rest of the chat service accepts. A row past it still gets its
 * stand-in, from the fields read so far (`provenance`, written after the
 * event, may be missed).
 */
const OMITTED_ROW_FIELD_SCAN_MAX_BYTES = 8 * 1024 * 1024;

type OmittedRowFields = {
  sessionId?: string;
  timestamp?: string;
  eventType?: string;
  eventIsObject?: boolean;
  targetKind?: string;
};

/**
 * Reads the few envelope fields a stand-in needs from a JSONL row fed in
 * chunks, without materializing the row: `sessionId` and `timestamp` at the
 * top level, `event.type` and `provenance.targetKind` one
 * level down. Tracks only string/escape state and nesting depth; long
 * strings are skipped with `indexOf`, so a multi-megabyte tool result costs a
 * few native scans, not a byte loop.
 */
function createOmittedRowFieldScanner() {
  const fields: OmittedRowFields = {};
  const maxCaptureBytes = 1024;
  let depth = 0;
  let inString = false;
  let escape = false;
  let stringIsKey = false;
  let expectKey = false;
  let pendingKey: string | null = null;
  /** Key of the depth-2 object being read ("event" / "provenance"), else null. */
  let container: string | null = null;
  let capture: number[] | null = null;
  let captureKey: string | null = null;
  let captureOverflow = false;
  let finished = false;

  const tracked = () => depth === 1 || (depth === 2 && container !== null);
  const wantsValue = (key: string): boolean => {
    if (depth === 1) return key === "sessionId" || key === "timestamp";
    if (container === "event") return key === "type";
    if (container === "provenance") return key === "targetKind";
    return false;
  };
  const assign = (key: string, value: string) => {
    if (depth === 1) {
      if (key === "sessionId") fields.sessionId ??= value;
      else if (key === "timestamp") fields.timestamp ??= value;
    } else if (container === "event" && key === "type") {
      fields.eventType ??= value;
    } else if (container === "provenance" && key === "targetKind") {
      fields.targetKind ??= value;
    }
  };
  const decodeString = (bytes: number[]): string | null => {
    try {
      const decoded: unknown = JSON.parse(`"${Buffer.from(bytes).toString("utf8")}"`);
      return typeof decoded === "string" ? decoded : null;
    } catch {
      return null;
    }
  };

  return {
    fields,
    get finished() {
      return finished;
    },
    feed(chunk: Buffer): void {
      let index = 0;
      // Next quote / backslash at or after `index` in this chunk (-1: none),
      // cached so text dense with escapes does not rescan for a far quote.
      let nextQuote = -2;
      let nextBackslash = -2;
      while (index < chunk.length && !finished) {
        if (inString) {
          if (!escape && !stringIsKey && capture === null) {
            // Skip to the next quote or backslash with native scans.
            if (nextQuote !== -1 && nextQuote < index) nextQuote = chunk.indexOf(0x22, index);
            if (nextBackslash !== -1 && nextBackslash < index) nextBackslash = chunk.indexOf(0x5c, index);
            const next = nextQuote < 0
              ? nextBackslash
              : nextBackslash < 0 ? nextQuote : Math.min(nextQuote, nextBackslash);
            if (next < 0) return;
            index = next;
          }
          const byte = chunk[index]!;
          index += 1;
          if (escape) {
            escape = false;
          } else if (byte === 0x5c) {
            escape = true;
          } else if (byte === 0x22) {
            inString = false;
            if (stringIsKey) {
              pendingKey = capture && !captureOverflow ? decodeString(capture) : null;
              expectKey = false;
            } else if (capture && captureKey && !captureOverflow) {
              const value = decodeString(capture);
              if (value !== null) assign(captureKey, value);
            }
            capture = null;
            captureKey = null;
            captureOverflow = false;
            continue;
          }
          if (capture) {
            if (capture.length < maxCaptureBytes) capture.push(byte);
            else captureOverflow = true;
          }
          continue;
        }
        const byte = chunk[index]!;
        index += 1;
        if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x3a) continue;
        if (byte === 0x22) {
          inString = true;
          stringIsKey = tracked() && expectKey;
          if (stringIsKey) {
            capture = [];
          } else if (tracked() && pendingKey !== null && wantsValue(pendingKey)) {
            capture = [];
            captureKey = pendingKey;
          }
          if (!stringIsKey) pendingKey = null;
          continue;
        }
        if (byte === 0x7b || byte === 0x5b) {
          const openingKey = depth === 1 ? pendingKey : null;
          depth += 1;
          if (depth === 2) {
            container = byte === 0x7b && (openingKey === "event" || openingKey === "provenance") ? openingKey : null;
            if (container === "event") fields.eventIsObject = true;
          }
          pendingKey = null;
          expectKey = byte === 0x7b;
          continue;
        }
        if (byte === 0x7d || byte === 0x5d) {
          depth -= 1;
          if (depth <= 1) container = null;
          pendingKey = null;
          expectKey = false;
          if (depth <= 0) finished = true;
          continue;
        }
        if (byte === 0x2c) {
          pendingKey = null;
          expectKey = tracked();
          continue;
        }
        // Numbers and true / false / null literals.
        pendingKey = null;
      }
    },
  };
}

function formatOmittedRowSize(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** Plain words for the kinds of row that grow this large. */
const OMITTED_ROW_KIND_LABELS: Readonly<Record<string, string>> = {
  tool_result: "a tool result",
  tool_call: "a tool call",
  user_message: "a message",
  text: "a reply",
};

/**
 * The page for a row too large to page (`readTranscriptHistoryPage` found no
 * line start in its largest window). Nothing older than the row is skipped:
 * the page is exactly the row, `[rowStart, end)`, and the next page continues
 * from `rowStart`.
 *
 * 1. Scan backward from `searchBefore` in bounded chunks for the newline that
 *    ends the previous row; none before offset 0 means the row starts at 0.
 * 2. Read the row forward in bounded chunks, at most
 *    `OMITTED_ROW_FIELD_SCAN_MAX_BYTES`, for its session, timestamp, event
 *    type and provenance target.
 * 3. A row of this chat becomes one `system_notice` stand-in with the row's
 *    timestamp and NO `sequence`. The stand-in is display-only: a durable log
 *    keyed on sequence (the phone's chat log, sync resume, delivery keys)
 *    never stores it as row N, so it can never take the real row's place,
 *    and a later full copy of row N is never deduped against it. A row of another
 *    chat, or one whose fields cannot be read (a torn or malformed row), would
 *    have been dropped by the normal parse too, and is dropped here.
 *
 * Cost: the row's bytes minus the window already read, backward, plus up to
 * 8 MB forward, all in 1 MB reads. Terminates for any input: both scans move
 * monotonically and stop at offset 0 / `end`.
 */
async function readOmittedRowPage(args: {
  transcriptPath: string;
  sessionId: string;
  /** No newline lies in `[searchBefore, end - 1)`. */
  searchBefore: number;
  end: number;
  signal?: AbortSignal;
}): Promise<TranscriptHistoryPageRead> {
  const { transcriptPath, sessionId, end, signal } = args;
  let rowStart = 0;
  let scan = args.searchBefore;
  while (scan > 0) {
    signal?.throwIfAborted();
    const chunkStart = Math.max(0, scan - OMITTED_ROW_SCAN_CHUNK_BYTES);
    const chunk = await readHistoryFileRange(transcriptPath, chunkStart, scan - chunkStart, signal);
    if (chunk.length === 0) break;
    const newline = chunk.lastIndexOf(0x0a);
    if (newline >= 0) {
      rowStart = chunkStart + newline + 1;
      break;
    }
    scan = chunkStart;
  }

  const scanner = createOmittedRowFieldScanner();
  const fieldScanEnd = Math.min(end, rowStart + OMITTED_ROW_FIELD_SCAN_MAX_BYTES);
  for (let offset = rowStart; offset < fieldScanEnd && !scanner.finished;) {
    signal?.throwIfAborted();
    const chunk = await readHistoryFileRange(
      transcriptPath,
      offset,
      Math.min(OMITTED_ROW_SCAN_CHUNK_BYTES, fieldScanEnd - offset),
      signal,
    );
    if (chunk.length === 0) break;
    scanner.feed(chunk);
    offset += chunk.length;
  }

  const { fields } = scanner;
  const page: TranscriptHistoryPageRead = {
    envelopes: [],
    envelopeStartOffsets: [],
    startOffset: rowStart,
    hasMore: rowStart > 0,
  };
  if (fields.sessionId?.trim() !== sessionId || !fields.eventIsObject) return page;

  const rowBytes = end - rowStart;
  const kindLabel = fields.eventType ? OMITTED_ROW_KIND_LABELS[fields.eventType] : undefined;
  const stoodInFor = kindLabel ? ` (${kindLabel})` : "";
  page.envelopes.push({
    sessionId,
    timestamp: fields.timestamp ?? new Date(0).toISOString(),
    event: {
      type: "system_notice",
      noticeKind: "info",
      severity: "info",
      status: HISTORY_ROW_OMITTED_NOTICE_STATUS,
      message: "One very large entry was left out of this chat's history.",
      detail: `The entry${stoodInFor} is ${formatOmittedRowSize(rowBytes)}, more than chat history loads at once (${formatOmittedRowSize(CHAT_EVENT_HISTORY_PAGE_MAX_BYTES)}). It is still saved in the chat's transcript file.`,
    },
    ...(fields.targetKind ? { provenance: { targetKind: fields.targetKind } } : {}),
  });
  page.envelopeStartOffsets.push(rowStart);
  return page;
}

const SEQUENCE_PROBE_CHUNK_BYTES = 64 * 1024;
/** A probe never materializes a row larger than this; such rows are skipped. */
const SEQUENCE_PROBE_MAX_ROW_BYTES = 8 * 1024 * 1024;

type SequencedRowProbe = { lineStart: number; sequence: number };

function parseSequencedRow(raw: string, sessionId: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed.length) return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<AgentChatEventEnvelope>;
    if (typeof parsed.sessionId !== "string" || parsed.sessionId.trim() !== sessionId) return null;
    if (!parsed.event || typeof parsed.event !== "object") return null;
    const sequence = parsed.sequence;
    return typeof sequence === "number" && Number.isFinite(sequence) && sequence > 0
      ? Math.floor(sequence)
      : null;
  } catch {
    return null;
  }
}

/**
 * The first row of `sessionId` that starts at or after `offset` and carries a
 * sequence, or null at EOF. Reads forward in bounded chunks.
 */
async function probeSequencedRowAtOrAfter(args: {
  transcriptPath: string;
  sessionId: string;
  offset: number;
  size: number;
  signal?: AbortSignal;
}): Promise<SequencedRowProbe | null> {
  const { transcriptPath, sessionId, size, signal } = args;
  // Find the first line start at or after `offset`.
  let lineStart: number;
  if (args.offset <= 0) {
    lineStart = 0;
  } else {
    let scan = args.offset - 1;
    lineStart = -1;
    while (scan < size) {
      signal?.throwIfAborted();
      const chunk = await readHistoryFileRange(
        transcriptPath,
        scan,
        Math.min(SEQUENCE_PROBE_CHUNK_BYTES, size - scan),
        signal,
      );
      if (chunk.length === 0) break;
      const newline = chunk.indexOf(0x0a);
      if (newline >= 0) {
        lineStart = scan + newline + 1;
        break;
      }
      scan += chunk.length;
    }
    if (lineStart < 0) return null;
  }
  // Walk rows forward until one carries a sequence.
  while (lineStart < size) {
    signal?.throwIfAborted();
    let length = Math.min(SEQUENCE_PROBE_CHUNK_BYTES, size - lineStart);
    let row: Buffer | null = null;
    let rowEnd = -1;
    while (true) {
      const chunk = await readHistoryFileRange(transcriptPath, lineStart, length, signal);
      const newline = chunk.indexOf(0x0a);
      if (newline >= 0) {
        row = chunk.subarray(0, newline);
        rowEnd = lineStart + newline + 1;
        break;
      }
      if (lineStart + chunk.length >= size) {
        row = chunk;
        rowEnd = size;
        break;
      }
      if (length >= SEQUENCE_PROBE_MAX_ROW_BYTES) {
        // Too large to parse here: skip to the end of this row.
        let skip = lineStart + chunk.length;
        rowEnd = -1;
        while (skip < size) {
          const next = await readHistoryFileRange(
            transcriptPath,
            skip,
            Math.min(SEQUENCE_PROBE_CHUNK_BYTES, size - skip),
            signal,
          );
          if (next.length === 0) break;
          const skipNewline = next.indexOf(0x0a);
          if (skipNewline >= 0) {
            rowEnd = skip + skipNewline + 1;
            break;
          }
          skip += next.length;
        }
        row = null;
        break;
      }
      length = Math.min(size - lineStart, length * 2, SEQUENCE_PROBE_MAX_ROW_BYTES);
    }
    if (row) {
      const sequence = parseSequencedRow(row.toString("utf8"), sessionId);
      if (sequence != null) return { lineStart, sequence };
    }
    if (rowEnd < 0 || rowEnd <= lineStart) return null;
    lineStart = rowEnd;
  }
  return null;
}

/**
 * Byte offset of the first row whose sequence is `>= sequence` — the exclusive
 * end of "everything older than `sequence`". Binary search over line starts:
 * the durable transcript's sequences increase with file position, so the probe
 * predicate is monotone and the search costs O(log size) bounded reads.
 * Returns the file size when every row is older.
 */
export async function findTranscriptOffsetForSequence(args: {
  transcriptPath: string;
  sessionId: string;
  sequence: number;
  signal?: AbortSignal;
}): Promise<number> {
  const size = await readHistoryFileSize(args.transcriptPath);
  let lo = 0;
  let hi = size;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const probe = await probeSequencedRowAtOrAfter({ ...args, offset: mid, size });
    if (!probe || probe.sequence >= args.sequence) {
      hi = mid;
    } else {
      // Every offset up to this row's start probes the same (older) row.
      lo = Math.max(mid + 1, probe.lineStart + 1);
    }
  }
  const first = await probeSequencedRowAtOrAfter({ ...args, offset: lo, size });
  return first && first.sequence >= args.sequence ? first.lineStart : size;
}

/**
 * One page of history OLDER than `beforeSequence` (a persisted envelope
 * sequence) — the sequence-cursor twin of `readTranscriptHistoryPage`, for
 * clients whose cached log trims its oldest rows and so cannot keep a byte
 * cursor. Same byte window, same ordering (oldest first), same `hasMore`.
 */
export async function readTranscriptHistoryPageBeforeSequence(args: {
  transcriptPath: string;
  sessionId: string;
  beforeSequence: number;
  maxBytes?: number | null;
  signal?: AbortSignal;
}): Promise<TranscriptHistoryPageRead> {
  const beforeSequence = Math.floor(args.beforeSequence);
  if (!Number.isFinite(beforeSequence) || beforeSequence <= 1) return { ...EMPTY_PAGE };
  const beforeOffset = await findTranscriptOffsetForSequence({
    transcriptPath: args.transcriptPath,
    sessionId: args.sessionId,
    sequence: beforeSequence,
    ...(args.signal ? { signal: args.signal } : {}),
  });
  const readBefore = (offset: number) => readTranscriptHistoryPage({
    transcriptPath: args.transcriptPath,
    sessionId: args.sessionId,
    beforeOffset: offset,
    maxBytes: args.maxBytes,
    ...(args.signal ? { signal: args.signal } : {}),
  });
  let page = await readBefore(beforeOffset);
  // The client's next cursor is the oldest sequence on this page, and an
  // omitted-row stand-in carries none. A page that is only stand-ins (or only
  // unsequenced rows) takes the older pages too, up to a bound, so the cursor
  // moves past the oversized row instead of asking for it again.
  for (
    let extra = 0;
    extra < 8 && page.hasMore && !page.envelopes.some((envelope) => typeof envelope.sequence === "number");
    extra += 1
  ) {
    const older = await readBefore(page.startOffset);
    page = {
      envelopes: [...older.envelopes, ...page.envelopes],
      envelopeStartOffsets: [...older.envelopeStartOffsets, ...page.envelopeStartOffsets],
      startOffset: older.startOffset,
      hasMore: older.hasMore,
    };
  }
  // Defensive: a legacy file whose numbering restarted can put a newer
  // sequence below the cut. Never hand those back as "older".
  const keep = page.envelopes.map((envelope) =>
    !(typeof envelope.sequence === "number" && envelope.sequence >= beforeSequence));
  if (keep.every(Boolean)) return page;
  return {
    ...page,
    envelopes: page.envelopes.filter((_, index) => keep[index]),
    envelopeStartOffsets: page.envelopeStartOffsets.filter((_, index) => keep[index]),
  };
}

/**
 * The chat's events exactly as written, newest pages first, back to the first
 * one at or before `since` (or just the newest two pages without one).
 * `reachedSince` is false when the cursor lies further back than the pages
 * read. The lossy reader behind `readTranscript` swaps non-conversation rows
 * for stand-ins, so lifecycle events need this one.
 */
export async function readEnvelopesBackToSequence(args: {
  transcriptPath: string;
  sessionId: string;
  since: number | null;
  onPageError: (error: unknown) => void;
}): Promise<{ envelopes: AgentChatEventEnvelope[]; reachedSince: boolean }> {
  const { since } = args;
  const pages: AgentChatEventEnvelope[][] = [];
  let cursor = await readHistoryFileSize(args.transcriptPath);
  let reachedSince = since === null;
  const maxPages = since === null ? 2 : 16;
  for (let count = 0; cursor > 0 && count < maxPages; count += 1) {
    let page: TranscriptHistoryPageRead;
    try {
      page = await readTranscriptHistoryPage({
        transcriptPath: args.transcriptPath,
        sessionId: args.sessionId,
        beforeOffset: cursor,
        maxBytes: CHAT_EVENT_HISTORY_PAGE_DEFAULT_BYTES,
      });
    } catch (error) {
      args.onPageError(error);
      break;
    }
    cursor = page.startOffset;
    pages.unshift(page.envelopes);
    if (since !== null && page.envelopes.some((entry) => (entry.sequence ?? Number.POSITIVE_INFINITY) <= since)) {
      reachedSince = true;
      break;
    }
    if (!page.hasMore) {
      reachedSince = true;
      break;
    }
  }
  return { envelopes: pages.flat(), reachedSince };
}
