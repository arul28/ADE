import fs from "node:fs";
import path from "node:path";
import {
  detectCloudStorageProvider,
  isDatalessFileStats,
} from "../../../../desktop/src/main/services/storage/cloudPlaceholder";
import { MATERIALIZE_DATALESS_FILES_KEY } from "../../serviceManager/common";

/**
 * Where this machine's two ADE directories actually live, and whether their
 * bytes are on the disk.
 *
 * A user spent a day inside "Unknown system error -11" — macOS `EDEADLK`, which
 * `read(2)` returns for exactly one documented reason: the file is a dataless
 * cloud placeholder and the reading process may not materialize it. Nothing in
 * the diagnostic report said the project was in iCloud Drive, nothing said its
 * files had been evicted, and so the report that was supposed to explain the
 * failure explained nothing.
 *
 * This probe answers both questions with `fs` alone. It runs with the brain
 * DOWN, like every other source in `diagnosticSources.ts` — the machine where
 * the brain will not start is the machine that needs the report.
 *
 * PRIVACY: this section reports enums and counts. It never reports a path, a
 * directory name or a file name. The report's redaction pass is the safety net,
 * not the design: a probe that walks a user's project must not put what it
 * found there into a document the user is asked to upload.
 */

/** How a root is stored, as coarsely as is still useful. */
export type StorageLocationClass =
  | "icloud"
  | "dropbox"
  | "google-drive"
  | "onedrive"
  | "cloud-storage"
  | "external-volume"
  | "network-volume"
  | "local";

/**
 * External and network volumes, which `detectCloudStorageProvider` does not
 * cover because it answers a different question (is a cloud client syncing
 * this) than this one (are the bytes reliably here).
 *
 * A `/Volumes/…` path on macOS is any mount that is not the boot volume: an
 * external disk, a disk image, an SMB share, a third-party cloud client that
 * mounts its own filesystem. A UNC path or a non-system drive letter is the
 * Windows equivalent. None of them is a fault on its own — this is the enum
 * that makes "the project is on a drive that can go away" visible at all.
 */
function classifyVolume(
  targetPath: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): StorageLocationClass | null {
  if (platform === "win32") {
    if (/^\\\\/.test(targetPath)) return "network-volume";
    const drive = /^([A-Za-z]):[\\/]/.exec(targetPath)?.[1]?.toUpperCase();
    // Windows always boots from the system drive, and `SystemDrive` names it;
    // anything else is removable, a second disk, or a mapped share. Assuming
    // "C" misreads a machine that boots from D: as living on a removable disk.
    const systemDrive = /^([A-Za-z]):/.exec(env.SystemDrive?.trim() ?? "")?.[1]?.toUpperCase() ?? "C";
    if (drive && drive !== systemDrive) return "external-volume";
    return null;
  }
  if (/^\/Volumes\//.test(targetPath)) return "external-volume";
  // Linux automounts, and the macOS SMB/AFP mount points that predate
  // `/Volumes` for network shares.
  if (/^\/(?:media|mnt|net)\//.test(targetPath)) return "external-volume";
  return null;
}

/** The one classification the report prints for a root. Cloud wins over volume. */
export function classifyStorageLocation(
  targetPath: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): StorageLocationClass {
  if (!targetPath) return "local";
  // A cloud provider that mounts under `/Volumes` (some File Provider clients
  // do) is more usefully reported as the provider than as "some other disk".
  const provider = detectCloudStorageProvider(targetPath);
  if (provider) return provider;
  return classifyVolume(targetPath, platform, env) ?? "local";
}

/**
 * The classes where a sync client owns the bytes, so a file that is here today
 * can be evicted tomorrow.
 *
 * An external or a network volume can also go away, but it goes away as a
 * whole and says so with `ENOENT`. Only these five produce the failure this
 * module was written for: a path that still lists, still stats, and refuses to
 * read.
 */
const CLOUD_STORAGE_LOCATIONS: ReadonlySet<StorageLocationClass> = new Set([
  "icloud",
  "dropbox",
  "google-drive",
  "onedrive",
  "cloud-storage",
]);

export function isCloudStorageLocation(location: StorageLocationClass): boolean {
  return CLOUD_STORAGE_LOCATIONS.has(location);
}

/** Bounds on the walk. A diagnostic collector may never become the outage. */
export const STORAGE_SAMPLE_MAX_FILES = 200;
export const STORAGE_SAMPLE_MAX_DIRECTORIES = 40;
export const STORAGE_SAMPLE_TIME_BUDGET_MS = 750;

/**
 * Directories worth neither the time nor the stat calls: they are ADE's or the
 * toolchain's, not the user's, and a `node_modules` alone would spend the whole
 * file budget without ever reaching a file the user cares about.
 */
const SKIPPED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".worktrees",
  "DerivedData",
  "Pods",
  "target",
  "dist",
  "build",
  ".venv",
]);

export type StorageEnvironmentRoot = {
  /** "ADE home" / "Project" — never the path. */
  label: string;
  location: StorageLocationClass;
  /** Files stat'ed. Zero means the walk found none, not that it failed. */
  sampledFiles: number;
  /** Of those, how many look like unmaterialized cloud placeholders. */
  datalessFiles: number;
  /** True when a bound stopped the walk, so the counts are of a prefix. */
  sampleTruncated: boolean;
  /** Set when the root itself could not be read at all. */
  error?: string;
};

export type StorageEnvironmentProcess = {
  platform: NodeJS.Platform;
  /** "cli" for the brain and `ade`, "desktop" for Electron's main process. */
  processType: "cli" | "desktop";
  /**
   * Whether this process looks like a launchd job rather than something a
   * person started. Null off darwin, where the question has no meaning.
   */
  launchdManaged: boolean | null;
  /**
   * Whether the INSTALLED launch agent grants the brain permission to hydrate
   * dataless files.
   *
   * This is the fingerprint that separates the two ways the same failure
   * arrives. False means this machine is still running a launch agent from
   * before ADE granted the policy, so the brain is denied materialization and
   * every other process on the machine is not — reads fail in ADE and succeed
   * in Terminal. True means the policy is granted and an unreadable placeholder
   * is the provider's refusal, not ADE's configuration.
   *
   * Null when there is no launch agent to read, when it could not be read, or
   * off darwin, where no such key exists.
   */
  materializeDatalessFiles: boolean | null;
};

export type StorageEnvironment = {
  roots: StorageEnvironmentRoot[];
  process: StorageEnvironmentProcess;
  /** What this probe could NOT determine, stated in the report itself. */
  limitations: string[];
};

type StatFn = (target: string) => Pick<fs.Stats, "size" | "blocks">;
type ReadDirFn = (target: string) => fs.Dirent[];

export type StorageEnvironmentProbeDeps = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Test seams; production reads the real filesystem. */
  statSync?: StatFn;
  readdirSync?: ReadDirFn;
  now?: () => number;
  maxFiles?: number;
  maxDirectories?: number;
  timeBudgetMs?: number;
  processType?: "cli" | "desktop";
  parentPid?: number;
  /**
   * The installed launch agent, so the probe can read the materialization
   * policy off it. Passed in rather than resolved here: the path comes from
   * `serviceManager`, and this module stays a plain filesystem probe.
   */
  launchAgentPath?: string | null;
  readFileSync?: (target: string) => string;
};

/**
 * Whether launchd started this process.
 *
 * Two independent signals, either of which is enough. launchd sets
 * `XPC_SERVICE_NAME` to the job's label for the jobs it spawns, and leaves it
 * unset (or "0") for a login shell; and a LaunchAgent's child is reparented to
 * launchd itself, which is always pid 1. Neither is documented API, so this is
 * reported as the heuristic it is — but it is the ONE fact that separates the
 * two variants of the placeholder failure (a provider that will not
 * materialize for anybody, versus a background process that is not allowed to
 * ask), and it costs nothing to read.
 */
export function detectLaunchdManaged(
  env: NodeJS.ProcessEnv,
  parentPid: number,
): boolean {
  const xpcName = env.XPC_SERVICE_NAME?.trim();
  if (xpcName && xpcName !== "0") return true;
  return parentPid === 1;
}

/**
 * Stats a bounded sample of the files under `root`.
 *
 * Breadth-first and shallow-biased on purpose: the placeholders that matter sit
 * in the top few levels of a project, and a depth-first walk into one deep tree
 * would spend the whole budget there and report a sample of one directory as if
 * it were a sample of the project.
 */
function sampleRoot(
  root: string,
  deps: Required<Pick<StorageEnvironmentProbeDeps,
    "statSync" | "readdirSync" | "now" | "maxFiles" | "maxDirectories" | "timeBudgetMs">>,
): Omit<StorageEnvironmentRoot, "label" | "location"> {
  const deadline = deps.now() + deps.timeBudgetMs;
  let sampledFiles = 0;
  let datalessFiles = 0;
  let visitedDirectories = 0;
  let truncated = false;

  let queue: string[] = [root];

  while (queue.length > 0) {
    if (sampledFiles >= deps.maxFiles || visitedDirectories >= deps.maxDirectories) {
      truncated = true;
      break;
    }
    if (deps.now() >= deadline) {
      truncated = true;
      break;
    }
    const dir = queue.shift() as string;
    visitedDirectories += 1;
    let entries: fs.Dirent[];
    try {
      entries = deps.readdirSync(dir);
    } catch {
      // One unreadable subdirectory is not a failed probe. An unreadable ROOT
      // is: it is the difference between "we looked and the files are here" and
      // "we could not look", and only the second one is the reader's problem.
      if (dir === root) {
        return {
          sampledFiles: 0,
          datalessFiles: 0,
          sampleTruncated: false,
          error: "(could not be read)",
        };
      }
      continue;
    }
    const nested: string[] = [];
    for (const entry of entries) {
      if (sampledFiles >= deps.maxFiles) {
        truncated = true;
        break;
      }
      const name = entry.name;
      // A symlink is never followed: it can point out of the root, at a
      // different volume, or in a cycle, and none of those describes this root.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORY_NAMES.has(name)) continue;
        nested.push(path.join(dir, name));
        continue;
      }
      if (!entry.isFile()) continue;
      let stats: Pick<fs.Stats, "size" | "blocks">;
      try {
        stats = deps.statSync(path.join(dir, name));
      } catch {
        // An unreadable file is very often the exact fault being hunted, but a
        // stat that throws cannot say whether it was dataless — so it is not
        // counted either way rather than guessed at.
        continue;
      }
      sampledFiles += 1;
      if (isDatalessFileStats(stats)) datalessFiles += 1;
    }
    queue = queue.concat(nested);
  }

  if (queue.length > 0) truncated = true;
  return { sampledFiles, datalessFiles, sampleTruncated: truncated };
}

/**
 * Whether the installed launch agent grants dataless materialization.
 *
 * macOS gates hydration of a dataless file on the reading process's I/O policy
 * (`setiopolicy_np`, `IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES`). The policy
 * of a RUNNING process is not readable from Node — `getiopolicy_np` has no
 * `process`, `os` or `fs` surface, and reading the brain's would mean starting
 * the brain, which this collector must never do. But `launchd.plist(5)` exposes
 * the very same switch as a `MaterializeDatalessFiles` key, and ADE's launch
 * agents now set it, so what the job was GRANTED is an ordinary file read.
 *
 * That is the better answer anyway. The policy is what the plist says it is,
 * and a machine whose installed agent predates the key is exactly the machine
 * where the brain is denied and every other process is allowed.
 *
 * Deliberately a text match rather than a plist parse: the file is ADE's own
 * generated XML, the collector runs where nothing else works, and a parser
 * dependency (or a `plutil` subprocess) would be a new way for this to fail.
 */
export function readMaterializeDatalessFilesKey(
  plistText: string,
): boolean | null {
  // Built from the same constant the plists are written with, so the reader
  // cannot drift from the writer.
  const match = new RegExp(
    `<key>\\s*${MATERIALIZE_DATALESS_FILES_KEY}\\s*</key>\\s*<(true|false)\\s*/>`,
    "i",
  ).exec(plistText);
  if (!match) return null;
  return match[1]?.toLowerCase() === "true";
}

function readLaunchAgentPolicy(
  plistPath: string | null | undefined,
  readFileSync: (target: string) => string,
): boolean | null {
  if (!plistPath) return null;
  try {
    return readMaterializeDatalessFilesKey(readFileSync(plistPath));
  } catch {
    // No agent installed, or one this process may not read. Either way the
    // policy is unknown rather than absent, and null says so.
    return null;
  }
}

/**
 * The one thing that stays unknowable: what policy the process doing the
 * reading is actually running under, as opposed to what its job was granted.
 * They differ only if something re-set the policy at runtime, which nothing in
 * ADE does — but the report should not claim more than it read.
 */
const MATERIALIZATION_POLICY_LIMITATION =
  "materialization policy is read from the installed launch agent, not from the running process (getiopolicy_np is not exposed to Node)";

/**
 * Why the Windows counts are as good as the macOS ones despite the missing
 * attributes.
 *
 * `fs.stat` exposes no Win32 file attributes, so
 * `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` and `FILE_ATTRIBUTE_OFFLINE` — the
 * attributes that say "OneDrive placeholder" outright — are unreachable. The
 * zero-blocks heuristic still holds there: libuv fills `st_blocks` from the
 * file's allocation size, and a placeholder allocates nothing. It is the
 * weaker signal (a genuinely sparse file also reads as dataless), which is why
 * the count is reported beside the provider class rather than as a verdict.
 */
const WINDOWS_ATTRIBUTE_LIMITATION =
  "dataless detection on Windows uses allocated blocks; the OneDrive placeholder attributes (FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS / _OFFLINE) are not exposed by fs.stat";

/**
 * The whole section, for however many roots the caller has. Never throws: a
 * probe that took the report down with it would be worse than no probe.
 */
export function collectStorageEnvironment(
  roots: readonly { label: string; path: string }[],
  deps: StorageEnvironmentProbeDeps = {},
): StorageEnvironment {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const sampleDeps = {
    statSync: deps.statSync ?? ((target: string) => fs.statSync(target)),
    readdirSync: deps.readdirSync ?? ((target: string) => fs.readdirSync(target, { withFileTypes: true })),
    now: deps.now ?? Date.now,
    maxFiles: deps.maxFiles ?? STORAGE_SAMPLE_MAX_FILES,
    maxDirectories: deps.maxDirectories ?? STORAGE_SAMPLE_MAX_DIRECTORIES,
    timeBudgetMs: deps.timeBudgetMs ?? STORAGE_SAMPLE_TIME_BUDGET_MS,
  };

  const collected: StorageEnvironmentRoot[] = [];
  for (const root of roots) {
    const location = classifyStorageLocation(root.path, platform, env);
    try {
      collected.push({ label: root.label, location, ...sampleRoot(root.path, sampleDeps) });
    } catch {
      collected.push({
        label: root.label,
        location,
        sampledFiles: 0,
        datalessFiles: 0,
        sampleTruncated: false,
        error: "(could not be read)",
      });
    }
  }

  const limitations = [MATERIALIZATION_POLICY_LIMITATION];
  if (platform === "win32") limitations.push(WINDOWS_ATTRIBUTE_LIMITATION);

  return {
    roots: collected,
    process: {
      platform,
      // Electron's main process is the only place `process.versions.electron`
      // is set; the brain and `ade` are plain Node even when they run out of
      // the same binary with `ELECTRON_RUN_AS_NODE=1`.
      processType: deps.processType ?? (process.versions.electron ? "desktop" : "cli"),
      launchdManaged: platform === "darwin"
        ? detectLaunchdManaged(env, deps.parentPid ?? process.ppid)
        : null,
      materializeDatalessFiles: platform === "darwin"
        ? readLaunchAgentPolicy(
          deps.launchAgentPath,
          deps.readFileSync ?? ((target: string) => fs.readFileSync(target, "utf8")),
        )
        : null,
    },
    limitations,
  };
}
