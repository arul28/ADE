import type { GitBranchSummary } from "./types";

// Host-side counterpart of the renderer's `newLaneBaseSource.ts`: resolve the
// base ref a new lane should branch from when the caller did not pick one.
// Desktop's create-lane dialog and auto-create always resolve a base in the
// renderer (defaulting to the remote-tracking ref) before calling
// `lanes.create`; callers without that UI — the mobile app and headless CLI —
// omit `baseBranch`, and without this resolution the lane silently branches
// from the LOCAL primary tip, which may be stale relative to the remote.

export const DEFAULT_LANE_BASE_REMOTE_FETCH_TIMEOUT_MS = 4_000;

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
