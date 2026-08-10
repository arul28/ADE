/**
 * Repo-scoped cache for git answers that are the same for every lane.
 *
 * ADE runs many worktrees of one repository, and a lane status refresh asks the
 * same repo-wide question once per lane. Measured on a 14-lane checkout, one
 * refresh spawned 161 `git` processes, of which 31 were byte-identical argv at
 * a byte-identical cwd — `git rev-parse main` ran 14 times at the project root
 * inside a single refresh, and every lane paid two separate `rev-parse HEAD`
 * calls because two services asked without knowing about each other.
 *
 * Everything here is keyed by the repository's **common git dir**, so all lane
 * worktrees of one repo share an entry. That is the multiplier: caching per
 * worktree would leave a 14-lane repo with 14 copies of one answer.
 *
 * Two freshness classes, because the questions differ in kind:
 *
 * - `stable` (5 min) — the origin URL, the default branch, the committer
 *   identity. These change when someone edits git config, which ADE does not do
 *   on a poll loop.
 * - `volatile` (1.5 s) — resolved ref SHAs. Long enough to collapse the
 *   duplicates inside one refresh (a full refresh measured 626 ms), short
 *   enough that a commit made outside ADE surfaces almost immediately. For
 *   comparison the lane list itself already caches for 10 s, so this is the
 *   more conservative of the two.
 *
 * Failures are cached too, deliberately. A repo with no `origin` answers
 * "no origin" by failing, and re-asking that question once per lane per refresh
 * costs exactly as much as asking a successful one.
 */

import { pathKey } from "../shared/pathCompare";

/** Ref SHAs: collapses one refresh's duplicates, expires within a heartbeat. */
export const GIT_REPO_CACHE_VOLATILE_TTL_MS = 1_500;
/** Config-shaped answers: origin URL, default branch, committer identity. */
export const GIT_REPO_CACHE_STABLE_TTL_MS = 5 * 60_000;

export type GitRepoCacheClass = "volatile" | "stable";

type CacheEntry = {
  expiresAt: number;
  value: unknown;
};

type RepoCache = {
  entries: Map<string, CacheEntry>;
  inFlight: Map<string, Promise<unknown>>;
  /**
   * Bumped by every invalidation. A load that started before a mutation must
   * not publish afterwards, and clearing the map cannot express that on its own
   * because the load's `set` runs later. Same reason `laneService` carries a
   * `laneListEpoch` next to its lane-list cache.
   */
  epoch: number;
};

const repos = new Map<string, RepoCache>();

/**
 * Repos are keyed by a filesystem path, and on Windows and case-insensitive
 * macOS two spellings of one directory are the same directory. Two buckets
 * would mean a mutation issued under one spelling leaves the other's entries
 * live — a missed invalidation, not merely a missed hit.
 */
function repoKey(commonGitDir: string): string {
  return pathKey(commonGitDir);
}

/**
 * Git verbs that can change what a cached answer would be: refs, the remote
 * set, config, or the worktree list. Anything that writes is treated as
 * invalidating even when it fails — a `push` that is rejected may still have
 * updated a remote-tracking ref, and a half-applied `rebase` moves HEAD.
 */
const REF_AFFECTING_GIT_VERBS = new Set([
  "am", "branch", "checkout", "cherry-pick", "clone", "commit", "config",
  "fetch", "init", "merge", "pull", "push", "rebase", "remote", "reset",
  "restore", "revert", "stash", "switch", "symbolic-ref", "tag", "update-ref",
  "worktree",
]);

/**
 * Several of those verbs are read-only in one of their moods, and ADE calls
 * exactly those moods on hot paths — `config --get user.email`,
 * `remote get-url origin`, `worktree list`. Treating a read as a mutation would
 * drop the cache on every lookup, which is worse than not caching at all: the
 * subprocess still runs and every other entry dies with it.
 *
 * The mood lives in different places depending on the verb, so they are two
 * separate tables rather than one scan of the whole argv. Scanning everything
 * lets an argument *value* masquerade as a mood — `git stash push -m list` is a
 * mutation whose message happens to be the word `list`.
 */
const READ_ONLY_GIT_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  remote: new Set(["get-url", "show"]),
  stash: new Set(["list", "show"]),
  worktree: new Set(["list"]),
};

const READ_ONLY_GIT_FLAGS: Record<string, ReadonlySet<string>> = {
  branch: new Set(["--list", "-l", "--show-current", "--contains", "--points-at", "--merged", "--no-merged"]),
  config: new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l"]),
  remote: new Set(["-v", "--verbose"]),
  tag: new Set(["--list", "-l", "--points-at", "--contains"]),
};

/**
 * Git's own options, before the verb. The ones listed here take a separate
 * operand, so both tokens have to be stepped over to reach the verb.
 *
 * ADE ships `git -c core.editor=true rebase --continue`. Reading the first
 * non-dash token as the verb finds `core.editor=true`, concludes the command is
 * harmless, and skips invalidating after a rebase actually moved HEAD.
 */
const GIT_GLOBAL_OPTIONS_WITH_OPERAND = new Set([
  "-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env",
]);

function gitVerbIndex(args: readonly string[]): number {
  let index = 0;
  while (index < args.length) {
    const arg = args[index] ?? "";
    if (!arg.startsWith("-")) break;
    index += GIT_GLOBAL_OPTIONS_WITH_OPERAND.has(arg) ? 2 : 1;
  }
  return index;
}

/**
 * True when running `args` may change a repo-wide answer this module caches.
 *
 * Ordinary read plumbing (`rev-parse`, `status`, `for-each-ref`, `diff`, …) is
 * absent from the verb set entirely, so a refresh never invalidates its own
 * cache. An unrecognized mood of a writing verb counts as a write — an unknown
 * command is a reason to re-read, not a reason to trust stale data.
 */
export function isRefAffectingGitCommand(args: readonly string[]): boolean {
  const verbIndex = gitVerbIndex(args);
  const verb = args[verbIndex];
  if (!verb || !REF_AFFECTING_GIT_VERBS.has(verb)) return false;

  const rest = args.slice(verbIndex + 1);
  const subcommands = READ_ONLY_GIT_SUBCOMMANDS[verb];
  if (subcommands) {
    const subcommand = rest.find((arg) => !arg.startsWith("-"));
    if (subcommand !== undefined) return !subcommands.has(subcommand);
  }
  const flags = READ_ONLY_GIT_FLAGS[verb];
  if (flags) return !rest.some((arg) => flags.has(arg));
  return true;
}

function repoFor(commonGitDir: string): RepoCache {
  const key = repoKey(commonGitDir);
  let repo = repos.get(key);
  if (!repo) {
    repo = { entries: new Map(), inFlight: new Map(), epoch: 0 };
    repos.set(key, repo);
  }
  return repo;
}

/**
 * A `GitRunResult`-shaped value that reports a non-zero exit. Anything else —
 * a plain string, an object without an exit code — is treated as a success,
 * since only git results carry the concept.
 */
function isFailedGitResult(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && "exitCode" in value
    && (value as { exitCode: unknown }).exitCode !== 0;
}

function ttlFor(cacheClass: GitRepoCacheClass): number {
  return cacheClass === "stable"
    ? GIT_REPO_CACHE_STABLE_TTL_MS
    : GIT_REPO_CACHE_VOLATILE_TTL_MS;
}

/**
 * Read `key` for `commonGitDir`, running `load` on a miss.
 *
 * Concurrent misses for one key share a single `load`, which is what collapses
 * the fan-out — a refresh asks 14 lanes' worth of questions in parallel, so a
 * plain TTL check would let all 14 through before the first one resolved.
 */
export async function cachedGitRepoValue<T>(args: {
  commonGitDir: string;
  key: string;
  cacheClass: GitRepoCacheClass;
  load: () => Promise<T>;
  nowMs?: number;
}): Promise<T> {
  const { commonGitDir, key, cacheClass, load } = args;
  if (!commonGitDir) return await load();
  const nowMs = args.nowMs ?? Date.now();
  const repo = repoFor(commonGitDir);

  const entry = repo.entries.get(key);
  if (entry && entry.expiresAt > nowMs) return entry.value as T;
  if (entry) repo.entries.delete(key);

  const existing = repo.inFlight.get(key);
  if (existing) return await (existing as Promise<T>);

  const loadEpoch = repo.epoch;
  const request = load().then(
    (value) => {
      // Cache the answer whichever way it came out: "this repo has no origin"
      // costs a subprocess to rediscover exactly like a successful lookup does.
      // Unless the repo was mutated while we were reading, in which case this
      // answer describes the old repo — return it to the caller that asked for
      // it, but never pin it for the next one.
      // TTL runs from when we asked, not from when git answered. A slow load
      // therefore expires slightly sooner rather than extending its own
      // freshness window past what the caller was told to expect — and it
      // makes the window deterministic under an injected clock.
      if (repo.epoch === loadEpoch) {
        // A failure is cached — re-asking "does this repo have an origin?" once
        // per lane costs the same as asking a successful question — but only on
        // the short window. The absent answer is the one most likely to change
        // (the user runs `git remote add` in a terminal, which never passes
        // through runGit), so pinning it for five minutes would leave the
        // publish affordances wrong for five minutes.
        const failed = isFailedGitResult(value);
        repo.entries.set(key, {
          value,
          expiresAt: nowMs + ttlFor(failed ? "volatile" : cacheClass),
        });
      }
      return value;
    },
    (error) => {
      // A thrown load is a different thing from a git command that exited
      // non-zero — that one resolves with an exit code and is cached above.
      // Something threw, so we know nothing; do not pin it.
      throw error;
    },
  ).finally(() => {
    if (repo.inFlight.get(key) === request) repo.inFlight.delete(key);
  });
  repo.inFlight.set(key, request);
  return await request;
}

/**
 * Drop cached answers. With no argument, drops every repository.
 *
 * In-flight loads still resolve to the caller that asked for them, but the
 * epoch bump stops them from pinning a pre-mutation answer, and dropping them
 * from `inFlight` stops a later caller from *joining* one. Clearing only
 * `entries` left that second door open: a read that started before a commit
 * would be handed to every caller arriving after it, with no cache entry left
 * behind to explain where the stale SHA came from.
 */
export function invalidateGitRepoCache(commonGitDir?: string): void {
  const drop = (repo: RepoCache): void => {
    repo.entries.clear();
    repo.inFlight.clear();
    repo.epoch += 1;
  };
  if (commonGitDir === undefined) {
    for (const repo of repos.values()) drop(repo);
    return;
  }
  const repo = repos.get(repoKey(commonGitDir));
  if (repo) drop(repo);
}

/** Test seam: forget every repository, in-flight loads included. */
export function resetGitRepoCacheForTests(): void {
  repos.clear();
}
