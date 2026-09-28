import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_LANE_BASE_REMOTE_FETCH_TIMEOUT_MS,
  STALE_LANE_BASE_FETCH_WAIT_MS,
  isLaneBaseStale,
  remoteLaneBaseCandidate,
  selectRemoteLaneBaseRef,
} from "../../../desktop/src/shared/defaultRemoteLaneBase";
import type { NewLaneBaseSource } from "../../../desktop/src/shared/types";
import { resolveGitCommit, runGit } from "../../../desktop/src/main/services/git/git";
import type { createProjectConfigService } from "../../../desktop/src/main/services/config/projectConfigService";
import type { createGitOperationsService } from "../../../desktop/src/main/services/git/gitOperationsService";
import type { createLaneService } from "../../../desktop/src/main/services/lanes/laneService";

/** How old a remote-tracking base is, as far as the local clone can tell. */
export type LaneBaseFreshness = {
  /** When this clone last fetched (FETCH_HEAD, or the ref's reflog), epoch ms; null = unknown/never. */
  lastFetchedAtMs: number | null;
  /** Committer time of the ref's tip, epoch ms; null when the ref does not resolve. */
  committedAtMs: number | null;
  /**
   * Commits on the local base branch that the remote-tracking ref lacks — a
   * lower bound on how far behind it is. Null when unknown.
   */
  behindLocal: number | null;
};

export interface LaneCreateRemoteBaseDeps {
  laneService: Pick<ReturnType<typeof createLaneService>, "list">;
  gitService?: (
    Pick<ReturnType<typeof createGitOperationsService>, "fetch" | "listBranches">
    & Partial<Pick<ReturnType<typeof createGitOperationsService>, "getSyncStatus">>
  ) | null;
  projectConfigService?: Pick<ReturnType<typeof createProjectConfigService>, "getEffective"> | null;
  onWarning?: (warning: string) => void;
  /** How long to wait for the fetch when the base looks fresh. */
  fetchTimeoutMs?: number;
  /** How long to wait for the fetch when the base looks stale (the fetch's own budget). */
  staleFetchTimeoutMs?: number;
  /**
   * Called when the base looks stale and the fast wait ran out, just before
   * waiting for the rest of the fetch. `lastFetchedAtMs` null = never fetched.
   */
  onWaitingForStaleFetch?: (info: { remoteRef: string; lastFetchedAtMs: number | null }) => void;
  /**
   * True when `ref` resolves to a commit in `cwd` (the primary lane's
   * worktree). Defaults to `git rev-parse --verify --quiet <ref>^{commit}`.
   */
  refResolves?: (ref: string, cwd: string) => Promise<boolean>;
  /** Reads how old `ref` is in `cwd`. Defaults to FETCH_HEAD/reflog/commit times from git. */
  readFreshness?: (args: { ref: string; cwd: string; localBranch: string | null }) => Promise<LaneBaseFreshness>;
  now?: () => number;
}

/** "ok" = fetched; "timeout" = still running when we stopped waiting; "failed" = git reported an error. */
export type LaneBaseFetchOutcome = "ok" | "timeout" | "failed";

export type LaneCreateRemoteBaseResolution = {
  /** The remote ref to branch from, or null to keep the lane service's local default. */
  baseRef: string | null;
  /** Remote fetch outcome; null when no fetch was attempted. */
  fetchSucceeded: boolean | null;
  /** Why the fetch did not succeed, when it did not; absent when no fetch was attempted. */
  fetchOutcome?: LaneBaseFetchOutcome | null;
  /** git's error for a failed fetch. */
  fetchError?: string | null;
  /**
   * Age of the chosen base, reported when the fetch did not succeed (the lane
   * branches from whatever was fetched last) or when the base is still stale.
   */
  freshness?: LaneBaseFreshness | null;
  /** True when the chosen base still looks stale after the fetch attempt. */
  stale?: boolean;
};

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
export async function readGitLaneBaseFreshness(args: {
  ref: string;
  cwd: string;
  localBranch: string | null;
}): Promise<LaneBaseFreshness> {
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

const UNKNOWN_FRESHNESS: LaneBaseFreshness = { lastFetchedAtMs: null, committedAtMs: null, behindLocal: null };

/**
 * Remote-first default base for lane creation when the caller omits a base.
 * Reads the project's `git.newLaneBaseSource` (effective default "remote"),
 * fetches the primary lane's remote (bounded), and maps the primary base branch
 * to its remote-tracking ref. Returns null — keep the local default — when the
 * source is "local", services are unavailable, or no remote ref exists.
 *
 * Shared by every base-less lane-create entry point that a headless host
 * serves: the sync layer's `lanes.create` (mobile) and the ADE RPC server's
 * `create_lane` tool (`ade lanes create`, agent tool calls).
 */
export async function resolveLaneCreateRemoteBase(deps: LaneCreateRemoteBaseDeps): Promise<string | null> {
  return (await resolveLaneCreateRemoteBaseDetailed(deps)).baseRef;
}

/**
 * {@link resolveLaneCreateRemoteBase} plus the fetch outcome, for callers that
 * report it (the chat-launch "Fetch base branch" stage). The chosen ref is
 * verified to resolve to a commit: a local branch's configured upstream whose
 * remote ref is gone (`[gone]`) yields null rather than a base every
 * `laneService.create` would reject.
 *
 * Fetch timing: a fresh base (fetched within a day, tip under three days old)
 * waits only `fetchTimeoutMs` (4 s) for the fetch, then branches from what it
 * has. A stale base waits for the fetch's whole budget, because branching
 * from a months-old `origin/main` silently is far worse than a slow start.
 */
export async function resolveLaneCreateRemoteBaseDetailed(
  deps: LaneCreateRemoteBaseDeps,
): Promise<LaneCreateRemoteBaseResolution> {
  const none = (fetchSucceeded: boolean | null = null, extra: Partial<LaneCreateRemoteBaseResolution> = {}): LaneCreateRemoteBaseResolution => ({
    baseRef: null,
    fetchSucceeded,
    ...extra,
  });
  const gitService = deps.gitService;
  if (!gitService) return none();
  let source: NewLaneBaseSource | null = null;
  try {
    source = deps.projectConfigService?.getEffective().git?.newLaneBaseSource ?? null;
  } catch {
    source = null;
  }
  // "local" short-circuits before the lane/branch lookups; the callee re-checks
  // as its own contract.
  if (source === "local") return none();
  const now = deps.now ?? Date.now;
  const readFreshness = deps.readFreshness ?? readGitLaneBaseFreshness;
  let fetchSucceeded: boolean | null = null;
  let fetchOutcome: LaneBaseFetchOutcome | null = null;
  let fetchError: string | null = null;
  try {
    const lanes = await deps.laneService.list({ includeStatus: false });
    const primary = lanes.find((lane) => lane.laneType === "primary");
    if (!primary) return none();
    const primaryBaseRef = primary.baseRef || primary.branchRef;
    const remoteCandidate = remoteLaneBaseCandidate(primaryBaseRef);
    const defaultBranch = remoteCandidate.replace(/^origin\//, "") || "main";
    const cwd = primary.worktreePath || null;
    const localBranch = remoteCandidate ? defaultBranch : null;

    // How old the base was before this fetch — "last fetched" as the user
    // knew it. Started before the fetch: a fetch re-stamps FETCH_HEAD and the
    // ref's reflog, so reading afterwards would always look fresh. The catch
    // is attached now, so a fetch that fails first leaves no unhandled rejection.
    const freshnessBeforeRead: Promise<LaneBaseFreshness> = cwd && remoteCandidate
      ? readFreshness({ ref: remoteCandidate, cwd, localBranch }).catch(() => UNKNOWN_FRESHNESS)
      : Promise.resolve(UNKNOWN_FRESHNESS);
    const freshnessBefore = (): Promise<LaneBaseFreshness> => freshnessBeforeRead;
    const fetchResult: Promise<{ outcome: LaneBaseFetchOutcome; error: string | null }> = gitService
      .fetch({ laneId: primary.id })
      .then(() => ({ outcome: "ok" as const, error: null }))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        return { outcome: (/timed out|timeout/i.test(message) ? "timeout" : "failed") as LaneBaseFetchOutcome, error: message };
      });
    const waitFor = async (ms: number) => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      try {
        return await Promise.race([
          fetchResult,
          new Promise<{ outcome: LaneBaseFetchOutcome; error: string | null }>((resolve) => {
            timeoutId = setTimeout(() => resolve({ outcome: "timeout", error: null }), ms);
          }),
        ]);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    };

    let result = await waitFor(deps.fetchTimeoutMs ?? DEFAULT_LANE_BASE_REMOTE_FETCH_TIMEOUT_MS);
    if (result.outcome === "timeout" && result.error == null) {
      // The fetch is still running. A fresh base is good enough; a stale one
      // waits for the rest of the fetch's budget.
      const before = await freshnessBefore();
      if (isLaneBaseStale({ ...before, nowMs: now() })) {
        deps.onWaitingForStaleFetch?.({ remoteRef: remoteCandidate || `origin/${defaultBranch}`, lastFetchedAtMs: before.lastFetchedAtMs });
        result = await waitFor(deps.staleFetchTimeoutMs ?? STALE_LANE_BASE_FETCH_WAIT_MS);
      } else {
        // It may have finished while we read the base's age.
        result = await waitFor(0);
      }
    }
    fetchOutcome = result.outcome;
    fetchError = result.error;
    fetchSucceeded = result.outcome === "ok";
    if (!fetchSucceeded) {
      const reason = fetchOutcome === "timeout" ? "fetch timed out" : "fetch failed";
      deps.onWarning?.(`⚠ Base origin/${defaultBranch} may be stale — ${reason}; using last-known ref.`);
    }
    const fetchFields = { fetchOutcome, fetchError } satisfies Partial<LaneCreateRemoteBaseResolution>;

    const branches = await gitService.listBranches({ laneId: primary.id });
    const remoteBase = selectRemoteLaneBaseRef({ branches, primaryBaseRef });
    const chosen = async (ref: string): Promise<LaneCreateRemoteBaseResolution> => {
      if (fetchSucceeded || !cwd) return { baseRef: ref, fetchSucceeded, ...fetchFields, stale: false };
      // Branching from whatever was fetched last: say how old it is.
      const before = await freshnessBefore();
      const after = await readFreshness({ ref, cwd, localBranch }).catch(() => UNKNOWN_FRESHNESS);
      const freshness: LaneBaseFreshness = {
        lastFetchedAtMs: before.lastFetchedAtMs ?? after.lastFetchedAtMs,
        committedAtMs: after.committedAtMs,
        behindLocal: after.behindLocal,
      };
      return { baseRef: ref, fetchSucceeded, ...fetchFields, freshness, stale: isLaneBaseStale({ ...freshness, nowMs: now() }) };
    };
    if (remoteBase && cwd) {
      // A configured upstream can outlive its remote ref; check it resolves.
      const resolves = await (deps.refResolves ?? gitRefResolves)(remoteBase, cwd).catch(() => false);
      if (resolves) return await chosen(remoteBase);
      deps.onWarning?.(`⚠ Base ${remoteBase} no longer exists on the remote; using the local base.`);
      return none(fetchSucceeded, fetchFields);
    }
    // Nowhere to verify it: only a remote ref the listing actually shows counts.
    if (remoteBase && branches.some((branch) => branch.isRemote && branch.name === remoteBase)) {
      return await chosen(remoteBase);
    }

    if (fetchSucceeded && gitService.getSyncStatus) {
      try {
        const syncStatus = await gitService.getSyncStatus({ laneId: primary.id });
        if (syncStatus.behind > 0) {
          deps.onWarning?.(
            `⚠ local ${defaultBranch} is ${syncStatus.behind} behind origin — creating off possibly-stale base.`,
          );
        }
      } catch {
        // Warning enrichment is best-effort; lane creation still falls back locally.
      }
    }
    return none(fetchSucceeded, fetchFields);
  } catch {
    return none(fetchSucceeded, fetchOutcome ? { fetchOutcome, fetchError } : {});
  }
}
