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
  return (await readHistoryPage(args, { parseOmittedRow: true })).page;
}

/**
 * `readTranscriptHistoryPage`, plus whether an oversized row is parsed for
 * its stand-in. A sequence-cursor read stepping over a run of oversized rows
 * passes false: each later row only needs its start found. `oversizedRow`
 * marks a page that is exactly one row too large to page, whether it came
 * back as a stand-in or was dropped (another chat's, malformed).
 */
async function readHistoryPage(
  args: {
    transcriptPath: string;
    sessionId: string;
    beforeOffset: number;
    maxBytes?: number | null;
    signal?: AbortSignal;
  },
  options: { parseOmittedRow: boolean },
): Promise<{ page: TranscriptHistoryPageRead; oversizedRow: boolean }> {
  const { transcriptPath, sessionId } = args;
  const beforeOffset = Number.isFinite(args.beforeOffset) ? Math.floor(args.beforeOffset) : 0;
  if (beforeOffset <= 0) return { page: { ...EMPTY_PAGE }, oversizedRow: false };

  const pageBytes = clampHistoryPageBytes(args.maxBytes);
  const size = await readHistoryFileSize(transcriptPath);
  const end = Math.min(beforeOffset, size);
  if (end <= 0) return { page: { ...EMPTY_PAGE }, oversizedRow: false };

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
      const page = await readOmittedRowPage({
        transcriptPath,
        sessionId,
        searchBefore: readStart,
        end,
        parse: options.parseOmittedRow,
        ...(args.signal ? { signal: args.signal } : {}),
      });
      return { page, oversizedRow: true };
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
    page: {
      envelopes,
      envelopeStartOffsets,
      startOffset,
      hasMore: startOffset > 0,
    },
    oversizedRow: false,
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

/** Chunk size of the backward scan for an oversized row's start. */
const OMITTED_ROW_SCAN_CHUNK_BYTES = 1024 * 1024;
/**
 * The largest transcript row this module materializes and parses. A sequence
 * probe skips larger rows; resume counts an omitted row at most this much.
 */
export const SEQUENCE_PROBE_MAX_ROW_BYTES = 8 * 1024 * 1024;
/**
 * An oversized row up to this size is read whole and parsed for its own
 * session, timestamp, event type and provenance: the probe's bound, and the
 * same transient cost.
 */
const OMITTED_ROW_PARSE_MAX_BYTES = SEQUENCE_PROBE_MAX_ROW_BYTES;

/**
 * Thrown when the file shrank under an oversized-row read (rewritten or
 * truncated mid-scan). Retryable: the caller's cursor has not moved.
 */
const HISTORY_CHANGED_DURING_READ = "chat_history_changed_during_read";

/**
 * The usual start of a transcript row: the chat service builds its envelopes
 * as `{ sessionId, timestamp, event, ... }` and the writer serializes them
 * with `JSON.stringify`, which keeps that key order. Not guaranteed for every
 * row, so it is only a best effort, used for a row too large to parse: its
 * chat (to drop another chat's row) and its timestamp (to date the stand-in).
 */
const LEADING_ENVELOPE_FIELDS = /^\s*\{"sessionId":"((?:[^"\\]|\\.)*)","timestamp":"([^"\\]{1,64})"/;

type OmittedRowFields = {
  timestamp?: string;
  eventType?: string;
  targetKind?: string;
};

/**
 * One JSONL row as an envelope of `sessionId` with an object event, or null
 * (blank, malformed, another chat's, or no event): the rows the transcript
 * parser keeps.
 */
function parseSessionEnvelope(
  raw: string,
  sessionId: string,
): (Partial<AgentChatEventEnvelope> & Pick<AgentChatEventEnvelope, "event">) | null {
  const trimmed = raw.trim();
  if (!trimmed.length) return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<AgentChatEventEnvelope> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.sessionId !== "string" || parsed.sessionId.trim() !== sessionId) return null;
    if (!parsed.event || typeof parsed.event !== "object") return null;
    return parsed as Partial<AgentChatEventEnvelope> & Pick<AgentChatEventEnvelope, "event">;
  } catch {
    return null;
  }
}

/** The stand-in's fields from a row of at most `OMITTED_ROW_PARSE_MAX_BYTES`. */
function parseOmittedRowFields(raw: string, sessionId: string): OmittedRowFields | null {
  const parsed = parseSessionEnvelope(raw, sessionId);
  if (!parsed) return null;
  return {
    ...(typeof parsed.timestamp === "string" ? { timestamp: parsed.timestamp } : {}),
    ...(typeof parsed.event.type === "string" ? { eventType: parsed.event.type } : {}),
    ...(typeof parsed.provenance?.targetKind === "string" ? { targetKind: parsed.provenance.targetKind } : {}),
  };
}

/** A JSON string literal's body, decoded; null when it is not one. */
function decodeJsonStringBody(body: string): string | null {
  try {
    const decoded: unknown = JSON.parse(`"${body}"`);
    return typeof decoded === "string" ? decoded : null;
  } catch {
    return null;
  }
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
 * 2. A row up to `OMITTED_ROW_PARSE_MAX_BYTES` is read and parsed for its
 *    session, timestamp, event type and provenance. A row of another chat, or
 *    a torn/malformed one, is dropped, as the normal parse drops it.
 * 3. A larger row (or one stepped over unparsed) is not parsed. Its usual
 *    `{"sessionId":…,"timestamp":…` start names its chat (another chat's row
 *    is dropped) and dates the stand-in. Without that start it is taken to be
 *    this chat's, since transcript files are keyed by chat id
 *    (`<sessionId>.jsonl`, `<sessionId>.chat.jsonl`), and dated at the epoch
 *    (stable across reads, so repeated pages stay identical).
 * 4. The stand-in is a `system_notice` with NO `sequence`. It is
 *    display-only: a durable log keyed on sequence (the phone's chat log,
 *    sync resume, delivery keys) never stores it as row N, so it can never
 *    take the real row's place, and a later full copy of row N is never
 *    deduped against it.
 *
 * Cost: the row's bytes minus the window already read, backward in 1 MB
 * reads, plus one read of the row (at most 8 MB, or 1 KB for a larger row).
 * Terminates for any input: the backward scan only moves toward offset 0.
 * A read that comes back short (the file shrank meanwhile) throws
 * `chat_history_changed_during_read` instead of reporting the head of the
 * chat; the caller's cursor has not moved, so a retry is safe.
 */
async function readOmittedRowPage(args: {
  transcriptPath: string;
  sessionId: string;
  /** No newline lies in `[searchBefore, end - 1)`. */
  searchBefore: number;
  end: number;
  /** False: stand in without parsing, as for a row past the parse bound. */
  parse: boolean;
  signal?: AbortSignal;
}): Promise<TranscriptHistoryPageRead> {
  const { transcriptPath, sessionId, end, signal } = args;
  let rowStart = 0;
  let scan = args.searchBefore;
  while (scan > 0) {
    signal?.throwIfAborted();
    const chunkStart = Math.max(0, scan - OMITTED_ROW_SCAN_CHUNK_BYTES);
    const chunk = await readHistoryFileRange(transcriptPath, chunkStart, scan - chunkStart, signal);
    if (chunk.length < scan - chunkStart) throw new Error(HISTORY_CHANGED_DURING_READ);
    const newline = chunk.lastIndexOf(0x0a);
    if (newline >= 0) {
      rowStart = chunkStart + newline + 1;
      break;
    }
    scan = chunkStart;
  }

  const rowBytes = end - rowStart;
  const page: TranscriptHistoryPageRead = {
    envelopes: [],
    envelopeStartOffsets: [],
    startOffset: rowStart,
    hasMore: rowStart > 0,
  };
  let fields: OmittedRowFields;
  if (args.parse && rowBytes <= OMITTED_ROW_PARSE_MAX_BYTES) {
    const row = await readHistoryFileRange(transcriptPath, rowStart, rowBytes, signal);
    if (row.length < rowBytes) throw new Error(HISTORY_CHANGED_DURING_READ);
    const parsed = parseOmittedRowFields(row.toString("utf8"), sessionId);
    if (!parsed) return page;
    fields = parsed;
  } else {
    const head = await readHistoryFileRange(transcriptPath, rowStart, 1024, signal);
    const leading = LEADING_ENVELOPE_FIELDS.exec(head.toString("utf8"));
    const rowSessionId = leading ? decodeJsonStringBody(leading[1]!) : null;
    // A row that names another chat is dropped, as a parsed one would be.
    if (rowSessionId !== null && rowSessionId.trim() !== sessionId) return page;
    fields = leading ? { timestamp: leading[2]! } : {};
  }

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

type SequencedRowProbe = { lineStart: number; sequence: number };

function parseSequencedRow(raw: string, sessionId: string): number | null {
  const sequence = parseSessionEnvelope(raw, sessionId)?.sequence;
  return typeof sequence === "number" && Number.isFinite(sequence) && sequence > 0
    ? Math.floor(sequence)
    : null;
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
  const pageArgs = {
    transcriptPath: args.transcriptPath,
    sessionId: args.sessionId,
    maxBytes: args.maxBytes,
    ...(args.signal ? { signal: args.signal } : {}),
  };
  const first = await readHistoryPage({ ...pageArgs, beforeOffset }, { parseOmittedRow: true });
  let page = first.page;
  // Invariant for a sequence cursor: the reply holds a sequenced row older
  // than the cursor, or `hasMore: false`. The client's next request is its
  // oldest cached sequence, and a row too large to page yields no sequenced
  // row (a stand-in without a sequence, or nothing when the row is another
  // chat's), so such a page alone would be asked for again forever. While the
  // page just read was one oversized row, the next older page is taken too,
  // until one holds a sequenced row or the head is reached. An empty page (a
  // window of only other chats' rows, all filtered out) continues the same
  // way. Rows stepped over are not parsed (only their start is found, and a
  // 1 KB head is read), so the cost is the run scanned backward once, with no
  // count to strand the client. A page with rows of this chat but none
  // sequenced (a legacy run) ends the loop, exactly as before stand-ins.
  const hasSequencedRow = (read: TranscriptHistoryPageRead) =>
    read.envelopes.some((envelope) => typeof envelope.sequence === "number");
  let latestYieldsNoRows = first.oversizedRow || first.page.envelopes.length === 0;
  while (page.hasMore && !hasSequencedRow(page) && latestYieldsNoRows) {
    const latest = await readHistoryPage({ ...pageArgs, beforeOffset: page.startOffset }, { parseOmittedRow: false });
    latestYieldsNoRows = latest.oversizedRow || latest.page.envelopes.length === 0;
    page = {
      envelopes: [...latest.page.envelopes, ...page.envelopes],
      envelopeStartOffsets: [...latest.page.envelopeStartOffsets, ...page.envelopeStartOffsets],
      startOffset: latest.page.startOffset,
      hasMore: latest.page.hasMore,
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
