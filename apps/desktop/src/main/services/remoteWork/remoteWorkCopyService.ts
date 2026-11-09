/**
 * Work copies: where a chat on another machine runs its commands here.
 *
 * `ade shell start --machine <this machine> -- <command>` runs a command for a
 * chat that lives elsewhere. The chat's code stays on its own machine; this
 * service keeps a plain git worktree of the same repository for that chat,
 * detached at the chat's commit, with the chat's uncommitted changes applied.
 * It is not a lane: nothing lists it in Lanes, it has no chat and no branch.
 *
 * Rules:
 *  - Created on the first command, never in advance. Nothing is installed:
 *    deps and build output appear only when a command makes them, and stay
 *    between runs because a sync never removes ignored files.
 *  - Git moves code. The chat's commit must be on origin; its uncommitted
 *    changes travel as one patch. Work done HERE reaches the chat only through
 *    git (commit and push here, pull there).
 *  - Never lose work. A sync resets the copy, so it refuses while the copy
 *    holds changes nobody synced in: unpushed commits, or edits since the last
 *    sync. The caller then runs without a sync (to commit and push them) or
 *    discards them on purpose. The idle and low-disk cleanups skip such a copy.
 *  - One thing at a time. A copy is busy from its sync until the command it
 *    was synced for has started and while that command runs; a second synced
 *    command is refused rather than resetting files under the first.
 *  - Never clutter. A copy is deleted when its chat asks, when its chat is
 *    deleted or archived on its own machine, after a week unused, and first
 *    when the disk runs low.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGit, type GitRunResult } from "../git/git";
import { isPathInside, pathComparisonKey, pathsEqual } from "../shared/pathCompare";
import { writeTextAtomic } from "../shared/utils";
import { isRemoteWorkLaneId, REMOTE_WORK_LANE_PREFIX, REMOTE_WORK_MAX_PATCH_BYTES } from "../../../shared/types/remoteWork";

/** What the calling chat sends with each command. */
export type RemoteWorkSource = {
  /** The chat's commit. Must exist on origin. */
  head: string;
  /** Remote branch that holds `head` (e.g. `ade/my-lane`), fetched when the commit is missing here. */
  fetchRef?: string | null;
  /** The chat's uncommitted changes against `head` (untracked files included) as a binary git patch, base64. */
  patchBase64?: string | null;
  /** The chat's branch, for people reading the copy list. */
  branch?: string | null;
  /** The machine the chat runs on, for people reading the copy list. */
  machineName?: string | null;
};

export type RemoteWorkSyncMode =
  /** Reset the copy to the chat's commit and changes (default). */
  | "sync"
  /** Run in the copy as it is (a missing copy is still made first). */
  | "none"
  /** Reset even if the copy holds work nobody synced in. */
  | "discard";

export function isRemoteWorkSyncMode(value: unknown): value is RemoteWorkSyncMode {
  return value === "sync" || value === "none" || value === "discard";
}

export type RemoteWorkCopy = {
  /** Foreign caller session id (`remote:<device>:<chat>`) that owns the copy. */
  owner: string;
  path: string;
  head: string;
  branch: string | null;
  machineName: string | null;
  /** Tree id of the copy right after the last sync; null before the first. */
  syncedTree: string | null;
  createdAt: string;
  lastUsedAt: string;
};

/**
 * `prepareWithin`'s answer: the copy, ready; or `preparing` when a new copy
 * took longer than the wait, and is still being made in the background.
 */
export type RemoteWorkPrepareWithinResult = { prepared: RemoteWorkPrepareResult } | { preparing: true };

export type RemoteWorkPrepareResult = {
  path: string;
  created: boolean;
  synced: boolean;
  /**
   * Call once the command this copy was readied for has started (its shell is
   * registered) or, for a call that runs to the end, once it returns. Until
   * then the copy counts as busy.
   */
  done: () => void;
};

export class RemoteWorkError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** A copy unused this long is deleted by the sweep. */
const REMOTE_WORK_IDLE_MS = 7 * 24 * 60 * 60_000;
/** Below this much free disk, older copies are deleted before a new one is made. */
const REMOTE_WORK_RECLAIM_FREE_BYTES = 20 * 1024 ** 3;
/** Below this much free disk, no new copy is made. */
const REMOTE_WORK_MIN_FREE_BYTES = 5 * 1024 ** 3;

const SHA = /^[0-9a-f]{40}$/i;
const REGISTRY_FILE = "copies.json";
const GIT_TIMEOUT_MS = 120_000;
/** Stops the project's checkout hooks running in a throwaway copy. Git finds no hook at this path. */
const WORK_COPY_NO_HOOKS = ["-c", "core.hooksPath=/dev/null"] as const;
const WORK_COPY_CLEAN_PASSES = 5;
const FETCH_TIMEOUT_MS = 300_000;

/**
 * How long `prepareWithin` waits for a NEW work copy before it answers
 * "still being made". The first copy is a git fetch plus a worktree (minutes
 * on Windows), and the caller's machine gives a call 30 s by default; an
 * answer has to get back before that, or the caller only sees a timeout.
 */
const REMOTE_WORK_FIRST_COPY_WAIT_MS = 20_000;
/** A background make that failed keeps its error for the next call this long, then a call tries again. */
const FAILED_MAKE_RETENTION_MS = 10 * 60_000;

function ownerHash(owner: string): string {
  return createHash("sha256").update(owner).digest("hex").slice(0, 12);
}

export function remoteWorkLaneIdFor(owner: string): string {
  return `${REMOTE_WORK_LANE_PREFIX}${ownerHash(owner)}`;
}

export { isRemoteWorkLaneId, REMOTE_WORK_LANE_PREFIX };

type Registry = { version: 1; copies: RemoteWorkCopy[] };

function registryPathFor(projectRoot: string): string {
  return path.join(projectRoot, ".ade", "remote-work", REGISTRY_FILE);
}

/**
 * A project's copies. A missing file is "none yet"; an unreadable one throws,
 * so nothing is deleted or rewritten on a guess.
 */
function readRegistryAt(projectRoot: string): Registry {
  let text: string;
  try {
    text = fs.readFileSync(registryPathFor(projectRoot), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { version: 1, copies: [] };
    throw new RemoteWorkError("registry_unreadable", `Could not read this project's work copies: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const parsed = JSON.parse(text) as Partial<Registry>;
    return { version: 1, copies: Array.isArray(parsed.copies) ? parsed.copies.filter(isCopy) : [] };
  } catch (error) {
    throw new RemoteWorkError("registry_unreadable", `This project's work copy list is damaged (${registryPathFor(projectRoot)}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Does a `remote-work-…` lane still have its work copy in the project at
 * `projectRoot`? For deciding whether to delete what the lane holds, so a
 * list that cannot be read is "unknown", never "gone".
 */
export function remoteWorkLaneState(projectRoot: string, laneId: string): "live" | "gone" | "unknown" {
  if (!isRemoteWorkLaneId(laneId)) return "gone";
  try {
    const copy = readRegistryAt(projectRoot).copies.find((entry) => remoteWorkLaneIdFor(entry.owner) === laneId);
    if (!copy) return "gone";
    // `statSync`, not `existsSync`: existsSync reads any error (EIO, EACCES)
    // as "absent", and "gone" lets a cleanup delete the lane's simulator.
    // Only a path that is confirmed missing is gone.
    fs.statSync(copy.path);
    return "live";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return "gone";
    console.warn(`[remote_work] could not tell whether ${laneId}'s work copy is still there: ${error instanceof Error ? error.message : String(error)}`);
    return "unknown";
  }
}

/** The work copy a `remote-work-…` lane id names in this project, or null when it is gone or unreadable. */
export function findRemoteWorkCopyForLane(projectRoot: string, laneId: string): RemoteWorkCopy | null {
  if (!isRemoteWorkLaneId(laneId)) return null;
  try {
    return readRegistryAt(projectRoot).copies
      .find((copy) => remoteWorkLaneIdFor(copy.owner) === laneId && fs.existsSync(copy.path)) ?? null;
  } catch (error) {
    // Unreadable: say "gone" to the lane lookups, and say so in the log.
    console.warn(`[remote_work] ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export type RemoteWorkLogger = {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
};

/**
 * What every service for one project shares, whoever made it: one lock per
 * copy, the copies whose command has not started yet, the newest way to
 * ask whether a shell still runs in a copy (from the project's runtime), the
 * device services that can say a copy's simulator or emulator is in use, and
 * who wants to hear that a copy is gone (the Android device service).
 */
type ProjectState = {
  locks: Map<string, Promise<unknown>>;
  starting: Map<string, number>;
  /**
   * New copies still being made after their call answered "preparing", by
   * owner. `head` is the commit the make was for; `failure` is set when it
   * failed, and kept for FAILED_MAKE_RETENTION_MS.
   */
  making: Map<string, BackgroundMake>;
  shellRunsIn: ((owner: string) => boolean) | null;
  deviceInUse: Set<(laneId: string) => boolean>;
  released: Set<(laneId: string) => void>;
};
const projectStates = new Map<string, ProjectState>();

/** A new copy still being made after its call answered "preparing". */
type BackgroundMake = { done: Promise<void>; head: string; failure: unknown | null };

function projectStateFor(projectRoot: string): ProjectState {
  // Case-folded where the file system folds case, so the sweep and the runtime share one state.
  const key = pathComparisonKey(path.resolve(projectRoot));
  let state = projectStates.get(key);
  if (!state) {
    state = { locks: new Map(), starting: new Map(), making: new Map(), shellRunsIn: null, deviceInUse: new Set(), released: new Set() };
    projectStates.set(key, state);
  }
  return state;
}

export type RemoteWorkCopyServiceOptions = {
  projectRoot: string;
  /** The ADE home holding the machine index; defaults to $ADE_HOME or ~/.ade. */
  adeHome?: string;
  logger?: RemoteWorkLogger;
  now?: () => number;
  /** Free bytes on the project's disk; null when unknown. */
  freeBytes?: () => number | null;
};

function defaultFreeBytes(dir: string, logger?: RemoteWorkLogger): number | null {
  try {
    const stats = fs.statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch (error) {
    logger?.warn("remote_work.free_bytes_unknown", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** Which projects on this machine hold work copies, so one read finds them all. */
/** `rebuilt`: read back from ADE's project list because the file was damaged; never written. */
type MachineIndex = { version: 1; projects: Array<{ projectRoot: string }>; rebuilt?: true };

function defaultAdeHome(): string {
  const fromEnv = process.env.ADE_HOME?.trim();
  return path.resolve(fromEnv || path.join(os.homedir(), ".ade"));
}

function machineIndexPath(adeHome: string): string {
  return path.join(adeHome, "remote-work", "projects.json");
}

function readMachineIndex(adeHome: string, logger?: RemoteWorkLogger): MachineIndex {
  try {
    const parsed = JSON.parse(fs.readFileSync(machineIndexPath(adeHome), "utf8")) as Partial<MachineIndex>;
    const projects = Array.isArray(parsed.projects)
      ? parsed.projects.filter((entry): entry is MachineIndex["projects"][number] =>
        Boolean(entry) && typeof entry.projectRoot === "string")
      : [];
    return { version: 1, projects };
  } catch (error) {
    // Missing: no copies yet.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, projects: [] };
    // Damaged: rebuild it from ADE's project list, so the next write keeps
    // every project that holds copies, not just the one writing.
    logger?.warn("remote_work.index_unreadable", { error: error instanceof Error ? error.message : String(error) });
    return { version: 1, projects: projectsWithCopies(adeHome, logger), rebuilt: true };
  }
}

/** Every project ADE knows on this machine (`<ADE_HOME>/projects.json`) that has a work copy list. */
function projectsWithCopies(adeHome: string, logger?: RemoteWorkLogger): MachineIndex["projects"] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(adeHome, "projects.json"), "utf8")) as { projects?: Array<{ rootPath?: unknown }> };
    return (Array.isArray(parsed.projects) ? parsed.projects : [])
      .map((entry) => entry?.rootPath)
      .filter((root): root is string => typeof root === "string" && fs.existsSync(registryPathFor(root)))
      .map((root) => ({ projectRoot: path.resolve(root) }));
  } catch (error) {
    logger?.warn("remote_work.index_rebuild_failed", { error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

function writeMachineIndexEntry(adeHome: string, projectRoot: string, present: boolean, logger?: RemoteWorkLogger): void {
  const index = readMachineIndex(adeHome, logger);
  const listed = index.projects.some((entry) => pathsEqual(entry.projectRoot, projectRoot));
  // A rebuilt index is written even when this project's entry is right: the file is still damaged.
  if (listed === present && !index.rebuilt) return;
  const next = present
    ? [...index.projects, { projectRoot: path.resolve(projectRoot) }]
    : index.projects.filter((entry) => !pathsEqual(entry.projectRoot, projectRoot));
  writeTextAtomic(machineIndexPath(adeHome), `${JSON.stringify({ version: 1, projects: next }, null, 2)}\n`);
}

/** Every work copy on this machine, across its projects, from the index. */
export function listMachineRemoteWorkCopies(
  adeHome: string = defaultAdeHome(),
  logger?: RemoteWorkLogger,
): Array<RemoteWorkCopy & { projectRoot: string }> {
  const rows: Array<RemoteWorkCopy & { projectRoot: string }> = [];
  for (const entry of readMachineIndex(adeHome, logger).projects) {
    try {
      for (const copy of readRegistryAt(entry.projectRoot).copies) rows.push({ ...copy, projectRoot: entry.projectRoot });
    } catch (error) {
      logger?.warn("remote_work.registry_unreadable", { projectRoot: entry.projectRoot, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return rows;
}

export function createRemoteWorkCopyService(options: RemoteWorkCopyServiceOptions) {
  const { projectRoot, logger } = options;
  const now = options.now ?? (() => Date.now());
  const freeBytes = options.freeBytes ?? (() => defaultFreeBytes(projectRoot, logger));
  const adeHome = options.adeHome ?? defaultAdeHome();
  const root = path.join(projectRoot, ".ade", "remote-work");
  const state = projectStateFor(projectRoot);

  const readRegistry = (): Registry => readRegistryAt(projectRoot);
  const writeRegistry = (registry: Registry): void => {
    writeTextAtomic(registryPathFor(projectRoot), `${JSON.stringify(registry, null, 2)}\n`);
    try {
      writeMachineIndexEntry(adeHome, projectRoot, registry.copies.length > 0, logger);
    } catch (error) {
      logger?.warn("remote_work.index_write_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  };
  const updateCopy = (owner: string, update: (copy: RemoteWorkCopy | null) => RemoteWorkCopy | null): void => {
    const registry = readRegistry();
    const rest = registry.copies.filter((copy) => copy.owner !== owner);
    const next = update(registry.copies.find((copy) => copy.owner === owner) ?? null);
    writeRegistry({ version: 1, copies: next ? [...rest, next] : rest });
  };

  const withLock = async <T>(owner: string, run: () => Promise<T>): Promise<T> => {
    const previous = state.locks.get(owner) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(run);
    state.locks.set(owner, current);
    try {
      return await current;
    } finally {
      if (state.locks.get(owner) === current) state.locks.delete(owner);
    }
  };

  const inUse = (owner: string): boolean => isRemoteWorkCopyInUse(projectRoot, owner);
  const drivesDevice = (owner: string): boolean => remoteWorkCopyDrivesDevice(projectRoot, owner);

  const markStarting = (owner: string): (() => void) => {
    state.starting.set(owner, (state.starting.get(owner) ?? 0) + 1);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      const left = (state.starting.get(owner) ?? 1) - 1;
      if (left > 0) state.starting.set(owner, left);
      else state.starting.delete(owner);
    };
  };

  const git = (args: string[], cwd: string, extra: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<GitRunResult> =>
    runGit(args, { cwd, timeoutMs: extra.timeoutMs ?? GIT_TIMEOUT_MS, ...(extra.env ? { env: extra.env } : {}) });

  const gitOrThrow = async (args: string[], cwd: string, failure: string, extra?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<string> => {
    const result = await git(args, cwd, extra);
    if (result.exitCode !== 0 || result.timedOut) {
      const detail = (result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ");
      throw new RemoteWorkError("git_failed", `${failure}${detail ? `: ${detail}` : ""}`);
    }
    return result.stdout.trim();
  };

  const hasCommit = async (sha: string): Promise<boolean> =>
    (await git(["cat-file", "-e", `${sha}^{commit}`], projectRoot)).exitCode === 0;

  /** Fetch the chat's commit from origin when this checkout does not have it yet. */
  const ensureCommit = async (source: RemoteWorkSource): Promise<void> => {
    if (await hasCommit(source.head)) return;
    const ref = source.fetchRef?.trim();
    const fetchArgs = ref && /^[A-Za-z0-9._/-]+$/.test(ref) && !ref.startsWith("-") && !ref.includes("..")
      ? ["fetch", "--no-tags", "origin", "--", ref]
      : ["fetch", "--no-tags", "origin"];
    await git(fetchArgs, projectRoot, { timeoutMs: FETCH_TIMEOUT_MS });
    if (await hasCommit(source.head)) return;
    // Some hosts serve a reachable commit by id even when no branch was named.
    await git(["fetch", "--no-tags", "origin", "--", source.head], projectRoot, { timeoutMs: FETCH_TIMEOUT_MS });
    if (await hasCommit(source.head)) return;
    throw new RemoteWorkError(
      "commit_not_on_origin",
      `Commit ${source.head.slice(0, 12)} is not on origin, so this machine cannot check it out. Push it first (git push), then run the command again.`,
    );
  };

  /**
   * The tree id of everything in the copy that git would commit with
   * `git add -A`, without touching the copy's own index: a copy of the index
   * keeps the stat cache, so only changed files are hashed.
   */
  const workingTree = async (copyPath: string): Promise<string> => {
    const indexPath = await gitOrThrow(["rev-parse", "--path-format=absolute", "--git-path", "index"], copyPath, "Could not find the work copy's index");
    const tempIndex = path.join(os.tmpdir(), `ade-remote-work-index-${randomUUID()}`);
    try {
      try {
        fs.copyFileSync(indexPath, tempIndex);
      } catch {
        // No index yet: git builds one from scratch.
      }
      const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
      await gitOrThrow(["-c", "core.sparseCheckout=false", "add", "-A"], copyPath, "Could not read the work copy", { env });
      return await gitOrThrow(["write-tree"], copyPath, "Could not read the work copy", { env });
    } finally {
      fs.rmSync(tempIndex, { force: true });
    }
  };

  /**
   * Why a sync would lose work in this copy, or null when it would not. Work
   * that reached origin is safe; work nobody synced in and nobody pushed is not.
   */
  const unsyncedWork = async (copy: RemoteWorkCopy): Promise<string | null> => {
    const head = await gitOrThrow(["rev-parse", "HEAD"], copy.path, "Could not read the work copy");
    // An adopted copy (never synced here) may hold commits made before it was lost from the list.
    if (copy.syncedTree === null || head.toLowerCase() !== copy.head.toLowerCase()) {
      const remotes = await git(["branch", "-r", "--contains", "HEAD"], copy.path);
      if (remotes.exitCode !== 0 || !remotes.stdout.trim()) {
        return "it has commits that are not pushed";
      }
    }
    // A file is at risk only if it differs from what the last sync wrote AND
    // from the commit checked out now: a file the sync wrote, or one committed
    // (and so pushed, above) there, is safe to reset.
    const current = await workingTree(copy.path);
    const committed = await gitOrThrow(["rev-parse", "HEAD^{tree}"], copy.path, "Could not read the work copy");
    const changedPaths = async (from: string): Promise<Set<string>> => new Set(
      (await gitOrThrow(["diff", "--name-only", "-z", from, current], copy.path, "Could not read the work copy"))
        .split("\0").filter(Boolean),
    );
    const sinceCommit = await changedPaths(committed);
    const atRisk = copy.syncedTree
      ? [...(await changedPaths(copy.syncedTree))].filter((file) => sinceCommit.has(file))
      : [...sinceCommit];
    if (atRisk.length) {
      const named = atRisk.slice(0, 3).join(", ") + (atRisk.length > 3 ? ` and ${atRisk.length - 3} more` : "");
      return `it has changes made there that are not committed and pushed (${named})`;
    }
    return null;
  };

  const syncCopy = async (copyPath: string, source: RemoteWorkSource, patch: Buffer | null): Promise<string> => {
    // A work copy is ADE's own throwaway: the project's checkout hooks are not for it.
    await gitOrThrow([...WORK_COPY_NO_HOOKS, "checkout", "--force", "--detach", source.head], copyPath, "Could not check out the chat's commit");
    // No -x: ignored files (installed deps, build output) survive between runs.
    // Removing a `.gitignore` can uncover files it was hiding, so go until clean.
    for (let pass = 0; pass < WORK_COPY_CLEAN_PASSES; pass += 1) {
      const removed = await gitOrThrow(["clean", "-fd"], copyPath, "Could not clean the work copy");
      if (!removed.trim()) break;
    }
    if (patch && patch.length > 0) {
      // A file, not a string on stdin: the patch is bytes, and a text file in
      // another encoding must arrive as it was.
      const patchFile = path.join(os.tmpdir(), `ade-remote-work-patch-${randomUUID()}.patch`);
      try {
        fs.writeFileSync(patchFile, patch);
        await removeIgnoredLeftoversThePatchCreates(copyPath, patchFile);
        await gitOrThrow(["apply", "--binary", "--whitespace=nowarn", "--", patchFile], copyPath, "Could not apply the chat's uncommitted changes");
      } finally {
        fs.rmSync(patchFile, { force: true });
      }
    }
    return await workingTree(copyPath);
  };

  /**
   * A file the chat's patch creates (untracked on the chat's machine) can be
   * ignored HERE, by this machine's global excludes or `.git/info/exclude`.
   * `clean -fd` keeps ignored files, so the copy of it from the last sync is
   * still there and `git apply` refuses it ("already exists in working
   * directory"). Only the patch's own new files are removed, and only plain
   * files or links that resolve inside the copy; ignored build output
   * elsewhere stays (no `clean -x`).
   */
  const removeIgnoredLeftoversThePatchCreates = async (copyPath: string, patchFile: string): Promise<void> => {
    // `-z` prints names as they are (unquoted), one `create mode` line each.
    const summary = await git(["apply", "--summary", "-z", "--", patchFile], copyPath);
    if (summary.exitCode !== 0) return; // `git apply` itself reports a bad patch next.
    const root = fs.realpathSync(copyPath);
    // Strictly inside: the copy itself is never a leftover to remove.
    const inside = (candidate: string): boolean => !pathsEqual(candidate, root) && isPathInside(candidate, root);
    for (const line of summary.stdout.split("\n")) {
      const match = /^ create mode \d{6} (.+)$/.exec(line);
      if (!match) continue;
      const relative = match[1]!;
      const target = path.resolve(root, relative);
      if (!inside(target)) {
        logger?.warn("remote_work.patch_path_outside_copy", { path: relative });
        continue;
      }
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(target);
      } catch {
        continue; // Not there: nothing in the way.
      }
      if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      // A linked parent folder could point outside the copy.
      let parent: string;
      try {
        parent = fs.realpathSync(path.dirname(target));
      } catch {
        continue;
      }
      if (!pathsEqual(parent, root) && !inside(parent)) {
        logger?.warn("remote_work.patch_path_outside_copy", { path: relative });
        continue;
      }
      fs.rmSync(path.join(parent, path.basename(target)), { force: true });
      logger?.info("remote_work.removed_ignored_leftover", { path: relative });
    }
  };

  const removeCopyFiles = async (copyPath: string): Promise<void> => {
    const removed = await git(["worktree", "remove", "--force", copyPath], projectRoot);
    if (removed.exitCode !== 0) {
      fs.rmSync(copyPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      await git(["worktree", "prune"], projectRoot);
    }
  };

  /** The folder a copy for `owner` lives in, whether or not it exists. */
  const pathFor = (owner: string): string => path.join(root, ownerHash(owner));
  const get = (owner: string): RemoteWorkCopy | null =>
    readRegistry().copies.find((copy) => copy.owner === owner) ?? null;

  const busyError = (): RemoteWorkError => new RemoteWorkError(
    "copy_busy",
    "A command still runs in this chat's work copy here. Wait for it to end, or stop it "
    + "(`ade terminal list --machine <this machine>` shows it).",
  );

  /**
   * Delete the copy for `owner`. True when one existed. Refused while it is in
   * use. With `keepUnsynced` (the automatic cleanups that run on a guess), a
   * copy holding work nobody pushed is kept: false. With `keepDeviceInUse`
   * (the idle and low-disk cleanups), so is a copy whose simulator or
   * emulator is booted, streaming or claimed: a chat can drive a device for
   * days without a shell. A person's delete, or the chat being gone, still
   * releases the copy and with it the device.
   */
  const release = async (
    owner: string,
    releaseOptions: { keepUnsynced?: boolean; keepDeviceInUse?: boolean; onlyIfUnusedBefore?: number } = {},
  ): Promise<boolean> =>
    await withLock(owner, async () => {
      if (inUse(owner)) throw busyError();
      if (releaseOptions.keepDeviceInUse && drivesDevice(owner)) {
        logger?.info("remote_work.kept_device_in_use", { owner });
        return false;
      }
      const copy = get(owner);
      // Re-read in the lock: a command may have used the copy since the sweep chose it.
      if (copy && releaseOptions.onlyIfUnusedBefore != null && Date.parse(copy.lastUsedAt) >= releaseOptions.onlyIfUnusedBefore) {
        return false;
      }
      const copyPath = copy?.path ?? pathFor(owner);
      if (copy && releaseOptions.keepUnsynced && fs.existsSync(copyPath)) {
        const reason = await unsyncedWork(copy).catch((error: unknown) => {
          logger?.warn("remote_work.unsynced_check_failed", { owner, error: error instanceof Error ? error.message : String(error) });
          return "its state could not be read";
        });
        if (reason) {
          logger?.info("remote_work.kept_unsynced", { owner, reason });
          return false;
        }
      }
      const existed = Boolean(copy) || fs.existsSync(copyPath);
      if (fs.existsSync(copyPath)) await removeCopyFiles(copyPath);
      updateCopy(owner, () => null);
      if (existed) {
        logger?.info("remote_work.released", { owner });
        notifyCopyReleased(projectRoot, owner, logger);
      }
      return existed;
    });

  /** Release, but a copy that is busy now is skipped rather than an error. */
  const releaseIfIdle = async (owner: string, releaseOptions: Parameters<typeof release>[1] = {}): Promise<boolean> => {
    try {
      return await release(owner, releaseOptions);
    } catch (error) {
      if (error instanceof RemoteWorkError && error.code === "copy_busy") return false;
      throw error;
    }
  };

  /** A low disk deletes other chats' idle copies, oldest first, before refusing. */
  const makeRoomForCopy = async (owner: string): Promise<void> => {
    let free = freeBytes();
    if (free == null || free >= REMOTE_WORK_RECLAIM_FREE_BYTES) return;
    // A copy another call holds is skipped, never waited for: two prepares
    // freeing each other's copies would wait on each other's locks.
    const oldestFirst = readRegistry().copies
      .filter((copy) => copy.owner !== owner && !state.locks.has(copy.owner))
      .sort((a, b) => Date.parse(a.lastUsedAt) - Date.parse(b.lastUsedAt));
    for (const copy of oldestFirst) {
      await releaseIfIdle(copy.owner, { keepUnsynced: true, keepDeviceInUse: true });
      free = freeBytes();
      if (free == null || free >= REMOTE_WORK_RECLAIM_FREE_BYTES) return;
    }
    if (free != null && free < REMOTE_WORK_MIN_FREE_BYTES) {
      throw new RemoteWorkError(
        "disk_full",
        `This machine has ${Math.floor(free / 1024 ** 3)} GB free, too little for a new work copy. Free some disk there or use another machine.`,
      );
    }
  };

  /**
   * A copy folder the list lost (a damaged or replaced copies.json): keep it,
   * list it unsynced, and let the guarded sync take it over rather than
   * deleting what it holds. Null when there is no such folder.
   */
  const adoptUnlistedCopy = async (owner: string, source: RemoteWorkSource, timestamp: string): Promise<RemoteWorkCopy | null> => {
    const copyPath = pathFor(owner);
    if (!fs.existsSync(path.join(copyPath, ".git"))) return null;
    // A folder that is there but unreadable is refused, not replaced: it may hold work.
    const head = await gitOrThrow(["rev-parse", "HEAD"], copyPath, "Could not read the work copy left in this chat's folder here");
    logger?.warn("remote_work.adopted_unlisted_copy", { owner, path: copyPath });
    const copy: RemoteWorkCopy = { owner, path: copyPath, head, branch: source.branch ?? null, machineName: source.machineName ?? null, syncedTree: null, createdAt: timestamp, lastUsedAt: timestamp };
    updateCopy(owner, () => copy);
    return copy;
  };

  /** A new copy for `owner` at the chat's commit, synced. */
  const createCopy = async (owner: string, source: RemoteWorkSource, patch: Buffer | null, timestamp: string): Promise<RemoteWorkCopy> => {
    const copyPath = pathFor(owner);
    await makeRoomForCopy(owner);
    await ensureCommit(source);
    if (fs.existsSync(copyPath)) await removeCopyFiles(copyPath);
    await git(["worktree", "prune"], projectRoot);
    fs.mkdirSync(root, { recursive: true });
    await gitOrThrow([...WORK_COPY_NO_HOOKS, "worktree", "add", "--detach", copyPath, source.head], projectRoot, "Could not create the work copy");
    const syncedTree = await syncCopy(copyPath, source, patch);
    const copy: RemoteWorkCopy = {
      owner,
      path: copyPath,
      head: source.head,
      branch: source.branch ?? null,
      machineName: source.machineName ?? null,
      syncedTree,
      createdAt: timestamp,
      lastUsedAt: timestamp,
    };
    updateCopy(owner, () => copy);
    logger?.info("remote_work.created", { owner, head: source.head });
    return copy;
  };

  /**
   * Make the copy for `owner` ready for one command: create it on first
   * use, then sync it to `source` unless `mode` says otherwise. The copy is
   * busy until the result's `done` is called.
   */
  const prepare = async (owner: string, source: RemoteWorkSource, mode: RemoteWorkSyncMode = "sync"): Promise<RemoteWorkPrepareResult> => {
    if (!SHA.test(source.head)) throw new RemoteWorkError("invalid_source", "The chat's commit id is not valid.");
    const patch = source.patchBase64 ? Buffer.from(source.patchBase64, "base64") : null;
    if ((patch?.length ?? 0) > REMOTE_WORK_MAX_PATCH_BYTES) {
      throw new RemoteWorkError(
        "patch_too_large",
        `The uncommitted changes are over ${REMOTE_WORK_MAX_PATCH_BYTES / (1024 * 1024)} MiB. Commit and push them, then run the command again.`,
      );
    }
    return await withLock(owner, async () => {
      const timestamp = new Date(now()).toISOString();
      let copy = get(owner);
      if (!copy || !fs.existsSync(copy.path)) {
        if (inUse(owner)) throw busyError();
        // An adopted folder goes through the guarded sync below; a new copy is synced already.
        const adopted = await adoptUnlistedCopy(owner, source, timestamp);
        if (!adopted) {
          const created = await createCopy(owner, source, patch, timestamp);
          return { path: created.path, created: true, synced: true, done: markStarting(owner) };
        }
        copy = adopted;
      }
      if (mode === "none") {
        // Taps and screenshots come many a minute: note the use at most once a minute.
        if (now() - Date.parse(copy.lastUsedAt) > 60_000) {
          updateCopy(owner, (current) => (current ? { ...current, lastUsedAt: timestamp } : current));
        }
        return { path: copy.path, created: false, synced: false, done: markStarting(owner) };
      }
      if (inUse(owner)) {
        throw new RemoteWorkError(
          "copy_busy",
          "A command still runs in this chat's work copy here, so it was not synced. Wait for it to end, or stop it "
          + "(`ade terminal list --machine <this machine>` shows it). To use the copy as it is, pass --no-sync.",
        );
      }
      if (mode !== "discard") {
        const reason = await unsyncedWork(copy);
        if (reason) {
          throw new RemoteWorkError(
            "copy_has_unsynced_work",
            `This chat's work copy here was not synced because ${reason}. Pass --no-sync to use the copy as it is `
            + "(and commit and push that work from there: `ade shell start --machine <this machine> --no-sync -- git push origin HEAD:<branch>`), "
            + "or --discard to throw it away.",
          );
        }
      }
      await ensureCommit(source);
      const syncedTree = await syncCopy(copy.path, source, patch);
      updateCopy(owner, (current) => (current ? {
        ...current,
        head: source.head,
        branch: source.branch ?? current.branch,
        machineName: source.machineName ?? current.machineName,
        syncedTree,
        lastUsedAt: timestamp,
      } : current));
      return { path: copy.path, created: false, synced: true, done: markStarting(owner) };
    });
  };

  /** `work` resolved, or null once `waitMs` passes first. */
  const waitAtMost = async <T>(work: Promise<T>, waitMs: number): Promise<{ value: T } | null> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        work.then((value) => ({ value })),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), waitMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  /**
   * `prepare`, for a call that must answer in time. A copy that exists is
   * prepared as usual. A new one is made under its own git budgets: when that
   * takes longer than REMOTE_WORK_FIRST_COPY_WAIT_MS, the answer is
   * `preparing` and the make goes on in the background; the next call for the
   * owner joins it (with the same wait) and then prepares as usual. A background make that failed is
   * that next call's error only when the call is for the same commit; a call
   * for another commit starts over.
   */
  const prepareWithin = async (
    owner: string,
    source: RemoteWorkSource,
    mode: RemoteWorkSyncMode = "sync",
  ): Promise<RemoteWorkPrepareWithinResult> => {
    const waitMs = REMOTE_WORK_FIRST_COPY_WAIT_MS;
    const making = state.making.get(owner);
    if (making) {
      if (!(await waitAtMost(making.done, waitMs))) return { preparing: true };
      if (state.making.get(owner) === making) state.making.delete(owner);
      if (making.failure && making.head.toLowerCase() === source.head.toLowerCase()) throw making.failure;
    }
    const existing = get(owner);
    if (existing && fs.existsSync(existing.path)) return { prepared: await prepare(owner, source, mode) };

    // No copy yet: make it, and answer in time either way.
    const work = prepare(owner, source, mode);
    const answered = await waitAtMost(work, waitMs);
    if (answered) return { prepared: answered.value };
    const job: BackgroundMake = { done: Promise.resolve(), head: source.head, failure: null };
    job.done = work.then(
      (prepared) => {
        // Nobody runs a command for this make: the copy is not busy.
        prepared.done();
        logger?.info("remote_work.copy_made_after_answer", { owner });
        if (state.making.get(owner) === job) state.making.delete(owner);
      },
      (error: unknown) => {
        job.failure = error;
        logger?.warn("remote_work.copy_make_failed_after_answer", { owner, error: error instanceof Error ? error.message : String(error) });
        setTimeout(() => {
          if (state.making.get(owner) === job) state.making.delete(owner);
        }, FAILED_MAKE_RETENTION_MS).unref?.();
      },
    );
    state.making.set(owner, job);
    logger?.info("remote_work.copy_still_being_made", { owner, waitedMs: waitMs });
    return { preparing: true };
  };

  return {
    get,
    list(): RemoteWorkCopy[] {
      return readRegistry().copies;
    },

    prepare,
    prepareWithin,

    release,

    /**
     * Delete copies unused for a week (unless they hold unpushed work),
     * and copies whose chat was deleted or archived on its own machine.
     * `ownerGone` answers the second; it is never asked about a copy in use,
     * and silence (null) keeps the copy.
     */
    async sweep(sweepOptions: {
      ownerGone?: (owner: string) => Promise<{ gone: boolean; archived: boolean } | null>;
    } = {}): Promise<number> {
      const cutoff = now() - REMOTE_WORK_IDLE_MS;
      let released = 0;
      for (const copy of readRegistry().copies) {
        if (inUse(copy.owner)) continue;
        // An idle copy kept (its device is in use, or it holds unpushed work)
        // still goes to the gone check: a deleted or archived chat gives its
        // copy, and with it the device, back.
        if (Date.parse(copy.lastUsedAt) < cutoff
          && await releaseIfIdle(copy.owner, { keepUnsynced: true, keepDeviceInUse: true, onlyIfUnusedBefore: cutoff })) {
          released += 1;
          continue;
        }
        const answer = sweepOptions.ownerGone
          ? await sweepOptions.ownerGone(copy.owner).catch((error: unknown) => {
            logger?.warn("remote_work.owner_check_failed", { owner: copy.owner, error: error instanceof Error ? error.message : String(error) });
            return null;
          })
          : null;
        // An archived chat can come back: its unpushed work stays until a person deletes it.
        if (answer?.gone && await releaseIfIdle(copy.owner, answer.archived ? { keepUnsynced: true } : {})) {
          released += 1;
          logger?.info("remote_work.owner_gone", { owner: copy.owner, archived: answer.archived });
        }
      }
      return released;
    },
  };
}

export type RemoteWorkCopyService = ReturnType<typeof createRemoteWorkCopyService>;

/**
 * How a project's runtime tells whether a shell still runs in a copy (its
 * terminals). Registered once when the runtime starts; the returned function
 * removes it when the runtime is disposed. A project with no runtime has no
 * running shells.
 */
export function registerRemoteWorkShellCheck(projectRoot: string, shellRunsIn: (owner: string) => boolean): () => void {
  const state = projectStateFor(projectRoot);
  state.shellRunsIn = shellRunsIn;
  return () => {
    if (state.shellRunsIn === shellRunsIn) state.shellRunsIn = null;
  };
}

/**
 * How a device service (the iOS simulator, the Android emulator) tells the
 * idle and low-disk cleanups that a copy's device is in use: booted,
 * streaming or claimed for the copy's lane id (`remote-work-…`). Registered
 * by each service when it starts; the returned function removes it.
 */
export function registerRemoteWorkDeviceCheck(projectRoot: string, deviceInUse: (laneId: string) => boolean): () => void {
  const state = projectStateFor(projectRoot);
  state.deviceInUse.add(deviceInUse);
  return () => {
    state.deviceInUse.delete(deviceInUse);
  };
}

/**
 * Calls `listener` with the copy's lane id (`remote-work-…`) each time a copy
 * of this project is deleted here: `ade shell clean`, a delete in Settings,
 * the idle or low-disk sweep, or its chat gone. The Android service gives the
 * copy's device back on it. A copy deleted while no listener runs is caught
 * by that service's start-up pass. Returns the function that removes it.
 */
export function onRemoteWorkCopyReleased(projectRoot: string, listener: (laneId: string) => void): () => void {
  const state = projectStateFor(projectRoot);
  state.released.add(listener);
  return () => {
    state.released.delete(listener);
  };
}

function notifyCopyReleased(projectRoot: string, owner: string, logger?: RemoteWorkLogger): void {
  const laneId = remoteWorkLaneIdFor(owner);
  for (const listener of projectStateFor(projectRoot).released) {
    try {
      listener(laneId);
    } catch (error) {
      logger?.warn("remote_work.release_listener_failed", { owner, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/** A command was readied for this copy and has not started, or a shell still runs in it. */
export function isRemoteWorkCopyInUse(projectRoot: string, owner: string): boolean {
  const state = projectStateFor(projectRoot);
  if ((state.starting.get(owner) ?? 0) > 0) return true;
  try {
    return state.shellRunsIn?.(owner) === true;
  } catch (error) {
    // The runtime's terminals could not be read: count the copy as in use, so nothing is deleted on a guess.
    console.warn(`[remote_work] could not tell whether a shell runs in ${owner}'s work copy`, error);
    return true;
  }
}

/** A device service says this copy's simulator or emulator is in use. An answer that cannot be read counts as in use. */
export function remoteWorkCopyDrivesDevice(projectRoot: string, owner: string): boolean {
  const laneId = remoteWorkLaneIdFor(owner);
  for (const deviceInUse of projectStateFor(projectRoot).deviceInUse) {
    try {
      if (deviceInUse(laneId)) return true;
    } catch (error) {
      console.warn(`[remote_work] could not tell whether ${owner}'s work copy drives a device`, error);
      return true;
    }
  }
  return false;
}

/**
 * One sweep of every project on this machine that holds work copies (the
 * brain runs it on a timer). `ownerGone` names a copy's chat as gone or
 * archived on its own machine; see `sweep`.
 */
export async function sweepMachineRemoteWork(sweepOptions: {
  adeHome?: string;
  logger?: RemoteWorkLogger;
  ownerGone?: (owner: string) => Promise<{ gone: boolean; archived: boolean } | null>;
} = {}): Promise<number> {
  let released = 0;
  for (const entry of readMachineIndex(sweepOptions.adeHome ?? defaultAdeHome(), sweepOptions.logger).projects) {
    try {
      released += await createRemoteWorkCopyService({ projectRoot: entry.projectRoot, adeHome: sweepOptions.adeHome, logger: sweepOptions.logger })
        .sweep({ ownerGone: sweepOptions.ownerGone });
    } catch (error) {
      sweepOptions.logger?.warn("remote_work.sweep_failed", { projectRoot: entry.projectRoot, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return released;
}

function isCopy(value: unknown): value is RemoteWorkCopy {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.owner === "string"
    && typeof record.path === "string"
    && typeof record.head === "string"
    && typeof record.createdAt === "string"
    && typeof record.lastUsedAt === "string";
}

/**
 * Bytes a copy takes on disk, counting what its commands installed and built.
 * Null when the walk runs past `budgetMs` (a copy with a huge node_modules):
 * a person sees "size unknown" rather than a list that never loads.
 */
export async function measureRemoteWorkCopy(copyPath: string, budgetMs = 3_000): Promise<number | null> {
  const deadline = Date.now() + budgetMs;
  let total = 0;
  const pending = [copyPath];
  while (pending.length) {
    if (Date.now() > deadline) return null;
    const dir = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.isFile()) {
        try {
          total += (await fs.promises.lstat(full)).size;
        } catch {
          // Gone between the read and the stat.
        }
      }
    }
  }
  return total;
}
