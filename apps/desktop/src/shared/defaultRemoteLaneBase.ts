import type { GitBranchSummary } from "./types";

// Host-side counterpart of the renderer's `newLaneBaseSource.ts`: resolve the
// base ref a new lane should branch from when the caller did not pick one.
// Desktop's create-lane dialog and auto-create always resolve a base in the
// renderer (defaulting to the remote-tracking ref) before calling
// `lanes.create`; callers without that UI — the mobile app and headless CLI —
// omit `baseBranch`, and without this resolution the lane silently branches
// from the LOCAL primary tip, which may be stale relative to the remote.

/** How long a new lane waits for the fetch when its remote-tracking base looks fresh. */
export const DEFAULT_LANE_BASE_REMOTE_FETCH_TIMEOUT_MS = 4_000;

/** `git fetch --prune`'s own budget (`gitOperationsService.fetch`). */
export const GIT_FETCH_TIMEOUT_MS = 60_000;

/**
 * How long a new lane waits for the fetch when its base looks stale: the
 * fetch's whole budget plus a little slack for the lane-operation queue.
 */
export const STALE_LANE_BASE_FETCH_WAIT_MS = GIT_FETCH_TIMEOUT_MS + 5_000;

/** The last fetch is older than this: the remote-tracking base is treated as stale. */
export const LANE_BASE_STALE_FETCH_AGE_MS = 24 * 60 * 60 * 1000;

/** The base commit is older than this: the remote-tracking base is treated as stale. */
export const LANE_BASE_STALE_COMMIT_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * True when a remote-tracking base may be far behind the remote: it was last
 * fetched more than a day ago (or never, as far as we can tell), or its tip
 * commit is more than three days old. A stale base waits for the fetch.
 */
export function isLaneBaseStale(args: {
  lastFetchedAtMs: number | null;
  committedAtMs: number | null;
  nowMs: number;
}): boolean {
  if (args.lastFetchedAtMs == null || args.nowMs - args.lastFetchedAtMs > LANE_BASE_STALE_FETCH_AGE_MS) return true;
  return args.committedAtMs != null && args.nowMs - args.committedAtMs > LANE_BASE_STALE_COMMIT_AGE_MS;
}

/** "3 days", "5 hours", "12 minutes", "just now" — for "last fetched N ago". */
export function formatLaneBaseAge(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "just now";
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (minutes < 60) return unit(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return unit(hours, "hour");
  return unit(Math.floor(hours / 24), "day");
}

/** `main` → `origin/main`; already-remote refs pass through; SHAs yield "". */
export function remoteLaneBaseCandidate(baseRef: string | null | undefined): string {
  const trimmed = baseRef?.trim() ?? "";
  if (!trimmed) return "";
  if (trimmed.startsWith("refs/remotes/")) return trimmed.slice("refs/remotes/".length);
  if (trimmed.startsWith("origin/")) return trimmed;
  if (trimmed.startsWith("refs/heads/")) return `origin/${trimmed.slice("refs/heads/".length)}`;
  if (/^[0-9a-f]{40}$/i.test(trimmed)) return "";
  return `origin/${trimmed}`;
}

/**
 * Pick the remote-tracking ref for the project's primary base branch, preferring
 * the local base branch's configured upstream. Returns null when there is no
 * candidate (e.g. no remote, unfetched) — callers then keep the local default
 * rather than failing creation. A configured upstream is returned even when
 * its remote ref is gone (`[gone]`), so callers MUST verify the ref resolves
 * before branching from it (the host's `resolveLaneCreateRemoteBaseDetailed`
 * does, with `git rev-parse --verify`).
 */
export function selectRemoteLaneBaseRef(args: {
  branches: GitBranchSummary[];
  primaryBaseRef: string | null | undefined;
}): string | null {
  const base = args.primaryBaseRef?.trim() || "";
  const localBase = base
    ? args.branches.find((branch) => !branch.isRemote && branch.name === base)
    : undefined;
  // A local base branch's configured upstream is the answer on its own:
  // branch listings fold a remote ref into the local branch that tracks it, so
  // `origin/main` is usually absent from the remote rows precisely because
  // `main` tracks it. Callers verify the ref resolves before branching from it.
  const upstream = localBase?.upstream?.trim() || "";
  if (upstream) return upstream;
  const candidate = remoteLaneBaseCandidate(base);
  if (candidate && args.branches.some((branch) => branch.isRemote && branch.name === candidate)) {
    return candidate;
  }
  return null;
}
