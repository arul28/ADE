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
 *    discards them on purpose.
 *  - Never clutter. A copy is deleted when its chat asks, when its chat is
 *    deleted or archived on its own machine, after a week unused, and first
 *    when the disk runs low.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGit, type GitRunResult } from "../git/git";
import { writeTextAtomic } from "../shared/utils";

/** What the calling chat sends with each command. */
export type RemoteWorkSource = {
  /** The chat's commit. Must exist on origin. */
  head: string;
  /** Remote branch that holds `head` (e.g. `ade/my-lane`), fetched when the commit is missing here. */
  fetchRef?: string | null;
  /** `git diff --binary` of the chat's uncommitted changes against `head`, untracked files included. */
  patch?: string | null;
  /** The chat's branch, for people reading the copy list. */
  branch?: string | null;
  /** The machine the chat runs on, for people reading the copy list. */
  machineName?: string | null;
};

export type RemoteWorkSyncMode =
  /** Reset the copy to the chat's commit and changes (default). */
  | "sync"
  /** Run in the copy as it is. */
  | "none"
  /** Reset even if the copy holds work nobody synced in. */
  | "discard";

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
};

export class RemoteWorkError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** A copy unused this long is deleted by the sweep. */
export const REMOTE_WORK_IDLE_MS = 7 * 24 * 60 * 60_000;
/** Below this much free disk, older copies are deleted before a new one is made. */
export const REMOTE_WORK_RECLAIM_FREE_BYTES = 20 * 1024 ** 3;
/** Below this much free disk, no new copy is made. */
export const REMOTE_WORK_MIN_FREE_BYTES = 5 * 1024 ** 3;
/** Largest uncommitted patch a chat may send. Bigger changes go through git. */
export const REMOTE_WORK_MAX_PATCH_BYTES = 16 * 1024 * 1024;

const SHA = /^[0-9a-f]{40}$/i;
const REGISTRY_FILE = "copies.json";
const GIT_TIMEOUT_MS = 120_000;
const FETCH_TIMEOUT_MS = 300_000;

type Registry = { version: 1; copies: RemoteWorkCopy[] };

export type RemoteWorkCopyServiceOptions = {
  projectRoot: string;
  logger?: { info(event: string, data?: Record<string, unknown>): void; warn(event: string, data?: Record<string, unknown>): void };
  /** True while a shell still runs in the copy; a sync then waits for it to end. */
  isInUse?: (copy: { owner: string; path: string }) => boolean;
  now?: () => number;
  /** Free bytes on the project's disk; null when unknown. */
  freeBytes?: () => number | null;
};

function defaultFreeBytes(dir: string): number | null {
  try {
    const stats = fs.statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

export function createRemoteWorkCopyService(options: RemoteWorkCopyServiceOptions) {
  const { projectRoot } = options;
  const now = options.now ?? (() => Date.now());
  const freeBytes = options.freeBytes ?? (() => defaultFreeBytes(projectRoot));
  const root = path.join(projectRoot, ".ade", "remote-work");
  const registryPath = path.join(root, REGISTRY_FILE);
  /** One operation per copy at a time; a second command waits for the first sync. */
  const locks = new Map<string, Promise<unknown>>();

  const readRegistry = (): Registry => {
    try {
      const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8")) as Partial<Registry>;
      const copies = Array.isArray(parsed.copies) ? parsed.copies.filter(isCopy) : [];
      return { version: 1, copies };
    } catch {
      return { version: 1, copies: [] };
    }
  };
  const writeRegistry = (registry: Registry): void => {
    writeTextAtomic(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  };
  const updateCopy = (owner: string, update: (copy: RemoteWorkCopy | null) => RemoteWorkCopy | null): void => {
    const registry = readRegistry();
    const rest = registry.copies.filter((copy) => copy.owner !== owner);
    const next = update(registry.copies.find((copy) => copy.owner === owner) ?? null);
    writeRegistry({ version: 1, copies: next ? [...rest, next] : rest });
  };

  const withLock = async <T>(owner: string, run: () => Promise<T>): Promise<T> => {
    const previous = locks.get(owner) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(run);
    locks.set(owner, current);
    try {
      return await current;
    } finally {
      if (locks.get(owner) === current) locks.delete(owner);
    }
  };

  const git = (args: string[], cwd: string, extra: { stdin?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<GitRunResult> =>
    runGit(args, { cwd, timeoutMs: extra.timeoutMs ?? GIT_TIMEOUT_MS, ...(extra.stdin != null ? { stdin: extra.stdin } : {}), ...(extra.env ? { env: extra.env } : {}) });

  const gitOrThrow = async (args: string[], cwd: string, failure: string, extra?: { stdin?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<string> => {
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
    const fetchArgs = ref && /^[A-Za-z0-9._/-]+$/.test(ref) && !ref.startsWith("-")
      ? ["fetch", "--no-tags", "origin", ref]
      : ["fetch", "--no-tags", "origin"];
    await git(fetchArgs, projectRoot, { timeoutMs: FETCH_TIMEOUT_MS });
    if (await hasCommit(source.head)) return;
    // Some hosts serve a reachable commit by id even when no branch was named.
    await git(["fetch", "--no-tags", "origin", source.head], projectRoot, { timeoutMs: FETCH_TIMEOUT_MS });
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
    if (head.toLowerCase() !== copy.head.toLowerCase()) {
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

  const syncCopy = async (copy: RemoteWorkCopy, source: RemoteWorkSource): Promise<string> => {
    await gitOrThrow(["checkout", "--force", "--detach", source.head], copy.path, "Could not check out the chat's commit");
    // No -x: ignored files (installed deps, build output) survive between runs.
    await gitOrThrow(["clean", "-fd"], copy.path, "Could not clean the work copy");
    const patch = source.patch ?? "";
    if (patch.trim()) {
      await gitOrThrow(
        ["apply", "--binary", "--whitespace=nowarn", "-"],
        copy.path,
        "Could not apply the chat's uncommitted changes",
        { stdin: patch.endsWith("\n") ? patch : `${patch}\n` },
      );
    }
    return await workingTree(copy.path);
  };

  const removeCopyFiles = async (copyPath: string): Promise<void> => {
    const removed = await git(["worktree", "remove", "--force", copyPath], projectRoot);
    if (removed.exitCode !== 0) {
      fs.rmSync(copyPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      await git(["worktree", "prune"], projectRoot);
    }
  };

  /** The folder a copy for `owner` lives in, whether or not it exists. */
  const pathFor = (owner: string): string =>
    path.join(root, createHash("sha256").update(owner).digest("hex").slice(0, 12));
  const get = (owner: string): RemoteWorkCopy | null =>
    readRegistry().copies.find((copy) => copy.owner === owner) ?? null;

  const release = async (owner: string): Promise<boolean> =>
    await withLock(owner, async () => {
      const copy = get(owner);
      const copyPath = copy?.path ?? pathFor(owner);
      const existed = Boolean(copy) || fs.existsSync(copyPath);
      if (fs.existsSync(copyPath)) await removeCopyFiles(copyPath);
      updateCopy(owner, () => null);
      if (existed) options.logger?.info("remote_work.released", { owner });
      return existed;
    });

  const releaseWhere = async (match: (copy: RemoteWorkCopy) => boolean): Promise<number> => {
    let count = 0;
    for (const copy of readRegistry().copies.filter(match)) {
      if (await release(copy.owner)) count += 1;
    }
    return count;
  };

  /** A low disk deletes other chats' idle copies, oldest first, before refusing. */
  const makeRoomForCopy = async (owner: string): Promise<void> => {
    let free = freeBytes();
    if (free == null || free >= REMOTE_WORK_RECLAIM_FREE_BYTES) return;
    const idle = readRegistry().copies
      .filter((copy) => copy.owner !== owner && !options.isInUse?.(copy))
      .sort((a, b) => Date.parse(a.lastUsedAt) - Date.parse(b.lastUsedAt));
    for (const copy of idle) {
      await release(copy.owner);
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

  return {
    pathFor,
    get,
    list(): RemoteWorkCopy[] {
      return readRegistry().copies;
    },

    /**
     * Make the copy for `owner` ready for one command: create it on first
     * use, then sync it to `source` unless `mode` says otherwise.
     */
    async prepare(owner: string, source: RemoteWorkSource, mode: RemoteWorkSyncMode = "sync"): Promise<RemoteWorkPrepareResult> {
      if (!SHA.test(source.head)) throw new RemoteWorkError("invalid_source", "The chat's commit id is not valid.");
      if ((source.patch?.length ?? 0) > REMOTE_WORK_MAX_PATCH_BYTES) {
        throw new RemoteWorkError(
          "patch_too_large",
          `The uncommitted changes are over ${REMOTE_WORK_MAX_PATCH_BYTES / (1024 * 1024)} MiB. Commit and push them, then run the command again.`,
        );
      }
      return await withLock(owner, async () => {
        const copyPath = pathFor(owner);
        const existing = get(owner);
        const timestamp = new Date(now()).toISOString();
        if (!existing || !fs.existsSync(copyPath)) {
          if (mode === "none") {
            throw new RemoteWorkError("no_copy", "There is no work copy on this machine yet. Run a command without --no-sync first.");
          }
          await makeRoomForCopy(owner);
          await ensureCommit(source);
          if (fs.existsSync(copyPath)) await removeCopyFiles(copyPath);
          await git(["worktree", "prune"], projectRoot);
          fs.mkdirSync(root, { recursive: true });
          await gitOrThrow(["worktree", "add", "--detach", copyPath, source.head], projectRoot, "Could not create the work copy");
          const fresh: RemoteWorkCopy = {
            owner,
            path: copyPath,
            head: source.head,
            branch: source.branch ?? null,
            machineName: source.machineName ?? null,
            syncedTree: null,
            createdAt: timestamp,
            lastUsedAt: timestamp,
          };
          const syncedTree = await syncCopy(fresh, source);
          updateCopy(owner, () => ({ ...fresh, syncedTree }));
          options.logger?.info("remote_work.created", { owner, head: source.head });
          return { path: copyPath, created: true, synced: true };
        }
        if (mode === "none") {
          updateCopy(owner, (copy) => (copy ? { ...copy, lastUsedAt: timestamp } : copy));
          return { path: copyPath, created: false, synced: false };
        }
        if (options.isInUse?.({ owner, path: copyPath })) {
          throw new RemoteWorkError(
            "copy_busy",
            "A command is still running in this chat's work copy. Wait for it to end, stop it, or pass --no-sync to run beside it without a sync.",
          );
        }
        if (mode !== "discard") {
          const reason = await unsyncedWork(existing);
          if (reason) {
            throw new RemoteWorkError(
              "copy_has_unsynced_work",
              `This chat's work copy here was not synced because ${reason}. Run with --no-sync to commit and push that work there, or pass --discard to throw it away.`,
            );
          }
        }
        await ensureCommit(source);
        const syncedTree = await syncCopy(existing, source);
        updateCopy(owner, (copy) => (copy ? {
          ...copy,
          head: source.head,
          branch: source.branch ?? copy.branch,
          machineName: source.machineName ?? copy.machineName,
          syncedTree,
          lastUsedAt: timestamp,
        } : copy));
        return { path: copyPath, created: false, synced: true };
      });
    },

    /** Delete the copy for `owner`. True when one existed. */
    release,

    /** Delete every copy that matches; used when a chat is gone. */
    releaseWhere,

    /** Delete copies unused for `maxIdleMs`, skipping any still in use. */
    async sweep(maxIdleMs: number = REMOTE_WORK_IDLE_MS): Promise<number> {
      const cutoff = now() - maxIdleMs;
      return await releaseWhere((copy) =>
        Date.parse(copy.lastUsedAt) < cutoff && !options.isInUse?.(copy));
    },

    /** Delete the least recently used copies first, up to `count`; for a low disk. */
    async releaseOldest(count: number): Promise<number> {
      const oldest = [...readRegistry().copies]
        .filter((copy) => !options.isInUse?.(copy))
        .sort((a, b) => Date.parse(a.lastUsedAt) - Date.parse(b.lastUsedAt))
        .slice(0, Math.max(0, count));
      const owners = new Set(oldest.map((copy) => copy.owner));
      return await releaseWhere((copy) => owners.has(copy.owner));
    },
  };
}

export type RemoteWorkCopyService = ReturnType<typeof createRemoteWorkCopyService>;

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
 * How to run one command for a caller on another machine: the machine's own
 * shell, not interactive, so the output is the command's alone and the
 * process ends with the command's exit code. `shell` is the terminal shell
 * this machine would start (its path, and on Windows its kind as the id).
 */
export function remoteWorkRunOnceLaunch(
  command: string,
  shell: { id: string | null; path: string | null },
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === "win32") {
    const kind = (shell.id ?? "powershell").toLowerCase();
    if (kind === "cmd") return { command: shell.path || "cmd.exe", args: ["/d", "/s", "/c", command] };
    if (kind === "git-bash" && shell.path) return { command: shell.path, args: ["-c", command] };
    // A command that never ran leaves $LASTEXITCODE null; fall back to $?.
    return {
      command: shell.path || (kind === "pwsh" ? "pwsh.exe" : "powershell.exe"),
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `${command}; if ($null -eq $LASTEXITCODE) { exit [int](-not $?) }; exit $LASTEXITCODE`],
    };
  }
  return { command: shell.path || "/bin/sh", args: ["-c", command] };
}
