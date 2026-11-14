import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type AtomicWriteOptions = {
  fsync?: boolean;
  /**
   * Permission bits for the temp file, e.g. `0o600`. The rename carries them
   * onto the target, so a secret never exists world-readable — not even for the
   * instant between create and rename. Left out, an existing target keeps its
   * own bits (see `existingFileMode`).
   */
  mode?: number;
};

/**
 * The permission bits of a file that is about to be replaced, or undefined.
 *
 * A replace is a new file renamed over the old one, so without this it takes
 * the default mode: a script loses its executable bit and a file the user
 * locked to 0o600 becomes readable to others. Windows has no POSIX bits to
 * keep.
 */
export function existingFileMode(filePath: string): number | undefined {
  if (process.platform === "win32") return undefined;
  try {
    const stat = fs.statSync(filePath, { throwIfNoEntry: false });
    return stat ? stat.mode & 0o777 : undefined;
  } catch {
    return undefined;
  }
}

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
 * Windows refuses to rename onto a file that any other process has open at
 * that instant, whatever sharing it opened with (EPERM). A reader holds it for
 * microseconds, so a few short waits nearly always let the atomic rename land;
 * going straight to the copy fallback let a reader see an empty or zero-filled
 * file. At most 32 ms in all, and only when the rename was refused.
 */
const WINDOWS_RENAME_RETRY_WAITS_MS = [0, 0, 0, 0, 1, 1, 2, 4, 8, 16];
const WINDOWS_TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function renameRetryingOnWindows(tempPath: string, filePath: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(tempPath, filePath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || !code || !WINDOWS_TRANSIENT_RENAME_CODES.has(code)
        || attempt >= WINDOWS_RENAME_RETRY_WAITS_MS.length) throw error;
      const waitMs = WINDOWS_RENAME_RETRY_WAITS_MS[attempt]!;
      if (waitMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
}

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
    renameRetryingOnWindows(tempPath, filePath);
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
  const mode = opts.mode ?? existingFileMode(filePath);
  let fd: number | null = null;
  try {
    fd = mode != null
      ? fs.openSync(tempPath, "wx", mode)
      : fs.openSync(tempPath, "wx");
    // The open's mode passes through the umask; a kept mode must come out
    // exactly as it was. A filesystem without POSIX bits keeps its default
    // rather than losing the write.
    if (opts.mode == null && mode != null) {
      try {
        fs.fchmodSync(fd, mode);
      } catch {
        // Best effort, like the copy fallback's chmod.
      }
    }
    fs.writeFileSync(fd, data);
    if (opts.fsync) bestEffortFsync(fd);
    fs.closeSync(fd);
    fd = null;
    replaceViaRename(tempPath, filePath, mode);

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

/**
 * Create `filePath` with `data` only if it does not exist, never exposing a
 * partial file: the bytes go to a sibling temp file, and a hard link puts it in
 * place (EEXIST when the name is taken). A filesystem without hard links (FAT,
 * some network shares) falls back to an exclusive create in place; any other
 * link failure propagates.
 */
export function createFileExclusive(
  filePath: string,
  data: string | Buffer,
  opts: { mode?: number } = {},
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = siblingTempPath(filePath);
  const writeOptions = opts.mode != null ? { flag: "wx", mode: opts.mode } : { flag: "wx" };
  try {
    fs.writeFileSync(tempPath, data, writeOptions);
    try {
      fs.linkSync(tempPath, filePath);
    } catch (error) {
      if (!HARD_LINK_UNSUPPORTED_CODES.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
      createInPlaceExclusive(filePath, data, opts.mode);
    }
  } finally {
    // A temp left behind is swept by `cleanupAbandonedTempFiles`.
    bestEffortUnlink(tempPath);
  }
}

// Link errors that mean "this filesystem has no hard links" (Windows FAT
// reports ERROR_INVALID_FUNCTION, which libuv maps to EISDIR).
const HARD_LINK_UNSUPPORTED_CODES = new Set([
  "EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK", "EISDIR", "EINVAL",
]);

/** O_EXCL create in place; a write that fails after the create removes the file it made. */
function createInPlaceExclusive(filePath: string, data: string | Buffer, mode: number | undefined): void {
  const fd = mode != null ? fs.openSync(filePath, "wx", mode) : fs.openSync(filePath, "wx");
  try {
    fs.writeFileSync(fd, data);
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* preserve original error */ }
    bestEffortUnlink(filePath);
    throw error;
  }
  fs.closeSync(fd);
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

/**
 * Two clock readings taken a few microseconds apart differ by timer jitter. A
 * fall in the wall clock's lead over the monotonic clock larger than this is a
 * step back.
 */
const CLOCK_STEP_TOLERANCE_MS = 500;

/** One stat of a file: its stamp, and when it last changed. */
type FileStamp = { stamp: string; changedAtMs: number };

/**
 * The stamp of a file is its device, inode, size, mtime and ctime. A replace by
 * rename gives the file a new inode, and the ctime cannot be set back by a
 * writer that keeps the mtime. The stat must be a bigint stat: an NTFS file id
 * does not fit in a double.
 */
function fileStampOf(stat: fs.BigIntStats): FileStamp {
  const changedAtNs = stat.mtimeNs > stat.ctimeNs ? stat.mtimeNs : stat.ctimeNs;
  return {
    stamp: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
    changedAtMs: Number(changedAtNs / 1_000_000n),
  };
}

/**
 * Returns a check that is true when the wall clock stepped back since its last
 * call. It compares the wall clock's lead over the monotonic clock, not the
 * wall clock alone: comparing wall readings misses a step whenever more time
 * than the step has passed between two calls. The lead falls only when the
 * wall clock is stepped back.
 */
function createClockStepDetector(): (wallNow: number) => boolean {
  let lastClockLead: number | null = null;
  return (wallNow) => {
    const clockLead = wallNow - performance.now();
    const stepped = lastClockLead !== null && clockLead < lastClockLead - CLOCK_STEP_TOLERANCE_MS;
    lastClockLead = clockLead;
    return stepped;
  };
}

export type StampedJsonCacheLimits = {
  maxEntries: number;
  /** Bytes of JSON on disk, not of the parsed heap. An entry larger than this is never kept. */
  maxBytes: number;
};

/**
 * JSON file text kept while the file's bytes are unchanged.
 *
 * A reader that walks many small files, such as one state file per chat, pays a
 * synchronous open and read for each file on every call. The stamp of one stat
 * (fileStampOf) says whether the cached text still holds. Every writer here
 * replaces a file by rename, which gives it a new inode, or rewrites it, which
 * gives it a new mtime and ctime. Each hit parses the cached text again: that
 * is cheaper than copying a parsed value, and every caller gets an object of
 * its own.
 *
 * Only a primary-file read is cached, and only when the file had been unchanged
 * for STAMP_SETTLE_MS before the read began. Two writes in one timestamp tick can
 * leave the same size and mtime, and a filesystem can reuse the inode; a settled
 * file has no write that new, so its stamp cannot match a later version. A
 * recovered read (the `.lkg` copy) and a missing file are never cached: they go
 * through readJsonWithRecovery, so recovery and its warnings run as they always did.
 *
 * The settle check reads the wall clock. If that clock steps back, a settled
 * stamp proves nothing, so every entry is dropped.
 */
export function createStampedJsonCache<T>(
  validate: (value: unknown) => value is T,
  limits: StampedJsonCacheLimits,
) {
  type Entry = { stamp: string; bytes: number; text: string };
  const entries = new Map<string, Entry>();
  let totalBytes = 0;
  const clockSteppedBack = createClockStepDetector();

  const clear = (): void => {
    entries.clear();
    totalBytes = 0;
  };

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
      // A step back of the wall clock can give a later write the stamp an entry
      // already holds.
      const wallNow = Date.now();
      if (clockSteppedBack(wallNow)) clear();

      // Both the clock and the stat come before the read: a write that lands
      // after them leaves the entry under the older stamp, so the next stat misses.
      // An inode of 0 means the filesystem has none, so such a file is never cached.
      const settledBefore = wallNow - STAMP_SETTLE_MS;
      const stat = bigIntStatOrNull(filePath);
      const look = stat && stat.ino !== 0n ? fileStampOf(stat) : null;
      const cached = entries.get(filePath);
      if (look !== null && cached?.stamp === look.stamp) {
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
        if (look !== null && look.changedAtMs <= settledBefore) {
          // Charged for the text read, not stat.size: a rewrite between the stat and
          // the read makes the two differ. remember() evicts the oldest entries to fit
          // a new one, so an entry over the whole budget is skipped rather than
          // emptying the cache for itself.
          const bytes = Buffer.byteLength(text, "utf8");
          if (bytes <= limits.maxBytes) remember(filePath, { stamp: look.stamp, bytes, text });
        }
        return { value, source: "primary" };
      }
      return readJsonWithRecovery(filePath, validate);
    },

    /** Drops the entry for a file that was deleted or is about to be. */
    forget,
  };
}

/**
 * Tells whether a file still holds what this process last read or wrote, when
 * other processes also rewrite it: another brain on the project, a sync client,
 * an editor.
 *
 * The mtime alone is not enough. Two writes in one timestamp tick (a few
 * milliseconds on Linux and Windows, one or two seconds on HFS+ and FAT) get the
 * same mtime. A check compares the whole stamp (fileStampOf) with one stat.
 *
 * A stamp can still match when the writes share a tick and the inode is reused
 * or meaningless (FAT, some network shares, the in-place copy fallback of
 * `writeFileAtomic`). So until the file has gone STAMP_SETTLE_MS unchanged, a
 * check with a matching stamp also compares a digest of the bytes. A settled
 * file costs one stat per check. The settle check reads the wall clock; when
 * that clock steps back, the next check compares the bytes again.
 */
export function createFileVersionTracker(filePath: string) {
  type Seen = { stamp: string | null; digest: string | null; settled: boolean };
  let seen: Seen | null = null;
  const clockSteppedBack = createClockStepDetector();

  const look = (): FileStamp | null => {
    const stat = fs.statSync(filePath, { bigint: true, throwIfNoEntry: false });
    return stat ? fileStampOf(stat) : null;
  };
  const lookOrNull = (): FileStamp | null => {
    try {
      return look();
    } catch {
      return null;
    }
  };
  const digestOf = (text: string): string => createHash("sha1").update(text).digest("base64");
  const settledAt = (current: FileStamp | null, wallNow: number): boolean =>
    current !== null && current.changedAtMs <= wallNow - STAMP_SETTLE_MS;

  return {
    /** True when the file may differ from what was last read or written here. */
    changed(): boolean {
      if (!seen) return true;
      const wallNow = Date.now();
      const stepped = clockSteppedBack(wallNow);
      let current: FileStamp | null;
      try {
        current = look();
      } catch {
        return true;
      }
      if ((current?.stamp ?? null) !== seen.stamp) return true;
      if (current === null || (seen.settled && !stepped)) return false;
      let text: string;
      try {
        text = fs.readFileSync(filePath, "utf8");
      } catch {
        return true;
      }
      if (digestOf(text) !== seen.digest) return true;
      seen = { ...seen, settled: settledAt(current, wallNow) };
      return false;
    },

    /** Reads the file as `fs.readFileSync` does (and throws as it does), and remembers what it read. */
    read(): string {
      // The clock and the stat come before the read: a write that lands after
      // them leaves an older stamp, so the next check sees a change.
      const wallNow = Date.now();
      clockSteppedBack(wallNow);
      const before = lookOrNull();
      try {
        const text = fs.readFileSync(filePath, "utf8");
        seen = { stamp: before?.stamp ?? null, digest: digestOf(text), settled: settledAt(before, wallNow) };
        return text;
      } catch (error) {
        // A missing or unreadable file reads as unchanged until its stamp changes.
        seen = { stamp: before?.stamp ?? null, digest: null, settled: before === null || settledAt(before, wallNow) };
        throw error;
      }
    },

    /** Remembers `text`, which this process just wrote to the file. */
    wrote(text: string): void {
      const wallNow = Date.now();
      clockSteppedBack(wallNow);
      const after = lookOrNull();
      seen = { stamp: after?.stamp ?? null, digest: digestOf(text), settled: settledAt(after, wallNow) };
    },
  };
}

function bigIntStatOrNull(filePath: string): fs.BigIntStats | null {
  try {
    return fs.statSync(filePath, { bigint: true, throwIfNoEntry: false }) ?? null;
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
