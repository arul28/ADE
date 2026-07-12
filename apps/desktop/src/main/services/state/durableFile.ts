import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type AtomicWriteOptions = { fsync?: boolean };

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
    fd = fs.openSync(tempPath, "wx");
    fs.writeFileSync(fd, data);
    if (opts.fsync) bestEffortFsync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, filePath);

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

function readValidJson<T>(filePath: string, validate: (value: unknown) => value is T): T | null {
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
