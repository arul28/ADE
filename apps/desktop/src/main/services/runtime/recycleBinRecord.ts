import fs from "node:fs";
import path from "node:path";

/**
 * The Windows Recycle Bin keeps each deleted item as a `$R…` copy of the data
 * beside a `$I…` record that says where it came from. Same suffix, so
 * `$IABC123` describes `$RABC123`.
 *
 * Record layout (little-endian): 8-byte version, 8-byte size, 8-byte deletion
 * time, then the original path in UTF-16. Version 1 (Vista to Windows 8)
 * stores it in a fixed 520-byte, NUL-padded field; version 2 (Windows 10 and
 * later) prefixes it with a 4-byte length in characters, NUL included.
 */
export function readRecycleBinOriginalPath(record: Buffer): string | null {
  if (record.length < 24) return null;
  const version = record.readBigUInt64LE(0);
  let start: number;
  let end: number;
  if (version === 1n) {
    start = 24;
    end = Math.min(record.length, 24 + 520);
  } else if (version === 2n) {
    if (record.length < 28) return null;
    start = 28;
    end = Math.min(record.length, 28 + record.readUInt32LE(24) * 2);
  } else {
    return null;
  }
  const text = record.subarray(start, end - ((end - start) % 2)).toString("utf16le");
  return text.split("\u0000")[0] || null;
}

/** Longest record worth reading: a version 2 header and a 32,767-character path. */
const MAX_RECORD_BYTES = 28 + 32_767 * 2;

/**
 * The original path a `$I…` record names, reading only the record's own bytes
 * (a few hundred for a normal path), never anything else in the Recycle Bin.
 */
export function readRecycleBinRecordFile(recordPath: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(recordPath, "r");
    const header = Buffer.alloc(28);
    const headerBytes = fs.readSync(fd, header, 0, 28, 0);
    if (headerBytes < 24) return null;
    const length = header.readBigUInt64LE(0) === 2n && headerBytes === 28
      ? Math.min(MAX_RECORD_BYTES, 28 + header.readUInt32LE(24) * 2)
      : 24 + 520;
    const record = Buffer.alloc(length);
    const read = fs.readSync(fd, record, 0, length, 0);
    return readRecycleBinOriginalPath(record.subarray(0, read));
  } catch {
    return null;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

/** The `$R…` data item a `$I…` record describes. */
export function recycleBinDataName(recordName: string): string | null {
  return recordName.startsWith("$I") ? `$R${recordName.slice(2)}` : null;
}

/** The `$I…` record that describes a `$R…` data item, or null for anything else. */
export function recycleBinRecordFor(dataPath: string): string | null {
  const name = path.basename(dataPath);
  return name.startsWith("$R") ? path.join(path.dirname(dataPath), `$I${name.slice(2)}`) : null;
}
