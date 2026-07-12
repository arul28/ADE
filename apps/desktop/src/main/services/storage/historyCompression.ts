import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform, Writable, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip, gunzipSync, type ZlibOptions } from "node:zlib";
import type { Logger } from "../logging/logger";
import { isEnoentError } from "../shared/utils";
import type { DiskPressureMonitor } from "./diskPressure";
import { readVolumeSpace } from "./volume";

const DAY_MS = 24 * 60 * 60_000;
const DEFAULT_MIN_AGE_DAYS = 30;
export const COMPRESSION_MIN_AGE_MS = DEFAULT_MIN_AGE_DAYS * DAY_MS;
const DEFAULT_MAX_FILES = 25;
const BETWEEN_FILES_DELAY_MS = 250;
const COMPRESSION_HEADROOM_FACTOR = 1.2;
export const MAX_TRANSPARENT_HISTORY_BYTES = 256 * 1024 * 1024;

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
  if (compressed.length > MAX_TRANSPARENT_HISTORY_BYTES) {
    throw new Error("compressed_history_too_large");
  }
  return gunzipSync(compressed, { maxOutputLength: MAX_TRANSPARENT_HISTORY_BYTES });
}

export function readHistoryFileSync(filePath: string): Buffer {
  return filePath.endsWith(".gz")
    ? readCompressedHistoryFileSync(filePath)
    : fs.readFileSync(filePath);
}

/**
 * Restore a compressed append target atomically before its writer opens it.
 * A leftover .gz beside an existing plain file is a completed crash-window
 * copy; the plain append target is authoritative and the stale copy is removed.
 */
export function reinflateHistoryFileSync(
  plainPath: string,
  writeAtomic: (filePath: string, data: Buffer) => void,
): boolean {
  const gzipPath = `${plainPath}.gz`;
  if (!fs.existsSync(gzipPath)) return false;
  if (!fs.existsSync(plainPath)) {
    writeAtomic(plainPath, readCompressedHistoryFileSync(gzipPath));
  }
  fs.unlinkSync(gzipPath);
  return true;
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
    const snapshot = deps.diskPressure?.getSnapshot({ maxAgeMs: 1_000 });
    if (snapshot && snapshot.state !== "normal") {
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
