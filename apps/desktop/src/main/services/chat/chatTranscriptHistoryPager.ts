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
 *   the service's 2 MB page ceiling. Rows beyond that fail explicitly instead
 *   of silently advancing the cursor past content the client never received.
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
      throw new Error("chat_history_row_too_large");
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
  const page = await readTranscriptHistoryPage({
    transcriptPath: args.transcriptPath,
    sessionId: args.sessionId,
    beforeOffset,
    maxBytes: args.maxBytes,
    ...(args.signal ? { signal: args.signal } : {}),
  });
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
