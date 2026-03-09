import type {
  ConflictChip,
  ConflictStatus,
  LaneSummary
} from "../../../shared/types";
import type { PaneSplit } from "../ui/PaneTilingLayout";

/* ---- Sort helpers ---- */

export function sortLanesForTabs<T extends { laneType: string; createdAt: string }>(lanes: T[]): T[] {
  return [...lanes].sort((a, b) => {
    const aPrimary = a.laneType === "primary" ? 1 : 0;
    const bPrimary = b.laneType === "primary" ? 1 : 0;
    if (aPrimary !== bPrimary) return bPrimary - aPrimary;
    const aTs = Date.parse(a.createdAt);
    const bTs = Date.parse(b.createdAt);
    if (!Number.isNaN(aTs) && !Number.isNaN(bTs) && aTs !== bTs) return bTs - aTs;
    return 0;
  });
}

export function sortLanesForStackGraph(lanes: LaneSummary[]): LaneSummary[] {
  const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));
  const childrenByParent = new Map<string, LaneSummary[]>();
  const roots: LaneSummary[] = [];
  const primary = lanes.find((lane) => lane.laneType === "primary") ?? null;
  const primaryId = primary?.id ?? null;

  for (const lane of lanes) {
    if (lane.laneType === "primary") { roots.push(lane); continue; }
    const effectiveParentId = lane.parentLaneId && laneById.has(lane.parentLaneId) ? lane.parentLaneId : primaryId;
    if (!effectiveParentId || effectiveParentId === lane.id) { roots.push(lane); continue; }
    const children = childrenByParent.get(effectiveParentId) ?? [];
    children.push(lane);
    childrenByParent.set(effectiveParentId, children);
  }

  const byCreatedAsc = (a: LaneSummary, b: LaneSummary) => {
    const aTs = Date.parse(a.createdAt);
    const bTs = Date.parse(b.createdAt);
    if (!Number.isNaN(aTs) && !Number.isNaN(bTs) && aTs !== bTs) return aTs - bTs;
    return a.name.localeCompare(b.name);
  };
  roots.sort((a, b) => {
    const aPrimary = a.laneType === "primary" ? 1 : 0;
    const bPrimary = b.laneType === "primary" ? 1 : 0;
    if (aPrimary !== bPrimary) return bPrimary - aPrimary;
    return byCreatedAsc(a, b);
  });
  for (const [, children] of childrenByParent.entries()) {
    children.sort(byCreatedAsc);
  }

  const out: LaneSummary[] = [];
  const visit = (lane: LaneSummary) => {
    out.push(lane);
    for (const child of childrenByParent.get(lane.id) ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  const seen = new Set(out.map((lane) => lane.id));
  return out.concat(lanes.filter((lane) => !seen.has(lane.id)).sort(byCreatedAsc));
}

export function mergeUnique(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const id of list) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/* ---- Filter helpers ---- */

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
    lane.name, lane.branchRef, lane.laneType, lane.description ?? "",
    lane.worktreePath,
    lane.status.dirty ? "dirty modified changed" : "clean",
    lane.status.ahead > 0 ? `ahead ahead:${lane.status.ahead}` : "ahead:0",
    lane.status.behind > 0 ? `behind behind:${lane.status.behind}` : "behind:0",
    isPinned ? "pinned" : ""
  ].join(" ").toLowerCase();
  return indexedText.includes(normalized);
}

export function laneMatchesFilter(lane: LaneSummary, isPinned: boolean, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((token) => matchesLaneFilterToken(lane, isPinned, token));
}

/* ---- Conflict helpers ---- */

export function conflictDotClass(status: ConflictStatus["status"] | undefined): string {
  if (status === "conflict-active") return "bg-red-600";
  if (status === "conflict-predicted") return "bg-orange-500";
  if (status === "behind-base") return "bg-amber-500";
  if (status === "merge-ready") return "bg-emerald-500";
  return "bg-muted-fg";
}

export function chipLabel(kind: ConflictChip["kind"]): string {
  return kind === "high-risk" ? "high risk" : "new overlap";
}

/* ---- Default tiling layouts ---- */

export const LANES_TILING_TREE: PaneSplit = {
  type: "split",
  direction: "horizontal",
  children: [
    {
      node: {
        type: "split",
        direction: "vertical",
        children: [
          { node: { type: "pane", id: "stack" }, defaultSize: 50, minSize: 15 },
          { node: { type: "pane", id: "diff-viewer" }, defaultSize: 50, minSize: 15 }
        ]
      },
      defaultSize: 20,
      minSize: 12
    },
    { node: { type: "pane", id: "work" }, defaultSize: 45, minSize: 25 },
    { node: { type: "pane", id: "git-actions" }, defaultSize: 35, minSize: 20 }
  ]
};

export const GIT_ACTIONS_FULLSCREEN_TREE: PaneSplit = {
  type: "split",
  direction: "vertical",
  children: [
    { node: { type: "pane", id: "git-actions" }, defaultSize: 100, minSize: 15 }
  ]
};

/* ---- Misc types ---- */

export type LanePaneDetailSelection = {
  selectedFilePath: string | null;
  selectedFileMode: "staged" | "unstaged" | null;
  selectedCommit: import("../../../shared/types").GitCommitSummary | null;
};

export type LaneBranchOption = {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  upstream: string | null;
};

export const EMPTY_LANE_PANE_DETAIL: LanePaneDetailSelection = {
  selectedFilePath: null,
  selectedFileMode: null,
  selectedCommit: null
};

export function formatBranchCheckoutError(input: string): string {
  const message = input.trim();
  const lowered = message.toLowerCase();
  const dirtyCheckout =
    lowered.includes("would be overwritten by checkout") ||
    lowered.includes("please commit your changes or stash them before you switch branches");
  if (!dirtyCheckout) return message;

  const touchedFiles = message
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("/") && !line.toLowerCase().startsWith("error:"));
  const fileCount = touchedFiles.length;
  if (fileCount > 0) {
    return `Cannot switch branches: you have uncommitted primary-lane changes in ${fileCount} file${fileCount === 1 ? "" : "s"}. Commit, stash, or discard changes first.`;
  }
  return "Cannot switch branches while primary lane has uncommitted changes. Commit, stash, or discard changes first.";
}

export const RESIZE_TARGET_MINIMUM_SIZE = { coarse: 37, fine: 27 } as const;
