/**
 * The search box's grammar, moved.
 *
 * Ported from `components/lanes/laneUtils.ts` — the two functions the graph's
 * filter calls and nothing else from that 400-line module. `isPinned` is kept
 * in the signature even though the graph always passes `false`: dropping it
 * would silently change what `is:pinned` means rather than leave it answering
 * "no", which is the truth on a canvas that has no pins.
 */

import type { LaneSummary } from "./types";

export function matchesLaneFilterToken(lane: LaneSummary, isPinned: boolean, token: string): boolean {
  const normalized = token.trim().toLowerCase();
  if (!normalized.length) return true;
  if (normalized.startsWith("is:")) {
    const value = normalized.slice(3);
    if (value === "dirty") return lane.status.dirty;
    if (value === "clean") return !lane.status.dirty;
    if (value === "pinned") return isPinned;
    if (value === "primary") return lane.laneType === "primary";
    if (value === "worktree") return lane.laneType === "worktree";
    if (value === "attached") return lane.laneType === "attached";
    return false;
  }
  if (normalized.startsWith("type:")) return lane.laneType === normalized.slice(5);

  const indexedText = [
    lane.name,
    lane.branchRef,
    lane.laneType,
    lane.description ?? "",
    lane.worktreePath,
    lane.folder ?? "",
    (lane.tags ?? []).join(" "),
    lane.status.dirty ? "dirty modified changed" : "clean",
    lane.status.ahead > 0 ? `ahead ahead:${lane.status.ahead}` : "ahead:0",
    lane.status.behind > 0 ? `behind behind:${lane.status.behind}` : "behind:0",
    isPinned ? "pinned" : "",
  ].join(" ").toLowerCase();
  return indexedText.includes(normalized);
}

export function laneMatchesFilter(lane: LaneSummary, isPinned: boolean, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((token) => matchesLaneFilterToken(lane, isPinned, token));
}
