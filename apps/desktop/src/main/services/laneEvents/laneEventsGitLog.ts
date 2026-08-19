/**
 * Git reading for the lane story — the only place that shells out to `git` on
 * behalf of `laneEventsService`.
 *
 * Why it is its own module: a lane's story is READ far more often than it is
 * written (the List view refreshes a digest for every visible lane), and every
 * read used to spawn a fresh `git log`, `rev-list --count` and one
 * `merge-base` per branch. Here each read first resolves the lane branch's head
 * sha with ONE `git rev-parse`, then memoizes every expensive answer under a
 * `${cwd}:${branchRef}:${baseRef}:${headSha}` key. A lane whose head has not
 * moved therefore costs exactly one git child per read, and a head that moves
 * invalidates naturally by producing a new key.
 */
import type { CommitPayload } from "../../../shared/types/laneEvents";

export type LaneEventsGitRunner = (
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export const GIT_TIMEOUT_MS = 15_000;

/** Past this many commits a `--shortstat` read stops being worth its cost. */
const SHORTSTAT_COMMIT_BUDGET = 200;
/** Cache entries are tiny (one parsed log each); the cap is about lane count. */
const DEFAULT_CACHE_MAX = 200;

const UNIT = "\u001f"; // field separator inside one commit record
const RECORD = "\u001e"; // record separator between commits
const MULTI = "\u001d"; // separator between repeated trailer values

/**
 * One lane's git identity for a single read, pinned to the shas it saw. BOTH
 * ends matter: `base..branch` answers change when either side moves, so the
 * base sha belongs in the key alongside the head.
 */
export type LaneEventsGitScope = {
  cwd: string;
  branchRef: string;
  baseRef: string;
  /** `null` when the branch could not be resolved; nothing is cached then. */
  headSha: string | null;
  /** Base branch tip; `null` when it did not resolve. */
  baseSha: string | null;
};

/**
 * Every read here THROWS on a failed git command rather than returning an
 * empty answer, so a transient failure is never memoized as "this lane has no
 * commits". Callers catch at their own call site and degrade there; the next
 * read retries.
 */
export type LaneEventsGitLog = {
  /** One `git rev-parse <branch> <base>` per lane per read; everything hangs off it. */
  resolveScope(args: { cwd: string; branchRef: string; baseRef: string }): Promise<LaneEventsGitScope>;
  /** Resolve a single ref to a sha, or `null` when it does not exist. Uncached. */
  resolveRef(cwd: string, ref: string): Promise<string | null>;
  /** `git log <range>` (with shortstat when the range is small), memoized. */
  readCommitsInRange(scope: LaneEventsGitScope, range: string): Promise<CommitPayload[]>;
  /** `git log --no-walk <shas>`, memoized — used for the summary's single tip commit. */
  readCommitsAt(scope: LaneEventsGitScope, shas: string[]): Promise<CommitPayload[]>;
  /** Uncached read for the write path, where the shas are new by construction. */
  readCommitsUncached(cwd: string, shas: string[]): Promise<CommitPayload[]>;
  /** `git merge-base <a> <b>`, memoized. Throws when git fails. */
  mergeBase(scope: LaneEventsGitScope, a: string, b: string): Promise<string | null>;
  /** Uncached `git merge-base`, for the write path. Throws when git fails. */
  mergeBaseUncached(cwd: string, a: string, b: string): Promise<string | null>;
  /** The repo's configured `user.name`, cached per worktree. */
  readRepoUserName(cwd: string): Promise<string | null>;
};

export function createLaneEventsGitLog(deps: {
  git: LaneEventsGitRunner;
  cacheMax?: number;
}): LaneEventsGitLog {
  const git = deps.git;
  const cacheMax = Math.max(1, deps.cacheMax ?? DEFAULT_CACHE_MAX);
  /** LRU by insertion order; values are promises so concurrent reads share one child. */
  const cache = new Map<string, Promise<unknown>>();
  const repoUserCache = new Map<string, string | null>();

  const scopeKey = (scope: LaneEventsGitScope): string =>
    `${scope.cwd}:${scope.branchRef}:${scope.baseRef}:${scope.headSha ?? ""}:${scope.baseSha ?? ""}`;

  async function memo<T>(scope: LaneEventsGitScope, suffix: string, load: () => Promise<T>): Promise<T> {
    // A lane whose head could not be resolved has no stable key to cache under.
    if (!scope.headSha) return load();
    const key = `${scopeKey(scope)}|${suffix}`;
    const hit = cache.get(key);
    if (hit) {
      // Refresh recency.
      cache.delete(key);
      cache.set(key, hit);
      return hit as Promise<T>;
    }
    const promise = load().catch((error) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, promise as Promise<unknown>);
    while (cache.size > cacheMax) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
    return promise;
  }

  async function readCommits(cwd: string, shasOrRange: string[] | string): Promise<CommitPayload[]> {
    const isRange = typeof shasOrRange === "string";
    const targets = isRange ? [shasOrRange] : shasOrRange;
    if (targets.length === 0) return [];

    const count = isRange ? await countCommits(cwd, shasOrRange) : targets.length;
    const withStats = count > 0 && count <= SHORTSTAT_COMMIT_BUDGET;
    const format =
      `${RECORD}%H${UNIT}%h${UNIT}%an${UNIT}%aI${UNIT}%s${UNIT}` +
      `%(trailers:key=Co-Authored-By,valueonly,separator=${MULTI})`;
    const args = [
      "log",
      "--no-color",
      `--format=${format}`,
      ...(withStats ? ["--shortstat"] : []),
      ...(isRange ? [] : ["--no-walk"]),
      ...targets,
    ];
    const res = await git(args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
    if (res.exitCode !== 0) throw new Error(`git log failed (${res.exitCode}): ${res.stderr.trim()}`);
    return parseCommitLog(res.stdout);
  }

  async function countCommits(cwd: string, range: string): Promise<number> {
    const res = await git(["rev-list", "--count", range], { cwd, timeoutMs: GIT_TIMEOUT_MS });
    if (res.exitCode !== 0) {
      throw new Error(`git rev-list --count failed (${res.exitCode}): ${res.stderr.trim()}`);
    }
    const parsed = Number.parseInt(res.stdout.trim(), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  async function mergeBaseOf(cwd: string, a: string, b: string): Promise<string | null> {
    const res = await git(["merge-base", a, b], { cwd, timeoutMs: GIT_TIMEOUT_MS });
    // Exit 1 is git's "these refs have no common ancestor" — a real answer, not
    // a failure. Anything else is a broken repo and must not be cached.
    if (res.exitCode === 1) return null;
    if (res.exitCode !== 0) {
      throw new Error(`git merge-base failed (${res.exitCode}): ${res.stderr.trim()}`);
    }
    return res.stdout.trim() || null;
  }

  return {
    async resolveScope({ cwd, branchRef, baseRef }) {
      // One spawn resolves BOTH ends of the range the reads measure.
      try {
        const res = await git(["rev-parse", branchRef, baseRef], { cwd, timeoutMs: GIT_TIMEOUT_MS });
        if (res.exitCode !== 0) return { cwd, branchRef, baseRef, headSha: null, baseSha: null };
        const [headSha, baseSha] = res.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        return { cwd, branchRef, baseRef, headSha: headSha ?? null, baseSha: baseSha ?? null };
      } catch {
        return { cwd, branchRef, baseRef, headSha: null, baseSha: null };
      }
    },

    async resolveRef(cwd, ref) {
      try {
        const res = await git(["rev-parse", "--verify", "--quiet", ref], { cwd, timeoutMs: GIT_TIMEOUT_MS });
        return res.exitCode === 0 ? res.stdout.trim() || null : null;
      } catch {
        return null;
      }
    },

    readCommitsInRange(scope, range) {
      return memo(scope, `log:${range}`, () => readCommits(scope.cwd, range));
    },

    readCommitsAt(scope, shas) {
      return memo(scope, `no-walk:${shas.join(",")}`, () => readCommits(scope.cwd, shas));
    },

    readCommitsUncached(cwd, shas) {
      return readCommits(cwd, shas);
    },

    mergeBase(scope, a, b) {
      return memo(scope, `merge-base:${a}..${b}`, () => mergeBaseOf(scope.cwd, a, b));
    },

    mergeBaseUncached(cwd, a, b) {
      return mergeBaseOf(cwd, a, b);
    },

    async readRepoUserName(cwd) {
      if (repoUserCache.has(cwd)) return repoUserCache.get(cwd) ?? null;
      try {
        const res = await git(["config", "user.name"], { cwd, timeoutMs: 5_000 });
        const name = res.exitCode === 0 ? res.stdout.trim() || null : null;
        repoUserCache.set(cwd, name);
        return name;
      } catch {
        repoUserCache.set(cwd, null);
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Pure parsing helpers (exported for the tests)
// ---------------------------------------------------------------------------

/**
 * Parse `git log --format=<RECORD>%H<UNIT>…` output, with optional
 * `--shortstat` lines following each record.
 */
export function parseCommitLog(stdout: string): CommitPayload[] {
  const commits: CommitPayload[] = [];
  for (const chunk of stdout.split(RECORD)) {
    if (!chunk.trim()) continue;
    const newlineAt = chunk.indexOf("\n");
    const head = newlineAt === -1 ? chunk : chunk.slice(0, newlineAt);
    const rest = newlineAt === -1 ? "" : chunk.slice(newlineAt + 1);
    const [sha, shortSha, authorName, authoredAt, subject, trailers] = head.split(UNIT);
    if (!sha) continue;
    const coAuthors = (trailers ?? "")
      .split(MULTI)
      .map((value) => value.trim())
      .filter(Boolean);
    const stats = parseShortstat(rest);
    commits.push({
      sha: sha.trim(),
      shortSha: (shortSha ?? "").trim(),
      subject: (subject ?? "").trim(),
      authorName: (authorName ?? "").trim() || null,
      authoredAt: (authoredAt ?? "").trim() || null,
      filesChanged: stats.filesChanged,
      insertions: stats.insertions,
      deletions: stats.deletions,
      ...(coAuthors.length > 0 ? { coAuthors } : {}),
    });
  }
  return commits;
}

export function parseShortstat(text: string): {
  filesChanged: number | null;
  insertions: number | null;
  deletions: number | null;
} {
  const line = text.split("\n").find((candidate) => /\bfiles? changed\b/.test(candidate));
  if (!line) return { filesChanged: null, insertions: null, deletions: null };
  const num = (pattern: RegExp): number | null => {
    const match = pattern.exec(line);
    if (!match?.[1]) return null;
    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    filesChanged: num(/(\d+) files? changed/),
    insertions: num(/(\d+) insertions?\(\+\)/) ?? 0,
    deletions: num(/(\d+) deletions?\(-\)/) ?? 0,
  };
}
