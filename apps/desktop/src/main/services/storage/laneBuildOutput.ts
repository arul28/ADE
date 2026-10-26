import type fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  LaneBuildOutputLaneEntry,
  LaneBuildOutputSummary,
  MaintenanceStepResult,
  StorageItem,
} from "../../../shared/types/storage";
import { runGit } from "../git/git";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import { nonAsarFs } from "../shared/nonAsarFs";
import { createLaneWorktreeLockService, LaneWorktreeLockedError } from "../lanes/laneWorktreeLockService";
import { measureTree } from "./diskUsage";

/**
 * Clean build output out of idle lanes.
 *
 * A lane worktree nobody has touched for a while still holds its
 * `node_modules`, `dist`, `.next`, Cargo `target`... often gigabytes each.
 * Once a day the storage doctor removes those folders from lanes idle longer
 * than `laneCleanup.cleanBuildOutputAfterDays` (7 by default, 0 = off). The
 * lane, its branch, its files and its chats stay; a reinstall or build brings
 * the folders back.
 *
 * A folder is removed only when every one of these holds, checked when the
 * lanes are scanned and again, holding the lane's worktree lease, right
 * before it goes:
 *
 * - The lane is an ADE-managed worktree lane: its folder is a direct child of
 *   the project's `.ade/worktrees`, not the primary checkout and not an
 *   attached folder, and git confirms that folder is its own checkout.
 * - Nothing runs in it: no open chat, live terminal (dev servers run in one),
 *   file watcher, worktree lease held by another operation, and no process
 *   on this computer has its working directory inside it.
 * - It is idle: no chat, terminal, operation, commit, checkout or uncommitted
 *   file change inside the window, and the folder itself and everything
 *   directly in it were not written in the window.
 * - The folder's name is on the list below (or it carries a valid
 *   `CACHEDIR.TAG`), it is at most `BUILD_OUTPUT_MAX_DEPTH` levels down, git
 *   ignores it (`git check-ignore`) and tracks nothing in it (`git ls-files`).
 * - No link anywhere on its path, the folder itself included: an older lane
 *   whose `node_modules` links into the main checkout is skipped, never
 *   deleted through and never unlinked.
 */

type BuildOutputFolderRule = {
  name: string;
  /** Only when one of these files sits beside the folder (a generic name). */
  requiresSibling?: readonly string[];
};

/**
 * Folders that build tools and package managers recreate. All of them must
 * also be ignored by git and hold no tracked file, which is what makes the
 * generic `dist` and `build` safe here. Left out on purpose: `out` and
 * `.cache` (too often hold hand-made data), `vendor` and `Pods` (often
 * committed or edited by hand), and virtualenvs (`.venv`: packages may have
 * been installed by hand with no lock file to rebuild them from).
 */
export const BUILD_OUTPUT_FOLDER_RULES: readonly BuildOutputFolderRule[] = [
  { name: "node_modules" },
  { name: "dist" },
  { name: "build" },
  { name: ".next" },
  { name: ".nuxt" },
  { name: ".svelte-kit" },
  { name: ".turbo" },
  { name: ".parcel-cache" },
  { name: ".angular" },
  { name: ".dart_tool" },
  { name: ".gradle" },
  { name: "DerivedData" },
  // Cargo and Maven both build into `target`; other tools use the name too.
  { name: "target", requiresSibling: ["Cargo.toml", "pom.xml"] },
];

/**
 * How deep a folder may sit, counted in path segments: `node_modules` is 1,
 * `apps/web/node_modules` is 3, `packages/@scope/pkg/node_modules` is 4. That
 * covers a monorepo's workspace packages, scoped ones included. Anything
 * deeper is rare, small, or inside another build folder, and a bound keeps the
 * scan cheap on very large trees.
 */
export const BUILD_OUTPUT_MAX_DEPTH = 4;

const CACHEDIR_TAG_SIGNATURE = "Signature: 8a477f597d28d172789f06886806bc55";
/** Ignored folders checked for a CACHEDIR.TAG per lane. */
const MAX_CACHEDIR_CHECKS = 100;
/** Build folders handled per lane per run. */
const MAX_FOLDERS_PER_LANE = 64;
/** Entries looked at under one build folder to decide whether it was written recently. */
const MAX_FIRST_LEVEL_ENTRIES = 5_000;
/** Uncommitted paths whose times are checked per lane. */
const MAX_DIRTY_PATHS = 200;
/** A run stops starting new work after this long; the next run carries on. */
const SWEEP_BUDGET_MS = 15 * 60_000;
/** Measuring one folder before it goes stops after this many entries or this long. */
const MEASURE_ENTRY_LIMIT = 500_000;
const MEASURE_BUDGET_MS = 3 * 60_000;
/** Automatic runs at most this often, across restarts. A manual run always goes. */
const MIN_RUN_INTERVAL_MS = 20 * 60 * 60_000;
const LEASE_MS = 30 * 60_000;
const GIT_TIMEOUT_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** A lane's "build output removed" note shows this long, while folders are still missing. */
const NOTE_MAX_AGE_MS = 30 * DAY_MS;
/** Cleanup records kept. */
const RECORD_MAX_AGE_MS = 90 * DAY_MS;
const RECORD_MAX_ROWS = 1_000;

type LaneRowLike = {
  id: string;
  name: string;
  worktree_path: string;
  archived_at: string | null;
  created_at: string;
  lane_type: string;
  is_edit_protected: number;
};

type LaneBuildOutputRemoved = NonNullable<StorageItem["buildOutputRemoved"]>;

type LiveWorkCounts = { activeChatCount: number; activePtyCount: number; activeWatcherCount: number };

export type LaneBuildOutputSweeperOptions = {
  db: AdeDb;
  logger: Logger;
  projectId: string | null | undefined;
  projectRoot: string;
  worktreesDir: string;
  /** Effective `cleanBuildOutputAfterDays`; 0 = off. */
  idleDays: () => number;
  listLanes: () => LaneRowLike[];
  /** Null when this process cannot see the lane's chats and terminals: nothing is removed. */
  liveWorkCounts: ((laneId: string) => LiveWorkCounts | null) | null;
  latestLaneActivityMs: (laneId: string, createdAt: string) => number;
};

type Candidate = {
  rel: string;
  abs: string;
  dev: number;
  ino: number;
};

type VerifiedWorktree = {
  root: string;
  realRoot: string;
  gitDir: string;
  dev: number;
};

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function lstatOrNull(targetPath: string): Promise<fs.Stats | null> {
  try {
    return await nonAsarFs.promises.lstat(targetPath);
  } catch {
    return null;
  }
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  // Case-insensitive volumes are the default on macOS and Windows; matching
  // more paths here only ever keeps more lanes.
  return process.platform === "darwin" || process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isSameOrWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(comparablePath(parent), comparablePath(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isDirectChild(parent: string, candidate: string): boolean {
  const normalizedParent = path.resolve(parent);
  const normalizedCandidate = path.resolve(candidate);
  return normalizedCandidate !== normalizedParent
    && path.dirname(normalizedCandidate) === normalizedParent
    && path.basename(normalizedCandidate).trim().length > 0;
}

/** True when `target`, or any folder between `anchor` and it, is a link (or is missing). */
async function hasLinkOnPath(anchor: string, target: string): Promise<boolean> {
  const root = path.resolve(anchor);
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return true;
  let current = root;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    const stat = await lstatOrNull(current);
    if (!stat || stat.isSymbolicLink()) return true;
  }
  return false;
}

function gitRelToAbs(root: string, rel: string): string {
  return path.join(root, ...rel.split("/"));
}

function nulList(text: string): string[] {
  return text.split("\0").filter((entry) => entry.length > 0);
}

/** A plain reason a folder could not be removed. */
export function describeRemovalError(error: unknown): string {
  switch (errorCode(error)) {
    case "EBUSY":
      return "A program is using files in it.";
    case "EPERM":
    case "EACCES":
      return "ADE isn't allowed to remove some files in it.";
    case "ENOTEMPTY":
      return "Files kept appearing while it was removed. A program may be writing to it.";
    case "ENAMETOOLONG":
      return "A path inside it is too long to remove.";
    case "EROFS":
      return "It is on a read-only drive.";
    default:
      return errorMessage(error);
  }
}

async function hasCacheDirTag(folder: string): Promise<boolean> {
  const tag = path.join(folder, "CACHEDIR.TAG");
  const stat = await lstatOrNull(tag);
  if (!stat?.isFile()) return false;
  try {
    const handle = await nonAsarFs.promises.open(tag, "r");
    try {
      const buffer = Buffer.alloc(CACHEDIR_TAG_SIGNATURE.length);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString("utf8") === CACHEDIR_TAG_SIGNATURE;
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

/** The newest write to a folder or anything directly in it (mtime or ctime). */
async function lastWriteMs(folder: string, stat: fs.Stats): Promise<number> {
  let latest = Math.max(stat.mtimeMs, stat.ctimeMs);
  let names: string[];
  try {
    names = await nonAsarFs.promises.readdir(folder);
  } catch {
    // Cannot see inside: treat it as written now, so it is kept.
    return Date.now();
  }
  // Too many entries to check one by one: keep it rather than guess.
  if (names.length > MAX_FIRST_LEVEL_ENTRIES) return Date.now();
  for (let index = 0; index < names.length; index += 32) {
    const stats = await Promise.all(names.slice(index, index + 32).map((name) => lstatOrNull(path.join(folder, name))));
    for (const child of stats) {
      if (child) latest = Math.max(latest, child.mtimeMs, child.ctimeMs);
    }
  }
  return latest;
}

/**
 * Where processes on this computer are working. A lane folder that holds one
 * is in use, whoever started it. Null when the check failed (nothing is
 * removed then). Windows has no cheap way to ask; there a program holding a
 * file makes the removal fail on that file instead, and the reason is kept.
 */
async function listProcessWorkingDirs(): Promise<{ dirs: string[]; supported: boolean } | null> {
  if (process.platform === "win32") return { dirs: [], supported: false };
  if (process.platform === "linux") {
    try {
      const pids = (await nonAsarFs.promises.readdir("/proc")).filter((name) => /^\d+$/.test(name));
      const dirs: string[] = [];
      for (let index = 0; index < pids.length; index += 64) {
        const batch = await Promise.all(pids.slice(index, index + 64).map((pid) =>
          nonAsarFs.promises.readlink(path.join("/proc", pid, "cwd")).catch(() => null)));
        for (const dir of batch) if (dir) dirs.push(dir);
      }
      return { dirs, supported: true };
    } catch {
      return null;
    }
  }
  return await new Promise((resolve) => {
    execFile(
      "lsof",
      ["-a", "-d", "cwd", "-F", "n", "-w"],
      { timeout: 15_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (error, stdout) => {
        // lsof exits 1 when some process could not be read; its output still counts.
        if (error && !stdout) {
          resolve(null);
          return;
        }
        const dirs = String(stdout ?? "")
          .split(/\r?\n/)
          .filter((line) => line.startsWith("n/"))
          .map((line) => line.slice(1));
        resolve({ dirs, supported: true });
      },
    );
  });
}

/**
 * Every mount point on this computer, so a folder with a disk mounted
 * somewhere inside it is kept: removing it would reach into that disk. Linux
 * also lists same-drive bind mounts, which the drive check cannot see. Null
 * when the list could not be read (nothing is removed then). Windows mounts a
 * volume into a folder as a reparse point, which Node treats as a link, and
 * links are removed as links, never followed.
 */
async function listMountPoints(): Promise<string[] | null> {
  if (process.platform === "win32") return [];
  if (process.platform === "linux") {
    try {
      const text = await nonAsarFs.promises.readFile("/proc/self/mountinfo", "utf8");
      return text.split("\n").map((line) => line.split(" ")[4]).filter((field): field is string => Boolean(field))
        .map((field) => field.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8))));
    } catch {
      return null;
    }
  }
  return await new Promise((resolve) => {
    execFile("/sbin/mount", [], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const points: string[] = [];
      for (const line of String(stdout).split("\n")) {
        const match = / on (\/.*) \([^()]*\)$/.exec(line);
        if (match?.[1]) points.push(match[1]);
      }
      resolve(points);
    });
  });
}

function processInside(probe: { dirs: string[] }, roots: string[]): boolean {
  return probe.dirs.some((dir) => roots.some((root) => isSameOrWithin(root, dir)));
}

async function makeTreeWritable(folder: string, deadline: number): Promise<void> {
  const pending = [folder];
  let visited = 0;
  while (pending.length > 0 && visited < MEASURE_ENTRY_LIMIT && Date.now() < deadline) {
    const current = pending.pop()!;
    visited += 1;
    const stat = await lstatOrNull(current);
    if (!stat || stat.isSymbolicLink()) continue;
    try {
      await nonAsarFs.promises.chmod(current, stat.mode | (stat.isDirectory() ? 0o700 : 0o600));
    } catch {
      // The removal reports what is still in the way.
    }
    if (!stat.isDirectory()) continue;
    try {
      for (const name of await nonAsarFs.promises.readdir(current)) pending.push(path.join(current, name));
    } catch {
      // Same.
    }
  }
}

/** Passes over a folder before its removal is reported as failed. */
const REMOVE_ATTEMPTS = 3;
const REMOVE_RETRY_DELAY_MS = 1_000;
const RETRYABLE_REMOVE_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY", "EMFILE", "ENFILE"]);

/**
 * Removes one build folder. Never follows links: a link inside is removed as
 * a link. Busy and permission errors (Windows virus scanners and indexers
 * hold files briefly; a read-only folder blocks its entries) get a few whole
 * passes, a second apart, with read-only entries made writable in between.
 * Node's own `maxRetries` is not used: it retries at every level of the tree,
 * so one file that stays locked deep in `node_modules` multiplies into
 * minutes of retries.
 */
async function removeFolder(folder: string, deadline: number): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await nonAsarFs.promises.rm(folder, { recursive: true, force: false, maxRetries: 0 });
      return;
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") return;
      if (!code || !RETRYABLE_REMOVE_CODES.has(code) || attempt >= REMOVE_ATTEMPTS || Date.now() >= deadline) throw error;
      if (code === "EACCES" || code === "EPERM") await makeTreeWritable(folder, deadline);
      await new Promise((resolve) => setTimeout(resolve, REMOVE_RETRY_DELAY_MS));
    }
  }
}

export function createLaneBuildOutputSweeper(options: LaneBuildOutputSweeperOptions) {
  const projectRoot = path.resolve(options.projectRoot);
  const worktreesDir = path.resolve(options.worktreesDir);
  const locks = createLaneWorktreeLockService({ db: options.db, logger: options.logger });
  let flight: Promise<MaintenanceStepResult> | null = null;

  const projectIdOrNull = (): string | null => options.projectId?.trim() || null;

  const readCheckedAt = (projectId: string): number | null => {
    const row = options.db.get<{ build_output_checked_at: string | null }>(
      "select build_output_checked_at from local_storage_lifecycle_runs where project_id = ?",
      [projectId],
    );
    const parsed = row?.build_output_checked_at ? Date.parse(row.build_output_checked_at) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : null;
  };

  const markChecked = (projectId: string): void => {
    const now = new Date().toISOString();
    options.db.run(
      `insert into local_storage_lifecycle_runs(project_id, build_output_checked_at, updated_at)
       values(?, ?, ?)
       on conflict(project_id) do update set
         build_output_checked_at = excluded.build_output_checked_at,
         updated_at = excluded.updated_at`,
      [projectId, now, now],
    );
  };

  const record = (row: {
    projectId: string;
    laneId: string;
    runId: string;
    folder: string;
    bytes: number;
    partial: boolean;
    error: string | null;
  }): void => {
    options.db.run(
      `insert into local_lane_build_output_cleanups(id, project_id, lane_id, run_id, folder, bytes, partial, error, removed_at)
       values(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        row.projectId,
        row.laneId,
        row.runId,
        row.folder,
        Math.max(0, Math.floor(row.bytes)),
        row.partial ? 1 : 0,
        row.error,
        new Date().toISOString(),
      ],
    );
  };

  const pruneRecords = (projectId: string): void => {
    const cutoff = new Date(Date.now() - RECORD_MAX_AGE_MS).toISOString();
    options.db.run(
      "delete from local_lane_build_output_cleanups where project_id = ? and removed_at < ?",
      [projectId, cutoff],
    );
    options.db.run(
      `delete from local_lane_build_output_cleanups
        where project_id = ?
          and id not in (
            select id from local_lane_build_output_cleanups
             where project_id = ?
             order by removed_at desc
             limit ?
          )`,
      [projectId, projectId, RECORD_MAX_ROWS],
    );
  };

  const busyReason = (laneId: string): string | null => {
    const counts = options.liveWorkCounts?.(laneId) ?? null;
    if (!counts) return "ADE can't see this lane's chats and terminals yet";
    if (counts.activeChatCount + counts.activePtyCount + counts.activeWatcherCount > 0) return "something is running in it";
    return null;
  };

  /** The lane's folder, proven to be its own git checkout under `.ade/worktrees`. */
  const verifyWorktree = async (worktreePath: string): Promise<VerifiedWorktree | null> => {
    const root = path.resolve(worktreePath);
    if (!isDirectChild(worktreesDir, root)) return null;
    if (comparablePath(root) === comparablePath(projectRoot)) return null;
    if (await hasLinkOnPath(projectRoot, root)) return null;
    const rootStat = await lstatOrNull(root);
    if (!rootStat?.isDirectory()) return null;
    // A linked worktree has a `.git` pointer file. Without it git would answer
    // for the main checkout, where `.ade/` itself is ignored.
    const pointer = await lstatOrNull(path.join(root, ".git"));
    if (!pointer?.isFile()) return null;
    const rev = await runGit(["rev-parse", "--show-toplevel", "--absolute-git-dir"], { cwd: root, timeoutMs: 15_000 });
    if (rev.exitCode !== 0) return null;
    const [top, gitDir] = rev.stdout.split(/\r?\n/).map((line) => line.trim());
    if (!top || !gitDir) return null;
    let topStat: fs.Stats;
    let realRoot: string;
    try {
      topStat = await nonAsarFs.promises.stat(top);
      realRoot = await nonAsarFs.promises.realpath(root);
    } catch {
      return null;
    }
    const sameFolder = topStat.ino && rootStat.ino
      ? topStat.dev === rootStat.dev && topStat.ino === rootStat.ino
      : comparablePath(top) === comparablePath(realRoot);
    if (!sameFolder) return null;
    return { root, realRoot, gitDir, dev: rootStat.dev };
  };

  /** The newest commit, checkout or uncommitted change in the lane, or null when git could not say. */
  const fileActivityMs = async (worktree: VerifiedWorktree): Promise<number | null> => {
    let latest = 0;
    for (const file of [path.join(worktree.gitDir, "HEAD"), path.join(worktree.gitDir, "logs", "HEAD")]) {
      const stat = await lstatOrNull(file);
      if (stat) latest = Math.max(latest, stat.mtimeMs);
    }
    const status = await runGit(
      ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--no-renames", "--ignore-submodules=all"],
      { cwd: worktree.root, timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: 4 * 1024 * 1024 },
    );
    if (status.exitCode !== 0) return null;
    const changed = nulList(status.stdout).map((entry) => entry.slice(3).replace(/\/$/, "")).filter(Boolean);
    for (let index = 0; index < Math.min(changed.length, MAX_DIRTY_PATHS); index += 32) {
      const stats = await Promise.all(changed.slice(index, Math.min(index + 32, MAX_DIRTY_PATHS)).map((rel) =>
        lstatOrNull(gitRelToAbs(worktree.root, rel))));
      for (const stat of stats) {
        if (stat) latest = Math.max(latest, stat.mtimeMs, stat.ctimeMs);
      }
    }
    // More changes than checked: a lane with that much going on is not idle.
    if (changed.length > MAX_DIRTY_PATHS) return Date.now();
    return latest;
  };

  /** Checks one folder on disk; null (with a reason) when it must stay. */
  const inspectFolder = async (
    worktree: VerifiedWorktree,
    rel: string,
    idleSince: number,
    expected?: Candidate,
  ): Promise<{ candidate: Candidate } | { reason: string }> => {
    const abs = gitRelToAbs(worktree.root, rel);
    if (await hasLinkOnPath(worktree.root, abs)) return { reason: "a link is on its path" };
    const stat = await lstatOrNull(abs);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return { reason: "not a folder" };
    if (stat.dev !== worktree.dev) return { reason: "on another drive" };
    if (expected && (stat.dev !== expected.dev || stat.ino !== expected.ino)) return { reason: "replaced since the scan" };
    if (await lastWriteMs(abs, stat) >= idleSince) return { reason: "written recently" };
    return { candidate: { rel, abs, dev: stat.dev, ino: stat.ino } };
  };

  /** Git ignores every one of them and tracks nothing in them. Fails closed. */
  const gitConfirm = async (worktree: VerifiedWorktree, candidates: Candidate[]): Promise<Candidate[]> => {
    if (candidates.length === 0) return [];
    const rels = candidates.map((candidate) => candidate.rel);
    const tracked = await runGit(
      ["--literal-pathspecs", "ls-files", "-z", "--", ...rels],
      { cwd: worktree.root, timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: 4 * 1024 * 1024 },
    );
    if (tracked.exitCode !== 0 || tracked.stdoutTruncated) return [];
    const trackedPaths = nulList(tracked.stdout);
    const ignored = await runGit(
      ["check-ignore", "-z", "--stdin"],
      { cwd: worktree.root, timeoutMs: GIT_TIMEOUT_MS, stdin: `${rels.join("\0")}\0` },
    );
    // 0: some are ignored; 1: none are. Anything else is an error.
    if (ignored.exitCode !== 0 && ignored.exitCode !== 1) return [];
    const ignoredSet = new Set(nulList(ignored.stdout));
    return candidates.filter((candidate) =>
      ignoredSet.has(candidate.rel)
      && !trackedPaths.some((file) => file === candidate.rel || file.startsWith(`${candidate.rel}/`)));
  };

  const findCandidates = async (worktree: VerifiedWorktree, idleSince: number): Promise<Candidate[]> => {
    // Ignored folders, each listed once without descending into it.
    const listing = await runGit(
      ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
      { cwd: worktree.root, timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: 16 * 1024 * 1024 },
    );
    if (listing.exitCode !== 0) return [];
    const entries = nulList(listing.stdout);
    // A cut-off listing ends in a cut-off name.
    if (listing.stdoutTruncated) entries.pop();
    const picks: Array<{ rel: string; siblings?: readonly string[] }> = [];
    let tagChecks = 0;
    for (const entry of entries) {
      if (!entry.endsWith("/")) continue;
      const rel = entry.slice(0, -1);
      const segments = rel.split("/");
      if (segments.length === 0 || segments.length > BUILD_OUTPUT_MAX_DEPTH) continue;
      if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment === ".git" || segment === ".ade")) continue;
      const rule = BUILD_OUTPUT_FOLDER_RULES.find((candidate) => candidate.name === segments[segments.length - 1]);
      if (rule) {
        picks.push({ rel, ...(rule.requiresSibling ? { siblings: rule.requiresSibling } : {}) });
      } else if (tagChecks < MAX_CACHEDIR_CHECKS) {
        tagChecks += 1;
        if (await hasCacheDirTag(gitRelToAbs(worktree.root, rel))) picks.push({ rel });
      }
    }
    // An outer build folder covers anything inside it.
    picks.sort((left, right) => left.rel.length - right.rel.length);
    const kept: typeof picks = [];
    for (const pick of picks) {
      if (kept.some((outer) => pick.rel.startsWith(`${outer.rel}/`))) continue;
      kept.push(pick);
      if (kept.length >= MAX_FOLDERS_PER_LANE) break;
    }
    const candidates: Candidate[] = [];
    for (const pick of kept) {
      if (pick.siblings) {
        const parent = path.dirname(gitRelToAbs(worktree.root, pick.rel));
        const stats = await Promise.all(pick.siblings.map((name) => lstatOrNull(path.join(parent, name))));
        if (!stats.some((stat) => stat?.isFile())) continue;
      }
      const inspected = await inspectFolder(worktree, pick.rel, idleSince);
      if ("candidate" in inspected) candidates.push(inspected.candidate);
    }
    return await gitConfirm(worktree, candidates);
  };

  const sweepLane = async (args: {
    lane: LaneRowLike;
    projectId: string;
    runId: string;
    idleSince: number;
    deadline: number;
    probe: { dirs: string[]; supported: boolean };
  }): Promise<{ removed: number; freed: number; failed: number }> => {
    const { lane, projectId, runId, idleSince, deadline } = args;
    const outcome = { removed: 0, freed: 0, failed: 0 };
    const skip = (reason: string) => {
      options.logger.debug("storage.build_output_lane_skipped", { laneId: lane.id, reason });
      return outcome;
    };
    const busy = busyReason(lane.id);
    if (busy) return skip(busy);
    const activity = Math.max(
      options.latestLaneActivityMs(lane.id, lane.created_at),
      lane.archived_at ? Date.parse(lane.archived_at) || 0 : 0,
    );
    if (activity >= idleSince) return skip("used recently");
    const worktree = await verifyWorktree(lane.worktree_path);
    if (!worktree) return skip("not an ADE-managed lane folder");
    if (processInside(args.probe, [worktree.root, worktree.realRoot])) return skip("a program is working in it");
    const files = await fileActivityMs(worktree);
    if (files == null) return skip("git could not read it");
    if (files >= idleSince) return skip("edited recently");
    const found = await findCandidates(worktree, idleSince);
    if (found.length === 0) return outcome;

    let lease: { token: string };
    try {
      // A token of our own: without it this lease would match, and take over,
      // one an Archive & Reclaim of the same lane already holds.
      const token = randomUUID();
      lease = locks.acquire({
        laneId: lane.id,
        worktreePath: worktree.root,
        ownerKind: "storage_lifecycle",
        ownerLabel: "Build output cleanup",
        ownerSessionId: token,
        token,
        leaseMs: LEASE_MS,
      });
    } catch (error) {
      if (error instanceof LaneWorktreeLockedError) return skip("another operation holds the lane");
      throw error;
    }
    try {
      // Again, now that nothing else can take the lane: a chat or a program
      // may have started while the other lanes were scanned.
      const fresh = await listProcessWorkingDirs();
      if (!fresh) return skip("couldn't check for running programs");
      if (processInside(fresh, [worktree.root, worktree.realRoot])) return skip("a program is working in it");
      const confirmed = await gitConfirm(worktree, found);
      for (const candidate of confirmed) {
        if (Date.now() >= deadline) break;
        const stillBusy = busyReason(lane.id);
        if (stillBusy) return skip(stillBusy);
        const check = await inspectFolder(worktree, candidate.rel, idleSince, candidate);
        if (!("candidate" in check)) continue;
        const measureDeadline = Math.min(deadline, Date.now() + MEASURE_BUDGET_MS);
        const before = await measureTree(candidate.abs, { entryLimit: MEASURE_ENTRY_LIMIT, deadline: measureDeadline });
        // Measuring can take minutes: look again right before removing. A
        // chat, terminal or program may have started, or a disk been mounted.
        const [processesNow, mounts] = await Promise.all([listProcessWorkingDirs(), listMountPoints()]);
        if (!processesNow || !mounts) return skip("couldn't check for running programs or mounted disks");
        if (processInside(processesNow, [worktree.root, worktree.realRoot])) return skip("a program is working in it");
        const realAbs = gitRelToAbs(worktree.realRoot, candidate.rel);
        if (mounts.some((mount) => isSameOrWithin(candidate.abs, mount) || isSameOrWithin(realAbs, mount))) continue;
        // The path may have changed while it was measured: no link on it,
        // and still the folder that was scanned.
        const recheck = await inspectFolder(worktree, candidate.rel, idleSince, candidate);
        if (!("candidate" in recheck)) continue;
        // Last, with nothing awaited between it and the removal.
        const busyNow = busyReason(lane.id);
        if (busyNow) return skip(busyNow);
        try {
          await removeFolder(candidate.abs, Math.max(deadline, Date.now() + MEASURE_BUDGET_MS));
          record({ projectId, laneId: lane.id, runId, folder: candidate.rel, bytes: before.bytes, partial: before.truncated, error: null });
          options.logger.info("storage.build_output_removed", {
            laneId: lane.id,
            folder: candidate.rel,
            bytes: before.bytes,
            partial: before.truncated,
          });
          outcome.removed += 1;
          outcome.freed += before.bytes;
        } catch (error) {
          // Part of it may be gone: count what was freed, and keep the reason.
          const after = await measureTree(candidate.abs, { entryLimit: MEASURE_ENTRY_LIMIT, deadline: Date.now() + MEASURE_BUDGET_MS });
          const freed = Math.max(0, before.bytes - after.bytes);
          const reason = describeRemovalError(error);
          record({ projectId, laneId: lane.id, runId, folder: candidate.rel, bytes: freed, partial: before.truncated || after.truncated, error: reason });
          options.logger.warn("storage.build_output_remove_failed", {
            laneId: lane.id,
            folder: candidate.rel,
            code: errorCode(error) ?? null,
            error: errorMessage(error),
            freedBytes: freed,
          });
          outcome.failed += 1;
          outcome.freed += freed;
        }
        await yieldToEventLoop();
      }
    } finally {
      try {
        locks.release({ token: lease.token });
      } catch (error) {
        options.logger.warn("storage.build_output_lease_release_failed", { laneId: lane.id, error: errorMessage(error) });
      }
    }
    return outcome;
  };

  const run = async (opts: { force: boolean }): Promise<MaintenanceStepResult> => {
    const projectId = projectIdOrNull();
    if (!projectId || !options.liveWorkCounts) return { itemsAffected: 0, bytesReclaimed: 0, skippedReason: "unsupported" };
    const idleDays = Math.max(0, Math.floor(options.idleDays()));
    if (idleDays <= 0) return { itemsAffected: 0, bytesReclaimed: 0, skippedReason: "disabled" };
    const lastChecked = readCheckedAt(projectId);
    if (!opts.force && lastChecked != null && Date.now() - lastChecked < MIN_RUN_INTERVAL_MS) {
      return { itemsAffected: 0, bytesReclaimed: 0, skippedReason: "not_due" };
    }
    const startedAt = Date.now();
    const deadline = startedAt + SWEEP_BUDGET_MS;
    const idleSince = startedAt - idleDays * DAY_MS;
    const runId = randomUUID();
    const lanes = options.listLanes()
      .filter((lane) => lane.lane_type === "worktree" && !lane.is_edit_protected && isDirectChild(worktreesDir, lane.worktree_path))
      .map((lane) => ({ lane, activity: options.latestLaneActivityMs(lane.id, lane.created_at) }))
      // Longest idle first, so a run cut short by its budget did the most good.
      .sort((left, right) => left.activity - right.activity)
      .map((entry) => entry.lane);
    const probe = lanes.length > 0 ? await listProcessWorkingDirs() : { dirs: [], supported: true };
    if (!probe) {
      options.logger.warn("storage.build_output_skipped", { reason: "process_check_failed" });
      return { itemsAffected: 0, bytesReclaimed: 0, skippedReason: "process_check_failed" };
    }
    let removed = 0;
    let freed = 0;
    let failed = 0;
    let stoppedEarly = false;
    for (const lane of lanes) {
      if (Date.now() >= deadline) {
        stoppedEarly = true;
        break;
      }
      try {
        const outcome = await sweepLane({ lane, projectId, runId, idleSince, deadline, probe });
        removed += outcome.removed;
        freed += outcome.freed;
        failed += outcome.failed;
      } catch (error) {
        options.logger.warn("storage.build_output_lane_failed", { laneId: lane.id, error: errorMessage(error) });
      }
      await yieldToEventLoop();
    }
    markChecked(projectId);
    pruneRecords(projectId);
    options.logger.info("storage.build_output_sweep_completed", {
      lanes: lanes.length,
      removed,
      failed,
      freedBytes: freed,
      stoppedEarly,
      durationMs: Date.now() - startedAt,
    });
    if (failed > 0 && removed === 0) {
      throw new Error(`${failed} build ${failed === 1 ? "folder" : "folders"} could not be removed.`);
    }
    return {
      itemsAffected: removed,
      bytesReclaimed: freed,
      skippedReason: removed === 0 ? "nothing_due" : null,
    };
  };

  /**
   * Checks idle lanes and removes their build output. Joins a run already in
   * flight. `force` (a manual cleanup) ignores the once-a-day pacing, never
   * the safety rules.
   */
  const sweep = (opts: { force?: boolean } = {}): Promise<MaintenanceStepResult> => {
    if (flight) return flight;
    flight = run({ force: Boolean(opts.force) }).finally(() => {
      flight = null;
    });
    return flight;
  };

  /**
   * What the cleanup removed, for the storage page: each lane's latest
   * cleanup, the total, and, per lane, the removed folders that have not come
   * back yet (a reinstall or build brings them back and ends the note).
   */
  const describe = async (lanes: LaneRowLike[]): Promise<{
    summary: LaneBuildOutputSummary;
    removedByLane: Map<string, NonNullable<StorageItem["buildOutputRemoved"]>>;
  }> => {
    const projectId = projectIdOrNull();
    const removedByLane = new Map<string, NonNullable<StorageItem["buildOutputRemoved"]>>();
    if (!projectId) return { summary: { lastCheckAt: null, totalFreedBytes: 0, since: null, lanes: [] }, removedByLane };
    const checkedAt = readCheckedAt(projectId);
    const rows = options.db.all<{
      lane_id: string;
      run_id: string;
      folder: string;
      bytes: number;
      partial: number;
      error: string | null;
      removed_at: string;
    }>(
      `select lane_id, run_id, folder, bytes, partial, error, removed_at
         from local_lane_build_output_cleanups
        where project_id = ?
        order by removed_at desc`,
      [projectId],
    );
    const laneById = new Map(lanes.map((lane) => [lane.id, lane]));
    const latestRunByLane = new Map<string, string>();
    const entries = new Map<string, LaneBuildOutputLaneEntry>();
    let totalFreedBytes = 0;
    let totalPartial = false;
    let since: string | null = null;
    for (const row of rows) {
      totalFreedBytes += Math.max(0, row.bytes);
      if (row.partial) totalPartial = true;
      since = row.removed_at;
      const lane = laneById.get(row.lane_id);
      if (!lane) continue;
      const latestRun = latestRunByLane.get(row.lane_id) ?? row.run_id;
      latestRunByLane.set(row.lane_id, latestRun);
      if (row.run_id !== latestRun) continue;
      const entry = entries.get(row.lane_id) ?? {
        laneId: row.lane_id,
        laneName: lane.name,
        removedAt: row.removed_at,
        bytes: 0,
        folders: [],
        failures: [],
      };
      entry.bytes += Math.max(0, row.bytes);
      if (row.partial) entry.partial = true;
      if (row.error) entry.failures.push({ folder: row.folder, reason: row.error });
      else entry.folders.push(row.folder);
      entries.set(row.lane_id, entry);
    }
    for (const entry of entries.values()) {
      if (entry.folders.length === 0 || Date.now() - Date.parse(entry.removedAt) > NOTE_MAX_AGE_MS) continue;
      const lane = laneById.get(entry.laneId);
      if (!lane) continue;
      const missing: string[] = [];
      for (const folder of entry.folders) {
        if (!(await lstatOrNull(gitRelToAbs(lane.worktree_path, folder)))) missing.push(folder);
      }
      if (missing.length === 0) continue;
      removedByLane.set(entry.laneId, {
        at: entry.removedAt,
        bytes: entry.bytes,
        ...(entry.partial ? { partial: true } : {}),
        folders: missing,
      });
    }
    return {
      summary: {
        lastCheckAt: checkedAt == null ? null : new Date(checkedAt).toISOString(),
        totalFreedBytes,
        ...(totalPartial ? { totalPartial: true } : {}),
        since,
        lanes: [...entries.values()].sort((left, right) => Date.parse(right.removedAt) - Date.parse(left.removedAt)),
      },
      removedByLane,
    };
  };

  /**
   * The lane view's notice: what the latest cleanup removed from this one
   * lane that has not come back yet. One indexed read and a stat per folder,
   * so opening a lane never waits on a storage scan.
   */
  const describeLane = async (lane: LaneRowLike): Promise<LaneBuildOutputRemoved | null> => {
    const projectId = projectIdOrNull();
    if (!projectId) return null;
    const rows = options.db.all<{
      run_id: string;
      folder: string;
      bytes: number;
      partial: number;
      error: string | null;
      removed_at: string;
    }>(
      `select run_id, folder, bytes, partial, error, removed_at
         from local_lane_build_output_cleanups
        where project_id = ? and lane_id = ?
        order by removed_at desc`,
      [projectId, lane.id],
    );
    const latestRun = rows[0]?.run_id;
    if (!latestRun) return null;
    const removedAt = rows[0]!.removed_at;
    if (Date.now() - Date.parse(removedAt) > NOTE_MAX_AGE_MS) return null;
    let bytes = 0;
    let partial = false;
    const missing: string[] = [];
    for (const row of rows) {
      if (row.run_id !== latestRun || row.error) continue;
      bytes += Math.max(0, row.bytes);
      if (row.partial) partial = true;
      if (!(await lstatOrNull(gitRelToAbs(lane.worktree_path, row.folder)))) missing.push(row.folder);
    }
    if (missing.length === 0) return null;
    return { at: removedAt, bytes, ...(partial ? { partial: true } : {}), folders: missing };
  };

  return { sweep, describe, describeLane };
}
