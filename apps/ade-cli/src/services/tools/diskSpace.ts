import fs from "node:fs";
import path from "node:path";

const MIB = 1024 * 1024;

/**
 * Slack on top of the download, for the unpacked tree plus filesystem
 * overhead. The tools cache holds compressed binaries whose unpacked size runs
 * roughly 2.5-3x the tarball (codex: ~110 MB compressed, ~297 MB unpacked), and
 * both copies coexist until the archive is deleted.
 */
export const TOOL_UNPACK_RATIO = 4;
export const TOOL_SPACE_HEADROOM_BYTES = 256 * MIB;
/**
 * Used when the registry does not send Content-Length. Sized above the largest
 * pinned tool so a headerless response cannot slip past the preflight.
 */
export const TOOL_DEFAULT_ARCHIVE_BYTES = 384 * MIB;

export type FreeSpaceReader = (dirPath: string) => number | null;

export function estimateToolRequiredBytes(archiveBytes: number | null): number {
  const bytes = archiveBytes && archiveBytes > 0 ? archiveBytes : TOOL_DEFAULT_ARCHIVE_BYTES;
  return bytes * TOOL_UNPACK_RATIO + TOOL_SPACE_HEADROOM_BYTES;
}

/**
 * Free bytes on the volume hosting `dirPath`, walking up to the nearest
 * ancestor that exists — the tools root is usually created by the very install
 * that needs the preflight. Returns null when the platform cannot answer, and
 * callers treat that as "proceed", because refusing to install on an
 * unmeasurable volume is worse than trying and hitting a real ENOSPC.
 */
export const readFreeBytes: FreeSpaceReader = (dirPath) => {
  let cursor = path.resolve(dirPath);
  for (;;) {
    try {
      const stats = fs.statfsSync(cursor, { bigint: true });
      return Number(stats.bavail * stats.bsize);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      const parent = path.dirname(cursor);
      if (parent === cursor) return null;
      cursor = parent;
    }
  }
};
