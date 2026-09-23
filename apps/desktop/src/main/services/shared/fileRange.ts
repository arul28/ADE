import fs from "node:fs";

import { ARTIFACT_RANGE_READ_MAX_BYTES } from "../../../shared/artifactStreamUrl";

export type FileRange = {
  totalSize: number;
  /** Where the bytes start. The file's size when the offset is at or past the end. */
  rangeStart: number;
  /** One past the last byte read. */
  rangeEnd: number;
  base64: string;
  eof: boolean;
};

/**
 * One bounded slice of a file, for a proof read one chunk at a time.
 *
 * The caller has already checked the path is one it may serve. A missing
 * offset starts at 0, a missing length reads the cap, and any length is cut
 * to {@link ARTIFACT_RANGE_READ_MAX_BYTES}.
 */
export async function readFileRange(absolutePath: string, offset?: number, length?: number): Promise<FileRange> {
  const handle = await fs.promises.open(absolutePath, "r").catch(() => {
    throw new Error("Artifact file does not exist.");
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Artifact file does not exist.");
    const totalSize = stat.size;
    const requestedOffset = Number(offset ?? 0);
    const start = Number.isFinite(requestedOffset) ? Math.max(0, Math.floor(requestedOffset)) : 0;
    const requestedLength = Number(length ?? ARTIFACT_RANGE_READ_MAX_BYTES);
    const size = Number.isFinite(requestedLength)
      ? Math.max(1, Math.min(ARTIFACT_RANGE_READ_MAX_BYTES, Math.floor(requestedLength)))
      : ARTIFACT_RANGE_READ_MAX_BYTES;
    if (start >= totalSize) {
      return { totalSize, rangeStart: totalSize, rangeEnd: totalSize, base64: "", eof: true };
    }
    const buffer = Buffer.alloc(Math.min(size, totalSize - start));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const rangeEnd = start + bytesRead;
    return {
      totalSize,
      rangeStart: start,
      rangeEnd,
      base64: buffer.subarray(0, bytesRead).toString("base64"),
      eof: rangeEnd >= totalSize,
    };
  } finally {
    await handle.close();
  }
}
