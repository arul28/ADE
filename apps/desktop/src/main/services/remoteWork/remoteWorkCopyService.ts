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
import { pathComparisonKey, pathsEqual } from "../shared/pathCompare";
import { writeTextAtomic } from "../shared/utils";
import { REMOTE_WORK_MAX_PATCH_BYTES } from "../../../shared/types/remoteWork";

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
const FETCH_TIMEOUT_MS = 300_000;

/**
 * A work copy stands in for a lane where a service keys its state by lane,
 * as the Apple device registry does: `remote-work-<12 hex>`, the same hash as
 * the copy's folder. No real lane id has this prefix (they are UUIDs).
 */
export const REMOTE_WORK_LANE_PREFIX = "remote-work-";

function ownerHash(owner: string): string {
  return createHash("sha256").update(owner).digest("hex").slice(0, 12);
}

export function remoteWorkLaneIdFor(owner: string): string {
  return `${REMOTE_WORK_LANE_PREFIX}${ownerHash(owner)}`;
}

export function isRemoteWorkLaneId(laneId: string | null | undefined): boolean {
  return typeof laneId === "string" && laneId.startsWith(REMOTE_WORK_LANE_PREFIX);
}

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
 * copy, the copies whose command has not started yet, and the newest way to
 * ask whether a shell still runs in a copy (from the project's runtime).
 */
type ProjectState = {
  locks: Map<string, Promise<unknown>>;
  starting: Map<string, number>;
  shellRunsIn: ((owner: string) => boolean) | null;
};
const projectStates = new Map<string, ProjectState>();

function projectStateFor(projectRoot: string): ProjectState {
  // Case-folded where the file system folds case, so the sweep and the runtime share one state.
  const key = pathComparisonKey(path.resolve(projectRoot));
  let state = projectStates.get(key);
  if (!state) {
    state = { locks: new Map(), starting: new Map(), shellRunsIn: null };
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
type MachineIndex = { version: 1; projects: Array<{ projectRoot: string }> };

function defaultAdeHome(): string {
  const fromEnv = process.env.ADE_HOME?.trim();
  return path.resolve(fromEnv || path.join(os.homedir(), ".ade"));
}

function machineIndexPath(adeHome: string): string {
  return path.join(adeHome, "remote-work", "projects.json");
}

function readMachineIndex(adeHome: string): MachineIndex {
  try {
    const parsed = JSON.parse(fs.readFileSync(machineIndexPath(adeHome), "utf8")) as Partial<MachineIndex>;
    const projects = Array.isArray(parsed.projects)
      ? parsed.projects.filter((entry): entry is MachineIndex["projects"][number] =>
        Boolean(entry) && typeof entry.projectRoot === "string")
      : [];
    return { version: 1, projects };
  } catch {
    // Missing (no copies yet) or damaged: the index is rebuilt by the next copy written.
    return { version: 1, projects: [] };
  }
}

function writeMachineIndexEntry(adeHome: string, projectRoot: string, present: boolean): void {
  const index = readMachineIndex(adeHome);
  const listed = index.projects.some((entry) => pathsEqual(entry.projectRoot, projectRoot));
  if (listed === present) return;
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
  for (const entry of readMachineIndex(adeHome).projects) {
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
      writeMachineIndexEntry(adeHome, projectRoot, registry.copies.length > 0);
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
      await gitOrThrow(["add", "-A"], copyPath, "Could not read the work copy", { env });
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
    await gitOrThrow(["checkout", "--force", "--detach", source.head], copyPath, "Could not check out the chat's commit");
    // No -x: ignored files (installed deps, build output) survive between runs.
    await gitOrThrow(["clean", "-fd"], copyPath, "Could not clean the work copy");
    if (patch && patch.length > 0) {
      // A file, not a string on stdin: the patch is bytes, and a text file in
      // another encoding must arrive as it was.
      const patchFile = path.join(os.tmpdir(), `ade-remote-work-patch-${randomUUID()}.patch`);
      try {
        fs.writeFileSync(patchFile, patch);
        await gitOrThrow(["apply", "--binary", "--whitespace=nowarn", "--", patchFile], copyPath, "Could not apply the chat's uncommitted changes");
      } finally {
        fs.rmSync(patchFile, { force: true });
      }
    }
    return await workingTree(copyPath);
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
   * copy holding work nobody pushed is kept: false.
   */
  const release = async (
    owner: string,
    releaseOptions: { keepUnsynced?: boolean; onlyIfUnusedBefore?: number } = {},
  ): Promise<boolean> =>
    await withLock(owner, async () => {
      if (inUse(owner)) throw busyError();
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
      if (existed) logger?.info("remote_work.released", { owner });
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
      await releaseIfIdle(copy.owner, { keepUnsynced: true });
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
    await gitOrThrow(["worktree", "add", "--detach", copyPath, source.head], projectRoot, "Could not create the work copy");
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

  return {
    get,
    list(): RemoteWorkCopy[] {
      return readRegistry().copies;
    },

    /**
     * Make the copy for `owner` ready for one command: create it on first
     * use, then sync it to `source` unless `mode` says otherwise. The copy is
     * busy until the result's `done` is called.
     */
    async prepare(owner: string, source: RemoteWorkSource, mode: RemoteWorkSyncMode = "sync"): Promise<RemoteWorkPrepareResult> {
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
    },

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
        if (Date.parse(copy.lastUsedAt) < cutoff) {
          if (await releaseIfIdle(copy.owner, { keepUnsynced: true, onlyIfUnusedBefore: cutoff })) released += 1;
          continue;
        }
        const answer = sweepOptions.ownerGone
          ? await sweepOptions.ownerGone(copy.owner).catch((error: unknown) => {
            logger?.warn("remote_work.owner_check_failed", { owner: copy.owner, error: error instanceof Error ? error.message : String(error) });
            return null;
          })
          : null;
        if (answer?.gone && await releaseIfIdle(copy.owner)) {
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
  for (const entry of readMachineIndex(sweepOptions.adeHome ?? defaultAdeHome()).projects) {
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
