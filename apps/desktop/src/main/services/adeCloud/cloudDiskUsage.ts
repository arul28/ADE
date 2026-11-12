import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLOUD_DISK_USAGE_MAX_ITEMS } from "../../../../../account-directory/src/cloud/contract";
import type { CloudDiskUsage, CloudDiskUsageItem, CloudDiskUsageReport, CloudLaneWork } from "../../../shared/adeCloud";
import { addSentryBreadcrumb } from "../../../shared/sentry/capture";

/**
 * A cloud computer measures what uses its disk (repository, dependencies,
 * Docker, Android, caches) and clears its caches on request. It measures at
 * its idle step, while it is awake anyway, at most every `CLOUD_DISK_MEASURE_EVERY_MS`,
 * and sends the measure with its last work to ADE's server
 * (`POST .../disk-usage`). The dashboard reads it with the computer list, so
 * nothing ever wakes a computer to measure it.
 *
 * Linux only (cloud computers): `du` and `docker` answer within a time limit,
 * at the lowest CPU and I/O priority; a part that doesn't answer is left out.
 */

/** A new measure at most this often: a disk changes slowly, and `du` reads every file. */
const CLOUD_DISK_MEASURE_EVERY_MS = 6 * 60 * 60_000;
/** One `du` or `docker` call gives up after this long. */
const COMMAND_TIMEOUT_MS = 90_000;
/** Deepest folder under a project root searched for `node_modules`. */
const NODE_MODULES_DEPTH = 5;
/** Parts smaller than this are folded into "Other". */
const MIN_PART_GB = 0.05;

const GB = 1024 ** 3;

type Run = (command: string, args: string[]) => Promise<string>;

/** `ionice` where the image has it (util-linux), else CPU priority alone. */
const IONICE = ["/usr/bin/ionice", "/bin/ionice"].find((file) => fs.existsSync(file)) ?? null;

function defaultRun(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // Lowest CPU and I/O priority: the measure must never slow work that starts during it.
    const lowPriority = IONICE ? ["-n", "19", IONICE, "-c", "3", command, ...args] : ["-n", "19", command, ...args];
    execFile("nice", lowPriority, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      // `du` exits 1 when one file can't be read and still prints the total.
      if (error && !stdout) reject(error);
      else resolve(stdout);
    });
  });
}

/**
 * A part that doesn't answer is left out (no Docker on a standard computer is
 * normal), with a trace for the next report rather than a report of its own.
 */
function leftOut(part: string): (error: unknown) => string {
  return (error: unknown) => {
    addSentryBreadcrumb("cloud.disk", `${part} didn't answer`, { error: error instanceof Error ? error.message : String(error) }, "warning");
    return "";
  };
}

/** Folders inside a cache that a tool doesn't fetch again by itself (a browser download): never cleared. */
const KEEP_IN_CACHES = new Set(["ms-playwright", "puppeteer", "ade"]);

/** The caches ADE may clear: rebuilt on next use, never work. Relative to the home folder. */
const CLOUD_CLEARABLE_CACHES: readonly string[] = [
  ".cache",
  ".npm/_cacache",
  ".local/share/pnpm/store",
  ".pnpm-store",
  ".bun/install/cache",
  ".yarn/berry/cache",
  ".gradle/caches",
  ".cargo/registry/cache",
];

/** The Android SDK and emulator images, where the image installs them. */
function androidFolders(home: string): string[] {
  const env = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT].filter((value): value is string => Boolean(value?.trim()));
  return [...new Set([...env, path.join(home, "Android", "Sdk"), path.join(home, ".android", "avd")])];
}

function exists(folder: string): boolean {
  try {
    return fs.statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

/** The file system a folder is on, or null when it isn't there. */
function deviceOf(folder: string): number | null {
  try {
    return fs.statSync(folder).dev;
  } catch {
    return null;
  }
}

/**
 * Kilobytes under each folder, from one `du -sk` call; a folder that isn't
 * there is left out, and so is one on another disk than `onDiskOf` (the
 * image's own layer: an SDK there uses none of the computer's billed disk).
 */
async function duKb(run: Run, folders: string[], extra: string[] = [], onDiskOf?: string): Promise<Map<string, number>> {
  const disk = onDiskOf ? deviceOf(onDiskOf) : null;
  const present = folders.filter(exists).filter((folder) => disk == null || deviceOf(folder) === disk);
  const sizes = new Map<string, number>();
  if (!present.length) return sizes;
  const out = await run("du", ["-sk", ...extra, ...present]).catch(leftOut("du"));
  for (const line of out.split("\n")) {
    const match = /^(\d+)\s+(.+)$/.exec(line.trim());
    if (match) sizes.set(match[2]!, Number(match[1]));
  }
  return sizes;
}

const gbFromKb = (kb: number): number => Math.round((kb * 1024 / GB) * 1000) / 1000;

/** "1.2GB", "340MB", "0B" from `docker system df`. */
function dockerBytes(text: string): number {
  const match = /^([\d.]+)\s*([kKMGT]?)B$/.exec(text.trim());
  if (!match) return 0;
  const scale: Record<string, number> = { "": 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };
  return Number(match[1]) * (scale[match[2]!] ?? 1);
}

async function dockerParts(run: Run): Promise<{ imagesGb: number; buildCacheGb: number }> {
  const out = await run("docker", ["system", "df", "--format", "{{json .}}"]).catch(leftOut("docker system df"));
  let images = 0;
  let buildCache = 0;
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { Type?: string; Size?: string };
      const bytes = dockerBytes(row.Size ?? "");
      if (row.Type === "Build Cache") buildCache += bytes;
      else images += bytes;
    } catch {
      // A line `docker` added that isn't JSON: skip it.
    }
  }
  return { imagesGb: Math.round((images / GB) * 1000) / 1000, buildCacheGb: Math.round((buildCache / GB) * 1000) / 1000 };
}

async function nodeModulesFolders(run: Run, roots: string[]): Promise<string[]> {
  const present = roots.filter(exists);
  if (!present.length) return [];
  const out = await run("find", [...present, "-maxdepth", String(NODE_MODULES_DEPTH), "-type", "d", "-name", "node_modules", "-prune"]).catch(leftOut("find node_modules"));
  return out.split("\n").map((line) => line.trim()).filter(Boolean);
}

function usedDiskGb(folder: string): number | null {
  try {
    const stats = fs.statfsSync(folder);
    return Math.round((((stats.blocks - stats.bfree) * stats.bsize) / GB) * 1000) / 1000;
  } catch {
    return null;
  }
}

/**
 * What uses the disk now. `projectRoots` are the projects open on this
 * computer (each lane's worktree is inside its project).
 */
async function measureCloudDisk(input: { home?: string; projectRoots: string[]; run?: Run; now?: number }): Promise<CloudDiskUsage | null> {
  const home = input.home ?? os.homedir();
  const run = input.run ?? defaultRun;
  const totalGb = usedDiskGb(home);
  if (totalGb == null) return null;
  const roots = [...new Set(input.projectRoots.map((root) => path.resolve(root)))];
  const modules = await nodeModulesFolders(run, roots);
  // Every part is on the measured disk only (`totalGb` is the home disk's).
  const adeHome = process.env.ADE_HOME?.trim() || path.join(home, ".ade");
  const [repoKb, modulesKb, androidKb, cachesKb, toolsKb, adeKb, docker] = await Promise.all([
    duKb(run, roots, ["--exclude=node_modules"], home),
    duKb(run, modules, [], home),
    duKb(run, androidFolders(home), [], home),
    duKb(run, CLOUD_CLEARABLE_CACHES.map((folder) => path.join(home, folder)), [], home),
    duKb(run, [path.join(adeHome, "tools")], [], home),
    duKb(run, [adeHome], ["--exclude=tools"], home),
    dockerParts(run),
  ]);
  const sum = (sizes: Map<string, number>) => gbFromKb([...sizes.values()].reduce((total, kb) => total + kb, 0));
  const parts = ([
    { kind: "repository", label: roots.length === 1 ? "Repository" : "Repositories", gb: sum(repoKb), clearable: false },
    { kind: "dependencies", label: "Dependencies", gb: sum(modulesKb), clearable: false },
    { kind: "docker", label: "Docker images", gb: docker.imagesGb, clearable: false },
    { kind: "docker", label: "Docker build cache", gb: docker.buildCacheGb, clearable: true },
    { kind: "android", label: "Android SDK and emulators", gb: sum(androidKb), clearable: false },
    { kind: "caches", label: "Caches", gb: sum(cachesKb), clearable: true },
    // The server knows six kinds; these two go as `other` with their own names, so older servers keep them.
    { kind: "other", label: "Agent programs", gb: sum(toolsKb), clearable: false },
    { kind: "other", label: "ADE data (chats and lanes)", gb: sum(adeKb), clearable: false },
  ] satisfies CloudDiskUsageItem[] as CloudDiskUsageItem[]).filter((part) => part.gb >= MIN_PART_GB);
  const known = parts.reduce((total, part) => total + part.gb, 0);
  const other = Math.round(Math.max(0, totalGb - known) * 1000) / 1000;
  if (other >= MIN_PART_GB) parts.push({ kind: "other", label: "System and other", gb: other, clearable: false });
  parts.sort((left, right) => right.gb - left.gb);
  return { measuredAt: input.now ?? Date.now(), totalGb, items: parts.slice(0, CLOUD_DISK_USAGE_MAX_ITEMS) };
}

/**
 * Clears what can be rebuilt: the package and tool caches and Docker's build
 * cache. Never a repository, a dependency folder, an image or an emulator.
 * Answers how much it freed.
 */
export async function clearCloudDiskCaches(input: { home?: string; run?: Run } = {}): Promise<{ freedGb: number }> {
  const home = input.home ?? os.homedir();
  const run = input.run ?? defaultRun;
  const before = usedDiskGb(home);
  for (const folder of CLOUD_CLEARABLE_CACHES) {
    const full = path.join(home, folder);
    // Only inside the home folder, and never a link out of it.
    if (!full.startsWith(`${home}${path.sep}`) || !exists(full) || fs.lstatSync(full).isSymbolicLink()) continue;
    for (const entry of fs.readdirSync(full)) {
      if (KEEP_IN_CACHES.has(entry)) continue;
      fs.rmSync(path.join(full, entry), { recursive: true, force: true });
    }
  }
  await run("docker", ["builder", "prune", "--force"]).catch(leftOut("docker builder prune"));
  const after = usedDiskGb(home);
  return { freedGb: before != null && after != null ? Math.max(0, Math.round((before - after) * 1000) / 1000) : 0 };
}

/**
 * The idle step's report: the last work always, a new measure when the last
 * is older than `CLOUD_DISK_MEASURE_EVERY_MS`. The time of the last measure
 * is kept in `stateFile`, so a restart doesn't measure again at once.
 */
export function createCloudDiskUsageReporter(deps: {
  instanceId: string;
  stateFile: string;
  projectRoots: () => string[];
  send: (report: CloudDiskUsageReport) => Promise<void>;
  /** Its lanes' work now (git status and the pull request, no network); null when it can't say. */
  readWork?: () => Promise<CloudLaneWork | null>;
  measure?: typeof measureCloudDisk;
  now?: () => number;
  logger?: { info(event: string, data?: unknown): void; warn(event: string, data?: unknown): void };
}) {
  const now = deps.now ?? (() => Date.now());
  const measure = deps.measure ?? measureCloudDisk;
  const lastMeasuredAt = (): number => {
    try {
      const raw = JSON.parse(fs.readFileSync(deps.stateFile, "utf8")) as { measuredAt?: unknown };
      return typeof raw.measuredAt === "number" ? raw.measuredAt : 0;
    } catch {
      return 0;
    }
  };
  let forceNext = false;
  const reporter = {
    /** Measure and send now, whatever the time (the person cleared caches). */
    async reportNow(): Promise<void> {
      forceNext = true;
      await reporter.report(null, () => true);
    },
    /** `lastActiveAt`: the end of the last work. `stillIdle`: false once work started, then the measure is not sent. */
    async report(lastActiveAt: number | null, stillIdle: () => boolean): Promise<void> {
      if (!deps.instanceId) return;
      let usage: CloudDiskUsage | null = null;
      if (forceNext || now() - lastMeasuredAt() >= CLOUD_DISK_MEASURE_EVERY_MS) {
        usage = await measure({ projectRoots: deps.projectRoots(), now: now() }).catch((error: unknown) => {
          deps.logger?.warn("cloud.disk_measure_failed", { error: error instanceof Error ? error.message : String(error) });
          return null;
        });
        // Work that started during the measure changed the disk under it: measure again next time.
        if (usage && !stillIdle()) usage = null;
      }
      const work = await deps.readWork?.().catch((error: unknown) => {
        deps.logger?.warn("cloud.lane_work_read_failed", { error: error instanceof Error ? error.message : String(error) });
        return null;
      }) ?? null;
      await deps.send({ lastActiveAt, usage, work });
      if (usage) {
        forceNext = false;
        try {
          fs.mkdirSync(path.dirname(deps.stateFile), { recursive: true });
          fs.writeFileSync(deps.stateFile, JSON.stringify({ measuredAt: usage.measuredAt }));
        } catch {
          // Unwritable: the next idle step measures again, which is only slower.
        }
        deps.logger?.info("cloud.disk_measured", { totalGb: usage.totalGb, parts: usage.items.length });
      }
    },
  };
  activeReporter = reporter;
  return reporter;
}

export type CloudDiskUsageReporter = ReturnType<typeof createCloudDiskUsageReporter>;

/** This computer's reporter, once its brain made one; the cache clear sends its new measure through it. */
let activeReporter: { reportNow(): Promise<void> } | null = null;
export const cloudDiskReporter = (): { reportNow(): Promise<void> } | null => activeReporter;
