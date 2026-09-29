import fs from "node:fs";

const READ_CHUNK_BYTES = 256 * 1024;
const NEWLINE = 0x0a;

function envelopeSequence(line: Buffer): number | null {
  if (line.length === 0) return null;
  try {
    const parsed = JSON.parse(line.toString("utf8")) as { sequence?: unknown };
    return typeof parsed.sequence === "number" && Number.isFinite(parsed.sequence) ? parsed.sequence : null;
  } catch {
    return null;
  }
}

/**
 * Cut an append-only JSONL transcript back to just before the first envelope
 * whose `sequence` is `fromSequence` or later.
 *
 * Reads backwards from the end in fixed chunks and stops at the first envelope
 * older than `fromSequence`, so the cost is the size of the removed tail, not of
 * the file. The cut lands on a line start, so the kept part still ends with a
 * newline. Lines with no `sequence` inside the removed tail go with it.
 *
 * Returns the number of bytes removed, or null when the file does not exist or
 * holds no envelope at or after `fromSequence`.
 */
export function truncateTranscriptFromSequenceSync(filePath: string, fromSequence: number): number | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r+");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    let position = size;
    // Bytes of the line that continues past the start of the chunk read next.
    let carry = Buffer.alloc(0);
    let cut: number | null = null;
    let reachedOlder = false;
    while (position > 0 && !reachedOlder) {
      const readSize = Math.min(READ_CHUNK_BYTES, position);
      position -= readSize;
      const chunk = Buffer.alloc(readSize);
      fs.readSync(fd, chunk, 0, readSize, position);
      const buffer = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      let lineEnd = buffer.length;
      for (let index = buffer.length - 1; index >= 0; index -= 1) {
        if (buffer[index] !== NEWLINE) continue;
        const sequence = envelopeSequence(buffer.subarray(index + 1, lineEnd));
        if (sequence != null && sequence < fromSequence) {
          reachedOlder = true;
          break;
        }
        if (sequence != null) cut = position + index + 1;
        lineEnd = index;
      }
      if (!reachedOlder && position === 0) {
        const sequence = envelopeSequence(buffer.subarray(0, lineEnd));
        if (sequence != null && sequence >= fromSequence) cut = 0;
      }
      carry = buffer.subarray(0, lineEnd);
    }
    if (cut == null) return null;
    fs.ftruncateSync(fd, cut);
    return size - cut;
  } finally {
    fs.closeSync(fd);
  }
}
