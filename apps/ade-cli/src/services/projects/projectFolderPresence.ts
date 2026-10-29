import fs from "node:fs";
import path from "node:path";
import { withTimeout } from "../../../../desktop/src/main/services/shared/withTimeout";

/**
 * Whether registered projects' folders are on this machine, without ever
 * blocking the brain's event loop. Used by `projects.list`, `projects prune`
 * and ADE MCP's project picking.
 */

/** Stats past this are left unknown, so a hung network mount can't stall a caller. */
const FOLDER_CHECK_BUDGET_MS = 250;
/** How long one folder answer is reused; the list is read often and folders rarely move. */
const FOLDER_PRESENCE_TTL_MS = 10_000;

/**
 * One stat per folder at a time, its answer reused for a few seconds. A stat
 * on an unreachable drive holds a libuv thread until the OS gives up, so a
 * fresh stat on every list would pile up behind it and starve the brain's
 * other file, crypto and zlib work.
 */
const folderPresence = new Map<string, { settledAt: number | null; check: Promise<boolean | undefined> }>();

function isMissing(error: NodeJS.ErrnoException | null | undefined): boolean {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

/**
 * The roots of the removable or network volume a path is on, when its path
 * says so: `/Volumes/<name>` (macOS), `/media/<user>/<name>`,
 * `/run/media/<user>/<name>` and `/mnt/<name>` (Linux), the drive or share
 * (Windows). Only roots above the path itself.
 */
function volumeRoots(rootPath: string): string[] {
  if (process.platform === "win32") {
    const root = path.win32.parse(rootPath).root;
    return root && root !== rootPath ? [root] : [];
  }
  const parts = rootPath.split("/");
  const depths = parts[1] === "Volumes" || parts[1] === "mnt"
    ? [2]
    : parts[1] === "media"
      ? [2, 3]
      : parts[1] === "run" && parts[2] === "media" ? [4] : [];
  return depths.filter((depth) => depth < parts.length - 1).map((depth) => parts.slice(0, depth + 1).join("/"));
}

/**
 * A folder that is not there: gone (`false`), unless the volume it lives on is
 * missing too (an unplugged drive, an unmapped drive letter). Then the folder
 * may come back with the drive, so it is unknown (`undefined`).
 */
async function absentFolderPresence(rootPath: string): Promise<boolean | undefined> {
  for (const root of volumeRoots(rootPath)) {
    try {
      await fs.promises.stat(root);
    } catch {
      // The drive is missing, or can't be checked: either way the folder may be there.
      return undefined;
    }
  }
  return false;
}

function checkFolderPresence(rootPath: string): Promise<boolean | undefined> {
  const cached = folderPresence.get(rootPath);
  // A pending stat is reused however long it takes.
  if (cached && (cached.settledAt === null || Date.now() - cached.settledAt < FOLDER_PRESENCE_TTL_MS)) {
    return cached.check;
  }
  const entry: { settledAt: number | null; check: Promise<boolean | undefined> } = {
    settledAt: null,
    check: fs.promises.stat(rootPath).then(
      (stat) => stat.isDirectory(),
      (error: NodeJS.ErrnoException) => (isMissing(error) ? absentFolderPresence(rootPath) : undefined),
    ),
  };
  folderPresence.set(rootPath, entry);
  void entry.check.then(() => { entry.settledAt = Date.now(); });
  return entry.check;
}

/**
 * Whether each project's folder is on this machine, by index: `false` when it
 * is gone, `undefined` when that is unknown: the check failed for another
 * reason (no permission), ran out of time, or the folder's drive is not
 * plugged in. Async stats on the thread pool, all at once, under one
 * deadline: nothing blocks the event loop.
 */
export async function readProjectFolderPresence(
  records: readonly { rootPath: string }[],
  budgetMs = FOLDER_CHECK_BUDGET_MS,
): Promise<Array<boolean | undefined>> {
  const presence = new Array<boolean | undefined>(records.length).fill(undefined);
  // Drop answers past their time, so a removed project's folder isn't kept forever.
  for (const [rootPath, entry] of folderPresence) {
    if (entry.settledAt !== null && Date.now() - entry.settledAt >= FOLDER_PRESENCE_TTL_MS) folderPresence.delete(rootPath);
  }
  const checks = Promise.all(records.map((record, index) =>
    checkFolderPresence(record.rootPath).then((value) => { presence[index] = value; })));
  await withTimeout(checks, budgetMs);
  // A copy, so a stat that lands after the deadline can't change an answer
  // that was already sent.
  return [...presence];
}
