import React from "react";
import { ArrowSquareOut, ChatText, CheckCircle, CircleNotch, GitBranch, GitMerge, GithubLogo, Warning, XCircle } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import { Group, Panel } from "react-resizable-panels";
import { useVirtualizer } from "@tanstack/react-virtual";
import type {
  CreateLaneFromPrBranchArgs,
  CreateLaneFromPrBranchPreflight,
  CreateLaneFromPrBranchPreflightResult,
  CreateLaneFromPrBranchResult,
  GitHubPrListItem,
  GitHubPrSnapshot,
  LaneSummary,
  MergeMethod,
  PrEventPayload,
  PrSummary,
  PrWithConflicts,
} from "../../../../shared/types";
import { EmptyState } from "../../ui/EmptyState";
import { ResizeGutter } from "../../ui/ResizeGutter";
import { COLORS, LABEL_STYLE, MONO_FONT, SANS_FONT, inlineBadge, outlineButton, primaryButton } from "../../lanes/laneDesignTokens";
import { LaneAccentDot } from "../../lanes/LaneAccentDot";
import { selectActiveProjectRoot, useAppStore, useAppStoreApi } from "../../../state/appStore";
import { PrDetailPane, type UnmappedAffordance } from "../detail/PrDetailPane";
import { formatTimeAgoCompact } from "../shared/prFormatters";
import { PrCiRunningIndicator } from "../shared/prVisuals";
import { usePrs } from "../state/PrsContext";
import type { PrDetailRouteTab } from "../prsRouteState";
import { GitHubRepoSyncBar } from "../shared/GitHubRepoSyncBar";
import { GitHubPrSearchInput } from "../shared/GitHubPrSearchInput";
import { getGitHubSnapshotCoalesced } from "../../../lib/prReadCache";

const VIRTUALIZE_AT = 50;
const LINKED_HYDRATION_LIMIT = 8;
const GITHUB_TAB_REVISIT_CACHE_TTL_MS = 60_000;
const GITHUB_TAB_SNAPSHOT_FRESH_MS = 30_000;
const GITHUB_TAB_HOT_REFRESH_DELAY_MS = 30_000;
const GITHUB_TAB_HISTORY_INITIAL_PAGE_LIMIT = 2;
const GITHUB_TAB_HISTORY_PAGE_INCREMENT = 2;
const GITHUB_TAB_HISTORY_MAX_PAGE_LIMIT = 10;
const GITHUB_TAB_CACHE_DISABLED = import.meta.env.MODE === "test";
const GITHUB_PR_LIST_WIDTH_KEY = "ade.prs.githubListWidth";
const GITHUB_PR_LIST_MIN_PX = 260;
const GITHUB_PR_LIST_MAX_PX = 560;
const GITHUB_PR_LIST_DEFAULT_PX = 380;

function readPersistedGithubPrListPx(): number {
  try {
    const raw = localStorage.getItem(GITHUB_PR_LIST_WIDTH_KEY);
    if (raw) {
      const value = Number(raw);
      if (Number.isFinite(value) && value >= GITHUB_PR_LIST_MIN_PX && value <= GITHUB_PR_LIST_MAX_PX) {
        return value;
      }
    }
  } catch {
    /* ignore */
  }
  return GITHUB_PR_LIST_DEFAULT_PX;
}

function persistGithubPrListPx(px: number): void {
  try {
    localStorage.setItem(GITHUB_PR_LIST_WIDTH_KEY, String(Math.round(px)));
  } catch {
    /* ignore */
  }
}

type GitHubTabProps = {
  lanes: LaneSummary[];
  mergeMethod: MergeMethod;
  selectedPrId: string | null;
  onSelectPr: (id: string | null) => void;
  selectedDetailTab?: PrDetailRouteTab | null;
  onDetailTabChange?: (tab: PrDetailRouteTab) => void;
  onRefreshAll: (args?: { prId?: string; prIds?: string[] }) => Promise<void>;
  onOpenRebaseTab?: (laneId?: string) => void;
  onOpenQueueView?: (groupId: string) => void;
  relocateHeaderChrome?: boolean;
  onHeaderChromeChange?: (state: GitHubHeaderChromeState | null) => void;
};

export type GitHubHeaderChromeState = {
  repoLabel: string;
  syncing: boolean;
  syncedAt: string | null;
  onSync: () => void;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
};

type GitHubFilter = "open" | "closed" | "merged";
type GitHubFilterSelectionMap = Partial<Record<GitHubFilter, string | null>>;

type GitHubTabWarmCache = {
  projectRoot: string;
  snapshot: GitHubPrSnapshot | null;
  filter: GitHubFilter;
  selectedItemId: string | null;
  selectedItemIdsByFilter?: GitHubFilterSelectionMap;
  searchQuery: string;
  externalHistoryLoaded: boolean;
  cachedAt: number;
};

type GitHubSnapshotRequestKey = {
  includeExternalClosed: boolean;
  historyPageLimit: number;
};

type CreateLaneFromPrBranchApi = {
  preflightCreateLaneFromPrBranch: (
    args: CreateLaneFromPrBranchArgs,
  ) => Promise<CreateLaneFromPrBranchPreflightResult>;
  createLaneFromPrBranch: (
    args: CreateLaneFromPrBranchArgs,
  ) => Promise<CreateLaneFromPrBranchResult>;
};

let githubTabWarmCache: GitHubTabWarmCache | null = null;

function normalizeGitHubFilter(value: unknown): GitHubFilter {
  return value === "open" || value === "closed" || value === "merged" ? value : "open";
}

function initialGitHubFilterSelections(cache: GitHubTabWarmCache | null): GitHubFilterSelectionMap {
  const selections: GitHubFilterSelectionMap = { ...(cache?.selectedItemIdsByFilter ?? {}) };
  if (cache?.selectedItemId) {
    selections[normalizeGitHubFilter(cache.filter)] = cache.selectedItemId;
  }
  return selections;
}

function normalizeHistoryPageLimit(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return GITHUB_TAB_HISTORY_INITIAL_PAGE_LIMIT;
  }
  return Math.min(
    GITHUB_TAB_HISTORY_MAX_PAGE_LIMIT,
    Math.max(GITHUB_TAB_HISTORY_INITIAL_PAGE_LIMIT, Math.floor(numeric)),
  );
}

function snapshotRequestKey(options?: {
  includeExternalClosed?: boolean;
  historyPageLimit?: number;
}): GitHubSnapshotRequestKey {
  const includeExternalClosed = options?.includeExternalClosed === true;
  return {
    includeExternalClosed,
    historyPageLimit: includeExternalClosed ? normalizeHistoryPageLimit(options?.historyPageLimit) : 0,
  };
}

function snapshotRequestSatisfies(
  current: GitHubSnapshotRequestKey | null,
  requested: GitHubSnapshotRequestKey,
): boolean {
  if (!current) return false;
  if (!requested.includeExternalClosed) return true;
  return current.includeExternalClosed && current.historyPageLimit >= requested.historyPageLimit;
}

function readGitHubTabWarmCache(projectRoot: string | null): GitHubTabWarmCache | null {
  if (GITHUB_TAB_CACHE_DISABLED) return null;
  if (!projectRoot) return null;
  if (githubTabWarmCache?.projectRoot !== projectRoot) return null;
  const filter = normalizeGitHubFilter((githubTabWarmCache as { filter?: unknown }).filter);
  return filter === githubTabWarmCache.filter ? githubTabWarmCache : { ...githubTabWarmCache, filter };
}

function writeGitHubTabWarmCache(cache: GitHubTabWarmCache): void {
  if (GITHUB_TAB_CACHE_DISABLED) return;
  if (!cache.projectRoot) return;
  githubTabWarmCache = cache;
}

function formatGitHubSnapshotError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const message = raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
  if (/github (token|auth) missing/i.test(message)) {
    return "Connect GitHub in Settings with gh auth or a PAT to sync pull requests.";
  }
  return message || "Unable to sync pull requests.";
}

function formatActionError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim() || "Action failed.";
}

function createLaneFromPrBranchApi(): CreateLaneFromPrBranchApi {
  return window.ade.prs as typeof window.ade.prs & CreateLaneFromPrBranchApi;
}

function createLaneFromPrBranchArgs(item: GitHubPrListItem): CreateLaneFromPrBranchArgs {
  return {
    repoOwner: item.repoOwner,
    repoName: item.repoName,
    githubPrNumber: item.githubPrNumber,
  };
}

function createLaneFromPrBranchRequestKey(item: GitHubPrListItem): string {
  return `${item.repoOwner}/${item.repoName}#${Number(item.githubPrNumber)}`;
}

function preflightText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const message = preflightText(record.message) ?? preflightText(record.reason) ?? preflightText(record.summary);
    if (message) return message;
    try {
      return JSON.stringify(value);
    } catch {
      return "Conflict details unavailable.";
    }
  }
  return String(value);
}

function preflightPrNumber(preflight: CreateLaneFromPrBranchPreflight | null, item: GitHubPrListItem): number {
  return Number(preflight?.githubPrNumber ?? item.githubPrNumber);
}

function preflightTitle(preflight: CreateLaneFromPrBranchPreflight | null, item: GitHubPrListItem): string {
  return preflightText(preflight?.title) ?? item.title;
}

function preflightRemoteBranch(preflight: CreateLaneFromPrBranchPreflight | null, item: GitHubPrListItem): string {
  return preflightText(preflight?.remoteBranch) ?? preflightText(preflight?.headBranch) ?? item.headBranch ?? "---";
}

function preflightImportRef(preflight: CreateLaneFromPrBranchPreflight | null): string | null {
  return preflightText(preflight?.importBranchRef);
}

function preflightTargetLaneName(preflight: CreateLaneFromPrBranchPreflight | null, item: GitHubPrListItem): string {
  const remoteBranch = preflightRemoteBranch(preflight, item);
  const fallback = branchNameFromRef(remoteBranch);
  return preflightText(preflight?.targetLaneName) ?? (fallback || "New lane");
}

function preflightBaseBranch(preflight: CreateLaneFromPrBranchPreflight | null, item: GitHubPrListItem): string {
  return preflightText(preflight?.baseBranch) ?? item.baseBranch ?? "---";
}

function preflightBlockingConflict(preflight: CreateLaneFromPrBranchPreflight | null): string | null {
  return preflightText(preflight?.blockingConflict);
}

function createLaneMappedPrId(result: CreateLaneFromPrBranchResult): string | null {
  return preflightText(result.pr?.id);
}

function createLaneMappedLaneId(result: CreateLaneFromPrBranchResult): string | null {
  return preflightText(result.pr?.laneId) ?? preflightText(result.lane?.id);
}

function createLaneMappedLaneName(result: CreateLaneFromPrBranchResult): string | null {
  return preflightText(result.lane?.name);
}

function upsertLaneSummary(lanes: LaneSummary[], lane: LaneSummary): LaneSummary[] {
  const index = lanes.findIndex((entry) => entry.id === lane.id);
  if (index === -1) return [lane, ...lanes];
  const next = lanes.slice();
  next[index] = lane;
  return next;
}

function matchesFilter(item: GitHubPrListItem, filter: GitHubFilter): boolean {
  if (filter === "open") return item.state === "open" || item.state === "draft";
  return item.state === filter;
}

function mergeGitHubListItems(snapshot: GitHubPrSnapshot): GitHubPrListItem[] {
  const combined = [...snapshot.repoPullRequests, ...snapshot.externalPullRequests];
  const seen = new Set<string>();
  return combined.filter((item) => {
    const key = `${item.scope}:${item.repoOwner}/${item.repoName}#${item.githubPrNumber}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type GitHubFilterCounts = Record<GitHubFilter, number>;

function countGitHubItemsByState(items: GitHubPrListItem[]): GitHubFilterCounts {
  return {
    open: items.filter((item) => item.state === "open" || item.state === "draft").length,
    closed: items.filter((item) => item.state === "closed").length,
    merged: items.filter((item) => item.state === "merged").length,
  };
}

/* -- Color-coded state badge with distinct colors per state -- */
function stateColor(state: string): { bg: string; border: string; text: string } {
  switch (state) {
    case "open":
      return { bg: "rgba(59,130,246,0.10)", border: "rgba(59,130,246,0.20)", text: "#60A5FA" };
    case "draft":
      return { bg: "rgba(245,158,11,0.10)", border: "rgba(245,158,11,0.20)", text: "#FBBF24" };
    case "merged":
      return { bg: "rgba(34,197,94,0.10)", border: "rgba(34,197,94,0.20)", text: "#4ADE80" };
    default:
      return { bg: "rgba(161,161,170,0.08)", border: "rgba(161,161,170,0.15)", text: "#A1A1AA" };
  }
}

function stateBadgeStyle(item: GitHubPrListItem): React.CSSProperties {
  const c = stateColor(item.state);
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px 7px",
    fontSize: 10,
    fontWeight: 600,
    fontFamily: SANS_FONT,
    color: c.text,
    background: c.bg,
    border: `1px solid ${c.border}`,
    borderRadius: 5,
    textTransform: "capitalize",
  };
}

/* -- CI status dot color -- */
function ciDotColor(linkedPr: PrSummary | null): { color: string; title: string } | null {
  if (!linkedPr) return null;
  switch (linkedPr.checksStatus) {
    case "passing":
      return { color: COLORS.success, title: "CI passing" };
    case "failing":
      return { color: COLORS.danger, title: "CI failing" };
    case "pending":
      return { color: COLORS.warning, title: "CI pending" };
    default:
      return null;
  }
}

/* -- Review status indicator -- */
function reviewIndicator(linkedPr: PrSummary | null): { color: string; label: string } | null {
  if (!linkedPr) return null;
  switch (linkedPr.reviewStatus) {
    case "approved":
      return { color: COLORS.success, label: "Approved" };
    case "changes_requested":
      return { color: COLORS.danger, label: "Changes" };
    case "requested":
      return { color: COLORS.warning, label: "Review required" };
    default:
      return null;
  }
}

/* -- adeKind badge with distinctive styling -- */
const ADE_KIND_STYLES: Record<string, { color: string; background: string; border: string }> = {
  integration: {
    color: "#FBBF24",
    background: "linear-gradient(135deg, rgba(245,158,11,0.14) 0%, rgba(217,119,6,0.06) 100%)",
    border: "1px solid rgba(245,158,11,0.22)",
  },
  queue: {
    color: "#60A5FA",
    background: "linear-gradient(135deg, rgba(59,130,246,0.14) 0%, rgba(37,99,235,0.06) 100%)",
    border: "1px solid rgba(59,130,246,0.22)",
  },
};

function AdeKindBadge({ kind }: { kind: GitHubPrListItem["adeKind"] }): React.ReactElement | null {
  if (!kind || kind === "single") return null;
  const style = ADE_KIND_STYLES[kind];
  if (!style) return null;
  return <span style={adeKindBadgeStyle(style)}>{kind}</span>;
}

function adeKindBadgeStyle(style: { color: string; background: string; border: string }): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px 7px",
    fontSize: 10,
    fontWeight: 600,
    fontFamily: SANS_FONT,
    color: style.color,
    background: style.background,
    border: style.border,
    borderRadius: 5,
  };
}

/* -- Label text color from hex background (luminance-aware) -- */
function labelTextColor(hexColor: string): string {
  const hex = hexColor.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16) || 0;
  const g = parseInt(hex.substring(2, 4), 16) || 0;
  const b = parseInt(hex.substring(4, 6), 16) || 0;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? "#1a1a2e" : "#f0f0f0";
}

/* -- Filter button styles -- */
const FILTER_COLORS: Record<GitHubFilter, { active: { bg: string; border: string; text: string; shadow: string }; inactive: { text: string } }> = {
  open: {
    active: { bg: "linear-gradient(135deg, rgba(59,130,246,0.16) 0%, rgba(37,99,235,0.08) 100%)", border: "rgba(59,130,246,0.30)", text: "#60A5FA", shadow: "0 0 10px rgba(59,130,246,0.12)" },
    inactive: { text: "#60A5FA" },
  },
  closed: {
    active: { bg: "linear-gradient(135deg, rgba(161,161,170,0.14) 0%, rgba(113,113,122,0.06) 100%)", border: "rgba(161,161,170,0.25)", text: "#A1A1AA", shadow: "0 0 10px rgba(161,161,170,0.08)" },
    inactive: { text: "#71717A" },
  },
  merged: {
    active: { bg: "linear-gradient(135deg, rgba(34,197,94,0.14) 0%, rgba(22,163,74,0.06) 100%)", border: "rgba(34,197,94,0.28)", text: "#4ADE80", shadow: "0 0 10px rgba(34,197,94,0.10)" },
    inactive: { text: "#4ADE80" },
  },
};

function useLaneColorById(laneId: string | null | undefined): string | null {
  return useAppStore((s) => {
    if (!laneId) return null;
    return s.lanes.find((l) => l.id === laneId)?.color ?? null;
  });
}

function branchNameFromRef(ref: string | null | undefined): string {
  return String(ref ?? "").replace(/^refs\/heads\//, "").trim();
}

function canCreateLaneFromPrBranch(item: GitHubPrListItem, lanes: LaneSummary[]): boolean {
  if (item.linkedPrId || item.scope !== "repo") return false;
  if (item.state !== "open" && item.state !== "draft") return false;
  const headBranch = branchNameFromRef(item.headBranch);
  if (!headBranch) return false;
  return !lanes.some((lane) => !lane.archivedAt && branchNameFromRef(lane.branchRef) === headBranch);
}

function sameGitHubPr(left: GitHubPrListItem, right: GitHubPrListItem): boolean {
  return left.repoOwner === right.repoOwner
    && left.repoName === right.repoName
    && Number(left.githubPrNumber) === Number(right.githubPrNumber);
}

/**
 * Stable synthetic PR id for an unmapped GitHub PR (no ADE lane / DB row).
 * Mirrors the backend's `syntheticGithubPrId` so the same coordinate-based
 * fetches that the pane issues resolve consistently. Must be deterministic
 * across renders — it keys both per-id effects in the pane and the React `key`.
 */
function syntheticUnmappedPrId(item: GitHubPrListItem): string {
  return `gh:${item.repoOwner}/${item.repoName}#${item.githubPrNumber}`;
}

/**
 * Build a referentially-stable synthetic `PrWithConflicts` for an unmapped
 * GitHub PR so it can flow through the full `PrDetailPane`. `laneId` is empty
 * (no lane) and the id is derived deterministically from the GitHub item.
 */
function buildSyntheticUnmappedPr(item: GitHubPrListItem, projectId: string): PrWithConflicts {
  return {
    id: syntheticUnmappedPrId(item),
    laneId: "",
    projectId,
    repoOwner: item.repoOwner,
    repoName: item.repoName,
    githubPrNumber: item.githubPrNumber,
    githubUrl: item.githubUrl,
    githubNodeId: null,
    title: item.title,
    state: item.state,
    baseBranch: item.baseBranch ?? "",
    headBranch: item.headBranch ?? "",
    checksStatus: "none",
    reviewStatus: "none",
    additions: 0,
    deletions: 0,
    lastSyncedAt: null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    conflictAnalysis: null,
  };
}

function patchSnapshotWithMappedPr(
  snapshot: GitHubPrSnapshot,
  item: GitHubPrListItem,
  args: {
    mappedPrId: string;
    laneId: string | null;
    laneName: string | null;
  },
): GitHubPrSnapshot {
  const patchItems = (items: GitHubPrListItem[]) => items.map((candidate) => {
    if (candidate.id !== item.id && !sameGitHubPr(candidate, item)) return candidate;
    return {
      ...candidate,
      linkedPrId: args.mappedPrId,
      linkedLaneId: args.laneId ?? candidate.linkedLaneId,
      linkedLaneName: args.laneName ?? candidate.linkedLaneName,
      adeKind: candidate.adeKind ?? "single",
    };
  });
  return {
    ...snapshot,
    repoPullRequests: patchItems(snapshot.repoPullRequests),
    externalPullRequests: patchItems(snapshot.externalPullRequests),
  };
}

function CreateLaneFromPrBranchDialog({
  item,
  preflight,
  loading,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  item: GitHubPrListItem;
  preflight: CreateLaneFromPrBranchPreflight | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const blockingConflict = preflightBlockingConflict(preflight);
  const canConfirm = Boolean(preflight?.canCreate) && !loading && !busy;
  const sourceBranch = preflightRemoteBranch(preflight, item);
  const importRef = preflightImportRef(preflight);
  const rows = [
    ["PR", `#${preflightPrNumber(preflight, item)} ${preflightTitle(preflight, item)}`],
    ["Source branch", sourceBranch],
    ...(importRef && importRef !== sourceBranch ? [["Import ref", importRef] as const] : []),
    ["Target lane", preflightTargetLaneName(preflight, item)],
    ["Base branch", preflightBaseBranch(preflight, item)],
  ] as const;

  return (
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.52)",
        backdropFilter: "blur(10px)",
        padding: 20,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-lane-from-pr-title"
        style={{
          width: "min(560px, 100%)",
          borderRadius: 12,
          border: `1px solid ${COLORS.border}`,
          background: COLORS.cardBgSolid,
          boxShadow: "0 24px 80px rgba(0,0,0,0.45)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "18px 20px 14px", borderBottom: `1px solid ${COLORS.border}` }}>
          <div id="create-lane-from-pr-title" style={{ fontFamily: SANS_FONT, fontSize: 16, fontWeight: 700, color: COLORS.textPrimary }}>
            Create lane from PR branch
          </div>
        </div>
        <div style={{ padding: 20, display: "grid", gap: 14 }}>
          {loading ? (
            <div style={{ fontFamily: SANS_FONT, fontSize: 13, color: COLORS.textSecondary }}>
              Checking branch ownership and PR head availability...
            </div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {rows.map(([label, value]) => (
                <div key={label} style={{ display: "grid", gridTemplateColumns: "120px minmax(0, 1fr)", gap: 12, alignItems: "baseline" }}>
                  <div style={LABEL_STYLE}>{label}</div>
                  <div style={{ fontFamily: label === "PR" ? SANS_FONT : MONO_FONT, fontSize: 12, color: COLORS.textSecondary, minWidth: 0, overflowWrap: "anywhere" }}>
                    {value}
                  </div>
                </div>
              ))}
            </div>
          )}
          {blockingConflict ? (
            <div style={{
              display: "flex",
              gap: 10,
              padding: "10px 12px",
              borderRadius: 9,
              background: "rgba(239,68,68,0.08)",
              border: "1px solid rgba(239,68,68,0.18)",
              color: COLORS.danger,
              fontFamily: SANS_FONT,
              fontSize: 12,
              lineHeight: 1.5,
            }}>
              <Warning size={15} weight="fill" style={{ marginTop: 2, flexShrink: 0 }} />
              <span>{blockingConflict}</span>
            </div>
          ) : null}
          {error ? (
            <div style={{ color: COLORS.danger, fontFamily: SANS_FONT, fontSize: 12, lineHeight: 1.5 }}>
              {error}
            </div>
          ) : null}
        </div>
        <div style={{ padding: "14px 20px", display: "flex", justifyContent: "flex-end", gap: 10, borderTop: `1px solid ${COLORS.border}` }}>
          <button type="button" onClick={onCancel} disabled={busy} style={outlineButton({ height: 34, opacity: busy ? 0.6 : 1 })}>
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!canConfirm}
            style={primaryButton({ height: 34, opacity: canConfirm ? 1 : 0.5 })}
          >
            <GitBranch size={14} /> {busy ? "Creating..." : "Create lane"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function GitHubTab({
  lanes,
  mergeMethod,
  selectedPrId,
  onSelectPr,
  selectedDetailTab,
  onDetailTabChange,
  onRefreshAll,
  onOpenRebaseTab,
  onOpenQueueView,
  relocateHeaderChrome = false,
  onHeaderChromeChange,
}: GitHubTabProps) {
  const navigate = useNavigate();
  const appStore = useAppStoreApi();
  const {
    prs,
    mergeContextByPrId,
    detailStatus,
    detailChecks,
    detailReviews,
    detailComments,
    detailSnapshot,
    detailSnapshotsByPrId = {},
    detailLiveDataPrId,
    detailBusy,
    loading: prsContextLoading,
    setViewerLogin: setContextViewerLogin,
  } = usePrs();
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const selectLane = useAppStore((s) => s.selectLane);

  const initialWarmCacheRef = React.useRef<GitHubTabWarmCache | null>(readGitHubTabWarmCache(projectRoot));
  const [snapshot, setSnapshot] = React.useState<GitHubPrSnapshot | null>(
    () => initialWarmCacheRef.current?.snapshot ?? null,
  );
  const [loading, setLoading] = React.useState(() => !initialWarmCacheRef.current?.snapshot);
  const [error, setError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<GitHubFilter>(() => normalizeGitHubFilter(initialWarmCacheRef.current?.filter));
  const [selectedItemId, setSelectedItemId] = React.useState<string | null>(
    () => initialWarmCacheRef.current?.selectedItemId ?? null,
  );
  const [selectedItemIdsByFilter, setSelectedItemIdsByFilter] = React.useState<GitHubFilterSelectionMap>(
    () => initialGitHubFilterSelections(initialWarmCacheRef.current),
  );
  const [linkLaneId, setLinkLaneId] = React.useState("");
  const [linkingItemId, setLinkingItemId] = React.useState<string | null>(null);
  const [unlinkingPrId, setUnlinkingPrId] = React.useState<string | null>(null);
  const [createLaneItem, setCreateLaneItem] = React.useState<GitHubPrListItem | null>(null);
  const [createLanePreflight, setCreateLanePreflight] = React.useState<CreateLaneFromPrBranchPreflightResult | null>(null);
  const [createLaneLoading, setCreateLaneLoading] = React.useState(false);
  const [createLaneBusy, setCreateLaneBusy] = React.useState(false);
  const [createLaneError, setCreateLaneError] = React.useState<string | null>(null);
  const [syncing, setSyncing] = React.useState(false);
  const [loadingOlderHistory, setLoadingOlderHistory] = React.useState(false);
  const [loadingFilter, setLoadingFilter] = React.useState<GitHubFilter | null>(null);
  const [renderedHydrationItems, setRenderedHydrationItems] = React.useState<GitHubPrListItem[]>([]);
  const [searchQuery, setSearchQuery] = React.useState(() => initialWarmCacheRef.current?.searchQuery ?? "");
  const [externalHistoryLoaded, setExternalHistoryLoaded] = React.useState(
    () => initialWarmCacheRef.current?.externalHistoryLoaded ?? false,
  );
  const createLanePreflightRequestIdRef = React.useRef(0);
  const createLanePreflightRequestRef = React.useRef<{ id: number; itemKey: string } | null>(null);
  const lastHandledSelectedPrIdRef = React.useRef<string | null | undefined>(undefined);
  const pendingSelectedItemIdRef = React.useRef<string | null>(null);
  const pendingRestoredSelectedItemIdRef = React.useRef<string | null>(null);
  const snapshotRef = React.useRef<GitHubPrSnapshot | null>(null);
  const hasInitializedSelectionRef = React.useRef(Boolean(initialWarmCacheRef.current?.selectedItemId));
  const lastPrFingerprintRef = React.useRef<string>("");
  const hotRefreshUntilRef = React.useRef(0);
  const hotRefreshTimerRef = React.useRef<number | null>(null);
  const inFlightSnapshotRef = React.useRef<({ request: Promise<GitHubPrSnapshot> } & GitHubSnapshotRequestKey) | null>(null);
  const loadingSnapshotRequestCountRef = React.useRef(0);
  const lastSnapshotLoadedAtRef = React.useRef(initialWarmCacheRef.current?.cachedAt ?? 0);
  const missingLinkedPrHydrationRef = React.useRef<string | null>(null);
  const visibleLinkedHydrationKeyRef = React.useRef<string>("");
  const filterRef = React.useRef(filter);
  const externalHistoryLoadedRef = React.useRef(externalHistoryLoaded);
  const projectRootRef = React.useRef(projectRoot);
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const defaultListPx = React.useMemo(() => readPersistedGithubPrListPx(), []);
  snapshotRef.current = snapshot;
  filterRef.current = filter;
  externalHistoryLoadedRef.current = externalHistoryLoaded;

  const currentHistoryPageLimit = React.useCallback(() => {
    const current = snapshotRef.current?.history?.pageLimit;
    return normalizeHistoryPageLimit(current);
  }, []);

  /* Build a lookup from linkedPrId -> PrSummary for CI/review indicators */
  const prsByIdMap = React.useMemo(() => {
    const map = new Map<string, PrSummary>();
    for (const pr of prs) {
      map.set(pr.id, pr);
    }
    return map;
  }, [prs]);

  const loadSnapshot = React.useCallback(async (options?: {
    force?: boolean;
    silent?: boolean;
    includeExternalClosed?: boolean;
    historyPageLimit?: number;
  }) => {
    const requestKey = snapshotRequestKey(options);
    const inFlightSnapshot = inFlightSnapshotRef.current;
    if (options?.force !== true && inFlightSnapshot && snapshotRequestSatisfies(inFlightSnapshot, requestKey)) {
      return inFlightSnapshot.request;
    }
    const shouldShowLoading = !options?.silent && (options?.force === true || snapshotRef.current == null);
    if (shouldShowLoading) {
      loadingSnapshotRequestCountRef.current += 1;
      setLoading(true);
    }
    setError(null);
    const requestProjectRoot = projectRootRef.current;
    let pending!: Promise<GitHubPrSnapshot>;
    const isCurrentSnapshotRequest = () =>
      inFlightSnapshotRef.current?.request === pending
      && inFlightSnapshotRef.current.includeExternalClosed === requestKey.includeExternalClosed
      && inFlightSnapshotRef.current.historyPageLimit === requestKey.historyPageLimit;
    pending = (async () => {
      return getGitHubSnapshotCoalesced(
        {
          force: options?.force === true,
          ...(requestKey.includeExternalClosed ? {
            includeExternalClosed: true,
            historyPageLimit: requestKey.historyPageLimit,
          } : {}),
        },
        { projectRoot: requestProjectRoot },
      );
    })()
      .then((next) => {
        if (!next) return next;
        if (projectRootRef.current !== requestProjectRoot) return next;
        if (!isCurrentSnapshotRequest()) return next;
        setSnapshot(next);
        setExternalHistoryLoaded((prev) => prev || requestKey.includeExternalClosed);
        lastSnapshotLoadedAtRef.current = Date.now();
        if (next.viewerLogin) {
          setContextViewerLogin?.(next.viewerLogin);
        }
        return next;
      })
      .catch((err) => {
        if (projectRootRef.current === requestProjectRoot && isCurrentSnapshotRequest()) {
          setError(formatGitHubSnapshotError(err));
        }
        return snapshotRef.current as GitHubPrSnapshot;
      })
      .finally(() => {
        if (isCurrentSnapshotRequest()) {
          inFlightSnapshotRef.current = null;
        }
        if (shouldShowLoading) {
          loadingSnapshotRequestCountRef.current = Math.max(0, loadingSnapshotRequestCountRef.current - 1);
          if (loadingSnapshotRequestCountRef.current === 0 && projectRootRef.current === requestProjectRoot) {
            setLoading(false);
          }
        }
      });
    inFlightSnapshotRef.current = { request: pending, ...requestKey };
    return pending;
  }, [setContextViewerLogin]);

  React.useEffect(() => {
    if (projectRootRef.current === projectRoot) return;
    projectRootRef.current = projectRoot;
    inFlightSnapshotRef.current = null;
    loadingSnapshotRequestCountRef.current = 0;
    const warmCache = readGitHubTabWarmCache(projectRoot);
    initialWarmCacheRef.current = warmCache;
    setSnapshot(warmCache?.snapshot ?? null);
    setLoading(!warmCache?.snapshot);
    setError(null);
    setFilter(normalizeGitHubFilter(warmCache?.filter));
    setSelectedItemId(warmCache?.selectedItemId ?? null);
    setSelectedItemIdsByFilter(initialGitHubFilterSelections(warmCache));
    setSearchQuery(warmCache?.searchQuery ?? "");
    setExternalHistoryLoaded(warmCache?.externalHistoryLoaded ?? false);
    lastSnapshotLoadedAtRef.current = warmCache?.cachedAt ?? 0;
    if (!warmCache?.snapshot) {
      void loadSnapshot({ silent: false });
    }
  }, [loadSnapshot, projectRoot]);

  React.useEffect(() => {
    if (snapshot?.viewerLogin) {
      setContextViewerLogin?.(snapshot.viewerLogin);
    }
  }, [setContextViewerLogin, snapshot?.viewerLogin]);

  const startHotRefreshWindow = React.useCallback(() => {
    if (hotRefreshTimerRef.current != null) return;
    hotRefreshUntilRef.current = Date.now() + GITHUB_TAB_HOT_REFRESH_DELAY_MS;
    hotRefreshTimerRef.current = window.setTimeout(() => {
      hotRefreshTimerRef.current = null;
      hotRefreshUntilRef.current = 0;
      const includeExternalClosed =
        externalHistoryLoadedRef.current || filterRef.current !== "open";
      void loadSnapshot({
        force: true,
        silent: true,
        ...(includeExternalClosed ? { includeExternalClosed: true, historyPageLimit: currentHistoryPageLimit() } : {}),
      });
    }, GITHUB_TAB_HOT_REFRESH_DELAY_MS);
  }, [currentHistoryPageLimit, loadSnapshot]);

  React.useEffect(() => {
    const warmCache = initialWarmCacheRef.current;
    const hasFreshWarmSnapshot =
      Boolean(warmCache?.snapshot)
      && Date.now() - (warmCache?.cachedAt ?? 0) < GITHUB_TAB_REVISIT_CACHE_TTL_MS;
    if (!hasFreshWarmSnapshot) {
      void loadSnapshot({ silent: snapshotRef.current != null });
    }
    return () => {
      if (hotRefreshTimerRef.current != null) {
        window.clearTimeout(hotRefreshTimerRef.current);
        hotRefreshTimerRef.current = null;
      }
      hotRefreshUntilRef.current = 0;
    };
  }, [loadSnapshot]);

  React.useEffect(() => {
    if (!projectRoot) return;
    writeGitHubTabWarmCache({
      projectRoot,
      snapshot,
      filter,
      selectedItemId,
      selectedItemIdsByFilter,
      searchQuery,
      externalHistoryLoaded,
      cachedAt: Date.now(),
    });
  }, [externalHistoryLoaded, filter, projectRoot, searchQuery, selectedItemId, selectedItemIdsByFilter, snapshot]);

  React.useEffect(() => {
    if (filter === "open" || externalHistoryLoaded) return;
    const loadingFor = filter;
    setLoadingFilter(loadingFor);
    void loadSnapshot({
      includeExternalClosed: true,
      historyPageLimit: GITHUB_TAB_HISTORY_INITIAL_PAGE_LIMIT,
      silent: snapshotRef.current != null,
    }).finally(() => {
      setLoadingFilter((current) => current === loadingFor ? null : current);
    });
  }, [externalHistoryLoaded, filter, loadSnapshot]);

  React.useEffect(() => {
    const unsubscribe = window.ade.prs.onEvent((event: PrEventPayload) => {
      if (event.type !== "prs-updated" && event.type !== "pr-auto-linked") return;
      const includeExternalClosed =
        externalHistoryLoadedRef.current || filterRef.current !== "open";
      void loadSnapshot({
        silent: true,
        ...(includeExternalClosed ? { includeExternalClosed: true, historyPageLimit: currentHistoryPageLimit() } : {}),
      });
    });
    return unsubscribe;
  }, [currentHistoryPageLimit, loadSnapshot]);

  React.useEffect(() => {
    if (prsContextLoading && prs.length === 0) return;
    const nextFingerprint = JSON.stringify(
      prs
        .map((pr) => [
          pr.id,
          pr.state,
          pr.title,
          pr.githubPrNumber,
        ])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    );
    if (!lastPrFingerprintRef.current) {
      lastPrFingerprintRef.current = nextFingerprint;
      return;
    }
    if (lastPrFingerprintRef.current === nextFingerprint) return;
    lastPrFingerprintRef.current = nextFingerprint;
    if (Date.now() - lastSnapshotLoadedAtRef.current < GITHUB_TAB_SNAPSHOT_FRESH_MS) return;
    startHotRefreshWindow();
    const includeExternalClosed =
      externalHistoryLoadedRef.current || filterRef.current !== "open";
    void loadSnapshot({
      force: true,
      silent: true,
      ...(includeExternalClosed ? { includeExternalClosed: true, historyPageLimit: currentHistoryPageLimit() } : {}),
    });
  }, [currentHistoryPageLimit, loadSnapshot, prs, prsContextLoading, startHotRefreshWindow]);

  const matchesSearch = React.useCallback((item: GitHubPrListItem) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.trim().toLowerCase();
    return (
      item.title.toLowerCase().includes(q) ||
      (item.author?.toLowerCase().includes(q) ?? false) ||
      (item.headBranch?.toLowerCase().includes(q) ?? false) ||
      String(item.githubPrNumber).includes(q)
    );
  }, [searchQuery]);

  const allItems = React.useMemo(
    () => (snapshot ? mergeGitHubListItems(snapshot) : []),
    [snapshot],
  );

  const filteredItems = React.useMemo(
    () => allItems
      .filter((item) => matchesFilter(item, filter) && matchesSearch(item))
      .sort((a, b) =>
        new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime(),
      ),
    [allItems, filter, matchesSearch],
  );
  const hydrationItems = filteredItems.length > VIRTUALIZE_AT ? renderedHydrationItems : filteredItems;

  const filterCounts = React.useMemo(() => {
    const listedCounts = countGitHubItemsByState(allItems);
    const snapshotCounts = snapshot?.history?.repoPullRequestCounts;
    return {
      open: snapshotCounts?.open ?? listedCounts.open,
      closed: snapshotCounts?.closed ?? listedCounts.closed,
      merged: snapshotCounts?.merged ?? listedCounts.merged,
    };
  }, [allItems, snapshot?.history?.repoPullRequestCounts]);
  const canLoadOlderHistory =
    filter !== "open"
    && Boolean(snapshot?.history?.repoPullRequestsMayHaveMore)
    && currentHistoryPageLimit() < GITHUB_TAB_HISTORY_MAX_PAGE_LIMIT;
  const showListLoadingIndicator = loading || syncing || loadingFilter !== null;

  React.useEffect(() => {
    if (!snapshot) return;
    if (selectedPrId === lastHandledSelectedPrIdRef.current) return;
    lastHandledSelectedPrIdRef.current = selectedPrId;

    if (!selectedPrId) {
      pendingSelectedItemIdRef.current = null;
      return;
    }

    const linkedItem = allItems.find((item) => item.linkedPrId === selectedPrId);
    if (!linkedItem) {
      pendingSelectedItemIdRef.current = null;
      return;
    }

    pendingSelectedItemIdRef.current = linkedItem.id;
    const linkedFilter = linkedItem.state === "merged" ? "merged" : linkedItem.state === "closed" ? "closed" : "open";
    setSelectedItemIdsByFilter((prev) => ({ ...prev, [linkedFilter]: linkedItem.id }));
    if (!matchesFilter(linkedItem, filter)) {
      setFilter(linkedFilter);
    }
    setSelectedItemId(linkedItem.id);
    hasInitializedSelectionRef.current = true;
  }, [allItems, snapshot, selectedPrId, filter]);

  React.useEffect(() => {
    if (!snapshot) return;
    if (pendingSelectedItemIdRef.current) {
      if (selectedItemId === pendingSelectedItemIdRef.current) {
        pendingSelectedItemIdRef.current = null;
      } else {
        return;
      }
    }

    if (selectedItemId && filteredItems.some((item) => item.id === selectedItemId)) return;
    if (!hasInitializedSelectionRef.current) {
      const next = filteredItems[0] ?? null;
      if (next) {
        hasInitializedSelectionRef.current = true;
        setSelectedItemId(next.id);
        setSelectedItemIdsByFilter((prev) => ({ ...prev, [filter]: next.id }));
        onSelectPr(next.linkedPrId ?? null);
      }
    }
  }, [snapshot, filter, filteredItems, selectedItemId, onSelectPr]);

  const selectedItem = React.useMemo(
    () => {
      const item = allItems.find((candidate) => candidate.id === selectedItemId) ?? null;
      return item && matchesFilter(item, filter) ? item : null;
    },
    [allItems, filter, selectedItemId],
  );

  React.useEffect(() => {
    const pending = pendingRestoredSelectedItemIdRef.current;
    if (!pending || !selectedItem || selectedItem.id !== pending) return;
    pendingRestoredSelectedItemIdRef.current = null;
    onSelectPr(selectedItem.linkedPrId ?? null);
  }, [onSelectPr, selectedItem]);
  const missingLinkedPrId = selectedItem?.linkedPrId && !prsByIdMap.has(selectedItem.linkedPrId)
    ? selectedItem.linkedPrId
    : null;

  React.useEffect(() => {
    if (!missingLinkedPrId) {
      missingLinkedPrHydrationRef.current = null;
      return;
    }
    if (missingLinkedPrHydrationRef.current === missingLinkedPrId) return;
    missingLinkedPrHydrationRef.current = missingLinkedPrId;
    void onRefreshAll({ prId: missingLinkedPrId }).catch(() => {});
  }, [missingLinkedPrId, onRefreshAll]);

  React.useEffect(() => {
    const prIds = hydrationItems
      .slice(0, LINKED_HYDRATION_LIMIT)
      .map((item) => item.linkedPrId)
      .filter((prId): prId is string => Boolean(prId));
    if (prIds.length === 0) return undefined;
    const uniquePrIds = [...new Set(prIds)];
    const key = uniquePrIds.join(",");
    if (visibleLinkedHydrationKeyRef.current === key) return undefined;
    visibleLinkedHydrationKeyRef.current = key;
    const timer = window.setTimeout(() => {
      void onRefreshAll({ prIds: uniquePrIds }).catch(() => {});
    }, 250);
    return () => window.clearTimeout(timer);
  }, [hydrationItems, onRefreshAll]);

  const handleHydrationItemsChange = React.useCallback((items: GitHubPrListItem[]) => {
    setRenderedHydrationItems((prev) => {
      if (prev.length === items.length && prev.every((item, index) => item.id === items[index]?.id)) return prev;
      return items;
    });
  }, []);

  const selectedLinkedPr = React.useMemo(
    (): PrWithConflicts | null => {
      if (!selectedItem?.linkedPrId) return null;
      const linked = prs.find((pr) => pr.id === selectedItem.linkedPrId);
      if (linked) return linked;
      const fallbackProjectId = prs[0]?.projectId ?? "cached-github-snapshot";
      return {
        id: selectedItem.linkedPrId,
        laneId: selectedItem.linkedLaneId ?? "",
        projectId: fallbackProjectId,
        repoOwner: selectedItem.repoOwner,
        repoName: selectedItem.repoName,
        githubPrNumber: selectedItem.githubPrNumber,
        githubUrl: selectedItem.githubUrl,
        githubNodeId: null,
        title: selectedItem.title,
        state: selectedItem.state,
        baseBranch: selectedItem.baseBranch ?? "",
        headBranch: selectedItem.headBranch ?? "",
        checksStatus: "none",
        reviewStatus: "none",
        additions: 0,
        deletions: 0,
        lastSyncedAt: null,
        createdAt: selectedItem.createdAt,
        updatedAt: selectedItem.updatedAt,
        conflictAnalysis: null,
      };
    },
    [prs, selectedItem],
  );

  // For an unmapped selected PR (no linkedPrId) build a referentially-stable
  // synthetic PR so it can render through the full PrDetailPane. Memoized on the
  // stable synthetic id so the object identity (and React key) stays constant
  // across renders while the same PR is selected.
  const syntheticUnmappedId = selectedItem && !selectedItem.linkedPrId
    ? syntheticUnmappedPrId(selectedItem)
    : null;
  const selectedUnmappedPr = React.useMemo(
    (): PrWithConflicts | null => {
      if (!selectedItem || selectedItem.linkedPrId) return null;
      const fallbackProjectId = prs[0]?.projectId ?? "cached-github-snapshot";
      return buildSyntheticUnmappedPr(selectedItem, fallbackProjectId);
    },
    // syntheticUnmappedId keys identity; prs[0]?.projectId is captured at build time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [syntheticUnmappedId, selectedItem, prs],
  );
  const selectedDisplayPr = selectedLinkedPr ?? selectedUnmappedPr;

  const selectedGithubCoords = React.useMemo(
    (): { repoOwner: string; repoName: string; githubPrNumber: number } | null =>
      selectedItem
        ? {
            repoOwner: selectedItem.repoOwner,
            repoName: selectedItem.repoName,
            githubPrNumber: selectedItem.githubPrNumber,
          }
        : null,
    [selectedItem],
  );

  // Lanes whose branch matches the unmapped PR's head branch (the same gate the
  // legacy read-only pane used) — offered in the in-pane "Map to lane" select.
  const linkableLanesForSelected = React.useMemo(
    () => {
      if (!selectedItem) return [] as Array<{ id: string; name: string }>;
      const headBranch = branchNameFromRef(selectedItem.headBranch);
      return lanes
        .filter((lane) => {
          if (lane.archivedAt || lane.laneType === "primary") return false;
          if (!headBranch) return true;
          return branchNameFromRef(lane.branchRef) === headBranch;
        })
        .map((lane) => ({ id: lane.id, name: lane.name }));
    },
    [lanes, selectedItem],
  );

  const selectedQueueContext = React.useMemo(() => {
    if (!selectedLinkedPr) return null;
    const mergeContext = mergeContextByPrId[selectedLinkedPr.id];
    if (mergeContext?.groupType !== "queue" || !mergeContext.groupId) return null;
    return {
      groupId: mergeContext.groupId,
      label: "Open queue",
    };
  }, [mergeContextByPrId, selectedLinkedPr]);

  const handleSync = React.useCallback(async (args: { prId?: string; prIds?: string[] } = {}) => {
    setSyncing(true);
    startHotRefreshWindow();
    try {
      const targeted = Boolean(args.prId || (args.prIds?.length ?? 0) > 0);
      const includeExternalClosed =
        externalHistoryLoadedRef.current || filterRef.current !== "open";
      if (targeted) {
        await onRefreshAll(args).catch(() => {});
      } else {
        await Promise.all([
          onRefreshAll().catch(() => {}),
          loadSnapshot({
            force: true,
            ...(includeExternalClosed ? { includeExternalClosed: true, historyPageLimit: currentHistoryPageLimit() } : {}),
          }),
        ]);
      }
    } finally {
      setSyncing(false);
    }
  }, [currentHistoryPageLimit, loadSnapshot, onRefreshAll, startHotRefreshWindow]);

  const handleLoadOlderHistory = React.useCallback(async () => {
    if (loadingOlderHistory) return;
    const nextLimit = Math.min(
      GITHUB_TAB_HISTORY_MAX_PAGE_LIMIT,
      currentHistoryPageLimit() + GITHUB_TAB_HISTORY_PAGE_INCREMENT,
    );
    setLoadingOlderHistory(true);
    setLoadingFilter(filter);
    try {
      await loadSnapshot({
        force: true,
        includeExternalClosed: true,
        historyPageLimit: nextLimit,
        silent: true,
      });
      setExternalHistoryLoaded(true);
    } finally {
      setLoadingOlderHistory(false);
      setLoadingFilter((current) => current === filter ? null : current);
    }
  }, [currentHistoryPageLimit, filter, loadSnapshot, loadingOlderHistory]);

  const repoLabel = snapshot?.repo ? `${snapshot.repo.owner}/${snapshot.repo.name}` : "";

  React.useEffect(() => {
    if (!relocateHeaderChrome || !onHeaderChromeChange) return;
    onHeaderChromeChange({
      repoLabel,
      syncing,
      syncedAt: snapshot?.syncedAt ?? null,
      onSync: () => {
        void handleSync();
      },
      searchQuery,
      onSearchQueryChange: setSearchQuery,
    });
  }, [handleSync, onHeaderChromeChange, relocateHeaderChrome, repoLabel, searchQuery, snapshot?.syncedAt, syncing]);

  React.useEffect(() => {
    if (!relocateHeaderChrome || !onHeaderChromeChange) return;
    return () => onHeaderChromeChange(null);
  }, [onHeaderChromeChange, relocateHeaderChrome]);

  const handleSelectItem = React.useCallback((item: GitHubPrListItem) => {
    hasInitializedSelectionRef.current = true;
    setSelectedItemId(item.id);
    setSelectedItemIdsByFilter((prev) => ({ ...prev, [filter]: item.id }));
    pendingRestoredSelectedItemIdRef.current = null;
    onSelectPr(item.linkedPrId ?? null);
    setLinkLaneId("");
  }, [filter, onSelectPr]);

  const handleFilterChange = React.useCallback((state: GitHubFilter) => {
    pendingSelectedItemIdRef.current = null;
    if (state !== filter && listRef.current) {
      if (typeof listRef.current.scrollTo === "function") {
        listRef.current.scrollTo({ top: 0, left: 0 });
      } else {
        listRef.current.scrollTop = 0;
      }
    }
    const cachedSelectedItemId = selectedItemIdsByFilter[state] ?? null;
    const cachedSelectedItem = cachedSelectedItemId
      ? allItems.find((item) => item.id === cachedSelectedItemId) ?? null
      : null;
    const nextSelectedItemId = cachedSelectedItem && !matchesFilter(cachedSelectedItem, state)
      ? null
      : cachedSelectedItemId;
    const nextSelectedItem = cachedSelectedItem && nextSelectedItemId
      ? cachedSelectedItem
      : null;
    setFilter(state);
    setSelectedItemIdsByFilter((prev) => ({ ...prev, [filter]: selectedItemId, [state]: nextSelectedItemId }));
    setSelectedItemId(nextSelectedItemId);
    if (nextSelectedItemId && !nextSelectedItem) {
      pendingRestoredSelectedItemIdRef.current = nextSelectedItemId;
    } else {
      pendingRestoredSelectedItemIdRef.current = null;
      onSelectPr(nextSelectedItem?.linkedPrId ?? null);
    }
    setLinkLaneId("");
  }, [allItems, filter, onSelectPr, selectedItemId, selectedItemIdsByFilter]);

  const handleLink = React.useCallback(async () => {
    if (!selectedItem || !linkLaneId) return;
    setLinkingItemId(selectedItem.id);
    setError(null);
    try {
      await window.ade.prs.linkToLane({ laneId: linkLaneId, prUrlOrNumber: selectedItem.githubUrl });
      await handleSync();
      setLinkLaneId("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLinkingItemId(null);
    }
  }, [handleSync, linkLaneId, selectedItem]);

  const handleUnlink = React.useCallback(async (item: GitHubPrListItem | null = selectedItem) => {
    if (!item?.linkedPrId) return;
    const confirmed = typeof window.confirm !== "function"
      ? true
      : window.confirm(`Unmap PR #${item.githubPrNumber} from its ADE lane? ADE will keep the GitHub PR open and remember not to relink it automatically.`);
    if (!confirmed) return;
    setUnlinkingPrId(item.linkedPrId);
    setError(null);
    try {
      await window.ade.prs.delete({
        prId: item.linkedPrId,
        closeOnGitHub: false,
        archiveLane: false,
      });
      onSelectPr(null);
      setSelectedItemId(item.id);
      setSelectedItemIdsByFilter((prev) => ({ ...prev, [filterRef.current]: item.id }));
      await Promise.all([
        onRefreshAll().catch(() => {}),
        loadSnapshot({
          force: true,
          silent: true,
          ...(externalHistoryLoadedRef.current || filterRef.current !== "open" ? { includeExternalClosed: true } : {}),
        }).catch(() => null),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUnlinkingPrId(null);
    }
  }, [loadSnapshot, onRefreshAll, onSelectPr, selectedItem]);

  const handleOpenCreateLaneFromPrBranch = React.useCallback((item: GitHubPrListItem | null = selectedItem) => {
    if (!item) return;
    const requestId = createLanePreflightRequestIdRef.current + 1;
    const itemKey = createLaneFromPrBranchRequestKey(item);
    createLanePreflightRequestIdRef.current = requestId;
    createLanePreflightRequestRef.current = { id: requestId, itemKey };
    const isCurrentPreflightRequest = () => {
      const current = createLanePreflightRequestRef.current;
      return current?.id === requestId && current.itemKey === itemKey;
    };
    setCreateLaneItem(item);
    setCreateLanePreflight(null);
    setCreateLaneError(null);
    setCreateLaneLoading(true);
    void createLaneFromPrBranchApi()
      .preflightCreateLaneFromPrBranch(createLaneFromPrBranchArgs(item))
      .then((result) => {
        if (!isCurrentPreflightRequest()) return;
        setCreateLanePreflight(result);
      })
      .catch((err) => {
        if (!isCurrentPreflightRequest()) return;
        setCreateLaneError(formatActionError(err));
      })
      .finally(() => {
        if (!isCurrentPreflightRequest()) return;
        setCreateLaneLoading(false);
      });
  }, [selectedItem]);

  const handleCancelCreateLaneFromPrBranch = React.useCallback(() => {
    if (createLaneBusy) return;
    createLanePreflightRequestRef.current = null;
    setCreateLaneItem(null);
    setCreateLanePreflight(null);
    setCreateLaneError(null);
    setCreateLaneLoading(false);
  }, [createLaneBusy]);

  const handleConfirmCreateLaneFromPrBranch = React.useCallback(async () => {
    if (!createLaneItem) return;
    setCreateLaneBusy(true);
    setCreateLaneError(null);
    const createProjectRoot = projectRoot;
    try {
      const result = await createLaneFromPrBranchApi()
        .createLaneFromPrBranch(createLaneFromPrBranchArgs(createLaneItem));
      const mappedPrId = createLaneMappedPrId(result);
      const mappedLaneId = createLaneMappedLaneId(result);
      if (mappedPrId) {
        setSnapshot((current) => current
          ? patchSnapshotWithMappedPr(current, createLaneItem, {
              mappedPrId,
              laneId: mappedLaneId,
              laneName: createLaneMappedLaneName(result),
            })
          : current);
        setSelectedItemId(createLaneItem.id);
        setSelectedItemIdsByFilter((prev) => ({ ...prev, [filterRef.current]: createLaneItem.id }));
        onSelectPr(mappedPrId);
      }
      setCreateLaneItem(null);
      setCreateLanePreflight(null);
      const syncCreatedLane = result.lane?.id
        ? refreshLanes({ includeStatus: false, includeSnapshots: false })
          .catch(() => {})
          .then(() => {
            const currentProjectRoot = selectActiveProjectRoot(appStore.getState());
            if (createProjectRoot && currentProjectRoot !== createProjectRoot) return;
            appStore.setState((prev) => ({
              lanes: upsertLaneSummary(prev.lanes, result.lane),
              laneSnapshots: prev.laneSnapshots.map((snapshot) =>
                snapshot.lane.id === result.lane.id ? { ...snapshot, lane: result.lane } : snapshot,
              ),
              lanesLoading: false,
            }));
            selectLane(result.lane.id);
          })
        : Promise.resolve();
      await Promise.all([
        mappedPrId ? onRefreshAll({ prId: mappedPrId }).catch(() => {}) : onRefreshAll().catch(() => {}),
        loadSnapshot({
          force: true,
          silent: true,
          ...(externalHistoryLoadedRef.current || filterRef.current !== "open" ? { includeExternalClosed: true } : {}),
        }).catch(() => null),
        syncCreatedLane,
      ]);
    } catch (err) {
      setCreateLaneError(formatActionError(err));
    } finally {
      setCreateLaneBusy(false);
    }
  }, [appStore, createLaneItem, loadSnapshot, onRefreshAll, onSelectPr, projectRoot, refreshLanes, selectLane]);

  // Create/map controls surfaced inside PrDetailPane for an unmapped selected PR.
  const unmappedAffordance = React.useMemo((): UnmappedAffordance | null => {
    if (!selectedItem || selectedItem.linkedPrId) return null;
    return {
      linkableLanes: linkableLanesForSelected,
      selectedLaneId: linkLaneId,
      onSelectLane: setLinkLaneId,
      onLink: () => { void handleLink(); },
      linkBusy: linkingItemId === selectedItem.id,
      canCreateLane: canCreateLaneFromPrBranch(selectedItem, lanes),
      onCreateLane: () => handleOpenCreateLaneFromPrBranch(selectedItem),
      scope: selectedItem.scope,
    };
  }, [
    handleLink,
    handleOpenCreateLaneFromPrBranch,
    lanes,
    linkLaneId,
    linkableLanesForSelected,
    linkingItemId,
    selectedItem,
  ]);

  if (error && !snapshot) {
    return (
      <EmptyState title="GitHub" description={error}>
        <button
          type="button"
          onClick={() => navigate("/settings?tab=general#github-connection")}
          style={primaryButton({ marginTop: 16 })}
        >
          <GithubLogo size={14} weight="fill" />
          Connect GitHub
        </button>
      </EmptyState>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* Search / sync chrome only renders inline when it hasn't been hoisted to
          the shared PRs header. The Open/Merged/Closed tabs now live at the top of
          the list column (below) so the detail pane can rise to sit level with them. */}
      {!relocateHeaderChrome ? (
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 16px",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          background: "rgba(255,255,255,0.01)",
        }}>
          <GitHubPrSearchInput value={searchQuery} onChange={setSearchQuery} />
          <GitHubRepoSyncBar
            repoLabel={repoLabel}
            syncing={syncing}
            syncedAt={snapshot?.syncedAt ?? null}
            onSync={() => {
              void handleSync();
            }}
          />
        </div>
      ) : null}

      {error ? (
        <div style={{
          padding: "10px 16px",
          borderBottom: "1px solid rgba(239,68,68,0.2)",
          background: "rgba(239,68,68,0.06)",
          color: COLORS.danger,
          fontFamily: SANS_FONT,
          fontSize: 12,
          borderRadius: 0,
        }}>
          {error}
        </div>
      ) : null}

      <div style={{ display: "flex", minHeight: 0, flex: 1 }}>
        <Group id="github-pr-layout" orientation="horizontal" className="flex h-full min-h-0 w-full">
          <Panel
            id="github-pr-list"
            data-tour="prs.list"
            defaultSize={defaultListPx}
            minSize={GITHUB_PR_LIST_MIN_PX}
            maxSize={GITHUB_PR_LIST_MAX_PX}
            onResize={(size) => persistGithubPrListPx(size.inPixels)}
            className="min-h-0 min-w-0"
            style={{ overflow: "hidden", borderRight: "1px solid rgba(255,255,255,0.06)" }}
          >
            <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
              {/* Filter tabs (Open / Merged / Closed) — fixed header capping the
                  list column. The detail pane to the right rises to sit level with
                  these; the list min width keeps the right edge of "Closed" aligned
                  with the list/detail divider. */}
              <div style={{
                display: "flex",
                alignItems: "center",
                gap: 0,
                padding: "0 16px",
                flexShrink: 0,
                borderBottom: "1px solid rgba(255,255,255,0.06)",
                background: "rgba(255,255,255,0.01)",
              }}>
                {(["open", "merged", "closed"] as GitHubFilter[]).map((state) => {
                  const active = filter === state;
                  const fc = FILTER_COLORS[state];
                  const count = filterCounts[state];
                  const icon = state === "merged" ? <GitMerge size={12} weight="bold" /> : null;
                  const tabLoading = active && (loading || syncing || loadingFilter === state || loadingOlderHistory);
                  return (
                    <button
                      key={state}
                      type="button"
                      onClick={() => handleFilterChange(state)}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 5,
                        height: 36,
                        padding: "0 14px",
                        fontSize: 12,
                        fontWeight: active ? 600 : 400,
                        fontFamily: SANS_FONT,
                        color: active ? fc.active.text : COLORS.textMuted,
                        background: "transparent",
                        border: "none",
                        borderBottom: active ? `2px solid ${fc.active.text}` : "2px solid transparent",
                        cursor: "pointer",
                        textTransform: "capitalize",
                        transition: "all 150ms ease",
                      }}
                    >
                      {icon}
                      {state}
                      {tabLoading ? (
                        <CircleNotch
                          size={12}
                          className="animate-spin"
                          weight="bold"
                          aria-label={`Loading ${state} pull requests`}
                          style={{ color: active ? fc.active.text : COLORS.accent, opacity: 0.9 }}
                        />
                      ) : (
                        <span style={{
                          fontFamily: MONO_FONT,
                          fontSize: 10,
                          fontWeight: 600,
                          color: active ? fc.active.text : COLORS.textDim,
                          opacity: active ? 0.8 : 0.6,
                        }}>
                          {count}
                        </span>
                      )}
                    </button>
                  );
                })}
                <div style={{ flex: 1 }} />
                {showListLoadingIndicator ? (
                  <span
                    role="status"
                    aria-label="Loading pull requests"
                    title="Loading pull requests"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 24,
                      height: 24,
                      color: COLORS.accent,
                      opacity: 0.9,
                    }}
                  >
                    <CircleNotch size={14} className="animate-spin" weight="bold" />
                  </span>
                ) : null}
              </div>
              <div ref={listRef} style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
                {filteredItems.length === 0 ? (
                <div style={{ padding: 20 }}>
                  <EmptyState
                    title={loading && !snapshot ? "Preparing pull requests" : "No pull requests"}
                    description={loading && !snapshot ? "ADE is syncing GitHub in the background." : "No pull requests match the current filters."}
                  />
                </div>
              ) : filteredItems.length > VIRTUALIZE_AT ? (
                <GitHubTabVirtualList
                  parentRef={listRef}
                  items={filteredItems}
                  selectedItemId={selectedItemId}
                  prsByIdMap={prsByIdMap}
                  onSelect={handleSelectItem}
                  onOpenQueueView={onOpenQueueView}
                  onHydrationItemsChange={handleHydrationItemsChange}
                />
              ) : (
                filteredItems.map((item) => (
                  <GitHubTabPrRow
                    key={item.id}
                    item={item}
                    selected={item.id === selectedItemId}
                    linkedPr={item.linkedPrId ? prsByIdMap.get(item.linkedPrId) ?? null : null}
                    onSelect={handleSelectItem}
                    onOpenQueueView={onOpenQueueView}
                  />
                ))
              )}
              {canLoadOlderHistory ? (
                <div style={{ padding: "12px 14px 16px", borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                  <button
                    type="button"
                    aria-label="Load older pull requests"
                    disabled={loadingOlderHistory}
                    onClick={() => { void handleLoadOlderHistory(); }}
                    style={{
                      ...outlineButton({ height: 32, width: "100%", opacity: loadingOlderHistory ? 0.6 : 1 }),
                      justifyContent: "center",
                    }}
                  >
                    {loadingOlderHistory ? "Loading older..." : "Load older PRs"}
                  </button>
                </div>
              ) : null}
              </div>
            </div>
          </Panel>
          <ResizeGutter orientation="vertical" thin narrow />
          <Panel
            id="github-pr-detail"
            data-tour="prs.detailDrawer"
            minSize="30%"
            className="min-h-0 min-w-0"
            style={{ overflow: "hidden" }}
          >
            {selectedItem && selectedDisplayPr ? (
              <PrDetailPane
                key={selectedDisplayPr.id}
                pr={selectedDisplayPr}
                status={selectedLinkedPr ? detailStatus : null}
                checks={selectedLinkedPr ? detailChecks : []}
                reviews={selectedLinkedPr ? detailReviews : []}
                comments={selectedLinkedPr ? detailComments : []}
                snapshotHydration={
                  selectedLinkedPr
                    ? (detailSnapshot?.prId === selectedDisplayPr.id
                        ? detailSnapshot
                        : detailSnapshotsByPrId[selectedDisplayPr.id] ?? null)
                    : null
                }
                snapshotHydrationOwnedByContext={Boolean(selectedLinkedPr)}
                liveDetailReady={Boolean(selectedLinkedPr) && detailLiveDataPrId === selectedDisplayPr.id}
                detailBusy={detailBusy}
                lanes={lanes}
                mergeMethod={mergeMethod}
                onRefresh={handleSync}
                onNavigate={navigate}
                onOpenRebaseTab={onOpenRebaseTab}
                queueContext={selectedQueueContext}
                onOpenQueueView={onOpenQueueView}
                initialDetailTab={selectedDetailTab}
                onDetailTabChange={onDetailTabChange}
                onUnmap={selectedItem.linkedPrId ? () => handleUnlink(selectedItem) : undefined}
                unmapBusy={Boolean(selectedItem.linkedPrId) && unlinkingPrId === selectedItem.linkedPrId}
                unmapped={!selectedItem.linkedPrId}
                githubCoords={selectedItem.linkedPrId ? null : selectedGithubCoords}
                unmappedAffordance={selectedItem.linkedPrId ? null : unmappedAffordance}
              />
            ) : (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
                <EmptyState
                  icon={GithubLogo}
                  iconSize={64}
                  title="No pull request selected"
                  description="Choose a GitHub pull request to inspect details."
                />
              </div>
            )}
          </Panel>
        </Group>
      </div>
      {createLaneItem ? (
        <CreateLaneFromPrBranchDialog
          item={createLaneItem}
          preflight={createLanePreflight?.preflight ?? null}
          loading={createLaneLoading}
          busy={createLaneBusy}
          error={createLaneError}
          onCancel={handleCancelCreateLaneFromPrBranch}
          onConfirm={handleConfirmCreateLaneFromPrBranch}
        />
      ) : null}
    </div>
  );
}

/* ---- PR row (shared between list and virtualizer) ---- */
function GitHubTabPrRow({
  item,
  selected,
  linkedPr,
  onSelect,
  onOpenQueueView,
}: {
  item: GitHubPrListItem;
  selected: boolean;
  linkedPr: PrSummary | null;
  onSelect: (item: GitHubPrListItem) => void;
  onOpenQueueView?: (groupId: string) => void;
}) {
  const sc = stateColor(item.state);
  const ci = ciDotColor(linkedPr);
  const ciRunning = linkedPr?.checksStatus === "pending";
  const review = reviewIndicator(linkedPr);
  const ago = formatTimeAgoCompact(item.createdAt);
  const labels = item.labels ?? [];
  const visibleLabels = labels.slice(0, 4);
  const overflowCount = labels.length - 4;
  const rowLinkedLaneColor = useLaneColorById(item.linkedLaneId ?? null);
  return (
    <button
      type="button"
      data-tour="prs.listRow"
      onClick={() => onSelect(item)}
      style={{
        display: "flex",
        width: "100%",
        flexDirection: "column",
        gap: 6,
        padding: "11px 14px",
        textAlign: "left",
        border: "none",
        borderLeft: selected ? `3px solid ${sc.text}` : "3px solid transparent",
        borderBottom: "1px solid rgba(255,255,255,0.04)",
        background: selected
          ? `linear-gradient(90deg, ${sc.bg} 0%, rgba(255,255,255,0.02) 100%)`
          : "transparent",
        cursor: "pointer",
        transition: "background 150ms ease",
      }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = "rgba(255,255,255,0.025)"; }}
      onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = "transparent"; }}
    >
      {/* Row 1: avatar, bot badge, PR number, title, CI icon, time, comments */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        {item.author ? (
          <img
            src={`https://avatars.githubusercontent.com/${item.author}?size=32`}
            alt=""
            style={{
              width: 22,
              height: 22,
              borderRadius: "50%",
              flexShrink: 0,
              border: `1.5px solid ${sc.bg}`,
            }}
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
        ) : (
          <div style={{
            width: 22,
            height: 22,
            borderRadius: "50%",
            flexShrink: 0,
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.08)",
          }} />
        )}
        {item.isBot ? (
          <span style={{
            fontSize: 9,
            fontWeight: 700,
            fontFamily: SANS_FONT,
            textTransform: "uppercase",
            padding: "1px 5px",
            borderRadius: 3,
            background: "rgba(255,255,255,0.06)",
            color: COLORS.textDim,
            flexShrink: 0,
            letterSpacing: "0.3px",
          }}>
            bot
          </span>
        ) : null}
        <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: sc.text, flexShrink: 0 }}>
          #{item.githubPrNumber}
        </span>
        <span style={{
          fontSize: 12,
          fontWeight: 600,
          color: COLORS.textPrimary,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontFamily: SANS_FONT,
          flex: 1,
          minWidth: 0,
        }}>
          {item.title}
        </span>
        {ci ? (
          <span title={ci.title} style={{ display: "inline-flex", flexShrink: 0 }}>
            {linkedPr?.checksStatus === "passing" ? (
              <CheckCircle size={14} weight="fill" style={{ color: "#4ADE80" }} />
            ) : linkedPr?.checksStatus === "failing" ? (
              <XCircle size={14} weight="fill" style={{ color: "#EF4444" }} />
            ) : ciRunning ? (
              <PrCiRunningIndicator color="#FBBF24" size={14} />
            ) : null}
          </span>
        ) : null}
        {ago ? (
          <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim, flexShrink: 0 }}>
            {ago}
          </span>
        ) : null}
        {item.commentCount > 0 ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0, color: COLORS.textDim }}>
            <ChatText size={12} />
            <span style={{ fontFamily: MONO_FONT, fontSize: 10 }}>{item.commentCount}</span>
          </span>
        ) : null}
      </div>
      {/* Row 1.5: labels */}
      {visibleLabels.length > 0 ? (
        <div style={{ display: "flex", alignItems: "center", gap: 4, paddingLeft: 30, flexWrap: "wrap" }}>
          {visibleLabels.map((label) => {
            const bg = `#${label.color}`;
            const textColor = labelTextColor(label.color);
            return (
              <span
                key={label.name}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  padding: "1px 8px",
                  fontSize: 10,
                  fontWeight: 600,
                  fontFamily: SANS_FONT,
                  color: textColor,
                  background: bg,
                  borderRadius: 10,
                  lineHeight: "16px",
                }}
              >
                {label.name}
              </span>
            );
          })}
          {overflowCount > 0 ? (
            <span style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textDim }}>
              +{overflowCount}
            </span>
          ) : null}
        </div>
      ) : null}
      {/* Row 2: branch info */}
      {item.baseBranch && item.headBranch ? (
        <div style={{ display: "flex", alignItems: "center", gap: 4, paddingLeft: 30, fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.headBranch}</span>
          <span style={{ color: COLORS.textMuted }}>→</span>
          <span>{item.baseBranch}</span>
        </div>
      ) : null}
      {/* Row 3: inline stats */}
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, paddingLeft: 30 }}>
        {item.state !== "open" && item.state !== "draft" ? (
          <span style={stateBadgeStyle(item)}>{item.state}</span>
        ) : null}
        <AdeKindBadge kind={item.adeKind} />
        {item.scope === "external" ? (
          <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>
            {item.repoOwner}/{item.repoName}
          </span>
        ) : null}
        {item.linkedLaneName || item.linkedLaneId ? (
          <span
            style={{
              ...inlineBadge(COLORS.textSecondary),
              fontSize: 10,
              padding: "2px 7px",
              borderRadius: 5,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              ...(rowLinkedLaneColor ? { color: rowLinkedLaneColor } : {}),
            }}
          >
            {rowLinkedLaneColor ? <LaneAccentDot lane={{ color: rowLinkedLaneColor }} size={6} /> : null}
            {item.linkedLaneName ?? item.linkedLaneId}
          </span>
        ) : (
          <span style={{ display: "inline-flex", alignItems: "center", padding: "2px 7px", fontSize: 10, fontWeight: 600, fontFamily: SANS_FONT, color: "#FBBF24", background: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.18)", borderRadius: 5 }}>
            unmapped
          </span>
        )}
        {review ? (
          <span style={{ display: "inline-flex", alignItems: "center", padding: "2px 6px", fontSize: 10, fontWeight: 500, fontFamily: SANS_FONT, color: review.color, background: `${review.color}10`, borderRadius: 4 }}>
            {review.label}
          </span>
        ) : null}
        {linkedPr ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontFamily: MONO_FONT }}>
            <span style={{ color: COLORS.success }}>+{linkedPr.additions}</span>
            <span style={{ color: COLORS.danger }}>-{linkedPr.deletions}</span>
          </span>
        ) : null}
        {item.cleanupState === "required" ? (
          <span style={{ ...inlineBadge(COLORS.warning), fontSize: 10, padding: "2px 7px", borderRadius: 5 }}>cleanup</span>
        ) : null}
        {item.adeKind === "queue" && item.linkedGroupId && onOpenQueueView ? (
          <span
            role="button"
            tabIndex={0}
            onClick={(event) => {
              event.stopPropagation();
              onOpenQueueView(item.linkedGroupId!);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                onOpenQueueView(item.linkedGroupId!);
              }
            }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "2px 7px",
              fontSize: 10,
              fontWeight: 600,
              fontFamily: SANS_FONT,
              color: COLORS.info,
              background: "rgba(59,130,246,0.10)",
              border: "1px solid rgba(59,130,246,0.18)",
              borderRadius: 5,
              cursor: "pointer",
            }}
            title="Open queue workflow"
          >
            open queue
          </span>
        ) : null}
        <span
          role="link"
          tabIndex={0}
          onClick={(e) => { e.stopPropagation(); void window.ade.app.openExternal(item.githubUrl); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); void window.ade.app.openExternal(item.githubUrl); } }}
          style={{ display: "inline-flex", alignItems: "center", marginLeft: "auto", padding: 0, cursor: "pointer", color: COLORS.textDim, transition: "color 100ms ease" }}
          title="Open on GitHub"
          onMouseEnter={(e) => { e.currentTarget.style.color = COLORS.textSecondary; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = COLORS.textDim; }}
        >
          <ArrowSquareOut size={13} />
        </span>
      </div>
    </button>
  );
}

/* ---- Virtual list for GitHub PR sidebar (activated above VIRTUALIZE_AT) ---- */
function GitHubTabVirtualList({
  parentRef,
  items,
  selectedItemId,
  prsByIdMap,
  onSelect,
  onOpenQueueView,
  onHydrationItemsChange,
}: {
  parentRef: React.RefObject<HTMLDivElement | null>;
  items: GitHubPrListItem[];
  selectedItemId: string | null;
  prsByIdMap: Map<string, PrSummary>;
  onSelect: (item: GitHubPrListItem) => void;
  onOpenQueueView?: (groupId: string) => void;
  onHydrationItemsChange: (items: GitHubPrListItem[]) => void;
}) {
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 108,
    overscan: 6,
  });
  const virtualItems = virtualizer.getVirtualItems();
  React.useEffect(() => {
    onHydrationItemsChange(
      virtualItems
        .map((virtualRow) => items[virtualRow.index])
        .filter((item): item is GitHubPrListItem => Boolean(item)),
    );
  }, [items, onHydrationItemsChange, virtualItems]);

  return (
    <div
      data-testid="pr-github-list-virtual"
      style={{ height: virtualizer.getTotalSize(), position: "relative" }}
    >
      {virtualItems.map((virtualRow) => {
        const item = items[virtualRow.index]!;
        return (
          <div
            key={item.id}
            data-index={virtualRow.index}
            ref={virtualizer.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            <GitHubTabPrRow
              item={item}
              selected={item.id === selectedItemId}
              linkedPr={item.linkedPrId ? prsByIdMap.get(item.linkedPrId) ?? null : null}
              onSelect={onSelect}
              onOpenQueueView={onOpenQueueView}
            />
          </div>
        );
      })}
    </div>
  );
}
