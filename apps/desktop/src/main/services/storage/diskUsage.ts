import type fs from "node:fs";
import path from "node:path";
import { nonAsarFs } from "../shared/nonAsarFs";

/**
 * How much disk a folder really takes, the one definition the storage page,
 * the lane reclaim estimate and the build-output cleanup share.
 *
 * - A file counts the blocks it has on disk (`st_blocks * 512`), not its
 *   length: a 5-byte file takes a whole block, a sparse file takes less.
 *   Windows (and any stat without block counts) falls back to the length.
 * - A file with several hard links counts once, and only when every link was
 *   seen in this measurement. A link that lives outside (a package store) means
 *   removing this folder frees nothing for that file.
 * - pnpm's `node_modules/.pnpm` is left out when its store is on the same
 *   volume: there pnpm clones or hard-links from the store, so those files
 *   share the store's blocks (a clone has one link and looks private, which is
 *   why the link count alone cannot catch it).
 * - Links are never followed.
 */

const STAT_BLOCK_BYTES = 512;
/** Multi-link files remembered per measurement; past this a new one counts 0. */
const MAX_TRACKED_LINKED_FILES = 100_000;
const PNPM_MODULES_MANIFEST = ".modules.yaml";
const PNPM_MANIFEST_MAX_BYTES = 64 * 1024;

/** Bytes a file occupies on disk. */
export function allocatedBytes(stat: fs.Stats): number {
  const size = Math.max(0, stat.size);
  if (process.platform === "win32") return size;
  const blocks = stat.blocks;
  if (typeof blocks !== "number" || !Number.isFinite(blocks) || blocks < 0) return size;
  return blocks * STAT_BLOCK_BYTES;
}

/**
 * Counts each file's bytes once per measurement. Call it for every non-folder
 * entry; it returns the bytes to add for that entry.
 */
export function createLinkedFileTally(): (stat: fs.Stats) => number {
  const seen = new Map<string, number>();
  return (stat) => {
    if (!(stat.nlink > 1)) return allocatedBytes(stat);
    // No inode to match links by: the file is shared, and not ours to count.
    if (!stat.ino) return 0;
    const key = `${stat.dev}:${stat.ino}`;
    const count = (seen.get(key) ?? 0) + 1;
    if (count >= stat.nlink) {
      seen.delete(key);
      return allocatedBytes(stat);
    }
    if (seen.size < MAX_TRACKED_LINKED_FILES || seen.has(key)) seen.set(key, count);
    return 0;
  };
}

/**
 * The `.pnpm` folder inside a `node_modules` to leave out of a measurement,
 * or null. Only asked when the folder lists `.modules.yaml`, so npm and yarn
 * folders cost nothing extra.
 */
export async function pnpmSharedStoreDir(nodeModulesPath: string, nodeModulesStat: fs.Stats): Promise<string | null> {
  let text: string;
  try {
    const handle = await nonAsarFs.promises.open(path.join(nodeModulesPath, PNPM_MODULES_MANIFEST), "r");
    try {
      const buffer = Buffer.alloc(PNPM_MANIFEST_MAX_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  const match = /^storeDir:[ \t]*(.+?)[ \t]*$/m.exec(text);
  const raw = match?.[1]?.replace(/^(['"])(.*)\1$/, "$2").trim();
  if (!raw) return null;
  const storeDir = path.resolve(nodeModulesPath, raw);
  try {
    const store = await nonAsarFs.promises.stat(storeDir);
    return store.dev === nodeModulesStat.dev ? path.join(nodeModulesPath, ".pnpm") : null;
  } catch {
    return null;
  }
}

export type TreeMeasurement = {
  bytes: number;
  fileCount: number;
  /** Entries looked at (files and folders). */
  entries: number;
  lastModifiedMs: number | null;
  /** Stopped at the entry limit or the deadline: `bytes` is a lower bound. */
  truncated: boolean;
};

export type MeasureTreeOptions = {
  entryLimit?: number;
  /** Absolute `Date.now()` time to stop at. */
  deadline?: number;
  concurrency?: number;
};

const DEFAULT_CONCURRENCY = 8;

/**
 * Measures a folder (or one file) with the rules above. Folders it cannot
 * read count as their own entry; the measurement carries on.
 */
export async function measureTree(rootPath: string, options: MeasureTreeOptions = {}): Promise<TreeMeasurement> {
  const result: TreeMeasurement = { bytes: 0, fileCount: 0, entries: 0, lastModifiedMs: null, truncated: false };
  const entryLimit = options.entryLimit ?? Number.POSITIVE_INFINITY;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const tally = createLinkedFileTally();
  const skipped = new Set<string>();
  const pending = [path.resolve(rootPath)];
  while (pending.length > 0) {
    if (result.entries >= entryLimit || (options.deadline != null && Date.now() >= options.deadline)) {
      result.truncated = true;
      break;
    }
    const batch = pending.splice(0, Math.min(concurrency, Math.max(1, entryLimit - result.entries)));
    result.entries += batch.length;
    const inspected = await Promise.all(batch.map(async (current) => {
      if (skipped.has(current)) return null;
      let stat: fs.Stats;
      try {
        stat = await nonAsarFs.promises.lstat(current);
      } catch {
        return null;
      }
      if (!stat.isDirectory()) return { stat, children: [] as string[] };
      let names: string[];
      try {
        names = await nonAsarFs.promises.readdir(current);
      } catch {
        return { stat, children: [] as string[] };
      }
      if (path.basename(current) === "node_modules" && names.includes(PNPM_MODULES_MANIFEST)) {
        const store = await pnpmSharedStoreDir(current, stat);
        if (store) skipped.add(store);
      }
      return { stat, children: names.map((name) => path.join(current, name)) };
    }));
    for (const entry of inspected) {
      if (!entry) continue;
      result.lastModifiedMs = Math.max(result.lastModifiedMs ?? 0, entry.stat.mtimeMs);
      if (entry.stat.isSymbolicLink()) continue;
      if (entry.stat.isDirectory()) {
        pending.push(...entry.children);
      } else {
        result.bytes += tally(entry.stat);
        result.fileCount += 1;
      }
    }
  }
  return result;
}
