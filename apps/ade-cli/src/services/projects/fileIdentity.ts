import fs from "node:fs";

/**
 * A file's identity for cache validation: inode, size and modification time.
 * A replace-by-rename changes the inode, an in-place write the size or mtime.
 */
export function statIdentity(stat: fs.Stats): string {
  return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

/** {@link statIdentity} of the file at `filePath`, or null when it cannot be read. */
export function fileIdentity(filePath: string): string | null {
  try {
    return statIdentity(fs.statSync(filePath));
  } catch {
    return null;
  }
}
