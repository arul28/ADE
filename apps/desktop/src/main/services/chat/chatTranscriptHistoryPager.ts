import fs from "node:fs";
import { parseAgentChatTranscript } from "../../../shared/chatTranscript";
import type { AgentChatEventEnvelope } from "../../../shared/types/chat";

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

export const CHAT_EVENT_HISTORY_PAGE_DEFAULT_BYTES = 1_000_000;
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
  /**
   * Byte offset where this page begins (always on a line start). 0 means the
   * head of the file was reached. Guaranteed to be strictly less than the
   * requested `beforeOffset` whenever `beforeOffset > 0` and the file is
   * non-empty, so cursor loops always terminate.
   */
  startOffset: number;
  hasMore: boolean;
};

const EMPTY_PAGE: TranscriptHistoryPageRead = { envelopes: [], startOffset: 0, hasMore: false };

/**
 * Read one page of transcript history ending (exclusively) at `beforeOffset`.
 *
 * - `beforeOffset <= 0` → empty page, head reached.
 * - `beforeOffset > file size` → clamped to the file size.
 * - When the window does not start at the head of the file, the first partial
 *   line is dropped and `startOffset` points at the byte right AFTER its
 *   terminating newline, so pages never overlap or skip lines.
 * - A single line longer than the window yields an empty page whose
 *   `startOffset` still strictly decreases, so callers can page past it.
 *
 * Throws on filesystem errors (missing file, etc.) — callers decide how to
 * surface that.
 */
export function readTranscriptHistoryPage(args: {
  transcriptPath: string;
  sessionId: string;
  beforeOffset: number;
  maxBytes?: number | null;
}): TranscriptHistoryPageRead {
  const { transcriptPath, sessionId } = args;
  const beforeOffset = Number.isFinite(args.beforeOffset) ? Math.floor(args.beforeOffset) : 0;
  if (beforeOffset <= 0) return { ...EMPTY_PAGE };

  const pageBytes = clampHistoryPageBytes(args.maxBytes);
  const stat = fs.statSync(transcriptPath);
  const end = Math.min(beforeOffset, stat.size);
  if (end <= 0) return { ...EMPTY_PAGE };

  const start = Math.max(0, end - pageBytes);
  // Read one extra byte before the window (when possible) so we can tell
  // whether `start` itself sits on a line start (previous byte is "\n"). This
  // prevents dropping a complete first line when the window boundary happens
  // to land exactly on a line boundary.
  const readStart = Math.max(0, start - 1);
  const length = end - readStart;
  const fd = fs.openSync(transcriptPath, "r");
  let slice: Buffer;
  try {
    const out = Buffer.allocUnsafe(length);
    const bytesRead = fs.readSync(fd, out, 0, length, readStart);
    slice = bytesRead === length ? out : out.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }

  let startOffset = readStart;
  if (readStart > 0) {
    // Advance to the first line start within the window: the byte right
    // after the first newline found at or after `readStart` (= start - 1).
    const firstNewline = slice.indexOf(0x0a);
    const lineStart = firstNewline >= 0 ? readStart + firstNewline + 1 : -1;
    if (lineStart < 0 || lineStart >= end) {
      // The whole window is a single partial line. Nothing parseable here —
      // return an empty page with a strictly decreasing cursor so the caller
      // can keep paging past oversized lines instead of looping forever.
      return { envelopes: [], startOffset: start, hasMore: start > 0 };
    }
    startOffset = lineStart;
    slice = slice.subarray(firstNewline + 1);
  }

  const envelopes = parseAgentChatTranscript(slice.toString("utf8"))
    .filter((entry) => entry.sessionId === sessionId);
  return { envelopes, startOffset, hasMore: startOffset > 0 };
}
