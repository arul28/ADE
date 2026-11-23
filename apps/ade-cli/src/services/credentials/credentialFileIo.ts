import fs from "node:fs";
import path from "node:path";

/**
 * File-level plumbing shared by everything that reads or writes an ADE
 * credential file: private-mode creation, atomic replacement, the cross-process
 * advisory lock, and the stat-poll change watcher.
 *
 * Split out of `credentialStore.ts` because it is infrastructure, not policy —
 * the store decides which key seals a file and what to do when it cannot be
 * read; nothing here knows what a credential is. The quarantine module needs the
 * same primitives, which is what forced the seam.
 */

/**
 * How long a writer waits for the credential-file lock before giving up.
 *
 * Exported because cross-process protocols layered on the credential store have
 * to out-wait it. In particular the account service polls for a peer's rotated
 * refresh token after a definitive `invalid_grant`: if that poll window were
 * shorter than this timeout, a peer that legitimately won the exchange but is
 * still queued behind the lock would have its session declared dead by the
 * loser.
 */
export const CREDENTIAL_FILE_LOCK_TIMEOUT_MS = 15_000;
const LOCK_TIMEOUT_MS = CREDENTIAL_FILE_LOCK_TIMEOUT_MS;
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 25;

type CredentialLockMetadata = {
  pid?: number;
  createdAt?: string;
};

export function ensureMode600(filePath: string): void {
  if (process.platform === "win32") return;
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort; some filesystems do not support chmod.
  }
}

export function ensureDirMode700(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  try {
    fs.chmodSync(dirPath, 0o700);
  } catch {
    // Best effort; some filesystems do not support chmod.
  }
}

/**
 * A crash right after the rename used to leave a zero-length credential file:
 * the bytes were never synced before the name moved. The refresh token in it
 * is spent the moment it was written, so that loss signs the machine out.
 */
function syncFileData(fd: number): void {
  try {
    fs.fsyncSync(fd);
  } catch {
    // Some filesystems do not support fsync; the rename still stands.
  }
}

/** Persist the rename itself. Windows has no directory handle to flush. */
function syncParentDirectory(dirPath: string): void {
  if (process.platform === "win32") return;
  let fd: number | null = null;
  try {
    fd = fs.openSync(dirPath, "r");
    fs.fsyncSync(fd);
  } catch {
    // Directory fsync is unavailable on some filesystems.
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
  }
}

export function writeFileAtomic(filePath: string, contents: string | Buffer): void {
  ensureDirMode700(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmpPath, "w", 0o600);
  try {
    fs.writeFileSync(fd, contents);
    syncFileData(fd);
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* preserve the write error */ }
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* preserve the write error */ }
    throw error;
  }
  try {
    fs.closeSync(fd);
  } catch (error) {
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* preserve the close error */ }
    throw error;
  }
  ensureMode600(tmpPath);
  try {
    renameRetryingOnWindows(tmpPath, filePath);
  } catch (error) {
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* the rename error is the one to report */ }
    throw error;
  }
  ensureMode600(filePath);
  syncParentDirectory(path.dirname(filePath));
}

/**
 * Waits between rename attempts on Windows, about 1.3 s in all. Antivirus
 * and the search indexer open a newly written file for a moment, and Windows
 * refuses a rename onto or from a file anyone has open (EPERM, EACCES, EBUSY).
 * A credential write must outlast that: after a refresh-token rotation the old
 * token is already spent, so a write that gives up signs the machine out.
 */
const WINDOWS_RENAME_RETRY_WAITS_MS = [0, 5, 10, 25, 50, 100, 150, 250, 300, 400];

function renameRetryingOnWindows(tmpPath: string, filePath: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(tmpPath, filePath);
      return;
    } catch (error) {
      if (!isLockContention(error) || isEexist(error) || attempt >= WINDOWS_RENAME_RETRY_WAITS_MS.length) throw error;
      sleepSync(WINDOWS_RENAME_RETRY_WAITS_MS[attempt]!);
    }
  }
}

export function isEnoent(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

export function isEexist(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "EEXIST";
}

/**
 * Windows does not report lock contention as EEXIST the way POSIX does.
 *
 * Deleting a file on Windows only unlinks the name once every open handle to it
 * closes, so between one holder's unlink and the last handle drop the lock name
 * still occupies the directory in a "delete pending" state. A concurrent
 * `open(lockPath, "wx")` against that name fails with a delete-pending or
 * sharing violation, which Node surfaces as EPERM, EACCES or EBUSY instead of
 * EEXIST. Those are the same "someone else holds it, try again" condition, so
 * they have to keep the acquisition loop running; treating them as fatal makes
 * every concurrent credential write a coin flip on Windows.
 */
export function isLockContention(error: unknown): boolean {
  if (isEexist(error)) return true;
  if (process.platform !== "win32") return false;
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function defaultLockPath(credentialsPath: string): string {
  return `${credentialsPath}.lock`;
}

export function isSamePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

export type CredentialFileStatSnapshot = {
  ino: number;
  mtimeMs: number;
  size: number;
} | null;

export function readCredentialFileStatSnapshot(filePath: string): CredentialFileStatSnapshot | undefined {
  try {
    const stat = fs.statSync(filePath);
    return { ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch (error: unknown) {
    if (isEnoent(error)) return null;
    return undefined;
  }
}

/**
 * {@link readCredentialFileStatSnapshot} on the thread pool. On Windows a
 * synchronous stat of a file under `~/.ade/secrets` can wait seconds while an
 * antivirus scan holds it, and the brain's event loop waits with it.
 */
export async function readCredentialFileStatSnapshotAsync(
  filePath: string,
): Promise<CredentialFileStatSnapshot | undefined> {
  try {
    const stat = await fs.promises.stat(filePath);
    return { ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch (error: unknown) {
    if (isEnoent(error)) return null;
    return undefined;
  }
}

export function isSameCredentialFileStat(
  left: CredentialFileStatSnapshot,
  right: CredentialFileStatSnapshot,
): boolean {
  if (left === null || right === null) return left === right;
  return left.ino === right.ino
    && left.mtimeMs === right.mtimeMs
    && left.size === right.size;
}

/**
 * How often a watcher whose folder watch is running still stats the file, for
 * the changes a folder watch can miss: a network volume, a folder that was
 * removed and made again, or events the OS merged or dropped.
 */
export const CREDENTIAL_FILE_WATCH_BACKUP_POLL_MS = 5_000;

export class CredentialFileStatWatcher {
  private previous: CredentialFileStatSnapshot | undefined;
  private timer: NodeJS.Timeout | null = null;
  private folderWatch: fs.FSWatcher | null = null;
  private disposed = false;
  /** One stat at a time: a stat stalled by a scan must not pile up behind itself. */
  private polling = false;
  /** A change was signalled while a stat was running: stat again after it. */
  private recheck = false;

  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly filePath: string,
    private readonly intervalMs: number | null,
  ) {}

  addListener(listener: () => void): void {
    this.listeners.add(listener);
  }

  /** True when no listener is left. */
  removeListener(listener: () => void): boolean {
    this.listeners.delete(listener);
    return this.listeners.size === 0;
  }

  /**
   * Watches the file's folder (writes replace the file by a rename, so a
   * watch on the file itself would end at the first write) and stats the file
   * on each event for its name, so another process's sign-in is seen at once.
   * A slow backup poll covers what a folder watch misses. Where the folder
   * watch cannot start, or stops with an error, the steady poll at
   * `intervalMs` runs instead, as before.
   */
  start(): void {
    this.previous = readCredentialFileStatSnapshot(this.filePath);
    if (this.intervalMs === null) return;
    const watching = this.startFolderWatch();
    this.startPoll(watching ? Math.max(this.intervalMs, CREDENTIAL_FILE_WATCH_BACKUP_POLL_MS) : this.intervalMs);
  }

  private startFolderWatch(): boolean {
    const fileName = path.basename(this.filePath);
    const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
    const sameName = (name: string): boolean => (caseInsensitive ? name.toLowerCase() === fileName.toLowerCase() : name === fileName);
    try {
      const watcher = fs.watch(path.dirname(this.filePath), { persistent: false }, (_event, changed) => {
        // Some platforms leave the name out; then any event in the folder is worth a stat.
        const name = typeof changed === "string" ? changed : changed ? String(changed) : null;
        if (name === null || sameName(name)) this.statAndCompare();
      });
      watcher.on("error", () => this.fallBackToSteadyPoll());
      this.folderWatch = watcher;
      return true;
    } catch {
      this.folderWatch = null;
      return false;
    }
  }

  /** The folder watch failed after it started: close it and poll at the steady rate, as before. */
  private fallBackToSteadyPoll(): void {
    if (this.disposed || this.intervalMs === null) return;
    this.closeFolderWatch();
    this.startPoll(this.intervalMs);
    // Whatever the watch missed while it was failing.
    this.statAndCompare();
  }

  private startPoll(intervalMs: number): void {
    if (this.timer) clearInterval(this.timer);
    // The poll stats off the event loop.
    this.timer = setInterval(() => this.statAndCompare(), intervalMs);
    this.timer.unref();
  }

  private statAndCompare(): void {
    if (this.disposed) return;
    if (this.polling) {
      this.recheck = true;
      return;
    }
    this.polling = true;
    void readCredentialFileStatSnapshotAsync(this.filePath)
      .then((current) => {
        if (!this.disposed) this.compare(current);
      })
      .finally(() => {
        this.polling = false;
        if (this.recheck) {
          this.recheck = false;
          this.statAndCompare();
        }
      });
  }

  private closeFolderWatch(): void {
    const watcher = this.folderWatch;
    this.folderWatch = null;
    try {
      watcher?.close();
    } catch {
      // Already closed.
    }
  }

  checkNow(): void {
    this.compare(readCredentialFileStatSnapshot(this.filePath));
  }

  private compare(current: CredentialFileStatSnapshot | undefined): void {
    if (current === undefined) return;
    if (this.previous === undefined) {
      this.previous = current;
      return;
    }
    if (isSameCredentialFileStat(current, this.previous)) return;
    this.previous = current;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // Credential observers are best-effort; one subscriber must not stop
        // the watcher or prevent sibling subscribers from seeing the change.
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.closeFolderWatch();
  }
}

/** A subscription to one credential file's changes; see {@link subscribeCredentialFileChanges}. */
export type CredentialFileChangeSubscription = {
  /** Stats the file now and tells every subscriber of the file if it changed. */
  checkNow(): void;
  dispose(): void;
};

const sharedCredentialFileWatchers = new Map<string, CredentialFileStatWatcher>();

/**
 * Tells `listener` when the file changes. Every subscriber of the same file
 * (and the same poll interval) in this process shares one watcher: each
 * subscriber used to start its own folder watch and its own backup stat of
 * the same file every 5 s.
 *
 * A subscriber that joins after the file changed, but before the shared
 * watcher saw that change, also hears of it. Subscribers re-read on a change,
 * so an extra call costs one read; a missed change is not possible.
 */
export function subscribeCredentialFileChanges(
  filePath: string,
  intervalMs: number | null,
  listener: () => void,
): CredentialFileChangeSubscription {
  const key = `${path.resolve(filePath)}\0${intervalMs ?? "manual"}`;
  let watcher = sharedCredentialFileWatchers.get(key);
  if (!watcher) {
    watcher = new CredentialFileStatWatcher(filePath, intervalMs);
    sharedCredentialFileWatchers.set(key, watcher);
    watcher.start();
  }
  const shared = watcher;
  // One registration per subscriber, even when two pass the same callback: a
  // Set would keep one, and the first dispose would stop the other's watcher.
  const entry = (): void => listener();
  shared.addListener(entry);
  let disposed = false;
  return {
    checkNow: () => {
      if (!disposed) shared.checkNow();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (!shared.removeListener(entry)) return;
      shared.dispose();
      if (sharedCredentialFileWatchers.get(key) === shared) sharedCredentialFileWatchers.delete(key);
    },
  };
}

function parseLockMetadata(raw: string): CredentialLockMetadata {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    return {
      pid: Number.isSafeInteger(record.pid) && Number(record.pid) > 0 ? Number(record.pid) : undefined,
      createdAt: typeof record.createdAt === "string" ? record.createdAt : undefined,
    };
  } catch {
    return {};
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !(
      typeof error === "object"
      && error !== null
      && "code" in error
      && (error as { code?: unknown }).code === "ESRCH"
    );
  }
}

function isSameLockStat(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function removeStaleLock(lockPath: string): void {
  let originalStat: fs.Stats;
  let originalRaw: string;
  try {
    originalStat = fs.statSync(lockPath);
    if (Date.now() - originalStat.mtimeMs <= LOCK_STALE_MS) return;
    originalRaw = fs.readFileSync(lockPath, "utf8");
  } catch {
    return;
  }

  const metadata = parseLockMetadata(originalRaw);
  if (metadata.pid && isProcessRunning(metadata.pid)) return;

  try {
    const currentStat = fs.statSync(lockPath);
    if (!isSameLockStat(currentStat, originalStat)) return;
    if (fs.readFileSync(lockPath, "utf8") !== originalRaw) return;
    fs.unlinkSync(lockPath);
  } catch {
    // Another process won the lock race or removed the stale file first.
  }
}

export function withCredentialFileLock<T>(
  lockPath: string,
  fn: () => T,
  options: { timeoutMs?: number } = {},
): T {
  ensureDirMode700(path.dirname(lockPath));
  const deadline = Date.now() + (options.timeoutMs ?? LOCK_TIMEOUT_MS);
  let fd: number | null = null;

  while (fd === null) {
    try {
      const candidateFd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeFileSync(
          candidateFd,
          JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
        );
        fd = candidateFd;
      } catch (error: unknown) {
        try {
          fs.closeSync(candidateFd);
        } catch {
          // ignore
        }
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // ignore
        }
        throw error;
      }
      ensureMode600(lockPath);
    } catch (error: unknown) {
      if (!isLockContention(error)) throw error;
      removeStaleLock(lockPath);
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for ADE credential store lock.", { cause: error });
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }

  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }
}

/** Acquire the same cross-process lock without blocking the calling event loop. */
export async function withCredentialFileLockAsync<T>(
  lockPath: string,
  fn: () => T | Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + (options.timeoutMs ?? LOCK_TIMEOUT_MS);
  let handle: fs.promises.FileHandle | null = null;

  while (handle === null) {
    try {
      handle = await fs.promises.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      } catch (error: unknown) {
        await handle.close().catch(() => undefined);
        handle = null;
        await fs.promises.unlink(lockPath).catch(() => undefined);
        throw error;
      }
      ensureMode600(lockPath);
    } catch (error: unknown) {
      if (!isLockContention(error)) throw error;
      removeStaleLock(lockPath);
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for ADE credential store lock.", { cause: error });
      }
      await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }

  try {
    return await fn();
  } finally {
    await handle.close().catch(() => undefined);
    await fs.promises.unlink(lockPath).catch(() => undefined);
  }
}

export function unlinkIfExists(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (error: unknown) {
    if (!isEnoent(error)) throw error;
  }
}

export function withOptionalCredentialFileLock<T>(lockPath: string, skippedLockPath: string, fn: () => T): T {
  if (isSamePath(lockPath, skippedLockPath)) return fn();
  return withCredentialFileLock(lockPath, fn);
}

export function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch (error: unknown) {
    if (isEnoent(error)) return {};
    throw error;
  }
}

export async function readJsonObjectAsync(filePath: string): Promise<{
  value: Record<string, unknown> | null;
  exists: boolean;
}> {
  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { value: null, exists: true };
    }
    return { value: parsed as Record<string, unknown>, exists: true };
  } catch (error: unknown) {
    if (isEnoent(error)) return { value: {}, exists: false };
    throw error;
  }
}
