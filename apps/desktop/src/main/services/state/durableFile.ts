import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type AtomicWriteOptions = {
  fsync?: boolean;
  /**
   * Permission bits for the temp file, e.g. `0o600`. The rename carries them
   * onto the target, so a secret never exists world-readable — not even for the
   * instant between create and rename.
   */
  mode?: number;
};

function bestEffortUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Best effort cleanup must not mask the original write failure.
  }
}

function bestEffortFsync(fd: number): void {
  try {
    fs.fsyncSync(fd);
  } catch {
    // Some filesystems and directory handles do not support fsync.
  }
}

/**
 * A scratch name beside the target. The shape matches
 * `ABANDONED_TEMP_FILE_PATTERN`, so anything left behind by a crash is swept by
 * `cleanupAbandonedTempFiles` rather than accumulating forever.
 */
function siblingTempPath(filePath: string): string {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
}

function describeCause(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Both causes, never one.
 *
 * The fallback used to rethrow the rename error and swallow its own, so a copy
 * that failed on a full disk was reported as the `EXDEV` that sent it there —
 * the wrong diagnosis for the wrong device. The rename's `code` is carried onto
 * the thrown error because callers switch on errnos, and the copy failure
 * travels as `cause`.
 */
function replaceFailure(filePath: string, renameError: unknown, copyError: unknown): Error {
  const error = new Error(
    `Failed to replace '${filePath}': rename failed (${describeCause(renameError)})`
    + ` and the copy fallback failed (${describeCause(copyError)}).`,
    { cause: copyError },
  ) as NodeJS.ErrnoException;
  const code = (renameError as NodeJS.ErrnoException | null)?.code;
  if (code) error.code = code;
  return error;
}

/**
 * Rename failures a copy can actually fix.
 *
 * `EXDEV` is a temp file that landed on another device; the rest are the
 * Windows shapes of "something else is holding the target open" — an indexer,
 * an antivirus scanner, another ADE process reading it. Every one of them is a
 * link-level refusal that says nothing about whether the bytes can be written.
 *
 * Deliberately NOT a catch-all. Retrying `ENOSPC` or `EIO` as a copy writes the
 * payload a second time to a filesystem that just proved it cannot take it, and
 * turns a clean "the write failed, the old file is intact" into a half-written
 * target. A disk-full rename must stay terminal.
 */
const COPY_RECOVERABLE_RENAME_CODES = new Set(["EXDEV", "EPERM", "EACCES", "EBUSY"]);

/**
 * Replace the target with the temp file.
 *
 * `rename` is the atomic path on every platform this ships to, including
 * Windows: libuv implements `fs.rename` with `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`,
 * which replaces an existing target in one step. Deleting the target first
 * would NOT be "the Windows fix" — it would open a window in which the file
 * simply does not exist, and a concurrent reader that looks during that window
 * sees a missing file rather than either version of it.
 *
 * The copy fallback is the last resort and never the first move: it is not
 * atomic, so it is reached only for the failures above, where the alternative
 * is losing the write outright. It runs in two steps, and the second one only
 * when the first proves the target itself is what refuses to be renamed over.
 */
function replaceViaRename(tempPath: string, filePath: string, mode?: number): void {
  try {
    fs.renameSync(tempPath, filePath);
    return;
  } catch (renameError) {
    const code = (renameError as NodeJS.ErrnoException).code;
    if (!code || !COPY_RECOVERABLE_RENAME_CODES.has(code)) throw renameError;

    // Copy BESIDE the target, then rename that into place. The destination is
    // still only ever replaced by a rename, so a copy that dies half-written —
    // the disk fills, the source turns out to be unreadable — leaves the
    // previous file whole instead of truncating it. It is also the whole fix
    // for `EXDEV`: the copy lands the bytes on the destination's device, and
    // the rename that follows is a local one.
    const stagedPath = siblingTempPath(filePath);
    let reachedStagedRename = false;
    try {
      fs.copyFileSync(tempPath, stagedPath);
      // The copy creates the staged file with the source's permissions, so a
      // 0o600 secret is never briefly world-readable; the chmod states it
      // outright for a filesystem that does not carry the mode across, and
      // happens BEFORE the file is exposed under the target's name.
      if (mode != null) fs.chmodSync(stagedPath, mode);
      reachedStagedRename = true;
      fs.renameSync(stagedPath, filePath);
      bestEffortUnlink(tempPath);
      return;
    } catch (stagedError) {
      bestEffortUnlink(stagedPath);
      const stagedCode = (stagedError as NodeJS.ErrnoException).code;
      // Only a link-level refusal of the staged RENAME earns the last resort
      // below. When the copy is what failed, writing those same bytes straight
      // onto the target would produce exactly the half-written destination the
      // staging exists to prevent.
      if (!reachedStagedRename || !stagedCode || !COPY_RECOVERABLE_RENAME_CODES.has(stagedCode)) {
        throw replaceFailure(filePath, renameError, stagedError);
      }
    }

    // Nothing can be renamed into this name — a Windows holder that permits
    // writes and denies the replace, or a directory that refuses links
    // outright. Copying onto the target is not atomic and a reader can catch it
    // mid-write, which is why it is last: the alternative here is losing the
    // write outright.
    try {
      fs.copyFileSync(tempPath, filePath);
      if (mode != null) {
        try {
          fs.chmodSync(filePath, mode);
        } catch {
          // Copying onto an existing file keeps that file's permissions; a
          // platform without chmod simply keeps whatever it had.
        }
      }
      bestEffortUnlink(tempPath);
    } catch (copyError) {
      throw replaceFailure(filePath, renameError, copyError);
    }
  }
}

export function writeFileAtomic(
  filePath: string,
  data: string | Buffer,
  opts: AtomicWriteOptions = {},
): void {
  const dir = path.dirname(filePath);
  const tempPath = siblingTempPath(filePath);
  let fd: number | null = null;
  try {
    fd = opts.mode != null
      ? fs.openSync(tempPath, "wx", opts.mode)
      : fs.openSync(tempPath, "wx");
    fs.writeFileSync(fd, data);
    if (opts.fsync) bestEffortFsync(fd);
    fs.closeSync(fd);
    fd = null;
    replaceViaRename(tempPath, filePath, opts.mode);

    // Windows has no directory handle to flush; opening one fails outright, so
    // the attempt is skipped rather than caught.
    if (opts.fsync && process.platform !== "win32") {
      let dirFd: number | null = null;
      try {
        dirFd = fs.openSync(dir, "r");
        bestEffortFsync(dirFd);
      } catch {
        // Parent-directory durability is unavailable on some platforms.
      } finally {
        if (dirFd !== null) {
          try { fs.closeSync(dirFd); } catch { /* best effort */ }
        }
      }
    }
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* preserve original error */ }
    }
    bestEffortUnlink(tempPath);
    throw error;
  }
}

export type JsonWithPreviousOptions<T> = {
  validate?: (value: unknown) => value is T;
  fsync?: boolean;
};

export function writeJsonWithPrevious<T>(
  filePath: string,
  payload: T,
  opts: JsonWithPreviousOptions<T> = {},
): boolean {
  if (opts.validate && !opts.validate(payload)) {
    throw new Error(`Refusing to persist invalid JSON payload to '${filePath}'.`);
  }
  const serialized = JSON.stringify(payload, null, 2);
  let lkgUpdated = false;
  if (fs.existsSync(filePath)) {
    try {
      fs.copyFileSync(filePath, `${filePath}.lkg`);
      lkgUpdated = true;
    } catch {
      // The primary atomic write can still succeed when the backup copy fails.
    }
  }
  writeFileAtomic(filePath, serialized, { fsync: opts.fsync });
  return lkgUpdated;
}

export type ReadJsonRecoveryResult<T> =
  | { value: T; source: "primary" | "previous" }
  | { value: null; source: "missing" | "unrecoverable" };

export function readValidJson<T>(filePath: string, validate: (value: unknown) => value is T): T | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return validate(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function readJsonWithRecovery<T>(
  filePath: string,
  validate: (value: unknown) => value is T,
): ReadJsonRecoveryResult<T> {
  const primaryExists = fs.existsSync(filePath);
  if (primaryExists) {
    const primary = readValidJson(filePath, validate);
    if (primary !== null) return { value: primary, source: "primary" };
  }

  const previousPath = `${filePath}.lkg`;
  const previousExists = fs.existsSync(previousPath);
  if (previousExists) {
    const previous = readValidJson(previousPath, validate);
    if (previous !== null) return { value: previous, source: "previous" };
  }

  return primaryExists || previousExists
    ? { value: null, source: "unrecoverable" }
    : { value: null, source: "missing" };
}

/** A cache entry is trusted only once its file has gone this long unchanged. */
const STAMP_SETTLE_MS = 2_000;

export type StampedJsonCacheLimits = {
  maxEntries: number;
  /** Bytes of JSON on disk, not of the parsed heap. */
  maxBytes: number;
};

/**
 * JSON file text kept while the file's bytes are unchanged.
 *
 * A reader that walks many small files, such as one state file per chat, pays a
 * synchronous open and read for each file on every call. The stat (inode, size,
 * mtime, ctime) says whether the cached text still holds. Every writer here
 * replaces a file by rename, which gives it a new inode, or rewrites it, which
 * gives it a new mtime and ctime. The ctime cannot be set back by a copy that
 * keeps the mtime. Each hit parses the cached text again: that is cheaper than
 * copying a parsed value, and every caller gets an object of its own.
 *
 * Only a primary-file read is cached, and only when the file had been unchanged
 * for STAMP_SETTLE_MS before the read began. Two writes in one timestamp tick can
 * leave the same size and mtime, and a filesystem can reuse the inode; a settled
 * file has no write that new, so its stamp cannot match a later version. A
 * recovered read (the `.lkg` copy) and a missing file are never cached: they go
 * through readJsonWithRecovery, so recovery and its warnings run as they always did.
 */
export function createStampedJsonCache<T>(
  validate: (value: unknown) => value is T,
  limits: StampedJsonCacheLimits,
) {
  type Entry = { stamp: string; bytes: number; text: string };
  const entries = new Map<string, Entry>();
  let totalBytes = 0;

  const forget = (filePath: string): void => {
    const entry = entries.get(filePath);
    if (!entry) return;
    entries.delete(filePath);
    totalBytes -= entry.bytes;
  };

  const remember = (filePath: string, entry: Entry): void => {
    forget(filePath);
    entries.set(filePath, entry);
    totalBytes += entry.bytes;
    // Map keeps insertion order, so the first key is the least recently used.
    while (entries.size > limits.maxEntries || totalBytes > limits.maxBytes) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      forget(oldest);
    }
  };

  const parseValid = (text: string): T | null => {
    try {
      const parsed: unknown = JSON.parse(text);
      return validate(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  return {
    read(filePath: string): ReadJsonRecoveryResult<T> {
      // Both the clock and the stat come before the read: a write that lands
      // after them leaves the entry under the older stamp, so the next stat misses.
      const settledBefore = Date.now() - STAMP_SETTLE_MS;
      const stat = statOrNull(filePath);
      const stamp = stat && stat.ino ? `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` : null;
      const cached = entries.get(filePath);
      if (stamp !== null && cached?.stamp === stamp) {
        const value = parseValid(cached.text);
        if (value !== null) {
          // Re-insert to mark it most recently used.
          entries.delete(filePath);
          entries.set(filePath, cached);
          return { value, source: "primary" };
        }
      }
      if (cached) forget(filePath);

      // The primary read, as readJsonWithRecovery does it. Anything but a valid
      // primary falls through to readJsonWithRecovery, which runs the recovery.
      let text: string | null = null;
      try {
        text = fs.readFileSync(filePath, "utf8");
      } catch {
        // Missing or unreadable: the recovery read reports it.
      }
      const value = text === null ? null : parseValid(text);
      if (text !== null && value !== null) {
        if (stat && stamp !== null && Math.max(stat.mtimeMs, stat.ctimeMs) <= settledBefore) {
          remember(filePath, { stamp, bytes: stat.size, text });
        }
        return { value, source: "primary" };
      }
      return readJsonWithRecovery(filePath, validate);
    },

    /** Drops the entry for a file that was deleted or is about to be. */
    forget,
  };
}

function statOrNull(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath, { throwIfNoEntry: false }) ?? null;
  } catch {
    // An unreadable file is read the normal way, which reports it as the read always has.
    return null;
  }
}

const ABANDONED_TEMP_FILE_PATTERN = /^\..+\.tmp-\d+-[A-Za-z0-9_-]+$/;

export function cleanupAbandonedTempFiles(
  dir: string,
  opts: { maxAgeMs?: number } = {},
): number {
  const maxAgeMs = opts.maxAgeMs ?? 60 * 60 * 1_000;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }

  let removed = 0;
  const now = Date.now();
  for (const name of names) {
    if (!ABANDONED_TEMP_FILE_PATTERN.test(name)) continue;
    const candidate = path.join(dir, name);
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() || now - stat.mtimeMs <= maxAgeMs) continue;
      fs.unlinkSync(candidate);
      removed += 1;
    } catch {
      // Each candidate is independent; one failure must not stop cleanup.
    }
  }
  return removed;
}
