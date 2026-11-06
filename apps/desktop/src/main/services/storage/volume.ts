import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { StorageVolumeRootKind, StorageVolumeSnapshot } from "../../../shared/types/storage";
import type { Logger } from "../logging/logger";

export function readVolumeSpace(dirPath: string): { freeBytes: number; totalBytes: number } | null {
  try {
    const stats = fs.statfsSync(dirPath, { bigint: true });
    return {
      freeBytes: Number(stats.bavail * stats.bsize),
      totalBytes: Number(stats.blocks * stats.bsize),
    };
  } catch {
    return null;
  }
}

const IMPORTANT_USAGE_TIMEOUT_MS = 3_000;
// Finder's "available": free space plus what macOS frees on its own when an
// app needs it (APFS snapshots, evictable files). statfs leaves that part out.
const IMPORTANT_USAGE_SCRIPT = [
  "ObjC.import('Foundation');",
  "function run(argv) {",
  "  var key = $.NSURLVolumeAvailableCapacityForImportantUsageKey;",
  "  return JSON.stringify(argv.map(function (p) {",
  "    var values = $.NSURL.fileURLWithPath(p).resourceValuesForKeysError($([key]), null);",
  "    if (!values || values.isNil()) return null;",
  "    var value = values.objectForKey(key);",
  "    return value && !value.isNil() ? Number(value.longLongValue) : null;",
  "  }));",
  "}",
].join("\n");

/**
 * macOS: each path's volume "available for important usage", in one short
 * `osascript` run. Null for a path it could not read, or all null on any
 * failure (logged); the caller keeps statfs then.
 */
function readImportantUsageBytes(
  paths: string[],
  logger?: Pick<Logger, "warn"> | null,
): Promise<Array<number | null>> {
  const none = paths.map(() => null);
  if (process.platform !== "darwin" || paths.length === 0) return Promise.resolve(none);
  const failed = (reason: string, error?: unknown) => {
    logger?.warn("storage.volume_important_usage_failed", {
      reason,
      ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
    });
    return none;
  };
  return new Promise((resolve) => {
    try {
      execFile(
        "/usr/bin/osascript",
        ["-l", "JavaScript", "-e", IMPORTANT_USAGE_SCRIPT, ...paths],
        { timeout: IMPORTANT_USAGE_TIMEOUT_MS, maxBuffer: 64 * 1024 },
        (error, stdout) => {
          if (error) return resolve(failed("osascript_failed", error));
          try {
            const parsed: unknown = JSON.parse(String(stdout).trim());
            if (!Array.isArray(parsed) || parsed.length !== paths.length) return resolve(failed("unexpected_output"));
            resolve(parsed.map((value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null)));
          } catch (parseError) {
            resolve(failed("unparseable_output", parseError));
          }
        },
      );
    } catch (spawnError) {
      resolve(failed("spawn_failed", spawnError));
    }
  });
}

/**
 * The drive a path lives on. Windows: its drive root (`c:\`, or the UNC
 * share), compared without case. Elsewhere: the device number.
 */
async function volumeKey(dirPath: string): Promise<string | null> {
  if (process.platform === "win32") return path.parse(path.resolve(dirPath)).root.toLowerCase() || null;
  try {
    return String((await fs.promises.stat(dirPath)).dev);
  } catch {
    return null;
  }
}

/**
 * Free and total space of every drive the given folders live on, one entry
 * per drive, in the order the folders were given. A folder that is missing
 * or unreadable is left out. Reads statfs, and on macOS adds the purgeable
 * space Finder counts as available. Async throughout: it runs while a
 * storage snapshot is built, never on a hot path.
 */
export async function readStorageVolumes(
  roots: Array<{ kind: StorageVolumeRootKind; path: string }>,
  logger?: Pick<Logger, "warn"> | null,
): Promise<StorageVolumeSnapshot[]> {
  const byKey = new Map<string, StorageVolumeSnapshot & { probePath: string }>();
  for (const root of roots) {
    const key = await volumeKey(root.path);
    if (!key) continue;
    const existing = byKey.get(key);
    if (existing) {
      existing.roots.push(root);
      continue;
    }
    let stats: fs.BigIntStatsFs;
    try {
      stats = await fs.promises.statfs(root.path, { bigint: true });
    } catch {
      continue;
    }
    byKey.set(key, {
      freeBytes: Number(stats.bavail * stats.bsize),
      totalBytes: Number(stats.blocks * stats.bsize),
      roots: [root],
      probePath: root.path,
    });
  }
  const volumes = [...byKey.values()];
  const important = await readImportantUsageBytes(volumes.map((volume) => volume.probePath), logger);
  return volumes.map(({ probePath: _probePath, ...volume }, index) => {
    const available = important[index];
    if (available == null || available <= volume.freeBytes) return volume;
    return { ...volume, freeBytes: available, purgeableBytes: available - volume.freeBytes };
  });
}

export function isNoSpaceError(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  if (code === "ENOSPC" || code === "EDQUOT") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /no space left|disk( is)? full|database or disk is full/i.test(message);
}
