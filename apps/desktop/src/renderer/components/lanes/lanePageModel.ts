import { branchNameFromLaneRef } from "../../../shared/laneBaseResolution";
import type { GitHubPrListItem, LaneListSnapshot, LaneSummary, PrSummary } from "../../../shared/types";
import type { CreateLaneMode } from "./CreateLaneDialog";
import { mergeUnique } from "./laneUtils";

type CreateLaneRequest =
  | { kind: "child"; args: { name: string; parentLaneId: string } }
  | { kind: "root"; args: { name: string; baseBranch: string } }
  | { kind: "import"; args: { branchRef: string; name: string; baseBranch?: string } };

export type LaneTabPrTag = {
  source: "ade" | "github";
  id: string;
  linkedPrId: string | null;
  githubPrNumber: number;
  githubUrl: string;
  title: string;
  state: PrSummary["state"];
};

export function resolveCreateLaneRequest(args: {
  name: string;
  createMode: CreateLaneMode;
  createParentLaneId: string;
  createBaseBranch: string;
  createImportBranch: string;
}): CreateLaneRequest {
  if (args.createMode === "child") {
    return {
      kind: "child",
      args: {
        name: args.name,
        parentLaneId: args.createParentLaneId,
      },
    };
  }

  if (args.createMode === "existing") {
    return {
      kind: "import",
      args: {
        branchRef: args.createImportBranch,
        name: args.name,
      },
    };
  }

  return {
    kind: "root",
    args: {
      name: args.name,
      baseBranch: args.createBaseBranch,
    },
  };
}

export function parseLaneIdsParam(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function resolveLaneIdsDeepLinkSelection(args: {
  laneIdsRaw: string | null;
  inspectorTabParam?: string | null;
  availableLaneIds: Iterable<string>;
  consumedSignature: string | null;
}): { laneIds: string[]; signature: string } | null {
  const parsed = parseLaneIdsParam(args.laneIdsRaw);
  if (parsed.length === 0) return null;
  const signature = `${parsed.join(",")}::${args.inspectorTabParam ?? ""}`;
  if (signature === args.consumedSignature) return null;
  const available = new Set(args.availableLaneIds);
  const laneIds = parsed.filter((laneId) => available.has(laneId));
  if (laneIds.length !== parsed.length) return null;
  return { laneIds, signature };
}

function normalizeLanePrBranch(ref: string | null | undefined): string {
  return branchNameFromLaneRef(ref).trim();
}

function prStateRank(state: PrSummary["state"]): number {
  if (state === "open" || state === "draft") return 0;
  if (state === "merged") return 1;
  return 2;
}

type PrTagComparable = {
  state: PrSummary["state"];
  updatedAt: string;
  githubPrNumber: number;
};

function comparePrTags(a: PrTagComparable, b: PrTagComparable): number {
  const byState = prStateRank(a.state) - prStateRank(b.state);
  if (byState !== 0) return byState;
  const aUpdated = Date.parse(a.updatedAt);
  const bUpdated = Date.parse(b.updatedAt);
  if (!Number.isNaN(aUpdated) && !Number.isNaN(bUpdated) && aUpdated !== bUpdated) {
    return bUpdated - aUpdated;
  }
  return b.githubPrNumber - a.githubPrNumber;
}

export function lanePrMatchesCurrentBranch(
  lane: Pick<LaneSummary, "id" | "laneType" | "branchRef" | "baseRef">,
  pr: Pick<PrSummary, "laneId" | "headBranch">,
): boolean {
  if (pr.laneId !== lane.id) return false;
  const laneBranch = normalizeLanePrBranch(lane.branchRef);
  const prHeadBranch = normalizeLanePrBranch(pr.headBranch);
  if (!laneBranch || !prHeadBranch || laneBranch !== prHeadBranch) return false;
  if (lane.laneType === "primary") {
    const baseBranch = normalizeLanePrBranch(lane.baseRef);
    if (laneBranch && baseBranch && laneBranch === baseBranch) return false;
  }
  return true;
}

export function selectLanePrTag(
  lane: Pick<LaneSummary, "id" | "laneType" | "branchRef" | "baseRef">,
  prs: PrSummary[],
): PrSummary | null {
  return prs
    .filter((pr) => lanePrMatchesCurrentBranch(lane, pr))
    .sort(comparePrTags)[0] ?? null;
}

export function githubPrMatchesCurrentBranch(
  lane: Pick<LaneSummary, "laneType" | "branchRef" | "baseRef">,
  pr: Pick<GitHubPrListItem, "headBranch">,
): boolean {
  const laneBranch = normalizeLanePrBranch(lane.branchRef);
  const prHeadBranch = normalizeLanePrBranch(pr.headBranch);
  if (!laneBranch || !prHeadBranch || laneBranch !== prHeadBranch) return false;
  if (lane.laneType === "primary") {
    const baseBranch = normalizeLanePrBranch(lane.baseRef);
    if (laneBranch && baseBranch && laneBranch === baseBranch) return false;
  }
  return true;
}

export function selectGithubLanePrTag(
  lane: Pick<LaneSummary, "laneType" | "branchRef" | "baseRef">,
  prs: GitHubPrListItem[],
): GitHubPrListItem | null {
  return prs
    .filter((pr) => pr.scope === "repo" && githubPrMatchesCurrentBranch(lane, pr))
    .sort(comparePrTags)[0] ?? null;
}

function toLaneTabPrTagFromPrSummary(pr: PrSummary): LaneTabPrTag {
  return {
    source: "ade",
    id: pr.id,
    linkedPrId: pr.id,
    githubPrNumber: pr.githubPrNumber,
    githubUrl: pr.githubUrl,
    title: pr.title,
    state: pr.state,
  };
}

function toLaneTabPrTagFromGithubItem(pr: GitHubPrListItem, laneId: string): LaneTabPrTag {
  const linkedPrId = pr.linkedLaneId === laneId ? pr.linkedPrId : null;
  return {
    source: "github",
    id: pr.id,
    linkedPrId,
    githubPrNumber: pr.githubPrNumber,
    githubUrl: pr.githubUrl,
    title: pr.title,
    state: pr.isDraft ? "draft" : pr.state,
  };
}

export function selectLaneTabPrTag(
  lane: Pick<LaneSummary, "id" | "laneType" | "branchRef" | "baseRef">,
  prs: PrSummary[],
  githubPrs: GitHubPrListItem[],
): LaneTabPrTag | null {
  const mappedPr = selectLanePrTag(lane, prs);
  if (mappedPr) return toLaneTabPrTagFromPrSummary(mappedPr);
  const githubPr = selectGithubLanePrTag(lane, githubPrs);
  return githubPr ? toLaneTabPrTagFromGithubItem(githubPr, lane.id) : null;
}

type LaneRuntimeBucket = LaneListSnapshot["runtime"]["bucket"];

export function sortLaneListRows<T extends Pick<LaneSummary, "id" | "laneType">>(args: {
  lanes: T[];
  laneRuntimeById: ReadonlyMap<string, Pick<LaneListSnapshot["runtime"], "bucket">>;
  laneStatusFilter: LaneRuntimeBucket | "all";
  laneOrderById: ReadonlyMap<string, number>;
  pinnedLaneIds: ReadonlySet<string>;
}): T[] {
  const bucketRank: Record<LaneRuntimeBucket, number> = {
    "awaiting-input": 0,
    running: 1,
    ended: 2,
    none: 3,
  };
  const base = [...args.lanes];
  if (args.laneStatusFilter !== "all") {
    return base.filter((lane) => (args.laneRuntimeById.get(lane.id)?.bucket ?? "none") === args.laneStatusFilter);
  }
  return base.sort((a, b) => {
    const aPrimary = a.laneType === "primary" ? 0 : 1;
    const bPrimary = b.laneType === "primary" ? 0 : 1;
    if (aPrimary !== bPrimary) return aPrimary - bPrimary;
    const aPinned = args.pinnedLaneIds.has(a.id) ? 0 : 1;
    const bPinned = args.pinnedLaneIds.has(b.id) ? 0 : 1;
    if (aPinned !== bPinned) return aPinned - bPinned;
    const aBucket = args.laneRuntimeById.get(a.id)?.bucket ?? "none";
    const bBucket = args.laneRuntimeById.get(b.id)?.bucket ?? "none";
    const byBucket = bucketRank[aBucket] - bucketRank[bBucket];
    if (byBucket !== 0) return byBucket;
    return (args.laneOrderById.get(a.id) ?? 0) - (args.laneOrderById.get(b.id) ?? 0);
  });
}

export function resolveLaneDeleteStartSelection(args: {
  deletingLaneIds: Iterable<string>;
  selectedLaneId: string | null;
  activeLaneIds: string[];
  pinnedLaneIds: Iterable<string>;
  filteredLaneIds: string[];
  sortedLaneIds: string[];
}): { selectedLaneId: string | null; activeLaneIds: string[]; pinnedLaneIds: Set<string> } {
  const deleting = new Set(args.deletingLaneIds);
  const isAvailable = (laneId: string | null | undefined): laneId is string =>
    Boolean(laneId && !deleting.has(laneId));
  const pinnedLaneIds = new Set(Array.from(args.pinnedLaneIds).filter((laneId) => !deleting.has(laneId)));
  const nextSelectedLaneId = isAvailable(args.selectedLaneId)
    ? args.selectedLaneId
    : args.filteredLaneIds.find((laneId) => !deleting.has(laneId))
      ?? args.sortedLaneIds.find((laneId) => !deleting.has(laneId))
      ?? null;
  const preservedActiveLaneIds = args.activeLaneIds.filter((laneId) => !deleting.has(laneId) && laneId !== nextSelectedLaneId);
  return {
    selectedLaneId: nextSelectedLaneId,
    activeLaneIds: mergeUnique(
      nextSelectedLaneId ? [nextSelectedLaneId] : [],
      preservedActiveLaneIds,
      Array.from(pinnedLaneIds),
    ),
    pinnedLaneIds,
  };
}
