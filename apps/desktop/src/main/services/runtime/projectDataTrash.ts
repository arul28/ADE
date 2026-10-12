import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeProjectRootPath } from "../../../../../ade-cli/src/services/projects/projectRoots";
import { openReadonlyDatabase } from "../state/kvDb";

/**
 * Finding a project's `.ade` folder in the Trash and putting it back. Plain
 * filesystem work with no service state, kept apart from the recovery
 * service that offers it.
 */

type DatabaseIdentity = { dev: string; ino: string };

/** Folders a deleted `.ade` lands in. Empty where ADE can't look. */
function trashDirs(): string[] {
  if (process.platform === "darwin") return [path.join(os.homedir(), ".Trash")];
  if (process.platform === "linux") {
    const dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
    return [path.join(dataHome, "Trash", "files")];
  }
  // The Recycle Bin keeps files under opaque names; the screen says where to look.
  return [];
}

/** Finder names a second `.ade` in the Trash ".ade 2", then ".ade 3", and so on. */
const TRASHED_ADE_NAMES = [".ade", ...Array.from({ length: 49 }, (_, index) => `.ade ${index + 2}`)];

/**
 * A trashed `.ade` belongs to this project when its database is the very file
 * this machine last opened for it (a move keeps the file's identity), or,
 * failing that, when the database's own project row names this project.
 */
function trashedDataBelongsTo(candidate: string, projectRoot: string, identity: DatabaseIdentity | null): boolean {
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
 * Keyed by the identity too, so a newly recorded database is looked up fresh.
 */
const LOOKUP_CACHE_MS = 5_000;
const lookupCache = new Map<string, { at: number; result: string | null }>();

function lookupKey(projectRoot: string, identity: DatabaseIdentity | null): string {
  return `${projectRoot}\0${identity ? `${identity.dev}:${identity.ino}` : ""}`;
}

/** The newest `.ade` in the Trash whose database belongs to this project. */
export function findTrashedProjectData(projectRoot: string, identity: DatabaseIdentity | null): string | null {
  const normalizedRoot = normalizeProjectRootPath(projectRoot);
  const key = lookupKey(normalizedRoot, identity);
  const cached = lookupCache.get(key);
  if (cached && Date.now() - cached.at < LOOKUP_CACHE_MS) return cached.result;
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  for (const dir of trashDirs()) {
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((name) => name.startsWith(".ade"));
    } catch {
      // macOS refuses to list the Trash without Full Disk Access, but still
      // opens a path it is given: try the names Finder gives a trashed .ade.
      names = TRASHED_ADE_NAMES;
    }
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (!trashedDataBelongsTo(candidate, normalizedRoot, identity)) continue;
      try {
        candidates.push({ path: candidate, mtimeMs: fs.statSync(candidate).mtimeMs });
      } catch {
        // Emptied while we looked.
      }
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const result = candidates[0]?.path ?? null;
  lookupCache.set(key, { at: Date.now(), result });
  return result;
}

/** Drops cached lookups for a project once its trashed data has moved. */
export function forgetTrashLookup(projectRoot: string): void {
  const prefix = `${normalizeProjectRootPath(projectRoot)}\0`;
  for (const key of lookupCache.keys()) if (key.startsWith(prefix)) lookupCache.delete(key);
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

/** Puts a trashed `.ade` back at `target`, whole or merged into what is there. */
export async function restoreTrashedProjectData(source: string, target: string): Promise<void> {
  if (fs.existsSync(target)) {
    await mergeEntries(source, target);
  } else {
    await moveEntry(source, target);
  }
}
