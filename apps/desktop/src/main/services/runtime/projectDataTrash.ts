import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeProjectRootPath } from "../../../../../ade-cli/src/services/projects/projectRoots";
import type { ProjectDatabaseIdentity } from "../../../../../ade-cli/src/services/projects/projectRegistry";
import { openReadonlyDatabase } from "../state/kvDb";
import { pathsEqual } from "../shared/pathCompare";
import { readRecycleBinRecordFile, recycleBinDataName, recycleBinRecordFor } from "./recycleBinRecord";

/**
 * Finding a project's `.ade` folder in the Trash and putting it back. Plain
 * filesystem work with no service state, kept apart from the recovery
 * service that offers it.
 */

/** Finder names a second `.ade` in the Trash ".ade 2", then ".ade 3", and so on. */
const TRASHED_ADE_NAMES = [".ade", ...Array.from({ length: 49 }, (_, index) => `.ade ${index + 2}`)];

function listDir(dir: string): string[] | null {
  try {
    return fs.readdirSync(dir);
  } catch {
    return null;
  }
}

/**
 * macOS and Linux name a deleted `.ade` `.ade` (or `.ade 2`…) in the home
 * Trash. macOS refuses to list the Trash without Full Disk Access but still
 * opens a path it is given, so the Finder names are tried then.
 */
function homeTrashCandidates(): string[] {
  const dir = process.platform === "darwin"
    ? path.join(os.homedir(), ".Trash")
    : path.join(process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share"), "Trash", "files");
  const names = listDir(dir)?.filter((name) => name.startsWith(".ade")) ?? TRASHED_ADE_NAMES;
  return names.map((name) => path.join(dir, name));
}

/**
 * Windows keeps a deleted `.ade` as `$R…` in its drive's Recycle Bin, found
 * through the `$I…` record that names the original path. One folder per user
 * SID; another user's is not readable and is skipped.
 */
function recycleBinCandidates(projectRoot: string): string[] {
  const recycleBin = path.join(path.parse(projectRoot).root, "$Recycle.Bin");
  const original = path.join(projectRoot, ".ade");
  const candidates: string[] = [];
  for (const sid of listDir(recycleBin) ?? []) {
    const sidDir = path.join(recycleBin, sid);
    for (const name of listDir(sidDir) ?? []) {
      const dataName = recycleBinDataName(name);
      if (dataName && pathsEqual(readRecycleBinRecordFile(path.join(sidDir, name)), original)) {
        candidates.push(path.join(sidDir, dataName));
      }
    }
  }
  return candidates;
}

function trashCandidates(projectRoot: string): string[] {
  return process.platform === "win32" ? recycleBinCandidates(projectRoot) : homeTrashCandidates();
}

/**
 * A trashed `.ade` belongs to this project when its database is the very file
 * this machine last opened for it (a move keeps the file's identity), or,
 * failing that, when the database's own project row names this project.
 */
function trashedDataBelongsTo(candidate: string, projectRoot: string, identity: ProjectDatabaseIdentity | null): boolean {
  const dbPath = path.join(candidate, "ade.db");
  let stat: fs.BigIntStats;
  try {
    stat = fs.statSync(dbPath, { bigint: true });
  } catch {
    return false;
  }
  if (identity && stat.dev.toString() === identity.dev && stat.ino.toString() === identity.ino) return true;
  let db: ReturnType<typeof openReadonlyDatabase> | null = null;
  try {
    db = openReadonlyDatabase(dbPath);
    const rows = db.prepare("select root_path from projects").all() as Array<{ root_path?: unknown }>;
    return rows.some((row) => typeof row.root_path === "string"
      && normalizeProjectRootPath(row.root_path) === projectRoot);
  } catch {
    return false;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

/**
 * How long a lookup is reused. The recovery screen asks every 2 seconds while
 * it waits, and each lookup may open every trashed `.ade` database read-only.
 */
const LOOKUP_CACHE_MS = 5_000;
/** One entry per project; a different recorded identity is looked up fresh. */
const lookupCache = new Map<string, { identityKey: string; at: number; result: string | null }>();

/** The newest `.ade` in the Trash whose database belongs to this project. */
export function findTrashedProjectData(projectRoot: string, identity: ProjectDatabaseIdentity | null): string | null {
  const normalizedRoot = normalizeProjectRootPath(projectRoot);
  const identityKey = identity ? `${identity.dev}:${identity.ino}` : "";
  const cached = lookupCache.get(normalizedRoot);
  if (cached && cached.identityKey === identityKey && Date.now() - cached.at < LOOKUP_CACHE_MS) return cached.result;
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  for (const candidate of trashCandidates(normalizedRoot)) {
    if (!trashedDataBelongsTo(candidate, normalizedRoot, identity)) continue;
    try {
      candidates.push({ path: candidate, mtimeMs: fs.statSync(candidate).mtimeMs });
    } catch {
      // Emptied while we looked.
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const result = candidates[0]?.path ?? null;
  lookupCache.set(normalizedRoot, { identityKey, at: Date.now(), result });
  return result;
}

/** Drops the cached lookup, so the next one sees the Trash as it is now. */
export function forgetTrashLookup(projectRoot: string): void {
  lookupCache.delete(normalizeProjectRootPath(projectRoot));
}

function isCrossDevice(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "EXDEV";
}

/** `<base>`, or `<base>-2`, `<base>-3`… whichever is free. */
function freeName(base: string): string {
  if (!fs.existsSync(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
}

/**
 * Moves `from` to `to`. Across volumes (an external disk's Trash) it copies to
 * a temporary sibling first and renames that into place, so a failed copy
 * never leaves a half-written entry at `to`; the trashed copy stays put.
 */
async function moveEntry(from: string, to: string): Promise<void> {
  try {
    fs.renameSync(from, to);
    return;
  } catch (error) {
    if (!isCrossDevice(error)) throw error;
  }
  const staging = freeName(`${to}.restoring`);
  try {
    await fs.promises.cp(from, staging, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    fs.renameSync(staging, to);
  } catch (error) {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * The database goes back last, after its write-ahead log: until `ade.db` is in
 * place a retry still sees missing data, and once it is, its log is too.
 */
function restoreOrder(names: string[]): string[] {
  const rank = (name: string) => (name === "ade.db" ? 2 : name.startsWith("ade.db-") ? 1 : 0);
  return [...names].sort((a, b) => rank(a) - rank(b));
}

/**
 * Merges a trashed `.ade` into a `.ade` that reappeared meanwhile (from git,
 * or written by ADE while the data was gone: it makes new machine keys). On a
 * clash the original wins; the file written meanwhile is kept as
 * `<name>.created-while-missing`, beside the trashed copy, or in the project
 * when the Trash is on another volume. Nothing is deleted.
 */
async function mergeEntries(source: string, target: string): Promise<void> {
  for (const name of restoreOrder(fs.readdirSync(source))) {
    const from = path.join(source, name);
    const to = path.join(target, name);
    let existing: fs.Stats | null = null;
    try {
      existing = fs.lstatSync(to);
    } catch {
      existing = null;
    }
    if (existing?.isDirectory() && fs.lstatSync(from).isDirectory()) {
      await mergeEntries(from, to);
      continue;
    }
    if (existing) {
      try {
        fs.renameSync(to, freeName(`${from}.created-while-missing`));
      } catch (error) {
        if (!isCrossDevice(error)) throw error;
        fs.renameSync(to, freeName(`${to}.created-while-missing`));
      }
    }
    await moveEntry(from, to);
  }
}

/** Removes `dir` when it holds nothing but empty folders; true when it is gone. */
function removeIfEmptyTree(dir: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return !fs.existsSync(dir);
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !removeIfEmptyTree(path.join(dir, entry.name))) return false;
  }
  try {
    fs.rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Puts a trashed `.ade` back at `target`, whole or merged into what is there.
 * Returns once the data is back; tidying the Trash afterwards is best effort.
 */
export async function restoreTrashedProjectData(
  source: string,
  target: string,
  logger?: { warn: (event: string, data: Record<string, unknown>) => void },
): Promise<void> {
  if (fs.existsSync(target)) {
    await mergeEntries(source, target);
  } else {
    await moveEntry(source, target);
  }
  // A merge empties the trashed folder without removing it. Once nothing is
  // left in it, drop it and, on Windows, its `$I…` record: otherwise Explorer
  // lists a deleted `.ade` whose restore would put back an empty folder. A
  // folder still holding files (a preserved `.created-while-missing`, or a
  // copy left on another volume) stays, record and all.
  if (!removeIfEmptyTree(source)) return;
  const record = process.platform === "win32" ? recycleBinRecordFor(source) : null;
  if (!record) return;
  try {
    fs.rmSync(record, { force: true });
  } catch (error) {
    logger?.warn("project.data_restore_record_cleanup_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
