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
