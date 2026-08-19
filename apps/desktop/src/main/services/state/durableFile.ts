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
 * is losing the write outright.
 */
function replaceViaRename(tempPath: string, filePath: string, mode?: number): void {
  try {
    fs.renameSync(tempPath, filePath);
  } catch (renameError) {
    const code = (renameError as NodeJS.ErrnoException).code;
    if (!code || !COPY_RECOVERABLE_RENAME_CODES.has(code)) throw renameError;
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
    } catch {
      throw renameError;
    }
  }
}

export function writeFileAtomic(
  filePath: string,
  data: string | Buffer,
  opts: AtomicWriteOptions = {},
): void {
  const dir = path.dirname(filePath);
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
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
