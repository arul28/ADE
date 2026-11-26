import type fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  XcodeDerivedDataArgs,
  XcodeDerivedDataDeleteArgs,
  XcodeDerivedDataDeleteResult,
  XcodeDerivedDataEntry,
  XcodeDerivedDataResult,
} from "../../../shared/types/iosSimulator";
import { AdeExpectedError } from "../../../shared/expectedError";
import { getErrorMessage } from "../shared/utils";
import type { Logger } from "../logging/logger";
import { measureTree } from "../storage/diskUsage";
import { DELETING_TRASH_NAME, deletingTrashName, removeTrashInBackground, sweepDeletingTrash } from "../shared/deletingTrash";
import { nonAsarFs } from "../shared/nonAsarFs";
import { pathsEqual } from "../shared/pathCompare";
import { removeTreeOffProcess } from "../shared/removeTreeOffProcess";

/**
 * Xcode's DerivedData: list its folders (one per project, plus the shared
 * module cache), measure them on request, and delete the ones the person picks.
 *
 * Machine-wide, on the machine that runs Xcode: the renderer reaches it
 * through the `ios_simulator` action domain with the lane's pin. Listing is a
 * read; deleting is person-only (`APPLE_USER_ONLY_ACTIONS`) and refuses while
 * Xcode or xcodebuild runs, since a build writes into these folders.
 *
 * Measuring walks every file (tens of GB on a busy Mac), so it runs only when
 * asked (`measure: true`), never on a timer, three folders at a time, and the
 * answer is kept for a minute.
 *
 * Only folders Xcode made are listed or deleted: a project folder carries an
 * `info.plist` naming its workspace, a cache folder ends in `.noindex`. A
 * custom DerivedData location can be any folder (Settings > Locations), so the
 * person's own folders that happen to sit there are never offered.
 */

type RunCommand = (
  command: string,
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string }>;

export type XcodeDerivedDataDeps = {
  run: RunCommand;
  logger: Pick<Logger, "info" | "warn">;
  homedir?: () => string;
  platform?: NodeJS.Platform;
  now?: () => Date;
};

export const XCODE_DERIVED_DATA_NOT_MAC_MESSAGE = "Xcode build data exists only on a Mac.";
export const XCODE_DERIVED_DATA_BUILD_RUNNING_MESSAGE = "Quit Xcode and wait for builds to finish, then try again.";

const MODULE_CACHE_FOLDER = "ModuleCache.noindex";
const MEASURE_FOLDERS_AT_ONCE = 3;
const MEASURE_CACHE_MS = 60_000;
/** Stays under the 15 minute action timeout; past it sizes are lower bounds. */
const MEASURE_BUDGET_MS = 10 * 60_000;
/**
 * How long a delete measures what it moved before it answers. The folders are
 * already gone by then; a person waits on this, so past it the answer is a
 * lower bound (the client already knows the sizes it showed in the confirm).
 */
const DELETE_MEASURE_BUDGET_MS = 20_000;
const MAX_DELETE_PATHS = 1_000;
const INFO_PLIST_MAX_BYTES = 256 * 1024;

/* ───────────────────────── parsing (pure) ───────────────────────── */

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

/** A DerivedData folder's `info.plist` as XML: its workspace and when Xcode last used it. */
export function parseDerivedDataInfoPlist(xml: string): { workspacePath: string | null; lastAccessedAt: string | null } {
  const workspace = /<key>\s*WorkspacePath\s*<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(xml)?.[1];
  const accessed = /<key>\s*LastAccessedDate\s*<\/key>\s*<date>([\s\S]*?)<\/date>/.exec(xml)?.[1]?.trim();
  const accessedMs = accessed ? Date.parse(accessed) : Number.NaN;
  const workspacePath = workspace ? decodeXmlText(workspace).trim() : "";
  return {
    workspacePath: workspacePath || null,
    lastAccessedAt: Number.isFinite(accessedMs) ? new Date(accessedMs).toISOString() : null,
  };
}

/** `ADE-abcdefghijklmnopqrstuvwxyzab` → `ADE`: Xcode appends a dash and a long lowercase hash. */
export function derivedDataDisplayName(folderName: string, workspacePath: string | null): string {
  if (folderName === MODULE_CACHE_FOLDER) return "Module cache";
  if (folderName.endsWith(".noindex")) return `${folderName.slice(0, -".noindex".length).replace(/Cache$/, "")} cache`.trim();
  if (workspacePath) {
    const base = path.posix.basename(workspacePath.replace(/\/+$/, ""));
    const ext = path.posix.extname(base);
    const name = ext && ext !== base ? base.slice(0, -ext.length) : base;
    if (name) return name;
  }
  return folderName.replace(/-[a-z]{16,}$/, "") || folderName;
}

/* ───────────────────────── the service ───────────────────────── */

type MeasuredCache = { at: number; result: XcodeDerivedDataResult };

// Machine-wide, so shared by every project's simulator service in this process.
const measuredCache = new Map<string, MeasuredCache>();
const measuresInFlight = new Map<string, Promise<XcodeDerivedDataResult>>();
/** Bumped by every delete: a walk started before it never fills the cache. */
const rootGenerations = new Map<string, number>();
/** Trash folders a delete in this process has moved and not measured yet. */
const trashBeingMeasured = new Set<string>();

async function lstatOrNull(target: string): Promise<fs.Stats | null> {
  try {
    return await nonAsarFs.promises.lstat(target);
  } catch {
    return null;
  }
}

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await nonAsarFs.promises.realpath(target);
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * The caches Xcode keeps beside the project folders, by their exact names.
 * Not every `*.noindex`: people add that suffix to their own folders to keep
 * Spotlight out, and a custom DerivedData location can hold those.
 */
const XCODE_CACHE_FOLDERS: ReadonlySet<string> = new Set([
  MODULE_CACHE_FOLDER,
  "SymbolCache.noindex",
  "SDKStatCaches.noindex",
  "CompilationCache.noindex",
]);

function isXcodeCacheFolder(name: string): boolean {
  return XCODE_CACHE_FOLDERS.has(name);
}

export function createXcodeDerivedData(deps: XcodeDerivedDataDeps) {
  const platform = deps.platform ?? process.platform;
  const homedir = deps.homedir ?? os.homedir;
  const now = deps.now ?? (() => new Date());

  const unsupported = (): XcodeDerivedDataResult => ({
    supported: false,
    root: null,
    exists: false,
    entries: [],
    totalBytes: null,
    buildRunning: false,
    measuredAt: null,
  });

  /** Xcode's custom location (Settings > Locations) when it is an absolute path, else the default. */
  const resolveRoot = async (): Promise<string> => {
    const custom = await deps.run("defaults", ["read", "com.apple.dt.Xcode", "IDECustomDerivedDataLocation"], { timeoutMs: 10_000 })
      .then(({ stdout }) => stdout.trim(), () => "");
    if (custom && path.posix.isAbsolute(custom)) return path.posix.normalize(custom).replace(/(.)\/+$/, "$1");
    return path.join(homedir(), "Library", "Developer", "Xcode", "DerivedData");
  };

  /** True or false from `pgrep`; null when it could not tell (a timeout, a spawn error). */
  const isRunning = (name: string): Promise<boolean | null> =>
    deps.run("pgrep", ["-x", name], { timeoutMs: 10_000 }).then(
      ({ stdout }) => stdout.trim().length > 0,
      // `pgrep` exits 1 when nothing matches: the one failure that means "not running".
      (error: unknown) => ((error as { code?: unknown } | null)?.code === 1 ? false : null),
    );

  /** A build that may be running counts as running: the delete waits rather than guess. */
  const buildRunning = async (): Promise<boolean | null> => {
    const [xcode, xcodebuild] = await Promise.all([isRunning("Xcode"), isRunning("xcodebuild")]);
    if (xcode || xcodebuild) return true;
    return xcode === false && xcodebuild === false ? false : null;
  };

  const readInfoPlist = async (folder: string): Promise<{ workspacePath: string | null; lastAccessedAt: string | null }> => {
    const file = path.join(folder, "info.plist");
    let head: Buffer;
    try {
      const handle = await nonAsarFs.promises.open(file, "r");
      try {
        const buffer = Buffer.alloc(INFO_PLIST_MAX_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        head = buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    } catch {
      return { workspacePath: null, lastAccessedAt: null };
    }
    let xml = head.toString("utf8");
    if (head.subarray(0, 6).toString("latin1") === "bplist") {
      // A binary plist: `plutil` prints it as XML (JSON cannot hold its <date>).
      xml = await deps.run("plutil", ["-convert", "xml1", "-o", "-", file], { timeoutMs: 10_000 })
        .then(({ stdout }) => stdout, () => "");
    }
    return parseDerivedDataInfoPlist(xml);
  };

  const workspaceGone = async (workspacePath: string | null): Promise<boolean> => {
    if (!workspacePath || !path.posix.isAbsolute(workspacePath)) return false;
    try {
      await nonAsarFs.promises.access(workspacePath);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
    }
  };

  const readEntries = async (root: string): Promise<{ exists: boolean; entries: XcodeDerivedDataEntry[] }> => {
    let dirents: fs.Dirent[];
    try {
      dirents = await nonAsarFs.promises.readdir(root, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") return { exists: false, entries: [] };
      // A folder that is there but unreadable is a failure to say, never an empty list.
      throw new AdeExpectedError(`ADE couldn't read Xcode's DerivedData folder: ${getErrorMessage(error)}`, "environment");
    }
    const folders = dirents.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !DELETING_TRASH_NAME.test(entry.name));
    const read = await mapLimit(folders, 8, async (dirent): Promise<XcodeDerivedDataEntry | null> => {
      const folder = path.join(root, dirent.name);
      const kind: XcodeDerivedDataEntry["kind"] = isXcodeCacheFolder(dirent.name) ? "module-cache" : "project";
      const info = kind === "project" ? await readInfoPlist(folder) : { workspacePath: null, lastAccessedAt: null };
      // Not Xcode's: no workspace in an info.plist, and not a cache folder.
      if (kind === "project" && !info.workspacePath) return null;
      const stat = info.lastAccessedAt ? null : await lstatOrNull(folder);
      return {
        path: folder,
        folderName: dirent.name,
        name: derivedDataDisplayName(dirent.name, info.workspacePath),
        workspacePath: info.workspacePath,
        workspaceMissing: await workspaceGone(info.workspacePath),
        sizeBytes: null,
        lastUsedAt: info.lastAccessedAt ?? (stat ? new Date(stat.mtimeMs).toISOString() : null),
        kind,
      };
    });
    const entries = read.filter((entry): entry is XcodeDerivedDataEntry => entry != null);
    entries.sort((a, b) => (b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0) - (a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0));
    return { exists: true, entries };
  };

  const removeInBackground = (trashPath: string) => {
    removeTrashInBackground(trashPath, {
      remove: removeTreeOffProcess,
      logger: deps.logger,
      events: { done: "apple.derived_data_trash_removed", failed: "apple.derived_data_trash_remove_failed" },
    });
  };

  /** Finishes an earlier delete this process did not get to: ADE's own trash names only. */
  const sweepTrash = (root: string) =>
    sweepDeletingTrash(root, { keep: async (trashPath) => trashBeingMeasured.has(path.resolve(trashPath)), removeInBackground }).catch(() => undefined);

  const measureEntries = async (root: string, entries: XcodeDerivedDataEntry[]): Promise<XcodeDerivedDataResult> => {
    const deadline = Date.now() + MEASURE_BUDGET_MS;
    const measured = await mapLimit(entries, MEASURE_FOLDERS_AT_ONCE, async (entry) => {
      try {
        const tree = await measureTree(entry.path, { deadline });
        // A walk the deadline cut off counted only part of the folder: unknown, not a smaller number.
        return { ...entry, sizeBytes: tree.truncated ? null : tree.bytes };
      } catch {
        return entry;
      }
    });
    const totalBytes = measured.every((entry) => entry.sizeBytes != null)
      ? measured.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0)
      : null;
    return {
      supported: true,
      root,
      exists: true,
      entries: measured,
      totalBytes,
      buildRunning: false,
      measuredAt: now().toISOString(),
    };
  };

  const list = async (args: XcodeDerivedDataArgs): Promise<XcodeDerivedDataResult> => {
    if (platform !== "darwin") return unsupported();
    const t0 = Date.now();
    const root = await resolveRoot();
    const measure = args?.measure === true;
    const [listing, runningAnswer] = await Promise.all([readEntries(root), buildRunning()]);
    // Unknown shows as busy: the page then waits instead of offering a delete the brain would refuse.
    const running = runningAnswer !== false;
    if (listing.exists) void sweepTrash(root);
    const cached = measuredCache.get(root);
    const fresh = cached && Date.now() - cached.at < MEASURE_CACHE_MS ? cached : null;
    let result: XcodeDerivedDataResult;
    if (!listing.exists) {
      result = { supported: true, root, exists: false, entries: [], totalBytes: null, buildRunning: running, measuredAt: null };
    } else if (fresh || !measure) {
      // A measurement from the last minute fills in the sizes of folders still there.
      const sizes = new Map(fresh?.result.entries.map((entry) => [entry.path, entry.sizeBytes]) ?? []);
      const entries = listing.entries.map((entry) => ({ ...entry, sizeBytes: sizes.get(entry.path) ?? null }));
      const allSized = fresh != null && entries.every((entry) => entry.sizeBytes != null);
      result = {
        supported: true,
        root,
        exists: true,
        entries,
        totalBytes: allSized ? entries.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0) : null,
        buildRunning: running,
        measuredAt: fresh ? fresh.result.measuredAt : null,
      };
    } else {
      let inFlight = measuresInFlight.get(root);
      if (!inFlight) {
        const generation = rootGenerations.get(root) ?? 0;
        const walk: Promise<XcodeDerivedDataResult> = measureEntries(root, listing.entries).finally(() => {
          if (measuresInFlight.get(root) === walk) measuresInFlight.delete(root);
        });
        inFlight = walk;
        measuresInFlight.set(root, walk);
        void walk.then((value) => {
          // A delete since this walk began: its sizes name folders that are gone.
          if ((rootGenerations.get(root) ?? 0) === generation) measuredCache.set(root, { at: Date.now(), result: value });
        }, () => undefined);
      }
      result = { ...(await inFlight), buildRunning: running };
    }
    deps.logger.info("apple.derived_data_listed", {
      count: result.entries.length,
      measured: result.measuredAt != null,
      totalBytes: result.totalBytes,
      durationMs: Date.now() - t0,
    });
    return result;
  };

  const remove = async (args: XcodeDerivedDataDeleteArgs): Promise<XcodeDerivedDataDeleteResult> => {
    if (args?.confirmedByUser !== true) {
      throw new AdeExpectedError("Deleting Xcode build data needs the person's confirmation (confirmedByUser: true).", "user");
    }
    if (platform !== "darwin") throw new AdeExpectedError(XCODE_DERIVED_DATA_NOT_MAC_MESSAGE, "environment");
    const requested = Array.isArray(args.paths) ? args.paths : [];
    if (requested.length === 0) throw new AdeExpectedError("Choose at least one DerivedData folder to delete.", "user");
    if (requested.length > MAX_DELETE_PATHS) {
      throw new AdeExpectedError(`At most ${MAX_DELETE_PATHS} folders can be deleted at once.`, "user");
    }
    const running = await buildRunning();
    if (running === true) throw new AdeExpectedError(XCODE_DERIVED_DATA_BUILD_RUNNING_MESSAGE, "user");
    if (running === null) throw new AdeExpectedError("ADE couldn't check whether Xcode is building, so nothing was deleted. Try again.", "environment");

    const root = await resolveRoot();
    const realRoot = await realpathOrNull(root);
    if (!realRoot) throw new AdeExpectedError("Xcode's DerivedData folder does not exist.", "user");

    const result: XcodeDerivedDataDeleteResult = { deleted: [], errors: [], freedBytes: 0 };
    const seen = new Set<string>();
    // Phase one moves each folder into ADE's trash: a rename, so fast, and a
    // build that starts now no longer finds its folder. Phase two measures.
    const moved: Array<{ reported: string; trashPath: string }> = [];
    for (const raw of requested) {
      const reported = typeof raw === "string" ? raw : String(raw);
      const fail = (message: string) => result.errors.push({ path: reported, message });
      if (typeof raw !== "string" || !raw.trim() || !path.isAbsolute(raw)) {
        fail("Not an absolute path.");
        continue;
      }
      const target = path.resolve(raw);
      const name = path.basename(target);
      if (seen.has(target)) continue;
      seen.add(target);
      if (!name || name.startsWith(".") || pathsEqual(target, root, platform) || pathsEqual(target, realRoot, platform)) {
        fail("Not a DerivedData folder.");
        continue;
      }
      const stat = await lstatOrNull(target);
      if (!stat) {
        fail("Already gone.");
        continue;
      }
      if (stat.isSymbolicLink()) {
        fail("A link, not a folder; ADE never deletes through links.");
        continue;
      }
      if (!stat.isDirectory()) {
        fail("Not a folder.");
        continue;
      }
      const realTarget = await realpathOrNull(target);
      if (!realTarget || !pathsEqual(path.dirname(realTarget), realRoot, platform) || pathsEqual(realTarget, realRoot, platform)) {
        fail("Not directly inside Xcode's DerivedData folder.");
        continue;
      }
      // The same rule as the list: only a folder Xcode made, never one of the person's that sits here.
      if (!isXcodeCacheFolder(path.basename(realTarget)) && !(await readInfoPlist(realTarget)).workspacePath) {
        fail("Not a folder Xcode made, so ADE leaves it alone.");
        continue;
      }
      const trashPath = path.join(realRoot, deletingTrashName(path.basename(realTarget)));
      try {
        await nonAsarFs.promises.rename(realTarget, trashPath);
      } catch (error) {
        fail(`Could not delete: ${getErrorMessage(error)}`);
        continue;
      }
      trashBeingMeasured.add(path.resolve(trashPath));
      moved.push({ reported, trashPath });
    }
    measuredCache.delete(root);
    measuresInFlight.delete(root);
    rootGenerations.set(root, (rootGenerations.get(root) ?? 0) + 1);
    // One short deadline for the whole call: the folders are gone already, so a big "Delete unused" answers in seconds.
    const deadline = Date.now() + DELETE_MEASURE_BUDGET_MS;
    await mapLimit(moved, MEASURE_FOLDERS_AT_ONCE, async ({ reported, trashPath }) => {
      let bytes: number | null = null;
      try {
        const tree = await measureTree(trashPath, { deadline });
        bytes = tree.bytes;
        // A walk cut off by the deadline counted only part of the folder.
        if (tree.truncated) result.freedIsLowerBound = true;
      } catch {
        result.freedIsLowerBound = true;
      } finally {
        trashBeingMeasured.delete(path.resolve(trashPath));
      }
      removeInBackground(trashPath);
      result.deleted.push({ path: reported, bytes });
      result.freedBytes += bytes ?? 0;
    });
    deps.logger.info("apple.derived_data_deleted", {
      count: result.deleted.length,
      errors: result.errors.length,
      freedBytes: result.freedBytes,
    });
    return result;
  };

  return { list, remove };
}

export type XcodeDerivedData = ReturnType<typeof createXcodeDerivedData>;
