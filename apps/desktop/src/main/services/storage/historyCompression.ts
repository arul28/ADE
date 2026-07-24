import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Transform, Writable, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip, gunzipSync, type ZlibOptions } from "node:zlib";
import type { Logger } from "../logging/logger";
import { isEnoentError } from "../shared/utils";
import type { DiskPressureMonitor } from "./diskPressure";
import { readVolumeSpace } from "./volume";

const DAY_MS = 24 * 60 * 60_000;
// Inactive history older than this is compressed by the storage doctor. Lowered
// from 30d to 14d: on the reference machine 62 files were >14d (280 MB) that the
// 30d threshold left uncompressed. Compression is transparent (read-back
// decompresses), so a shorter threshold reclaims more without user impact.
const DEFAULT_MIN_AGE_DAYS = 14;
export const COMPRESSION_MIN_AGE_MS = DEFAULT_MIN_AGE_DAYS * DAY_MS;
const DEFAULT_MAX_FILES = 25;
const BETWEEN_FILES_DELAY_MS = 250;
const COMPRESSION_HEADROOM_FACTOR = 1.2;
export const MAX_TRANSPARENT_HISTORY_BYTES = 256 * 1024 * 1024;
// A valid gzip can be slightly larger than its source when the source is
// incompressible. Keep the logical payload ceiling exact while allowing a
// conservative amount of gzip framing/deflate overhead on disk.
const MAX_TRANSPARENT_HISTORY_COMPRESSED_BYTES =
  MAX_TRANSPARENT_HISTORY_BYTES + (1024 * 1024);

export type CompressionCandidate = {
  path: string;
  bytes: number;
  kind: "chat_transcript" | "terminal_log" | "diagnostic_log";
};

export type CompressionRoot = {
  path: string;
  kind: CompressionCandidate["kind"];
  recursive?: boolean;
};

export type CompressionRoots = readonly CompressionRoot[];

export type CompressionSweepSummary = {
  filesCompressed: number;
  savedBytes: number;
  filesConsidered: number;
};

type HashingTransform = Transform & { readonly bytesSeen: number; digestHex(): string };

function hashingTransform(): HashingTransform {
  const hash = createHash("sha256");
  let bytesSeen = 0;
  let digested: string | null = null;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      bytesSeen += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  }) as HashingTransform;
  Object.defineProperties(stream, {
    bytesSeen: { get: () => bytesSeen },
    digestHex: {
      value: () => {
        digested ??= hash.digest("hex");
        return digested;
      },
    },
  });
  return stream;
}

function isEligibleName(filePath: string, kind: CompressionCandidate["kind"]): boolean {
  if (filePath.endsWith(".gz") || filePath.endsWith(".partial")) return false;
  if (kind === "chat_transcript") return filePath.endsWith(".jsonl");
  return filePath.endsWith(".log") || filePath.endsWith(".jsonl");
}

function freeBytesFor(filePath: string): number {
  return readVolumeSpace(path.dirname(filePath))?.freeBytes ?? 0;
}

async function removeFileBestEffort(filePath: string): Promise<void> {
  await fs.promises.unlink(filePath).catch((error) => {
    if (!isEnoentError(error)) throw error;
  });
}

async function fsyncFile(filePath: string): Promise<void> {
  const handle = await fs.promises.open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Read a compressed history file with a hard decompressed-size ceiling. */
export function readCompressedHistoryFileSync(filePath: string): Buffer {
  const compressed = fs.readFileSync(filePath);
  if (compressed.length > MAX_TRANSPARENT_HISTORY_COMPRESSED_BYTES) {
    throw new Error("compressed_history_too_large");
  }
  return gunzipSync(compressed, { maxOutputLength: MAX_TRANSPARENT_HISTORY_BYTES });
}

export function readHistoryFileSync(filePath: string): Buffer {
  return filePath.endsWith(".gz")
    ? readCompressedHistoryFileSync(filePath)
    : fs.readFileSync(filePath);
}

/** Prefer the plain append target, then its transparent gzip replacement. */
export function resolveReadableHistoryPath(filePath: string): string | null {
  const normalizedPath = path.resolve(filePath);
  const plainPath = normalizedPath.endsWith(".gz")
    ? normalizedPath.slice(0, -3)
    : normalizedPath;
  if (fs.existsSync(plainPath)) return plainPath;
  const gzipPath = `${plainPath}.gz`;
  return fs.existsSync(gzipPath) ? gzipPath : null;
}

/** Read an exact bounded raw byte range, tolerating permitted short FileHandle reads. */
async function readPlainHistoryFileRange(
  filePath: string,
  position: number,
  length: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  signal?.throwIfAborted();
  const handle = await fs.promises.open(filePath, "r");
  try {
    const out = Buffer.allocUnsafe(length);
    let totalRead = 0;
    while (totalRead < length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(
        out,
        totalRead,
        length - totalRead,
        position + totalRead,
      );
      if (bytesRead <= 0) break;
      totalRead += bytesRead;
    }
    return totalRead === length ? out : out.subarray(0, totalRead);
  } finally {
    await handle.close();
  }
}

const SMALL_HISTORY_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
const SMALL_HISTORY_SNAPSHOT_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const SMALL_HISTORY_SNAPSHOT_CACHE_MAX_ENTRIES = 4;
const LARGE_HISTORY_DISK_CACHE_MAX_BYTES = MAX_TRANSPARENT_HISTORY_BYTES;
const LARGE_HISTORY_DISK_CACHE_MAX_ENTRIES = 4;
const smallHistorySnapshotCache = new Map<string, {
  mtimeMs: number;
  size: number;
  snapshot: Buffer;
}>();
let smallHistorySnapshotCacheBytes = 0;
type HistoryInflateAdmission = {
  sequence: number;
  read: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  removeAbortListener: () => void;
};
const pendingHistoryInflateAdmissions: HistoryInflateAdmission[] = [];
let historyInflateAdmissionActive = false;
let historyInflateRequestSequence = 0;
let latestHistoryInflateRequestSequence = 0;
type LargeHistoryDiskSnapshot = {
  sourceMtimeMs: number;
  sourceSize: number;
  logicalSize: number;
  handle: FileHandle;
  activeReaders: number;
  evicted: boolean;
  closePromise: Promise<void> | null;
};
const largeHistoryDiskSnapshotCache = new Map<string, LargeHistoryDiskSnapshot>();
const largeHistoryDiskSnapshotReads = new Map<string, Promise<LargeHistoryDiskSnapshot>>();
let largeHistoryDiskSnapshotCacheBytes = 0;

function removeSmallHistorySnapshot(cacheKey: string): void {
  const cached = smallHistorySnapshotCache.get(cacheKey);
  if (!cached) return;
  smallHistorySnapshotCache.delete(cacheKey);
  smallHistorySnapshotCacheBytes -= cached.snapshot.length;
}

function reserveSmallHistorySnapshotBytes(bytes: number): void {
  while (
    smallHistorySnapshotCache.size > 0
    && (
      smallHistorySnapshotCache.size >= SMALL_HISTORY_SNAPSHOT_CACHE_MAX_ENTRIES
      || smallHistorySnapshotCacheBytes + bytes > SMALL_HISTORY_SNAPSHOT_CACHE_MAX_BYTES
    )
  ) {
    const oldestKey = smallHistorySnapshotCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    removeSmallHistorySnapshot(oldestKey);
  }
}

async function gzipUncompressedSize(filePath: string, compressedSize: number): Promise<number> {
  if (compressedSize < 4 || compressedSize > MAX_TRANSPARENT_HISTORY_COMPRESSED_BYTES) {
    throw new Error("compressed_history_too_large");
  }
  const trailer = await readPlainHistoryFileRange(filePath, compressedSize - 4, 4);
  if (trailer.length !== 4) throw new Error("compressed_history_invalid");
  const size = trailer.readUInt32LE(0);
  if (size > MAX_TRANSPARENT_HISTORY_BYTES) {
    throw new Error("compressed_history_too_large");
  }
  return size;
}

function abortReason(signal: AbortSignal): unknown {
  try {
    signal.throwIfAborted();
  } catch (error) {
    return error;
  }
  return new Error("History read aborted.");
}

function startNextHistoryInflateAdmission(): void {
  if (historyInflateAdmissionActive) return;
  const next = pendingHistoryInflateAdmissions.shift();
  if (!next) return;
  next.removeAbortListener();
  if (next.signal?.aborted) {
    next.reject(abortReason(next.signal));
    startNextHistoryInflateAdmission();
    return;
  }
  historyInflateAdmissionActive = true;
  void Promise.resolve()
    .then(next.read)
    .then(next.resolve, next.reject)
    .finally(() => {
      historyInflateAdmissionActive = false;
      startNextHistoryInflateAdmission();
    });
}

/**
 * Admit one inflater at a time and retain only the newest queued request.
 * Rapid chat switching can therefore leave at most the active archive plus
 * the current destination; superseded queued reads fail through the existing
 * retryable history-error path instead of keeping the brain busy long after
 * the viewer moved on.
 */
function withAsyncHistoryInflateAdmission<T>(
  read: () => Promise<T>,
  sequence: number,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    if (sequence < latestHistoryInflateRequestSequence) {
      reject(new Error("compressed_history_read_superseded"));
      return;
    }
    while (pendingHistoryInflateAdmissions.length > 0) {
      const superseded = pendingHistoryInflateAdmissions.shift()!;
      superseded.removeAbortListener();
      superseded.reject(new Error("compressed_history_read_superseded"));
    }
    let admission: HistoryInflateAdmission;
    const onAbort = () => {
      const index = pendingHistoryInflateAdmissions.indexOf(admission);
      if (index >= 0) pendingHistoryInflateAdmissions.splice(index, 1);
      admission.removeAbortListener();
      reject(signal ? abortReason(signal) : new Error("History read aborted."));
    };
    admission = {
      sequence,
      read,
      resolve: (value) => resolve(value as T),
      reject,
      signal,
      removeAbortListener: () => signal?.removeEventListener("abort", onAbort),
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    pendingHistoryInflateAdmissions.push(admission);
    startNextHistoryInflateAdmission();
  });
}

function readCachedSmallHistorySnapshot(
  cacheKey: string,
  stat: Pick<fs.Stats, "mtimeMs" | "size">,
  position: number,
  length: number,
): Buffer | null {
  const cached = smallHistorySnapshotCache.get(cacheKey);
  if (!cached) return null;
  if (cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
    removeSmallHistorySnapshot(cacheKey);
    return null;
  }
  smallHistorySnapshotCache.delete(cacheKey);
  smallHistorySnapshotCache.set(cacheKey, cached);
  return cached.snapshot.subarray(position, position + length);
}

async function readFileHandleRange(
  handle: FileHandle,
  position: number,
  length: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  signal?.throwIfAborted();
  const out = Buffer.allocUnsafe(length);
  let totalRead = 0;
  while (totalRead < length) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(
      out,
      totalRead,
      length - totalRead,
      position + totalRead,
    );
    if (bytesRead <= 0) break;
    totalRead += bytesRead;
  }
  return totalRead === length ? out : out.subarray(0, totalRead);
}

async function closeLargeHistoryDiskSnapshot(snapshot: LargeHistoryDiskSnapshot): Promise<void> {
  snapshot.closePromise ??= snapshot.handle.close().catch(() => {});
  await snapshot.closePromise;
}

async function evictLargeHistoryDiskSnapshot(cacheKey: string): Promise<void> {
  const snapshot = largeHistoryDiskSnapshotCache.get(cacheKey);
  if (!snapshot) return;
  largeHistoryDiskSnapshotCache.delete(cacheKey);
  largeHistoryDiskSnapshotCacheBytes -= snapshot.logicalSize;
  snapshot.evicted = true;
  if (snapshot.activeReaders === 0) {
    // A caller may already have received this snapshot from an async cache
    // lookup but not yet resumed far enough to increment activeReaders. Give
    // promise continuations one event-loop turn to pin the handle before
    // closing an otherwise idle eviction.
    setImmediate(() => {
      if (snapshot.evicted && snapshot.activeReaders === 0) {
        void closeLargeHistoryDiskSnapshot(snapshot);
      }
    });
  }
}

async function reserveLargeHistoryDiskSnapshotBytes(bytes: number): Promise<void> {
  while (
    largeHistoryDiskSnapshotCache.size > 0
    && (
      largeHistoryDiskSnapshotCache.size >= LARGE_HISTORY_DISK_CACHE_MAX_ENTRIES
      || largeHistoryDiskSnapshotCacheBytes + bytes > LARGE_HISTORY_DISK_CACHE_MAX_BYTES
    )
  ) {
    const oldestKey = largeHistoryDiskSnapshotCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    await evictLargeHistoryDiskSnapshot(oldestKey);
  }
}

async function createLargeHistoryDiskSnapshot(
  cacheKey: string,
  sourceStat: Pick<fs.Stats, "mtimeMs" | "size">,
  logicalSize: number,
  signal?: AbortSignal,
): Promise<LargeHistoryDiskSnapshot> {
  signal?.throwIfAborted();
  const tempVolume = readVolumeSpace(os.tmpdir());
  if (
    tempVolume
    && tempVolume.freeBytes < Math.ceil(logicalSize * COMPRESSION_HEADROOM_FACTOR)
  ) {
    throw new Error("compressed_history_insufficient_temp_space");
  }
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ade-history-read-"));
  const tempPath = path.join(tempDir, "snapshot");
  let outputBytes = 0;
  let handle: FileHandle | null = null;
  try {
    await pipeline(
      fs.createReadStream(cacheKey),
      createGunzip(),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          outputBytes += chunk.length;
          if (outputBytes > MAX_TRANSPARENT_HISTORY_BYTES) {
            callback(new Error("compressed_history_too_large"));
            return;
          }
          callback(null, chunk);
        },
      }),
      fs.createWriteStream(tempPath, { flags: "wx" }),
      { signal },
    );
    if (outputBytes !== logicalSize) {
      throw new Error("compressed_history_size_mismatch");
    }
    handle = await fs.promises.open(tempPath, "r");
    await fs.promises.unlink(tempPath);
    await fs.promises.rmdir(tempDir);
    return {
      sourceMtimeMs: sourceStat.mtimeMs,
      sourceSize: sourceStat.size,
      logicalSize,
      handle,
      activeReaders: 0,
      evicted: false,
      closePromise: null,
    };
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.promises.unlink(tempPath).catch(() => {});
    await fs.promises.rmdir(tempDir).catch(() => {});
    throw error;
  }
}

async function ensureLargeHistoryDiskSnapshot(
  cacheKey: string,
  sourceStat: Pick<fs.Stats, "mtimeMs" | "size">,
  logicalSize: number,
  requestSequence: number,
  signal?: AbortSignal,
): Promise<LargeHistoryDiskSnapshot> {
  signal?.throwIfAborted();
  const cached = largeHistoryDiskSnapshotCache.get(cacheKey);
  if (
    cached
    && cached.sourceMtimeMs === sourceStat.mtimeMs
    && cached.sourceSize === sourceStat.size
  ) {
    largeHistoryDiskSnapshotCache.delete(cacheKey);
    largeHistoryDiskSnapshotCache.set(cacheKey, cached);
    return cached;
  }
  if (cached) await evictLargeHistoryDiskSnapshot(cacheKey);

  const readKey = `${cacheKey}\0${sourceStat.mtimeMs}\0${sourceStat.size}`;
  const existingRead = signal ? null : largeHistoryDiskSnapshotReads.get(readKey);
  if (existingRead) return await existingRead;
  const read = withAsyncHistoryInflateAdmission(async () => {
    signal?.throwIfAborted();
    const admittedStat = await fs.promises.stat(cacheKey);
    const admittedCached = largeHistoryDiskSnapshotCache.get(cacheKey);
    if (
      admittedCached
      && admittedCached.sourceMtimeMs === admittedStat.mtimeMs
      && admittedCached.sourceSize === admittedStat.size
    ) {
      largeHistoryDiskSnapshotCache.delete(cacheKey);
      largeHistoryDiskSnapshotCache.set(cacheKey, admittedCached);
      return admittedCached;
    }
    if (admittedCached) await evictLargeHistoryDiskSnapshot(cacheKey);
    if (
      admittedStat.mtimeMs !== sourceStat.mtimeMs
      || admittedStat.size !== sourceStat.size
    ) {
      throw new Error("compressed_history_changed");
    }
    const snapshot = await createLargeHistoryDiskSnapshot(
      cacheKey,
      admittedStat,
      logicalSize,
      signal,
    );
    await reserveLargeHistoryDiskSnapshotBytes(snapshot.logicalSize);
    largeHistoryDiskSnapshotCache.set(cacheKey, snapshot);
    largeHistoryDiskSnapshotCacheBytes += snapshot.logicalSize;
    return snapshot;
  }, requestSequence, signal);
  if (!signal) largeHistoryDiskSnapshotReads.set(readKey, read);
  try {
    return await read;
  } finally {
    if (!signal && largeHistoryDiskSnapshotReads.get(readKey) === read) {
      largeHistoryDiskSnapshotReads.delete(readKey);
    }
  }
}

async function readLargeHistoryDiskSnapshotRange(
  snapshot: LargeHistoryDiskSnapshot,
  position: number,
  length: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  snapshot.activeReaders += 1;
  try {
    return await readFileHandleRange(snapshot.handle, position, length, signal);
  } finally {
    snapshot.activeReaders -= 1;
    if (snapshot.evicted && snapshot.activeReaders === 0) {
      await closeLargeHistoryDiskSnapshot(snapshot);
    }
  }
}

/**
 * Return the logical (decompressed) byte size without reading the full file.
 */
export async function readHistoryFileSize(filePath: string): Promise<number> {
  const stat = await fs.promises.stat(filePath);
  if (!filePath.endsWith(".gz")) return stat.size;
  return await gzipUncompressedSize(filePath, stat.size);
}

/**
 * Read a bounded logical byte range without blocking the Electron/runtime
 * event loop. Large gzip files are streamed to a bounded collector instead of
 * retaining both the compressed and decompressed snapshots in memory.
 * Inflations are globally admitted one at a time so unrelated archive reads
 * cannot multiply zlib CPU and memory pressure.
 */
const historyFileRangeReads = new Map<string, Promise<Buffer>>();

async function readHistoryFileRangeUncoalesced(
  filePath: string,
  position: number,
  length: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const normalizedPosition = Math.max(0, Number.isFinite(position) ? Math.floor(position) : 0);
  const normalizedLength = Math.max(
    0,
    Math.min(
      MAX_TRANSPARENT_HISTORY_BYTES,
      Number.isFinite(length) ? Math.floor(length) : 0,
    ),
  );
  if (normalizedLength <= 0) return Buffer.alloc(0);
  signal?.throwIfAborted();
  if (!filePath.endsWith(".gz")) {
    return await readPlainHistoryFileRange(
      filePath,
      normalizedPosition,
      normalizedLength,
      signal,
    );
  }

  const requestSequence = ++historyInflateRequestSequence;
  latestHistoryInflateRequestSequence = requestSequence;
  const cacheKey = path.resolve(filePath);
  const initialStat = await fs.promises.stat(cacheKey);
  const initialCached = readCachedSmallHistorySnapshot(
    cacheKey,
    initialStat,
    normalizedPosition,
    normalizedLength,
  );
  if (initialCached) return initialCached;
  const initialLogicalSize = await gzipUncompressedSize(cacheKey, initialStat.size);
  if (initialLogicalSize > SMALL_HISTORY_SNAPSHOT_MAX_BYTES) {
    const snapshot = await ensureLargeHistoryDiskSnapshot(
      cacheKey,
      initialStat,
      initialLogicalSize,
      requestSequence,
      signal,
    );
    const requestedEnd = Math.min(
      snapshot.logicalSize,
      normalizedPosition + normalizedLength,
    );
    return await readLargeHistoryDiskSnapshotRange(
      snapshot,
      normalizedPosition,
      Math.max(0, requestedEnd - normalizedPosition),
      signal,
    );
  }

  return await withAsyncHistoryInflateAdmission(async () => {
    signal?.throwIfAborted();
    const stat = await fs.promises.stat(cacheKey);
    const admittedCached = readCachedSmallHistorySnapshot(
      cacheKey,
      stat,
      normalizedPosition,
      normalizedLength,
    );
    if (admittedCached) return admittedCached;

    const logicalSize = await gzipUncompressedSize(cacheKey, stat.size);
    const snapshotChunks: Buffer[] = [];
    let decompressedOffset = 0;
    await pipeline(
      fs.createReadStream(cacheKey),
      createGunzip(),
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          decompressedOffset += chunk.length;
          if (decompressedOffset > MAX_TRANSPARENT_HISTORY_BYTES) {
            callback(new Error("compressed_history_too_large"));
            return;
          }
          snapshotChunks.push(Buffer.from(chunk));
          callback();
        },
      }),
      { signal },
    );
    if (decompressedOffset !== logicalSize) {
      throw new Error("compressed_history_size_mismatch");
    }
    const snapshot = Buffer.concat(snapshotChunks, logicalSize);
    reserveSmallHistorySnapshotBytes(snapshot.length);
    smallHistorySnapshotCache.set(cacheKey, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      snapshot,
    });
    smallHistorySnapshotCacheBytes += snapshot.length;
    return snapshot.subarray(
      normalizedPosition,
      normalizedPosition + normalizedLength,
    );
  }, requestSequence, signal);
}

export async function readHistoryFileRange(
  filePath: string,
  position: number,
  length: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (signal) {
    return await readHistoryFileRangeUncoalesced(filePath, position, length, signal);
  }
  const readKey = `${path.resolve(filePath)}\0${position}\0${length}`;
  const existing = historyFileRangeReads.get(readKey);
  if (existing) return await existing;
  const read = readHistoryFileRangeUncoalesced(filePath, position, length);
  historyFileRangeReads.set(readKey, read);
  try {
    return await read;
  } finally {
    if (historyFileRangeReads.get(readKey) === read) {
      historyFileRangeReads.delete(readKey);
    }
  }
}

const historyReinflateInFlight = new Map<string, Promise<boolean>>();

/**
 * Restore a compressed append target without materializing the archive on the
 * Electron/runtime event loop. Calls for the same path coalesce, and the gzip
 * remains intact unless a fully-written, fsynced plain file is ready.
 */
export async function reinflateHistoryFile(plainPath: string): Promise<boolean> {
  const normalizedPath = path.resolve(plainPath);
  const existing = historyReinflateInFlight.get(normalizedPath);
  if (existing) return await existing;

  const reinflate = (async () => {
    const gzipPath = `${normalizedPath}.gz`;
    let gzipStat: fs.Stats;
    try {
      gzipStat = await fs.promises.stat(gzipPath);
    } catch (error) {
      if (isEnoentError(error)) return false;
      throw error;
    }
    if (!gzipStat.isFile()) return false;
    if (gzipStat.size > MAX_TRANSPARENT_HISTORY_COMPRESSED_BYTES) {
      throw new Error("compressed_history_too_large");
    }

    try {
      const plainStat = await fs.promises.stat(normalizedPath);
      if (plainStat.isFile()) {
        await removeFileBestEffort(gzipPath);
        return true;
      }
    } catch (error) {
      if (!isEnoentError(error)) throw error;
    }

    const partialPath = `${normalizedPath}.${process.pid}.${randomUUID()}.reinflate.partial`;
    let outputBytes = 0;
    try {
      if (freeBytesFor(normalizedPath) < MAX_TRANSPARENT_HISTORY_BYTES * COMPRESSION_HEADROOM_FACTOR) {
        throw new Error("compressed_history_insufficient_headroom");
      }
      await fs.promises.mkdir(path.dirname(normalizedPath), { recursive: true });
      await pipeline(
        fs.createReadStream(gzipPath),
        createGunzip(),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            outputBytes += chunk.length;
            if (outputBytes > MAX_TRANSPARENT_HISTORY_BYTES) {
              callback(new Error("compressed_history_too_large"));
              return;
            }
            callback(null, chunk);
          },
        }),
        fs.createWriteStream(partialPath, { flags: "wx", mode: 0o600 }),
      );
      await fsyncFile(partialPath);
      try {
        const plainStat = await fs.promises.stat(normalizedPath);
        if (plainStat.isFile()) {
          await removeFileBestEffort(partialPath);
          await removeFileBestEffort(gzipPath);
          return true;
        }
      } catch (error) {
        if (!isEnoentError(error)) throw error;
      }
      await fs.promises.rename(partialPath, normalizedPath);
      await removeFileBestEffort(gzipPath);
      return true;
    } finally {
      await removeFileBestEffort(partialPath).catch(() => {});
    }
  })();
  historyReinflateInFlight.set(normalizedPath, reinflate);
  try {
    return await reinflate;
  } finally {
    if (historyReinflateInFlight.get(normalizedPath) === reinflate) {
      historyReinflateInFlight.delete(normalizedPath);
    }
  }
}

export function createHistoryCompressor(deps: {
  logger: Logger;
  diskPressure?: DiskPressureMonitor | null;
  isPathActive: (path: string) => boolean;
  minAgeDays?: number;
  /** Test seam for verification-failure coverage. */
  createGzipStream?: (options: ZlibOptions) => NodeJS.ReadWriteStream;
  betweenFilesDelayMs?: number;
}) {
  const minAgeMs = (deps.minAgeDays ?? DEFAULT_MIN_AGE_DAYS) * DAY_MS;
  const gzipFactory = deps.createGzipStream ?? ((options: ZlibOptions) => createGzip(options));

  const listCandidates = async (roots: CompressionRoots): Promise<CompressionCandidate[]> => {
    const candidates: Array<CompressionCandidate & { mtimeMs: number }> = [];
    const seen = new Set<string>();
    const oldBefore = Date.now() - minAgeMs;

    for (const root of roots) {
      const pending = [path.resolve(root.path)];
      while (pending.length > 0) {
        const current = pending.shift()!;
        let stat: fs.Stats;
        try {
          stat = await fs.promises.lstat(current);
        } catch (error) {
          if (isEnoentError(error)) continue;
          throw error;
        }
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          if (current !== path.resolve(root.path) && root.recursive === false) continue;
          let names: string[];
          try {
            names = await fs.promises.readdir(current);
          } catch (error) {
            if (isEnoentError(error)) continue;
            throw error;
          }
          for (const name of names) pending.push(path.join(current, name));
          continue;
        }
        const normalized = path.resolve(current);
        if (
          !stat.isFile()
          || seen.has(normalized)
          || stat.mtimeMs >= oldBefore
          || stat.size > MAX_TRANSPARENT_HISTORY_BYTES
          || !isEligibleName(normalized, root.kind)
          || deps.isPathActive(normalized)
        ) {
          continue;
        }
        seen.add(normalized);
        candidates.push({ path: normalized, bytes: stat.size, kind: root.kind, mtimeMs: stat.mtimeMs });
      }
    }

    return candidates
      .sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path))
      .map(({ mtimeMs: _mtimeMs, ...candidate }) => candidate);
  };

  const compressOne = async (
    candidate: CompressionCandidate,
  ): Promise<{ ok: boolean; savedBytes?: number; reason?: string }> => {
    const sourcePath = path.resolve(candidate.path);
    const partialPath = `${sourcePath}.gz.partial`;
    const gzipPath = `${sourcePath}.gz`;
    let createdGzip = false;
    try {
      if (deps.isPathActive(sourcePath)) return { ok: false, reason: "path_active" };
      const pressure = deps.diskPressure?.canPerform("compression");
      if (pressure && !pressure.allowed) return { ok: false, reason: "disk_pressure" };
      if (freeBytesFor(sourcePath) < candidate.bytes * COMPRESSION_HEADROOM_FACTOR) return { ok: false, reason: "insufficient_headroom" };
      if (fs.existsSync(gzipPath)) return { ok: false, reason: "compressed_copy_exists" };

      const before = await fs.promises.stat(sourcePath);
      if (!before.isFile()) return { ok: false, reason: "not_a_file" };
      const sourceHash = hashingTransform();
      await pipeline(
        fs.createReadStream(sourcePath),
        sourceHash,
        gzipFactory({ level: 6 }),
        fs.createWriteStream(partialPath, { flags: "wx" }),
      );
      await fsyncFile(partialPath);

      const verifiedHash = hashingTransform();
      try {
        await pipeline(
          fs.createReadStream(partialPath),
          createGunzip(),
          verifiedHash,
          new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
        );
      } catch {
        return { ok: false, reason: "verification_failed" };
      }
      const after = await fs.promises.stat(sourcePath);
      if (
        sourceHash.bytesSeen !== verifiedHash.bytesSeen
        || sourceHash.digestHex() !== verifiedHash.digestHex()
        || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs
      ) {
        return { ok: false, reason: "verification_failed" };
      }

      await fs.promises.rename(partialPath, gzipPath);
      createdGzip = true;
      if (deps.isPathActive(sourcePath)) {
        await removeFileBestEffort(gzipPath);
        return { ok: false, reason: "path_resumed" };
      }
      await fs.promises.unlink(sourcePath);
      const compressedBytes = (await fs.promises.stat(gzipPath)).size;
      const savedBytes = Math.max(0, before.size - compressedBytes);
      deps.logger.info("storage.history_compressed", {
        path: sourcePath,
        from: before.size,
        to: compressedBytes,
      });
      return { ok: true, savedBytes };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await removeFileBestEffort(partialPath).catch(() => {});
      if (createdGzip && fs.existsSync(sourcePath)) {
        // A failed or resumed compression must never leave a second full copy.
        await removeFileBestEffort(gzipPath).catch(() => {});
      }
    }
  };

  const runIdleSweep = async (
    roots: CompressionRoots,
    opts: { maxFiles?: number } = {},
  ): Promise<CompressionSweepSummary> => {
    // Gate on the compression policy, not on "not normal": warning-level
    // pressure still allows compression (it is one of the safest ways to
    // reclaim space), and only critical/exhausted refuse it. Refusing at
    // warning made "compress old history" report 0 files exactly when the
    // user wanted to free space.
    const decision = deps.diskPressure?.canPerform("compression");
    if (decision && !decision.allowed) {
      return { filesCompressed: 0, savedBytes: 0, filesConsidered: 0 };
    }
    const maxFiles = Math.max(0, Math.floor(opts.maxFiles ?? DEFAULT_MAX_FILES));
    const candidates = (await listCandidates(roots)).slice(0, maxFiles);
    let filesCompressed = 0;
    let savedBytes = 0;
    for (let index = 0; index < candidates.length; index += 1) {
      const result = await compressOne(candidates[index]!);
      if (result.ok) {
        filesCompressed += 1;
        savedBytes += result.savedBytes ?? 0;
      }
      if (index + 1 < candidates.length) await delay(deps.betweenFilesDelayMs ?? BETWEEN_FILES_DELAY_MS);
    }
    return { filesCompressed, savedBytes, filesConsidered: candidates.length };
  };

  return { listCandidates, compressOne, runIdleSweep };
}
