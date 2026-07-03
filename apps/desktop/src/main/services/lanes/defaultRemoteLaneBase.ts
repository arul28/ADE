import type { GitBranchSummary, NewLaneBaseSource } from "../../../shared/types";

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
 * the local base branch's configured upstream. Returns null when no matching
 * remote ref exists (e.g. no remote, unfetched) — callers then keep the local
 * default rather than failing creation.
 */
export function selectRemoteLaneBaseRef(args: {
  branches: GitBranchSummary[];
  primaryBaseRef: string | null | undefined;
}): string | null {
  const base = args.primaryBaseRef?.trim() || "";
  const localBase = base
    ? args.branches.find((branch) => !branch.isRemote && branch.name === base)
    : undefined;
  const candidates = [
    localBase?.upstream?.trim() || "",
    remoteLaneBaseCandidate(base),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (args.branches.some((branch) => branch.isRemote && branch.name === candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Resolve the default base for a caller that omitted one. Fetches the remote
 * first (bounded — a slow remote must not stall lane creation), then maps the
 * primary base branch to its remote-tracking ref. Any failure resolves to null
 * so creation proceeds with the existing local-default behavior.
 */
export async function resolveDefaultRemoteLaneBase(args: {
  newLaneBaseSource: NewLaneBaseSource | string | null | undefined;
  primaryBaseRef: string | null | undefined;
  fetchRemote: () => Promise<unknown>;
  listBranches: () => Promise<GitBranchSummary[]>;
  fetchTimeoutMs?: number;
}): Promise<string | null> {
  if (args.newLaneBaseSource === "local") return null;
  try {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        args.fetchRemote().catch(() => {}),
        new Promise<void>((resolve) => {
          timeoutId = setTimeout(resolve, args.fetchTimeoutMs ?? DEFAULT_LANE_BASE_REMOTE_FETCH_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
    const branches = await args.listBranches();
    return selectRemoteLaneBaseRef({ branches, primaryBaseRef: args.primaryBaseRef });
  } catch {
    return null;
  }
}
