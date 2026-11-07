import fs from "node:fs";

import { ARTIFACT_RANGE_READ_MAX_BYTES } from "../../../shared/artifactStreamUrl";
import { AdeExpectedError } from "../../../shared/expectedError";

/**
 * Read-only, and never through a link at the last step (POSIX only; Windows
 * has no O_NOFOLLOW). Callers pass a real path their jail already checked, so
 * a link there was swapped in after the check.
 */
const OPEN_FLAGS = fs.constants.O_RDONLY | (typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0);

export type ArtifactByteRange = {
  totalSize: number;
  /** Where the bytes start. The file's size when the offset is at or past the end. */
  rangeStart: number;
  /** One past the last byte read. */
  rangeEnd: number;
  base64: string;
  eof: boolean;
};

/**
 * One bounded slice of a proof file, for a proof read one chunk at a time.
 *
 * The caller has already checked the path is one it may serve. A missing
 * offset starts at 0, a missing length reads the cap, and any length is cut
 * to {@link ARTIFACT_RANGE_READ_MAX_BYTES}.
 */
export async function readArtifactByteRange(
  absolutePath: string,
  offset?: number,
  length?: number,
): Promise<ArtifactByteRange> {
  const handle = await fs.promises.open(absolutePath, OPEN_FLAGS).catch((error: NodeJS.ErrnoException) => {
    // Gone (deleted, or never copied to this computer) is an answer; anything
    // else that stops the open is not.
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      throw new AdeExpectedError("Artifact file does not exist.", "user");
    }
    throw new Error(`Artifact file could not be opened (${error?.code ?? "unknown"}).`, { cause: error });
  });
  try {
    // The opened handle's own stat, so the size and kind are those of the
    // file actually read, not of whatever the path named a moment earlier.
    const stat = await handle.stat();
    if (!stat.isFile()) throw new AdeExpectedError("Artifact file does not exist.", "user");
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
