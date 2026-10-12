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
  const nul = text.indexOf("\u0000");
  const original = nul >= 0 ? text.slice(0, nul) : text;
  return original || null;
}

/** The `$R…` data item a `$I…` record describes. */
export function recycleBinDataName(recordName: string): string | null {
  return recordName.startsWith("$I") ? `$R${recordName.slice(2)}` : null;
}
