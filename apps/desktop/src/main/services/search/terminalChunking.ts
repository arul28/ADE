import { stripAnsi } from "../../utils/ansiStrip";

/**
 * Splits raw terminal transcript bytes into newline-aligned chunks for FTS
 * indexing. Offsets are raw byte offsets into the on-disk transcript log so a
 * result can deep-link back to the exact scrollback position. The indexed text
 * is ANSI-stripped and control-char-sanitized.
 */

export const TERMINAL_CHUNK_MAX_RAW_BYTES = 8 * 1024;

export type TerminalChunk = {
  /** Raw byte offset of the chunk start in the transcript file. */
  startOffset: number;
  /** Raw byte offset just past the chunk end. */
  endOffset: number;
  /** ANSI-stripped, sanitized chunk text (may be empty for pure control output). */
  text: string;
};

/** Remove control chars that would confuse FTS or the snippet markers, keep \n and \t. */
export function sanitizeIndexedText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ");
}

function utf8SafeCut(buf: Buffer, end: number): number {
  // Back up past UTF-8 continuation bytes (0b10xxxxxx) so a hard cut never
  // splits a codepoint.
  let cut = end;
  while (cut > 0 && (buf[cut]! & 0b1100_0000) === 0b1000_0000) cut -= 1;
  return cut;
}

/**
 * Consume as many complete chunks as possible from `raw`. A trailing segment
 * with no newline is left unconsumed unless `force` is set (session ended) or
 * the segment already exceeds the max chunk size.
 */
export function chunkTerminalTranscript(
  raw: Buffer,
  baseOffset: number,
  options?: { force?: boolean; maxChunkRawBytes?: number }
): { chunks: TerminalChunk[]; consumedBytes: number } {
  const maxChunk = Math.max(64, options?.maxChunkRawBytes ?? TERMINAL_CHUNK_MAX_RAW_BYTES);
  const force = options?.force ?? false;
  const chunks: TerminalChunk[] = [];
  let pos = 0;

  while (pos < raw.length) {
    const remaining = raw.length - pos;
    let cut: number;

    if (remaining <= maxChunk) {
      const lastNewline = raw.lastIndexOf(0x0a, raw.length - 1);
      if (lastNewline >= pos) {
        cut = lastNewline + 1;
      } else if (force) {
        cut = raw.length;
      } else {
        break;
      }
    } else {
      const windowEnd = pos + maxChunk;
      const lastNewline = raw.lastIndexOf(0x0a, windowEnd - 1);
      cut = lastNewline >= pos ? lastNewline + 1 : utf8SafeCut(raw, windowEnd);
      if (cut <= pos) cut = windowEnd;
    }

    const segment = raw.subarray(pos, cut);
    const text = sanitizeIndexedText(stripAnsi(segment.toString("utf8"))).trim();
    chunks.push({
      startOffset: baseOffset + pos,
      endOffset: baseOffset + cut,
      text
    });
    pos = cut;

    // After a partial-tail cut (no trailing newline consumed), stop: the rest
    // waits for the next flush.
    if (!force && pos < raw.length && raw.lastIndexOf(0x0a, raw.length - 1) < pos) break;
  }

  return { chunks, consumedBytes: pos };
}
