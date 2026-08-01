import type {
  GitHubPrListItem,
  MergeMethod,
  PrDetachedLane,
  PrMergedBy,
} from "../../../shared/types";

/** Persisted PR-row fields used to build list and summary metadata. */
export type PullRequestRowMetadata = {
  lane_id: string;
  detached_at?: string | null;
  detached_lane_name?: string | null;
  detached_lane_color?: string | null;
  detached_provenance?: string | null;
  merged_at?: string | null;
  merged_by_login?: string | null;
  merged_by_avatar_url?: string | null;
  merge_method?: string | null;
  additions?: number | null;
  deletions?: number | null;
  commit_count?: number | null;
  changed_files?: number | null;
};

/** Normalize a persisted non-negative count, returning null for absent or invalid data. */
export function normalizeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/** Narrow persisted merge-method data to the supported public union. */
export function normalizeMergeMethod(value: unknown): MergeMethod | null {
  return value === "squash" || value === "merge" || value === "rebase" ? value : null;
}

/** Rehydrate the GitHub actor that merged a persisted PR row. */
export function rowMergedBy(row: PullRequestRowMetadata): PrMergedBy | null {
  const login = String(row.merged_by_login ?? "").trim();
  if (!login) return null;
  return { login, avatarUrl: row.merged_by_avatar_url ?? null };
}

/**
 * Rehydrate the lane provenance frozen at detach time. Returns null for live rows.
 * Malformed provenance still yields a usable lane record with zeroed counts.
 */
export function rowDetachedLane(row: PullRequestRowMetadata): PrDetachedLane | null {
  const at = String(row.detached_at ?? "").trim();
  if (!at) return null;
  let counts: { chats?: unknown; artifacts?: unknown; checkpoints?: unknown } = {};
  try {
    const parsed = JSON.parse(String(row.detached_provenance ?? "{}"));
    if (parsed && typeof parsed === "object") counts = parsed as typeof counts;
  } catch {
    /* a corrupt blob must not hide the lane name */
  }
  return {
    at,
    laneName: row.detached_lane_name ?? null,
    laneColor: row.detached_lane_color ?? null,
    chats: normalizeCount(counts.chats) ?? 0,
    artifacts: normalizeCount(counts.artifacts) ?? 0,
    checkpoints: normalizeCount(counts.checkpoints) ?? 0,
  };
}

/**
 * Resolve the lane columns of a GitHub list row. Detached rows carry frozen
 * provenance instead of exposing a live lane mapping.
 */
export function deriveGithubSnapshotLaneLink(
  linked: PullRequestRowMetadata | null,
  laneById: ReadonlyMap<string, { name: string }> | undefined,
): Pick<GitHubPrListItem, "linkedLaneId" | "linkedLaneName" | "detached"> {
  if (!linked) return { linkedLaneId: null, linkedLaneName: null, detached: null };
  const detached = rowDetachedLane(linked);
  if (detached) return { linkedLaneId: null, linkedLaneName: null, detached };
  return {
    linkedLaneId: linked.lane_id,
    linkedLaneName: laneById?.get(linked.lane_id)?.name ?? null,
    detached: null,
  };
}

/** Build the merge outcome and size fields shown by a GitHub list row. */
export function deriveGithubSnapshotMergeFacts(
  linked: PullRequestRowMetadata | null,
): Pick<
  GitHubPrListItem,
  "mergedAt" | "mergedBy" | "mergeMethod" | "additions" | "deletions" | "commitCount" | "changedFiles"
> {
  return {
    mergedAt: linked?.merged_at ?? null,
    mergedBy: linked ? rowMergedBy(linked) : null,
    mergeMethod: normalizeMergeMethod(linked?.merge_method),
    additions: normalizeCount(linked?.additions),
    deletions: normalizeCount(linked?.deletions),
    commitCount: normalizeCount(linked?.commit_count),
    changedFiles: normalizeCount(linked?.changed_files),
  };
}
