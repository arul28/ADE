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
/** How long a folder that is there is reused; the list is read often and folders rarely move. */
const FOLDER_PRESENCE_TTL_MS = 10_000;
/**
 * How long any other answer is reused. Short, so a folder that comes back
 * (a re-clone right after "the folder is gone", a drive plugged back in)
 * reads as there almost at once.
 */
const FOLDER_ABSENCE_TTL_MS = 2_000;

/**
 * Where a project's folder stands on this machine:
 * - `present`: the folder is there.
 * - `gone`: it is not, and the drive it lives on is (the folder was deleted).
 * - `driveMissing`: it is not, and neither is its drive (an unplugged or
 *   unmounted drive, an unmapped drive letter); it may come back with it.
 * - `unknown`: the check failed for another reason (no permission) or ran
 *   out of time.
 */
export type ProjectFolderState = "present" | "gone" | "driveMissing" | "unknown";

type PresenceEntry = {
  startedAt: number;
  /** When the check settled, and its answer; null while it is pending. */
  settledAt: number | null;
  state: ProjectFolderState | null;
  check: Promise<ProjectFolderState>;
};

/**
 * One stat per folder at a time, its answer reused for a few seconds. A stat
 * on an unreachable drive holds a libuv thread until the OS gives up, so a
 * fresh stat on every list would pile up behind it and starve the brain's
 * other file, crypto and zlib work.
 */
const folderPresence = new Map<string, PresenceEntry>();

function isMissing(error: NodeJS.ErrnoException | null | undefined): boolean {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

function trimTrailingSeparators(rootPath: string): string {
  const trimmed = rootPath.replace(/[\\/]+$/, "");
  return trimmed || rootPath;
}

/**
 * The roots of the removable or network volume a path is on, when its path
 * says so: `/Volumes/<name>` (macOS), `/media/<user>/<name>`,
 * `/run/media/<user>/<name>` and `/mnt/<name>` (Linux), the drive or share
 * (Windows). Outermost first; includes the path itself when it is one.
 */
function volumeRoots(rootPath: string): string[] {
  if (process.platform === "win32") {
    const root = path.win32.parse(rootPath).root;
    return root ? [root] : [];
  }
  const parts = trimTrailingSeparators(rootPath).split("/");
  const depths = parts[1] === "Volumes" || parts[1] === "mnt"
    ? [2]
    : parts[1] === "media"
      ? [2, 3]
      : parts[1] === "run" && parts[2] === "media" ? [4] : [];
  return depths.filter((depth) => depth < parts.length).map((depth) => parts.slice(0, depth + 1).join("/"));
}

/** Whether a project's folder lives on a volume that can be disconnected (a drive, a share, a mount). */
export function isOnRemovableVolume(rootPath: string): boolean {
  return volumeRoots(rootPath).length > 0;
}

/** Whether `root` is a mount point: another device than its parent folder. */
async function isMountPoint(root: string): Promise<boolean> {
  const [own, parent] = await Promise.all([fs.promises.stat(root), fs.promises.stat(path.dirname(root))]);
  return own.dev !== parent.dev;
}

/**
 * A folder that is not there: gone, unless the volume it lives on is missing
 * too. Then the folder may come back with the drive. A volume is missing when
 * its root is not there (an unplugged drive, an unmapped drive letter, a
 * project that is itself the root of a drive) or, off Windows, when none of
 * its roots is a mount point: an fstab mount point under /mnt or /media stays
 * behind as an empty folder while its drive is unmounted. (A plain folder
 * under /mnt that is not a mount point reads the same way: unknown, so it is
 * never pruned by mistake.)
 */
async function absentFolderState(rootPath: string): Promise<ProjectFolderState> {
  const roots = volumeRoots(rootPath);
  if (!roots.length) return "gone";
  const own = trimTrailingSeparators(rootPath);
  for (const root of roots) {
    // The project is the drive's root, and it is not there: the drive is not.
    if (trimTrailingSeparators(root) === own) return "driveMissing";
    try {
      await fs.promises.stat(root);
    } catch {
      // The drive is missing, or can't be checked: either way the folder may be there.
      return "driveMissing";
    }
  }
  if (process.platform === "win32") return "gone";
  for (const root of roots) {
    try {
      if (await isMountPoint(root)) return "gone";
    } catch {
      return "driveMissing";
    }
  }
  return "driveMissing";
}

function entryFresh(entry: PresenceEntry, now: number): boolean {
  if (entry.settledAt === null) return true;
  const ttl = entry.state === "present" ? FOLDER_PRESENCE_TTL_MS : FOLDER_ABSENCE_TTL_MS;
  return now - entry.settledAt < ttl;
}

function startCheck(rootPath: string): PresenceEntry {
  const entry: PresenceEntry = {
    startedAt: Date.now(),
    settledAt: null,
    state: null,
    check: fs.promises.stat(rootPath).then(
      (stat): ProjectFolderState | Promise<ProjectFolderState> => (stat.isDirectory() ? "present" : "gone"),
      (error: NodeJS.ErrnoException) => (isMissing(error) ? absentFolderState(rootPath) : "unknown"),
    ),
  };
  folderPresence.set(rootPath, entry);
  void entry.check.then((state) => {
    entry.state = state;
    entry.settledAt = Date.now();
  });
  return entry;
}

function checkFolderState(rootPath: string, budgetMs: number, fresh: boolean): Promise<ProjectFolderState> {
  const cached = folderPresence.get(rootPath);
  const now = Date.now();
  if (cached && cached.settledAt === null) {
    // One stat at a time per folder. One still pending past the budget is on
    // a hung mount: answer unknown at once instead of waiting it out again.
    if (now - cached.startedAt >= budgetMs) return Promise.resolve("unknown");
    return cached.check;
  }
  if (cached && !fresh && entryFresh(cached, now)) return cached.check;
  return startCheck(rootPath).check;
}

/**
 * Where each project's folder stands, by index. Async stats on the thread
 * pool, all at once, under one deadline: nothing blocks the event loop.
 * `fresh` re-checks folders whose answer is cached (a pending check is still
 * shared), for a caller about to act on the answer, like a prune.
 */
export async function readProjectFolderStates(
  records: readonly { rootPath: string }[],
  options: { budgetMs?: number; fresh?: boolean } = {},
): Promise<ProjectFolderState[]> {
  const budgetMs = options.budgetMs ?? FOLDER_CHECK_BUDGET_MS;
  const states = new Array<ProjectFolderState>(records.length).fill("unknown");
  // Drop answers past their time, so a removed project's folder isn't kept forever.
  const now = Date.now();
  for (const [rootPath, entry] of folderPresence) {
    if (!entryFresh(entry, now)) folderPresence.delete(rootPath);
  }
  const checks = Promise.all(records.map((record, index) =>
    checkFolderState(record.rootPath, budgetMs, options.fresh === true).then((value) => { states[index] = value; })));
  await withTimeout(checks, budgetMs);
  // A copy, so a stat that lands after the deadline can't change an answer
  // that was already sent.
  return [...states];
}

/**
 * Whether each project's folder is on this machine, by index: `false` when it
 * is gone, `undefined` when that is unknown: the check failed for another
 * reason (no permission), ran out of time, or the folder's drive is not
 * plugged in.
 */
export async function readProjectFolderPresence(
  records: readonly { rootPath: string }[],
  options: { budgetMs?: number; fresh?: boolean } = {},
): Promise<Array<boolean | undefined>> {
  const states = await readProjectFolderStates(records, options);
  return states.map((state) => (state === "present" ? true : state === "gone" ? false : undefined));
}
