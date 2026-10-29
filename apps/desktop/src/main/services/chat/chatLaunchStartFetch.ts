import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_LANE_BASE_REMOTE_FETCH_TIMEOUT_MS,
  STALE_LANE_BASE_FETCH_WAIT_MS,
  isLaneBaseStale,
} from "../../../shared/defaultRemoteLaneBase";
import { plainLaneStartBranch } from "../../../shared/laneStart";
import { resolveGitCommit, runGit } from "../git/git";
import type { createGitOperationsService } from "../git/gitOperationsService";
import type { createLaneService } from "../lanes/laneService";
import type { ChatLaunchBaseProgress, ChatLaunchBaseResolution } from "./chatLaunchService";

/**
 * The chat launch's "Fetch" stage: fetch the branch a new lane starts from
 * (`LaneStart.on === "remote"`), bounded so a slow remote does not hold
 * the launch, and report how old `origin/<branch>` is when the fetch did not
 * finish. The launch then creates the lane with `skipStartFetch`, so the
 * fetch runs once.
 */

/** How old a remote-tracking ref is, as far as the local clone can tell. */
export type LaneStartFreshness = {
  /** When this clone last fetched (FETCH_HEAD, or the ref's reflog), epoch ms; null = unknown/never. */
  lastFetchedAtMs: number | null;
  /** Committer time of the ref's tip, epoch ms; null when the ref does not resolve. */
  committedAtMs: number | null;
  /**
   * Commits on the local branch that the remote-tracking ref lacks — a lower
   * bound on how far behind it is. Null when unknown.
   */
  behindLocal: number | null;
};

export type LaneStartFetchDeps = ChatLaunchBaseProgress & {
  /** The branch the lane starts from, e.g. `main` (never `origin/main`). */
  branch: string;
  laneService: Pick<ReturnType<typeof createLaneService>, "list">;
  gitService?: Pick<ReturnType<typeof createGitOperationsService>, "fetch"> | null;
  /** How long to wait for the fetch when the ref looks fresh. */
  fetchTimeoutMs?: number;
  /** How long to wait for the fetch when the ref looks stale (the fetch's own budget). */
  staleFetchTimeoutMs?: number;
  /** True when `ref` resolves to a commit in `cwd`. Defaults to `git rev-parse --verify`. */
  refResolves?: (ref: string, cwd: string) => Promise<boolean>;
  /** Reads how old `ref` is in `cwd`. Defaults to FETCH_HEAD/reflog/commit times from git. */
  readFreshness?: (args: { ref: string; cwd: string; localBranch: string | null }) => Promise<LaneStartFreshness>;
  now?: () => number;
};

type FetchOutcome = "ok" | "timeout" | "failed";

async function gitRefResolves(ref: string, cwd: string): Promise<boolean> {
  return (await resolveGitCommit(ref, cwd)) !== null;
}

async function gitOutput(args: string[], cwd: string): Promise<string | null> {
  try {
    const result = await runGit(args, { cwd, timeoutMs: 5_000 });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

function secondsToMs(value: string | null): number | null {
  const seconds = value ? Number.parseInt(value.split(/\s+/)[0] ?? "", 10) : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/** `origin/main@{1727000000}` (from `--date=unix --format=%gd`) → epoch ms. */
function reflogSelectorToMs(value: string | null): number | null {
  const match = value?.trim().match(/@\{(\d+)\}\s*$/);
  return match ? secondsToMs(match[1] ?? null) : null;
}

/**
 * FETCH_HEAD's mtime (path from `git rev-parse --git-path`, so worktrees and
 * Windows resolve it), or the remote ref's newest reflog entry — whichever is
 * newer; plus the ref's commit time and how many local-branch commits it lacks.
 */
export async function readGitLaneStartFreshness(args: {
  ref: string;
  cwd: string;
  localBranch: string | null;
}): Promise<LaneStartFreshness> {
  const { ref, cwd, localBranch } = args;
  const fetchHeadStat = async (): Promise<number | null> => {
    const rel = await gitOutput(["rev-parse", "--git-path", "FETCH_HEAD"], cwd);
    if (!rel) return null;
    try {
      const stat = await fs.stat(path.resolve(cwd, rel));
      return stat.mtimeMs;
    } catch {
      return null;
    }
  };
  const [fetchHeadAt, reflogAt, committedAt, behind] = await Promise.all([
    fetchHeadStat(),
    // `%gd` with `--date=unix` is the reflog entry's own time
    // (`origin/main@{1727000000}`); `%ct` would be the commit's committer date.
    gitOutput(["log", "-g", "-1", "--date=unix", "--format=%gd", `refs/remotes/${ref}`, "--"], cwd).then(reflogSelectorToMs),
    gitOutput(["log", "-1", "--format=%ct", `${ref}^{commit}`, "--"], cwd).then(secondsToMs),
    localBranch
      ? gitOutput(["rev-list", "--count", `${ref}..refs/heads/${localBranch}`, "--"], cwd)
      : Promise.resolve(null),
  ]);
  const fetchedCandidates = [fetchHeadAt, reflogAt].filter((value): value is number => value != null);
  const behindCount = behind != null ? Number.parseInt(behind, 10) : Number.NaN;
  return {
    lastFetchedAtMs: fetchedCandidates.length ? Math.max(...fetchedCandidates) : null,
    committedAtMs: committedAt,
    behindLocal: Number.isFinite(behindCount) ? behindCount : null,
  };
}

const UNKNOWN_FRESHNESS: LaneStartFreshness = { lastFetchedAtMs: null, committedAtMs: null, behindLocal: null };

/**
 * Fetch the remote and report `origin/<branch>`, verified to resolve to a
 * commit. `baseRef` is null when the remote has no such branch (the lane then
 * starts from the local branch, which the lane service notes).
 *
 * Fetch timing: a fresh ref (fetched within a day, tip under three days old)
 * waits only `fetchTimeoutMs` (4 s) for the fetch, then uses what it has.
 * That choice is resolved before the fetch starts, so a fetch that is still
 * running cannot hold the repo lock over the rest of lane setup. A stale ref
 * waits for the fetch's whole budget, because starting from a months-old
 * `origin/main` silently is far worse than a slow start.
 */
export async function fetchLaneStartBranch(deps: LaneStartFetchDeps): Promise<ChatLaunchBaseResolution> {
  const branch = plainLaneStartBranch(deps.branch);
  const none = (fetch: ChatLaunchBaseResolution["fetch"], fetchError: string | null = null): ChatLaunchBaseResolution => ({
    baseRef: null,
    fetch,
    fetchError,
  });
  const gitService = deps.gitService;
  if (!gitService || !branch) return none("skipped");
  const remoteRef = `origin/${branch}`;
  const now = deps.now ?? Date.now;
  const readFreshness = deps.readFreshness ?? readGitLaneStartFreshness;
  const refResolves = deps.refResolves ?? gitRefResolves;
  try {
    const lanes = await deps.laneService.list({ includeStatus: false });
    const primary = lanes.find((lane) => lane.laneType === "primary");
    const cwd = primary?.worktreePath || null;
    if (!primary || !cwd) return none("skipped");

    // How old the ref was before this fetch — "last fetched" as the user knew
    // it. Started before the fetch: a fetch re-stamps FETCH_HEAD and the
    // ref's reflog, so reading afterwards would always look fresh. The catch
    // is attached now, so a fetch that fails first leaves no unhandled rejection.
    const freshnessBefore: Promise<LaneStartFreshness> = readFreshness({ ref: remoteRef, cwd, localBranch: branch })
      .catch(() => UNKNOWN_FRESHNESS);
    // Resolve the ref we already have before `git fetch` takes the repo: a
    // fresh ref that gives up after a few seconds uses this answer, because
    // asking again while the fetch runs blocks on git's lock.
    const resolvedBefore = await refResolves(remoteRef, cwd).catch(() => false);
    if (deps.signal?.aborted) return none("failed", "cancelled");

    const fetchResult: Promise<{ outcome: FetchOutcome; error: string | null }> = gitService
      .fetch({ laneId: primary.id, ...(deps.signal ? { signal: deps.signal } : {}) })
      .then(() => ({ outcome: "ok" as const, error: null }))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const cancelled = deps.signal?.aborted || /cancell?ed/i.test(message);
        const outcome: FetchOutcome = cancelled ? "failed" : (/timed out|timeout/i.test(message) ? "timeout" : "failed");
        return { outcome, error: cancelled ? "cancelled" : message };
      });
    const waitFor = async (ms: number) => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      try {
        return await Promise.race([
          fetchResult,
          new Promise<{ outcome: FetchOutcome; error: string | null }>((resolve) => {
            timeoutId = setTimeout(() => resolve({ outcome: "timeout", error: null }), ms);
          }),
        ]);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    };

    let result = await waitFor(deps.fetchTimeoutMs ?? DEFAULT_LANE_BASE_REMOTE_FETCH_TIMEOUT_MS);
    if (result.outcome === "timeout" && result.error == null) {
      // The fetch is still running. A fresh ref is good enough; a stale one
      // waits for the rest of the fetch's budget.
      const before = await freshnessBefore;
      if (isLaneBaseStale({ ...before, nowMs: now() })) {
        deps.onWaitingForStaleFetch?.({ remoteRef, lastFetchedAtMs: before.lastFetchedAtMs });
        result = await waitFor(deps.staleFetchTimeoutMs ?? STALE_LANE_BASE_FETCH_WAIT_MS);
      } else {
        // It may have finished while we read the ref's age.
        result = await waitFor(0);
      }
    }
    if (deps.signal?.aborted) return none("failed", "cancelled");
    const fetch: ChatLaunchBaseResolution["fetch"] = result.outcome;
    const fetchError = result.error;

    // A timed-out fetch is still running and holds the repo; reuse the check
    // made before it started instead of waiting on its lock.
    const resolves = result.outcome === "timeout"
      ? resolvedBefore
      : await refResolves(remoteRef, cwd).catch(() => false);
    if (!resolves) return none(fetch, fetchError);

    if (result.outcome === "timeout") {
      // Age was read before the fetch. Reading it again now would wait on
      // the fetch that is still running.
      const before = await freshnessBefore;
      return {
        baseRef: remoteRef,
        fetch,
        fetchError,
        lastFetchedAtMs: before.lastFetchedAtMs,
        baseCommittedAtMs: before.committedAtMs,
        behindLocal: before.behindLocal,
        stale: isLaneBaseStale({ ...before, nowMs: now() }),
      };
    }
    if (result.outcome === "ok") return { baseRef: remoteRef, fetch, fetchError, stale: false };
    // Starting from whatever was fetched last: say how old it is.
    const before = await freshnessBefore;
    const after = await readFreshness({ ref: remoteRef, cwd, localBranch: branch }).catch(() => UNKNOWN_FRESHNESS);
    const freshness: LaneStartFreshness = {
      lastFetchedAtMs: before.lastFetchedAtMs ?? after.lastFetchedAtMs,
      committedAtMs: after.committedAtMs,
      behindLocal: after.behindLocal,
    };
    return {
      baseRef: remoteRef,
      fetch,
      fetchError,
      lastFetchedAtMs: freshness.lastFetchedAtMs,
      baseCommittedAtMs: freshness.committedAtMs,
      behindLocal: freshness.behindLocal,
      stale: isLaneBaseStale({ ...freshness, nowMs: now() }),
    };
  } catch (error) {
    return none("failed", error instanceof Error ? error.message : String(error));
  }
}
