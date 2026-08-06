import fs from "node:fs";
import path from "node:path";

/**
 * Atomic JSON write: temp file in the same directory, then rename.
 *
 * A reader that catches a torn file would see a parse failure and -- because an
 * unreadable record is indistinguishable from an absent one -- could not tell
 * "wedged" from "not running", so the write must be all-or-none. Shared by the
 * brain heartbeat and the watchdog's wedge breadcrumb, which have the exact same
 * requirement; the win32 pre-unlink is the part that is easiest to drop when
 * this is retyped by hand, and dropping it makes every write after the first one
 * fail.
 *
 * `tempSuffix` only has to make concurrent writers pick different temp names.
 * Throws on failure and leaves no temp file behind; callers that would rather
 * swallow a failure wrap the call.
 */
export function writeJsonAtomic(target: string, value: unknown, tempSuffix: string): void {
  const tempPath = `${target}.${tempSuffix}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    // Windows `rename` fails onto an existing target; POSIX replaces silently.
    if (process.platform === "win32") {
      try { fs.unlinkSync(target); } catch { /* first write, or already gone */ }
    }
    fs.renameSync(tempPath, target);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
    throw error;
  }
}
