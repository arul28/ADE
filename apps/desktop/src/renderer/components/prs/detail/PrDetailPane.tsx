import React from "react";
import {
  GithubLogo, CheckCircle, XCircle, Circle,
  CircleNotch, ArrowRight, Eye, Code,
  PencilSimple, X, Check, ArrowsClockwise, Play,
  CaretDown, CaretRight, Stack as Layers,
} from "@phosphor-icons/react";
import { BranchIcon, LaneIcon } from "../../ui/vcsIcons";
import type {
  PrWithConflicts, PrCheck, PrReview, PrComment, PrStatus, PrDetail,
  PrFile, PrCommit, PrActionRun, PrActivityEvent, PrReviewThread,
  LaneSummary, MergeMethod, LandResult,
  FilePatch,
  PrSnapshotHydration,
  PrGithubCoords,
  AgentChatSessionSummary,
  PrCheckLogExcerpt,
  PrRerunChecksTarget,
} from "../../../../shared/types";
import { DEFAULT_PR_TIMELINE_FILTERS, type PrTimelineFilters } from "../shared/PrTimeline";
import type { PaletteKind } from "../shared/PrCommandPalettes";
import { parsePrsRouteState, type PrDetailRouteTab } from "../prsRouteState";
import { PrDetailTimelineRails as TimelineRailsOverview, type PrDetailTimelineRailsRef } from "./PrDetailTimelineRails";
import { PrChecksTab } from "./PrChecksTab";
import { PrManageLaneDialogHost } from "../shared/PrManageLaneDialogHost";
import { COLORS, MONO_FONT, SANS_FONT, LABEL_STYLE, cardStyle, outlineButton, primaryButton } from "../../lanes/laneDesignTokens";
import { AdeDiffViewer } from "../../shared/AdeDiffViewer";
import { getPrStateBadge, InlinePrBadge } from "../shared/prVisuals";
import { usePrs } from "../state/PrsContext";
import {
  buildUnifiedChecks,
  findUnifiedCheckId,
  isPipelineTerminal,
  summarizePipelineStates,
} from "../shared/prUnifiedChecks";
import type { PrReviewEvent } from "../shared/PrReviewSubmitModal";
import type { ReviewerRequest } from "../shared/PrDetailRightMetadataRail";
import { navigateToAppTarget } from "../../../lib/openExternal";
import { queueAgentChatDraftHandoff } from "../../../lib/agentChatDraftHandoff";

// ---- Sub-tab type ----
type DetailTab = PrDetailRouteTab;
const DETAIL_TAB_STORAGE_KEY = "ade:prs:detailTabs:v1";
const DETAIL_BACKGROUND_ACTIVITY_DELAY_MS = 250;
const DETAIL_PANE_WARM_CACHE_TTL_MS = 5 * 60_000;
const DETAIL_PANE_WARM_CACHE_MAX_ENTRIES = 50;

type PrDetailPaneWarmCache = {
  prId: string;
  cachedAt: number;
  detail: PrDetail | null;
  files: PrFile[];
  commits: PrCommit[];
  status: PrStatus | null;
  checks: PrCheck[];
  reviews: PrReview[];
  comments: PrComment[];
  actionRuns: PrActionRun[];
  activity: PrActivityEvent[];
  reviewThreads: PrReviewThread[];
};

type PrDetailPaneWarmCachePatch = Partial<Omit<PrDetailPaneWarmCache, "prId" | "cachedAt">>;

const detailPaneWarmCacheByPrId = new Map<string, PrDetailPaneWarmCache>();

function readDetailPaneWarmCache(prId: string): PrDetailPaneWarmCache | null {
  const cached = detailPaneWarmCacheByPrId.get(prId) ?? null;
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > DETAIL_PANE_WARM_CACHE_TTL_MS) {
    detailPaneWarmCacheByPrId.delete(prId);
    return null;
  }
  return cached;
}

function hasDetailPaneWarmCacheData(cache: PrDetailPaneWarmCache): boolean {
  return Boolean(cache.detail)
    || cache.files.length > 0
    || cache.commits.length > 0
    || Boolean(cache.status)
    || cache.checks.length > 0
    || cache.reviews.length > 0
    || cache.comments.length > 0
    || cache.actionRuns.length > 0
    || cache.activity.length > 0
    || cache.reviewThreads.length > 0;
}

function hasSnapshotHydrationData(snapshot: PrSnapshotHydration | null): boolean {
  return Boolean(snapshot?.detail)
    || (snapshot?.files.length ?? 0) > 0
    || (snapshot?.commits.length ?? 0) > 0
    || Boolean(snapshot?.status)
    || (snapshot?.checks.length ?? 0) > 0
    || (snapshot?.reviews.length ?? 0) > 0
    || (snapshot?.comments.length ?? 0) > 0;
}

function writeDetailPaneWarmCache(prId: string, patch: PrDetailPaneWarmCachePatch): void {
  const previous = readDetailPaneWarmCache(prId);
  const next: PrDetailPaneWarmCache = {
    detail: null,
    files: [],
    commits: [],
    status: null,
    checks: [],
    reviews: [],
    comments: [],
    actionRuns: [],
    activity: [],
    reviewThreads: [],
    ...(previous ?? {}),
    ...patch,
    prId,
    cachedAt: Date.now(),
  };
  if (hasDetailPaneWarmCacheData(next)) {
    detailPaneWarmCacheByPrId.set(prId, next);
    while (detailPaneWarmCacheByPrId.size > DETAIL_PANE_WARM_CACHE_MAX_ENTRIES) {
      let oldestPrId: string | null = null;
      let oldestCachedAt = Number.POSITIVE_INFINITY;
      for (const [cachedPrId, cachedEntry] of detailPaneWarmCacheByPrId) {
        if (cachedEntry.cachedAt < oldestCachedAt) {
          oldestPrId = cachedPrId;
          oldestCachedAt = cachedEntry.cachedAt;
        }
      }
      if (!oldestPrId) break;
      detailPaneWarmCacheByPrId.delete(oldestPrId);
    }
  } else {
    detailPaneWarmCacheByPrId.delete(prId);
  }
}

function isDetailTab(value: unknown): value is DetailTab {
  return value === "overview" || value === "files" || value === "checks";
}

function normalizeDetailTab(tab: DetailTab | "activity" | null | undefined): DetailTab {
  return tab === "activity" || tab == null ? "overview" : tab;
}

function isPrsRouteRuntime(): boolean {
  try {
    return window.location.pathname === "/prs" || window.location.hash.startsWith("#/prs");
  } catch {
    return false;
  }
}

function readStoredDetailTab(prId: string): DetailTab | null {
  if (!isPrsRouteRuntime()) return null;
  try {
    const raw = window.localStorage.getItem(DETAIL_TAB_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = parsed?.[prId];
    return isDetailTab(value) ? normalizeDetailTab(value) : null;
  } catch {
    return null;
  }
}

function writeStoredDetailTab(prId: string, tab: DetailTab): void {
  if (!isPrsRouteRuntime()) return;
  try {
    const raw = window.localStorage.getItem(DETAIL_TAB_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    parsed[prId] = tab;
    window.localStorage.setItem(DETAIL_TAB_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // localStorage can be unavailable in private/test environments.
  }
}

export function buildCiFixPrompt(
  pr: Pick<PrWithConflicts, "githubPrNumber" | "repoOwner" | "repoName" | "headBranch">,
  excerpt: PrCheckLogExcerpt,
): string {
  const logTail = excerpt.lines.slice(-80).join("\n").trim();
  const longestFence = Math.max(
    2,
    ...Array.from(logTail.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(longestFence + 1);
  return [
    `Fix the failing CI job \`${excerpt.jobName}\` on ${pr.repoOwner}/${pr.repoName} PR #${pr.githubPrNumber} (${pr.headBranch}).`,
    excerpt.failingStepName ? `Failing step: ${excerpt.failingStepName}.` : null,
    excerpt.headline ? `Failure headline: ${excerpt.headline}` : null,
    "",
    "Inspect the current lane, reproduce the failure locally when practical, make the smallest correct fix, run the relevant checks, and report what changed.",
    logTail ? `\nFailing log excerpt:\n${fence}text\n${logTail}\n${fence}` : null,
  ].filter((line): line is string => line != null).join("\n");
}

function newestWorkChat(sessions: AgentChatSessionSummary[]): AgentChatSessionSummary | null {
  const timestamp = (session: AgentChatSessionSummary): number => {
    const parsed = Date.parse(session.lastActivityAt);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return sessions
    .filter((session) => (session.surface ?? "work") === "work" && session.archivedAt == null)
    .sort((left, right) => timestamp(right) - timestamp(left))[0] ?? null;
}

function PrDetailLoadingPill() {
  return (
    <div
      role="status"
      aria-label="Loading pull request details"
      title="Loading pull request details"
      style={{
        position: "absolute",
        top: 14,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 2,
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        height: 30,
        padding: "0 12px",
        borderRadius: 999,
        border: `1px solid ${COLORS.border}`,
        background: "rgba(24, 20, 36, 0.88)",
        boxShadow: "0 10px 30px rgba(0,0,0,0.32)",
        color: COLORS.textSecondary,
        fontFamily: SANS_FONT,
        fontSize: 12,
        pointerEvents: "none",
      }}
    >
      <CircleNotch size={14} className="animate-spin" weight="bold" style={{ color: COLORS.accent }} />
      <span>Loading PR details</span>
    </div>
  );
}

// ---- Shared activity event helpers for the overview thread ----
function stableActivityIdPart(value: string | number | null | undefined): string {
  return encodeURIComponent(String(value ?? "none"));
}

function makeUniqueActivityId(base: string, seenIds: Map<string, number>): string {
  const seen = seenIds.get(base) ?? 0;
  seenIds.set(base, seen + 1);
  return seen === 0 ? base : `${base}-${seen + 1}`;
}

function buildActivityFromLoadedDetail(
  checks: PrCheck[],
  reviews: PrReview[],
  comments: PrComment[],
): PrActivityEvent[] {
  const events: PrActivityEvent[] = [];
  const seenIds = new Map<string, number>();
  for (const comment of comments) {
    const baseId = `comment-${stableActivityIdPart(comment.id)}`;
    events.push({
      id: makeUniqueActivityId(baseId, seenIds),
      type: "comment",
      author: comment.author,
      avatarUrl: comment.authorAvatarUrl ?? null,
      body: comment.body,
      timestamp: comment.createdAt ?? "",
      metadata: {
        source: comment.source,
        path: comment.path,
        line: comment.line,
        url: comment.url,
      },
    });
  }
  for (const review of reviews) {
    const baseId = [
      "review",
      stableActivityIdPart(review.reviewer),
      stableActivityIdPart(review.submittedAt),
    ].join("-");
    events.push({
      id: makeUniqueActivityId(baseId, seenIds),
      type: "review",
      author: review.reviewer,
      avatarUrl: review.reviewerAvatarUrl ?? null,
      body: review.body,
      timestamp: review.submittedAt ?? "",
      metadata: { state: review.state },
    });
  }
  for (const check of checks) {
    const baseId = [
      "ci",
      stableActivityIdPart(check.name),
      stableActivityIdPart(check.detailsUrl),
      stableActivityIdPart(check.startedAt),
    ].join("-");
    events.push({
      id: makeUniqueActivityId(baseId, seenIds),
      type: "ci_run",
      author: "github-actions",
      avatarUrl: null,
      body: `${check.name}: ${check.conclusion ?? check.status}`,
      timestamp: check.startedAt ?? check.completedAt ?? "",
      metadata: {
        status: check.status,
        conclusion: check.conclusion,
        detailsUrl: check.detailsUrl,
      },
    });
  }
  return events.sort((a, b) => Date.parse(b.timestamp || "0") - Date.parse(a.timestamp || "0"));
}

const FILE_STATUS_COLORS: Record<string, string> = {
  added: COLORS.success,
  removed: COLORS.danger,
  modified: COLORS.warning,
  renamed: COLORS.info,
};

function fileStatusColor(status: string): string {
  return FILE_STATUS_COLORS[status] ?? COLORS.textSecondary;
}

const FILE_STATUS_LABELS: Record<string, string> = {
  added: "A",
  removed: "D",
  modified: "M",
  renamed: "R",
  copied: "C",
};

function fileStatusLabel(status: string): string {
  return FILE_STATUS_LABELS[status] ?? "?";
}

// ---- Props ----
type PrDetailPaneProps = {
  pr: PrWithConflicts;
  status: PrStatus | null;
  checks: PrCheck[];
  reviews: PrReview[];
  comments: PrComment[];
  snapshotHydration?: PrSnapshotHydration | null;
  snapshotHydrationOwnedByContext?: boolean;
  liveDetailReady?: boolean;
  detailBusy: boolean;
  lanes: LaneSummary[];
  mergeMethod: MergeMethod;
  onRefresh: (args?: { prId?: string; prIds?: string[] }) => Promise<void>;
  onNavigate: (path: string) => void;
  onShowInGraph?: (laneId: string) => void;
  onOpenRebaseTab?: (laneId?: string) => void;
  queueContext?: { groupId: string; label?: string | null } | null;
  onOpenQueueView?: (groupId: string) => void;
  initialDetailTab?: DetailTab | null;
  onDetailTabChange?: (tab: DetailTab) => void;
  onUnmap?: () => void;
  unmapBusy?: boolean;
  /**
   * When set, the PR is NOT mapped to an ADE lane. The pane routes all detail
   * fetches through the coordinate-based endpoints (which never require a DB
   * row) and shows a create/map affordance instead of lane-dependent controls.
   */
  githubCoords?: PrGithubCoords | null;
  unmapped?: boolean;
  /**
   * Create-lane / map-to-lane controls surfaced as an in-pane banner when the
   * PR is unmapped. Provided by GitHubTab so this pane stays presentational.
   */
  unmappedAffordance?: UnmappedAffordance | null;
};

/** Create/map controls for an unmapped GitHub PR, surfaced as an in-pane banner. */
export type UnmappedAffordance = {
  /** Lanes whose branch matches (or could match) the PR head; for the link select. */
  linkableLanes: Array<{ id: string; name: string }>;
  selectedLaneId: string;
  onSelectLane: (laneId: string) => void;
  onLink: () => void;
  linkBusy: boolean;
  /** Whether the "create lane from PR branch" action is offered for this PR. */
  canCreateLane: boolean;
  onCreateLane: () => void;
  scope: "repo" | "external";
};

/**
 * Compact unmapped-PR affordance, surfaced in the top-right of the detail
 * header (directly above the refresh / GitHub action buttons) rather than as a
 * full-width banner. The full detail view renders as usual; this cluster offers
 * the create-lane / map-to-lane actions, with the "not mapped" reason kept as a
 * concise tinted label (full sentence on hover).
 */
function UnmappedPrBanner({ affordance }: { affordance: UnmappedAffordance }) {
  const notMappedLabel =
    affordance.scope === "external"
      ? "This pull request comes from a fork and is not mapped to an ADE lane."
      : "This pull request is not mapped to an ADE lane.";
  return (
    <div
      data-testid="pr-unmapped-affordance"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        flexWrap: "wrap",
        flexShrink: 0,
        gap: 8,
        fontFamily: SANS_FONT,
        fontSize: 12,
      }}
    >
      <span
        title={notMappedLabel}
        style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "#FBBF24", whiteSpace: "nowrap" }}
      >
        <GithubLogo size={14} weight="fill" style={{ flexShrink: 0 }} />
        <span>Not mapped to a lane</span>
      </span>
      {affordance.canCreateLane ? (
        <button
          type="button"
          onClick={affordance.onCreateLane}
          style={primaryButton({ height: 30, padding: "0 10px", borderRadius: 8, whiteSpace: "nowrap" })}
        >
          <BranchIcon size={14} /> Create lane from PR branch
        </button>
      ) : null}
      {affordance.linkableLanes.length > 0 ? (
        <>
          <select
            value={affordance.selectedLaneId}
            onChange={(event) => affordance.onSelectLane(event.target.value)}
            aria-label="Select lane to map"
            style={{
              height: 30,
              background: COLORS.recessedBg,
              border: `1px solid ${COLORS.border}`,
              color: COLORS.textPrimary,
              fontFamily: SANS_FONT,
              fontSize: 12,
              padding: "0 8px",
              borderRadius: 8,
            }}
          >
            <option value="">Map to lane…</option>
            {affordance.linkableLanes.map((lane) => (
              <option key={lane.id} value={lane.id}>{lane.name}</option>
            ))}
          </select>
          <button
            type="button"
            disabled={!affordance.selectedLaneId || affordance.linkBusy}
            onClick={affordance.onLink}
            aria-label={affordance.linkBusy ? "Mapping lane to pull request" : "Map selected lane to pull request"}
            style={primaryButton({
              height: 30,
              padding: "0 10px",
              borderRadius: 8,
              opacity: !affordance.selectedLaneId || affordance.linkBusy ? 0.5 : 1,
            })}
          >
            {affordance.linkBusy ? "Mapping…" : "Map"}
          </button>
        </>
      ) : null}
    </div>
  );
}

export function PrDetailPane({
  pr,
  status: liveStatus,
  checks: liveChecks,
  reviews: liveReviews,
  comments: liveComments,
  snapshotHydration = null,
  snapshotHydrationOwnedByContext: _snapshotHydrationOwnedByContext = false,
  liveDetailReady = false,
  detailBusy,
  lanes,
  mergeMethod,
  onRefresh,
  onNavigate: _onNavigate,
  onShowInGraph,
  onOpenRebaseTab,
  queueContext,
  onOpenQueueView,
  initialDetailTab,
  onDetailTabChange,
  onUnmap,
  unmapBusy = false,
  githubCoords = null,
  unmapped = false,
  unmappedAffordance = null,
}: PrDetailPaneProps) {
  const {
    dismissedAiSummaries,
    timelineFiltersByPrId,
    detailAiSummary,
    detailReviewThreads: ctxReviewThreads,
    detailDeployments,
    detailLiveDataPrId: ctxDetailPrId,
    viewerLogin,
    setTimelineFilters,
    setAiSummaryDismissed,
    regeneratePrAiSummary,
    isGithubRateLimited,
    noteGithubRateLimit,
  } = usePrs();
  const initialSnapshotHydration = snapshotHydration?.prId === pr.id ? snapshotHydration : null;
  const initialPaneWarmCache = readDetailPaneWarmCache(pr.id);
  const [activeTab, setActiveTabState] = React.useState<DetailTab>(
    () => normalizeDetailTab(initialDetailTab ?? readStoredDetailTab(pr.id)),
  );
  const [focusedCheckId, setFocusedCheckId] = React.useState<string | null>(null);
  // Bumped by the `g k` chord so the CI tab knows to open its checks palette.
  const [checksPaletteRequest, setChecksPaletteRequest] = React.useState(0);
  const [detail, setDetail] = React.useState<PrDetail | null>(() => initialSnapshotHydration?.detail ?? initialPaneWarmCache?.detail ?? null);
  const [files, setFiles] = React.useState<PrFile[]>(() => initialSnapshotHydration?.files ?? initialPaneWarmCache?.files ?? []);
  const [commits, setCommits] = React.useState<PrCommit[]>(() => initialSnapshotHydration?.commits ?? initialPaneWarmCache?.commits ?? []);
  const [snapshotStatus, setSnapshotStatus] = React.useState<PrStatus | null>(() => initialSnapshotHydration?.status ?? initialPaneWarmCache?.status ?? null);
  // Latest direct mergeability re-poll for the selected PR. Used to resolve the
  // "Checking mergeability…" spinner promptly for BOTH mapped (live-backed) and
  // unmapped PRs — it only overrides while the base status is still computing,
  // so it never shadows a fresher live status once GitHub settles.
  const [polledStatus, setPolledStatus] = React.useState<PrStatus | null>(null);
  const [snapshotChecks, setSnapshotChecks] = React.useState<PrCheck[]>(() => initialSnapshotHydration?.checks ?? initialPaneWarmCache?.checks ?? []);
  // Latest result of this pane's own `getChecks` poll. Cleared whenever the
  // context hands down a new live `checks` array, so context always wins and
  // this only fills the gaps between context refreshes.
  const [polledChecks, setPolledChecks] = React.useState<PrCheck[] | null>(null);
  const [snapshotReviews, setSnapshotReviews] = React.useState<PrReview[]>(() => initialSnapshotHydration?.reviews ?? initialPaneWarmCache?.reviews ?? []);
  const [snapshotComments, setSnapshotComments] = React.useState<PrComment[]>(() => initialSnapshotHydration?.comments ?? initialPaneWarmCache?.comments ?? []);
  const [actionRuns, setActionRuns] = React.useState<PrActionRun[]>(() => initialPaneWarmCache?.actionRuns ?? []);
  const [activity, setActivity] = React.useState<PrActivityEvent[]>(() => initialPaneWarmCache?.activity ?? []);
  const [reviewThreads, setReviewThreads] = React.useState<PrReviewThread[]>(() => initialPaneWarmCache?.reviewThreads ?? []);
  const [detailLoading, setDetailLoading] = React.useState(
    () => !(hasSnapshotHydrationData(initialSnapshotHydration) || Boolean(initialPaneWarmCache && hasDetailPaneWarmCacheData(initialPaneWarmCache))),
  );
  const timelineRailsRef = React.useRef<PrDetailTimelineRailsRef | null>(null);
  const hasSnapshotDetail =
    snapshotStatus !== null
    || snapshotChecks.length > 0
    || snapshotReviews.length > 0
    || snapshotComments.length > 0;
  const hasVisibleDetailData =
    Boolean(detail)
    || files.length > 0
    || commits.length > 0
    || hasSnapshotDetail
    || actionRuns.length > 0
    || activity.length > 0
    || reviewThreads.length > 0;
  const hasVisibleDetailDataRef = React.useRef(hasVisibleDetailData);
  React.useEffect(() => {
    hasVisibleDetailDataRef.current = hasVisibleDetailData;
  }, [hasVisibleDetailData]);
  const baseStatus = liveDetailReady ? liveStatus : (hasSnapshotDetail ? snapshotStatus : liveStatus);
  // While the base (live/snapshot) status still reports GitHub computing
  // mergeability, prefer the latest direct re-poll result for this PR.
  const status = polledStatus && baseStatus?.mergeabilityComputing ? polledStatus : baseStatus;
  const baseChecks = liveDetailReady ? liveChecks : (hasSnapshotDetail ? snapshotChecks : liveChecks);
  const checks = polledChecks ?? baseChecks;
  React.useEffect(() => {
    setPolledChecks(null);
  }, [liveChecks, pr.id]);
  const reviews = liveDetailReady ? liveReviews : (hasSnapshotDetail ? snapshotReviews : liveReviews);
  const comments = liveDetailReady ? liveComments : (hasSnapshotDetail ? snapshotComments : liveComments);

  // One unified check set for the tab header, the CI rollup, and the adaptive
  // refresh cadence below.
  const headerChecks = React.useMemo(() => buildUnifiedChecks(checks, actionRuns), [checks, actionRuns]);
  const checksTerminal = React.useMemo(
    // An empty result is not terminal: a workflow may not have created its
    // first check run yet. Keep the checks-tab poll alive until at least one
    // check exists and every one of them has settled.
    () => headerChecks.length > 0 && isPipelineTerminal(summarizePipelineStates(headerChecks)),
    [headerChecks],
  );

  const setActiveTab = React.useCallback((tab: DetailTab) => {
    setActiveTabState(tab);
    writeStoredDetailTab(pr.id, tab);
    onDetailTabChange?.(tab);
  }, [onDetailTabChange, pr.id]);

  const handleOpenChecksTab = React.useCallback(() => {
    setActiveTab("checks");
  }, [setActiveTab]);

  const handleFocusedCheckConsumed = React.useCallback(() => setFocusedCheckId(null), []);

  const handleSelectCheckFromRail = React.useCallback((check: PrCheck) => {
    const unifiedId = findUnifiedCheckId(check, checks, actionRuns);
    setFocusedCheckId(unifiedId);
    setActiveTab("checks");
  }, [actionRuns, checks, setActiveTab]);

  React.useEffect(() => {
    const next = normalizeDetailTab(initialDetailTab ?? readStoredDetailTab(pr.id));
    setActiveTabState(next);
    if (initialDetailTab) {
      writeStoredDetailTab(pr.id, normalizeDetailTab(initialDetailTab));
    }
  }, [initialDetailTab, pr.id]);

  const deepLinkState = React.useMemo(() => {
    try {
      const parsed = parsePrsRouteState({ search: window.location.search, hash: window.location.hash });
      const searchParams = new URLSearchParams(window.location.search.startsWith("?") ? window.location.search.slice(1) : window.location.search);
      const hashQuery = window.location.hash.includes("?") ? window.location.hash.slice(window.location.hash.indexOf("?") + 1) : "";
      const hashParams = new URLSearchParams(hashQuery);
      const legacyActivityTab = searchParams.get("detailTab") === "activity" || hashParams.get("detailTab") === "activity";
      return { eventId: parsed.eventId, threadId: parsed.threadId, commitSha: parsed.commitSha, legacyActivityTab };
    } catch {
      return { eventId: null, threadId: null, commitSha: null, legacyActivityTab: false };
    }
  }, [pr.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const timelineDeepLinkNeedsAllThreads = Boolean(deepLinkState.eventId || deepLinkState.threadId || deepLinkState.legacyActivityTab);
  const timelineFilters: PrTimelineFilters = React.useMemo(
    () => {
      const filters = timelineFiltersByPrId?.[pr.id] ?? DEFAULT_PR_TIMELINE_FILTERS;
      return timelineDeepLinkNeedsAllThreads
        ? { ...filters, showResolved: true, showOutdated: true }
        : filters;
    },
    [timelineFiltersByPrId, pr.id, timelineDeepLinkNeedsAllThreads],
  );
  const handleTimelineFiltersChange = React.useCallback(
    (next: PrTimelineFilters) => setTimelineFilters?.(pr.id, next),
    [pr.id, setTimelineFilters],
  );
  const reviewThreadsForTimeline = React.useMemo(
    () => (ctxDetailPrId === pr.id && (ctxReviewThreads?.length ?? 0) > 0 ? ctxReviewThreads! : reviewThreads),
    [ctxDetailPrId, ctxReviewThreads, pr.id, reviewThreads],
  );
  React.useEffect(() => {
    if (ctxDetailPrId === pr.id && (ctxReviewThreads?.length ?? 0) > 0) {
      setReviewThreads(ctxReviewThreads);
      writeDetailPaneWarmCache(pr.id, { reviewThreads: ctxReviewThreads ?? [] });
    }
  }, [ctxDetailPrId, ctxReviewThreads, pr.id]);
  const deploymentsForTimeline = React.useMemo(
    () => (ctxDetailPrId === pr.id ? detailDeployments : []),
    [ctxDetailPrId, detailDeployments, pr.id],
  );
  const aiSummaryDismissedForPr = Boolean(dismissedAiSummaries?.[pr.id]);
  const handleDismissAiSummary = React.useCallback(() => {
    setAiSummaryDismissed?.(pr.id, true);
  }, [pr.id, setAiSummaryDismissed]);
  const handleRegenerateAiSummary = React.useCallback(() => {
    void regeneratePrAiSummary?.(pr.id);
  }, [pr.id, regeneratePrAiSummary]);
  const timelineAiSummary = React.useMemo(
    () => (detailAiSummary?.prId === pr.id ? detailAiSummary : null),
    [detailAiSummary, pr.id],
  );

  // Page-level keyboard shortcuts scoped to the Timeline+Rails overview.
  // Only attach listeners when the flag is on AND the overview tab is active.
  React.useEffect(() => {
    const CHORD_WINDOW_MS = 800;
    const chordPalettes: Record<string, PaletteKind> = { c: "commit", t: "thread", f: "file" };
    let lastKey = "";
    let lastKeyAt = 0;
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const now = Date.now();
      const inChord = lastKey === "g" && now - lastKeyAt < CHORD_WINDOW_MS;

      // `g k` works from any detail tab: it routes to CI / Checks and opens the
      // checks palette there. Once the checks tab is mounted it owns the chord.
      if (inChord && event.key === "k" && activeTab !== "checks") {
        event.preventDefault();
        lastKey = "";
        lastKeyAt = 0;
        setActiveTab("checks");
        setChecksPaletteRequest((n) => n + 1);
        return;
      }

      if (activeTab !== "overview") {
        if (event.key === "g") {
          lastKey = "g";
          lastKeyAt = now;
        } else {
          lastKey = "";
        }
        return;
      }

      const rails = timelineRailsRef.current;
      if (!rails) return;

      if (inChord) {
        const palette = chordPalettes[event.key];
        if (palette) {
          event.preventDefault();
          rails.openPalette(palette);
        }
        lastKey = "";
        lastKeyAt = 0;
        return;
      }

      if (event.key === "g") {
        lastKey = "g";
        lastKeyAt = now;
        return;
      }

      if (event.key === "[") {
        event.preventDefault();
        rails.prevUnresolvedThread();
      } else if (event.key === "]") {
        event.preventDefault();
        rails.nextUnresolvedThread();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeTab, setActiveTab]);
  // Action states
  const [actionBusy, setActionBusy] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [actionResult, setActionResult] = React.useState<LandResult | null>(null);
  const [commentDraft, setCommentDraft] = React.useState("");
  const [editingTitle, setEditingTitle] = React.useState(false);
  const [titleDraft, setTitleDraft] = React.useState("");
  const [labelInput, setLabelInput] = React.useState("");
  const [showLabelEditor, setShowLabelEditor] = React.useState(false);
  const [reviewerInput, setReviewerInput] = React.useState("");
  const [showReviewerEditor, setShowReviewerEditor] = React.useState(false);
  const [manageLaneOpen, setManageLaneOpen] = React.useState(false);
  const [expandedFile, setExpandedFile] = React.useState<string | null>(null);
  const detailLoadSeqRef = React.useRef(0);
  const detailStatusRefreshKeyRef = React.useRef<string | null>(null);
  const snapshotHydrationRef = React.useRef<PrSnapshotHydration | null>(snapshotHydration);
  const snapshotPrefillPendingRef = React.useRef(false);
  const visibleActivityCountRef = React.useRef(0);
  const activityFetchKeyRef = React.useRef<string | null>(null);
  const liveDetailLoadedForPrRef = React.useRef<string | null>(null);
  const liveFilesLoadedForPrRef = React.useRef<string | null>(null);
  const liveCommitsLoadedForPrRef = React.useRef<string | null>(null);

  const updateDetailPaneWarmCache = React.useCallback((patch: PrDetailPaneWarmCachePatch) => {
    writeDetailPaneWarmCache(pr.id, patch);
  }, [pr.id]);

  const handleFixInChat = React.useCallback(async (excerpt: PrCheckLogExcerpt) => {
    if (!pr.laneId) return;
    const prompt = buildCiFixPrompt(pr, excerpt);
    try {
      const session = newestWorkChat(
        await window.ade.agentChat.list({ laneId: pr.laneId, includeArchived: false }),
      );
      if (session) {
        queueAgentChatDraftHandoff({ sessionId: session.sessionId }, prompt);
        navigateToAppTarget({
          kind: "work",
          laneId: pr.laneId,
          sessionId: session.sessionId,
        });
        return;
      }

      const draftTargetId = `work:draft:${pr.laneId}:chat`;
      queueAgentChatDraftHandoff({ draftTargetId }, prompt);
      navigateToAppTarget({ kind: "work", laneId: pr.laneId });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [pr]);

  const applyDetailPaneWarmCache = React.useCallback((cached: PrDetailPaneWarmCache) => {
    if (cached.detail) {
      liveDetailLoadedForPrRef.current = cached.prId;
    }
    if (cached.files.length > 0) {
      liveFilesLoadedForPrRef.current = cached.prId;
    }
    if (cached.commits.length > 0) {
      liveCommitsLoadedForPrRef.current = cached.prId;
    }
    setDetail(cached.detail);
    setFiles(cached.files);
    setCommits(cached.commits);
    setSnapshotStatus(cached.status);
    setSnapshotChecks(cached.checks);
    setSnapshotReviews(cached.reviews);
    setSnapshotComments(cached.comments);
    setActionRuns(cached.actionRuns);
    setActivity(cached.activity);
    setReviewThreads(cached.reviewThreads);
  }, []);

  const applySnapshotHydration = React.useCallback((cachedSnapshot: PrSnapshotHydration) => {
    const cachePatch: PrDetailPaneWarmCachePatch = {
      status: cachedSnapshot.status,
      checks: cachedSnapshot.checks,
      reviews: cachedSnapshot.reviews,
      comments: cachedSnapshot.comments,
    };
    setSnapshotStatus(cachedSnapshot.status);
    setSnapshotChecks(cachedSnapshot.checks);
    setSnapshotReviews(cachedSnapshot.reviews);
    setSnapshotComments(cachedSnapshot.comments);
    if (liveDetailLoadedForPrRef.current !== cachedSnapshot.prId) {
      setDetail(cachedSnapshot.detail);
      cachePatch.detail = cachedSnapshot.detail;
    }
    if (liveFilesLoadedForPrRef.current !== cachedSnapshot.prId) {
      setFiles(cachedSnapshot.files);
      cachePatch.files = cachedSnapshot.files;
    }
    if (liveCommitsLoadedForPrRef.current !== cachedSnapshot.prId) {
      setCommits(cachedSnapshot.commits);
      cachePatch.commits = cachedSnapshot.commits;
    }
    writeDetailPaneWarmCache(cachedSnapshot.prId, cachePatch);
  }, []);

  React.useEffect(() => {
    snapshotHydrationRef.current = snapshotHydration;
    if (snapshotHydration?.prId === pr.id) {
      applySnapshotHydration(snapshotHydration);
    }
  }, [applySnapshotHydration, pr.id, snapshotHydration]);

  // For unmapped PRs there is no DB row, so every detail fetch must route
  // through the coordinate-based endpoints. A ref keeps the coords stable across
  // renders so the per-PR fetch helpers below don't churn their identity.
  const isUnmapped = unmapped && Boolean(githubCoords);
  const coordsRef = React.useRef<PrGithubCoords | null>(githubCoords);
  coordsRef.current = githubCoords;

  // Each helper picks the row-based call for mapped PRs and the coordinate-based
  // call for unmapped PRs. Identity is stable (deps: pr.id, isUnmapped).
  const fetchDetail = React.useCallback((): Promise<PrDetail> =>
    isUnmapped && coordsRef.current
      ? window.ade.prs.getDetailByGithub(coordsRef.current)
      : window.ade.prs.getDetail(pr.id),
  [isUnmapped, pr.id]);
  const fetchFiles = React.useCallback((): Promise<PrFile[]> =>
    isUnmapped && coordsRef.current
      ? window.ade.prs.getFilesByGithub(coordsRef.current)
      : window.ade.prs.getFiles(pr.id),
  [isUnmapped, pr.id]);
  const fetchCommits = React.useCallback((): Promise<PrCommit[]> => {
    if (isUnmapped && coordsRef.current) return window.ade.prs.getCommitsByGithub(coordsRef.current);
    return typeof window.ade.prs.getCommits === "function" ? window.ade.prs.getCommits(pr.id) : Promise.resolve([]);
  }, [isUnmapped, pr.id]);
  const fetchActionRuns = React.useCallback((): Promise<PrActionRun[]> =>
    isUnmapped && coordsRef.current
      ? window.ade.prs.getActionRunsByGithub(coordsRef.current)
      : window.ade.prs.getActionRuns(pr.id),
  [isUnmapped, pr.id]);
  const fetchActivity = React.useCallback((): Promise<PrActivityEvent[]> =>
    isUnmapped && coordsRef.current
      ? window.ade.prs.getActivityByGithub(coordsRef.current)
      : window.ade.prs.getActivity(pr.id),
  [isUnmapped, pr.id]);
  const fetchReviewThreadsApi = React.useCallback((): Promise<PrReviewThread[]> =>
    isUnmapped && coordsRef.current
      ? window.ade.prs.getReviewThreadsByGithub(coordsRef.current)
      : window.ade.prs.getReviewThreads(pr.id),
  [isUnmapped, pr.id]);
  const fetchChecks = React.useCallback((): Promise<PrCheck[]> =>
    isUnmapped && coordsRef.current
      ? window.ade.prs.getChecksByGithub(coordsRef.current)
      : window.ade.prs.getChecks(pr.id),
  [isUnmapped, pr.id]);

  const loadDetail = React.useCallback(async (options: { hydrateSnapshot?: boolean; forceLive?: boolean; showLoading?: boolean } = {}) => {
    const requestId = ++detailLoadSeqRef.current;
    setDetailLoading(options.showLoading ?? !hasVisibleDetailDataRef.current);
    try {
      if (options.hydrateSnapshot && !options.forceLive) {
        const contextSnapshot = snapshotHydrationRef.current?.prId === pr.id ? snapshotHydrationRef.current : null;
        const cachedSnapshot = contextSnapshot ?? (typeof window.ade.prs.listSnapshots === "function"
          ? (await window.ade.prs.listSnapshots({ prId: pr.id }).catch(() => []))[0]
          : null);
        if (requestId !== detailLoadSeqRef.current) return;
        if (cachedSnapshot) {
          applySnapshotHydration(cachedSnapshot);
          if (hasSnapshotHydrationData(cachedSnapshot)) {
            hasVisibleDetailDataRef.current = true;
            setDetailLoading(false);
          }
        }
      }
      const applyIfCurrent = <T,>(apply: (value: T) => void) => (value: T) => {
        if (requestId === detailLoadSeqRef.current) apply(value);
        return value;
      };
      const detailPromise = fetchDetail()
        .then(applyIfCurrent((value) => {
          liveDetailLoadedForPrRef.current = pr.id;
          setDetail(value);
          updateDetailPaneWarmCache({ detail: value });
        }))
        .catch(() => null);
      const filesPromise = fetchFiles()
        .then(applyIfCurrent((value) => {
          liveFilesLoadedForPrRef.current = pr.id;
          setFiles(value);
          updateDetailPaneWarmCache({ files: value });
        }))
        .catch(() => []);
      const commitsPromise = fetchCommits()
        .then(applyIfCurrent((value) => {
          liveCommitsLoadedForPrRef.current = pr.id;
          setCommits(value);
          updateDetailPaneWarmCache({ commits: value });
        }))
        .catch(() => []);
      const actionRunsPromise = fetchActionRuns()
        .then(applyIfCurrent((value) => {
          setActionRuns(value);
          updateDetailPaneWarmCache({ actionRuns: value });
        }))
        .catch(() => []);
      // Unmapped GitHub-tab PRs have no DB row and no PrsContext live status, so
      // fetch the live merge box by coords and feed it into snapshotStatus (which
      // `status` falls back to). Mapped PRs get their live status from PrsContext.
      const statusPromise = (isUnmapped && coordsRef.current && typeof window.ade.prs.getStatusByGithub === "function")
        ? window.ade.prs.getStatusByGithub(coordsRef.current)
            .then(applyIfCurrent((value) => {
              if (value) {
                setSnapshotStatus(value);
                updateDetailPaneWarmCache({ status: value });
              }
            }))
            .catch(() => null)
        : Promise.resolve(null);
      await Promise.allSettled([detailPromise, filesPromise, commitsPromise, actionRunsPromise, statusPromise]);
    } catch {
      // silently fail - basic data still available from context
    } finally {
      if (requestId === detailLoadSeqRef.current) {
        snapshotPrefillPendingRef.current = false;
        setDetailLoading(false);
      }
    }
  }, [applySnapshotHydration, fetchActionRuns, fetchCommits, fetchDetail, fetchFiles, isUnmapped, pr.id, updateDetailPaneWarmCache]);

  const refreshReviewThreads = React.useCallback(async () => {
    const requestId = detailLoadSeqRef.current;
    const threads = await fetchReviewThreadsApi().catch(() => null);
    if (threads && requestId === detailLoadSeqRef.current) {
      setReviewThreads(threads);
      updateDetailPaneWarmCache({ reviewThreads: threads });
    }
    return threads;
  }, [fetchReviewThreadsApi, updateDetailPaneWarmCache]);

  // Load detail on PR change
  React.useEffect(() => {
    setActionError(null);
    setActionResult(null);
    setEditingTitle(false);
    setShowLabelEditor(false);
    setShowReviewerEditor(false);
    setActivity([]);
    activityFetchKeyRef.current = null;
    liveDetailLoadedForPrRef.current = null;
    liveFilesLoadedForPrRef.current = null;
    liveCommitsLoadedForPrRef.current = null;
    setPolledStatus(null); // transient re-poll value is per-PR
    const contextSnapshot = snapshotHydrationRef.current?.prId === pr.id ? snapshotHydrationRef.current : null;
    const paneWarmCache = readDetailPaneWarmCache(pr.id);
    const hasPrefill = hasSnapshotHydrationData(contextSnapshot) || Boolean(paneWarmCache && hasDetailPaneWarmCacheData(paneWarmCache));
    hasVisibleDetailDataRef.current = hasPrefill;
    setDetailLoading(!hasPrefill);
    if (paneWarmCache) {
      applyDetailPaneWarmCache(paneWarmCache);
    }
    if (contextSnapshot) {
      applySnapshotHydration(contextSnapshot);
    } else if (!paneWarmCache) {
      setDetail(null);
      setFiles([]);
      setCommits([]);
      setSnapshotStatus(null);
      setSnapshotChecks([]);
      setSnapshotReviews([]);
      setSnapshotComments([]);
    }
    if (!paneWarmCache) {
      setActionRuns([]);
      setReviewThreads([]);
    }

    snapshotPrefillPendingRef.current = true;
    void loadDetail({ hydrateSnapshot: true, showLoading: !hasPrefill });
    void refreshReviewThreads();
    return () => {
      detailLoadSeqRef.current += 1;
    };
  }, [applyDetailPaneWarmCache, applySnapshotHydration, loadDetail, pr.id, refreshReviewThreads]);

  React.useEffect(() => {
    const key = [
      pr.id,
      pr.checksStatus ?? "",
      pr.reviewStatus ?? "",
      pr.updatedAt ?? "",
    ].join("|");
    const prev = detailStatusRefreshKeyRef.current;
    if (!prev || !prev.startsWith(`${pr.id}|`)) {
      detailStatusRefreshKeyRef.current = key;
      return;
    }
    if (prev === key) return;
    detailStatusRefreshKeyRef.current = key;
    void loadDetail({ forceLive: true });
    void refreshReviewThreads();
  }, [loadDetail, pr.checksStatus, pr.id, pr.reviewStatus, pr.updatedAt, refreshReviewThreads]);

  const derivedActivity = React.useMemo(
    () => buildActivityFromLoadedDetail(checks, reviews, comments),
    [checks, comments, reviews],
  );
  const visibleActivity = activity.length > 0 ? activity : derivedActivity;

  React.useEffect(() => {
    visibleActivityCountRef.current = visibleActivity.length;
  }, [visibleActivity.length]);

  React.useEffect(() => {
    const shouldLoadImmediately = activeTab === "overview" || Boolean(deepLinkState.eventId);
    if (!shouldLoadImmediately) return undefined;
    const key = `${pr.id}|${activeTab}|${deepLinkState.eventId ?? ""}`;
    if (activityFetchKeyRef.current === key) return undefined;
    activityFetchKeyRef.current = key;
    let cancelled = false;
    const hasLocalActivity = visibleActivityCountRef.current > 0;
    const delay = !deepLinkState.eventId && (hasLocalActivity || snapshotPrefillPendingRef.current)
      ? DETAIL_BACKGROUND_ACTIVITY_DELAY_MS
      : 0;
    const timeoutId = window.setTimeout(() => {
      fetchActivity().then((events) => {
        if (!cancelled) {
          setActivity(events);
          updateDetailPaneWarmCache({ activity: events });
        }
      }).catch(() => {});
    }, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [activeTab, deepLinkState.eventId, fetchActivity, pr.id, updateDetailPaneWarmCache]);

  // Adaptive refresh for the PR detail readiness signals.
  //
  // Cadence: ~5s while the CI tab is open AND something is still queued or
  // running, 60s otherwise. It stops entirely when the window is hidden, and on
  // the CI tab once everything is terminal — there is nothing left to observe.
  // `getChecks` is included: it used to be missing, so third-party checks
  // (CodeRabbit, Vercel, …) never refreshed while the tab was open.
  const [windowVisible, setWindowVisible] = React.useState(
    () => (typeof document === "undefined" ? true : document.visibilityState !== "hidden"),
  );
  React.useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const onVisibility = () => setWindowVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  React.useEffect(() => {
    if (!windowVisible) return undefined;
    const checksTabOpen = activeTab === "checks";
    if (checksTabOpen && checksTerminal) return undefined;
    const periodMs = checksTabOpen && !checksTerminal ? 5_000 : 60_000;

    let cancelled = false;
    const id = window.setInterval(() => {
      // Honour PrsContext's shared GitHub rate-limit backoff rather than
      // hammering the API alongside it.
      if (isGithubRateLimited()) return;
      const activityPromise = activeTab === "overview"
        ? fetchActivity()
        : Promise.resolve(null);
      Promise.allSettled([
        fetchActionRuns(),
        fetchReviewThreadsApi(),
        activityPromise,
        fetchChecks(),
      ]).then(([arResult, thrResult, actResult, checksResult]) => {
        if (cancelled) return;
        for (const result of [arResult, thrResult, actResult, checksResult]) {
          if (result.status !== "rejected") continue;
          const message = String((result.reason as Error | undefined)?.message ?? result.reason);
          if (message.includes("rate limit") || message.includes("API rate")) {
            noteGithubRateLimit();
            return;
          }
        }
        if (arResult.status === "fulfilled") {
          setActionRuns(arResult.value);
          updateDetailPaneWarmCache({ actionRuns: arResult.value });
        }
        if (thrResult.status === "fulfilled") {
          setReviewThreads(thrResult.value);
          updateDetailPaneWarmCache({ reviewThreads: thrResult.value });
        }
        if (actResult.status === "fulfilled" && actResult.value) {
          setActivity(actResult.value);
          updateDetailPaneWarmCache({ activity: actResult.value });
        }
        if (checksResult.status === "fulfilled") {
          setPolledChecks(checksResult.value);
          updateDetailPaneWarmCache({ checks: checksResult.value });
        }
      });
    }, periodMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [
    activeTab, checksTerminal, fetchActionRuns, fetchActivity, fetchChecks, fetchReviewThreadsApi,
    isGithubRateLimited, noteGithubRateLimit, pr.id, updateDetailPaneWarmCache, windowVisible,
  ]);

  // While GitHub is still computing mergeability for the selected PR, re-poll
  // its status every ~2.5s until it resolves so the merge checklist stops
  // showing the "Checking mergeability…" shimmer once the merge box settles.
  // The result feeds `polledStatus`, which the status selector prefers while the
  // base status is still computing — so this resolves the spinner for BOTH
  // mapped (live-backed) and unmapped PRs. Bounded so it never polls forever.
  const mergeabilityComputing = Boolean(status?.mergeabilityComputing);
  React.useEffect(() => {
    if (!mergeabilityComputing) return undefined;
    // Unmapped PRs have a synthetic `gh:` id that getStatus(prId) can't resolve,
    // so re-poll them by coords instead.
    const pollStatus = (): Promise<PrStatus | null> => {
      if (isUnmapped && coordsRef.current && typeof window.ade.prs.getStatusByGithub === "function") {
        return window.ade.prs.getStatusByGithub(coordsRef.current);
      }
      if (typeof window.ade.prs.getStatus === "function") return window.ade.prs.getStatus(pr.id);
      return Promise.resolve(null);
    };
    let cancelled = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 24; // ~1 minute ceiling, then defer to background poll
    const seqAtStart = detailLoadSeqRef.current;
    const id = window.setInterval(() => {
      if (attempts >= MAX_ATTEMPTS) {
        window.clearInterval(id);
        return;
      }
      attempts += 1;
      pollStatus()
        .then((next) => {
          // Drop if cancelled, empty, or a newer detail load superseded us.
          if (cancelled || !next || seqAtStart !== detailLoadSeqRef.current) return;
          setPolledStatus(next);
          updateDetailPaneWarmCache({ status: next });
          if (!next.mergeabilityComputing) {
            window.clearInterval(id);
          }
        })
        .catch(() => {});
    }, 2_500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [mergeabilityComputing, isUnmapped, pr.id, updateDetailPaneWarmCache]);

  // ---- Action helper to reduce repetitive try/catch/finally ----
  const runAction = async (fn: () => Promise<void>) => {
    setActionBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  };

  // ---- Actions ----
  const handleMerge = (
    method: MergeMethod,
    options?: {
      bypassRules?: boolean;
      commitTitle?: string;
      commitBody?: string;
      expectedHeadSha?: string;
    },
  ) => {
    setActionResult(null);
    return runAction(async () => {
      // `land` is row-based; an unmapped GitHub-tab PR has a synthetic `gh:` id
      // with no DB row, so it would throw "PR not found". Surface a clear reason
      // instead of crashing — these PRs are merged from their project lane / GitHub.
      if (isUnmapped) {
        throw new Error(
          "This PR isn't mapped to an ADE lane — open it from its project lane or merge it on GitHub.",
        );
      }
      const res = await window.ade.prs.land({
        prId: pr.id,
        method,
        bypassRules: options?.bypassRules,
        commitTitle: options?.commitTitle,
        commitBody: options?.commitBody,
        expectedHeadSha: options?.expectedHeadSha,
      });
      setActionResult(res);
      await onRefresh();
    });
  };

  const [updateBranchBusy, setUpdateBranchBusy] = React.useState(false);
  const [updateBranchNotice, setUpdateBranchNotice] = React.useState<{ tone: "success" | "error"; text: string } | null>(null);

  // Reset the inline update-branch notice when switching PRs.
  React.useEffect(() => {
    setUpdateBranchNotice(null);
    setUpdateBranchBusy(false);
  }, [pr.id]);

  const handleUpdateBranch = React.useCallback(
    async (strategy: "merge" | "rebase") => {
      setUpdateBranchBusy(true);
      setUpdateBranchNotice(null);
      try {
        const result = await window.ade.prs.updateBranch({
          prId: pr.id,
          strategy,
          expectedHeadSha: status?.headSha ?? undefined,
        });
        // Conflicts come back as `{ success: false, hasConflicts: true, error }`,
        // so check hasConflicts FIRST — otherwise the generic failure branch
        // shadows the conflict UX (resolve-in-Rebase message + onOpenRebaseTab).
        if (result.hasConflicts) {
          setUpdateBranchNotice({
            tone: "error",
            text: "Update hit conflicts — resolve in the Rebase tab / launch resolver.",
          });
          if (pr.laneId && onOpenRebaseTab) onOpenRebaseTab(pr.laneId);
        } else if (!result.success || result.error) {
          setUpdateBranchNotice({ tone: "error", text: result.error ?? "Update branch failed." });
        } else {
          setUpdateBranchNotice({ tone: "success", text: "Branch updated with base." });
        }
        // Re-poll status + detail so the checklist refreshes off the new head.
        await Promise.all([onRefresh({ prId: pr.id }), loadDetail({ forceLive: true })]);
      } catch (err: unknown) {
        setUpdateBranchNotice({ tone: "error", text: err instanceof Error ? err.message : String(err) });
      } finally {
        setUpdateBranchBusy(false);
      }
    },
    [loadDetail, onOpenRebaseTab, onRefresh, pr.id, pr.laneId, status?.headSha],
  );

  const handleDeleteBranch = () => runAction(async () => {
    await window.ade.prs.cleanupBranch({
      prId: pr.id,
      deleteLocalBranch: true,
      deleteRemoteBranch: true,
    });
    await onRefresh();
  });

  const handleAddComment = async () => {
    if (!commentDraft.trim()) return;
    return runAction(async () => {
      await window.ade.prs.addComment({ prId: pr.id, body: commentDraft });
      setCommentDraft("");
      activityFetchKeyRef.current = null;
      setActivity([]);
      const activityPromise = fetchActivity()
        .then((events) => setActivity(events))
        .catch(() => undefined);
      await Promise.all([
        onRefresh(),
        loadDetail({ forceLive: true }),
        activityPromise,
      ]);
    });
  };

  const handleUpdateTitle = async () => {
    if (!titleDraft.trim()) return;
    return runAction(async () => {
      await window.ade.prs.updateTitle({ prId: pr.id, title: titleDraft });
      setEditingTitle(false);
      await onRefresh();
    });
  };

  const handleSetLabels = (labels: string[]) => runAction(async () => {
    await window.ade.prs.setLabels({ prId: pr.id, labels });
    setShowLabelEditor(false);
    await loadDetail({ forceLive: true });
  });

  const handleRequestReviewers = (request: ReviewerRequest) => runAction(async () => {
    await window.ade.prs.requestReviewers({
      prId: pr.id,
      reviewers: request.reviewers,
      teamReviewers: request.teamReviewers,
    });
    setShowReviewerEditor(false);
    await onRefresh();
    await loadDetail({ forceLive: true });
  });

  const handleSubmitReview = (event: PrReviewEvent, body: string) => runAction(async () => {
    await window.ade.prs.submitReview({ prId: pr.id, event, body: body || undefined });
    await onRefresh();
  });

  const handleClosePr = () => runAction(async () => {
    await window.ade.prs.close({ prId: pr.id });
    await onRefresh();
  });

  const handleReopenPr = () => runAction(async () => {
    await window.ade.prs.reopen({ prId: pr.id });
    await onRefresh();
  });

  const handleRerunChecks = (target?: PrRerunChecksTarget) => runAction(async () => {
    await window.ade.prs.rerunChecks({ prId: pr.id, ...target });
    await onRefresh();
    await loadDetail({ forceLive: true });
  });

  const laneForPr = React.useMemo(
    () => lanes.find((lane) => lane.id === pr.laneId && !lane.archivedAt) ?? null,
    [lanes, pr.laneId],
  );
  const handleOpenManageLane = React.useCallback(() => {
    if (!laneForPr) return;
    setManageLaneOpen(true);
  }, [laneForPr]);
  const handleRefresh = React.useCallback(async () => {
    try {
      await Promise.all([
        onRefresh({ prId: pr.id }),
        loadDetail({ forceLive: true }),
        refreshReviewThreads(),
      ]);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }, [loadDetail, onRefresh, pr.id, refreshReviewThreads]);

  const TAB_ACTIVE_COLORS: Record<DetailTab, string> = {
    overview: COLORS.accent,
    files: COLORS.info,
    checks: COLORS.checkPass,
  };
  const showDetailLoadingPill = (detailLoading || detailBusy) && !hasVisibleDetailData;

  const headerCi = React.useMemo(() => {
    if (headerChecks.length === 0) return null;
    // Same rollup as the CI tab and the overview card — one implementation.
    const buckets = summarizePipelineStates(headerChecks);
    const passing = buckets.passed;
    const failing = buckets.failed + buckets.unknown;
    const pending = buckets.running + buckets.queued;
    if (failing > 0) {
      return { color: COLORS.danger, label: `${failing} failed`, icon: <XCircle size={12} weight="fill" /> };
    }
    if (pending > 0) {
      return { color: COLORS.info, label: `${pending} running`, icon: <CircleNotch size={12} className="animate-spin" /> };
    }
    return { color: COLORS.checkPass, label: `${passing}/${headerChecks.length} passed`, icon: <CheckCircle size={12} weight="fill" /> };
  }, [headerChecks]);

  const DETAIL_TABS: Array<{ id: DetailTab; label: string; icon: React.ElementType; count?: number }> = [
    { id: "overview", label: "Overview", icon: Eye },
    { id: "files", label: "Files", icon: Code, count: files.length },
    { id: "checks", label: "CI / Checks", icon: Play, count: headerChecks.length },
  ];

  const overviewRailsActive = activeTab === "overview";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, minWidth: 0, overflow: "hidden", background: COLORS.prSurface }}>
      {/* ===== HEADER ===== */}
      <div style={{ padding: "18px 20px 0", borderBottom: `1px solid ${COLORS.border}`, flexShrink: 0, background: COLORS.prSurface }}>
        {/* Title row */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            {editingTitle ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void handleUpdateTitle(); if (e.key === "Escape") setEditingTitle(false); }}
                  autoFocus
                  style={{
                    flex: 1, height: 36, padding: "0 12px", fontSize: 16, fontWeight: 700,
                    fontFamily: SANS_FONT, color: COLORS.textPrimary,
                    background: COLORS.recessedBg, border: `1px solid ${COLORS.accent}`, borderRadius: 8, outline: "none",
                  }}
                />
                <button type="button" onClick={() => void handleUpdateTitle()} style={outlineButton({ height: 28, padding: "0 8px", color: COLORS.success, borderColor: "color-mix(in srgb, var(--color-success) 40%, transparent)" })}>
                  <Check size={14} weight="bold" />
                </button>
                <button type="button" onClick={() => setEditingTitle(false)} style={outlineButton({ height: 28, padding: "0 8px" })}>
                  <X size={14} weight="bold" />
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontFamily: MONO_FONT, fontSize: 14, color: COLORS.accent, fontWeight: 600, opacity: 0.8 }}>#{pr.githubPrNumber}</span>
                <span style={{ fontSize: 18, fontWeight: 700, color: COLORS.textPrimary, fontFamily: SANS_FONT, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", letterSpacing: "-0.01em" }}>
                  {pr.title}
                </span>
                <span style={{ flexShrink: 0 }}>
                  <InlinePrBadge {...getPrStateBadge(pr.state)} />
                </span>
                {pr.laneId ? (
                  <button
                    type="button"
                    onClick={() => { setTitleDraft(pr.title); setEditingTitle(true); }}
                    style={{ background: "none", border: "none", cursor: "pointer", padding: 2, color: COLORS.textMuted, flexShrink: 0, opacity: 0.6 }}
                    title="Edit title"
                  >
                    <PencilSimple size={14} />
                  </button>
                ) : null}
              </div>
            )}
            <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted, fontWeight: 500 }}>{pr.repoOwner}/{pr.repoName}</span>
              <span style={{ color: COLORS.border }}>|</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "color-mix(in srgb, var(--color-accent) 12%, transparent)", padding: "2px 8px", borderRadius: 6, border: "1px solid color-mix(in srgb, var(--color-accent) 20%, transparent)" }}>
                <BranchIcon size={12} style={{ color: COLORS.accent }} />
                <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.accent }}>{pr.headBranch}</span>
              </span>
              <ArrowRight size={10} style={{ color: COLORS.textDim }} />
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "color-mix(in srgb, var(--color-info) 12%, transparent)", padding: "2px 8px", borderRadius: 6, border: "1px solid color-mix(in srgb, var(--color-info) 20%, transparent)" }}>
                <BranchIcon size={12} style={{ color: COLORS.info }} />
                <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.info }}>{pr.baseBranch}</span>
              </span>
              {headerCi ? (
                <button
                  type="button"
                  onClick={() => setActiveTab("checks")}
                  title="View CI / Checks"
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 5,
                    padding: "2px 8px", borderRadius: 6, cursor: "pointer",
                    fontFamily: SANS_FONT, fontSize: 11, fontWeight: 500,
                    color: headerCi.color,
                    background: `color-mix(in srgb, ${headerCi.color} 12%, transparent)`,
                    border: `1px solid color-mix(in srgb, ${headerCi.color} 28%, transparent)`,
                  }}
                  data-testid="pr-header-ci-badge"
                >
                  {headerCi.icon}
                  {headerCi.label}
                </button>
              ) : null}
            </div>
          </div>
          {/* Unmapped-PR affordance: top-right of the header, above the
              refresh / GitHub action buttons. */}
          {!pr.laneId && unmappedAffordance ? (
            <UnmappedPrBanner affordance={unmappedAffordance} />
          ) : null}
        </div>

        {/* Sub-tab bar */}
        <div style={{ display: "flex", alignItems: "center", gap: 2, marginTop: 16 }}>
          {DETAIL_TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            const tabColor = TAB_ACTIVE_COLORS[tab.id];
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "9px 16px", fontSize: 12, fontWeight: isActive ? 600 : 500, fontFamily: SANS_FONT,
                  color: isActive ? COLORS.textPrimary : COLORS.textMuted,
                  background: isActive ? `${tabColor}14` : "transparent",
                  borderBottom: isActive ? `2.5px solid ${tabColor}` : "2.5px solid transparent",
                  borderTop: "none",
                  borderLeft: "none",
                  borderRight: "none",
                  borderRadius: "8px 8px 0 0",
                  cursor: "pointer", transition: "all 120ms ease",
                }}
              >
                <Icon size={15} weight={isActive ? "fill" : "regular"} style={{ color: isActive ? tabColor : COLORS.textMuted, transition: "color 120ms ease" }} />
                {tab.label}
                {tab.count != null && tab.count > 0 && (
                  <span style={{
                    fontSize: 10, fontFamily: MONO_FONT, padding: "1px 6px", fontVariantNumeric: "tabular-nums",
                    borderRadius: 10,
                    background: isActive ? `${tabColor}28` : "color-mix(in srgb, var(--color-muted-fg) 30%, transparent)",
                    color: isActive ? tabColor : COLORS.textMuted,
                    fontWeight: 600,
                  }}>
                    {tab.count}
                  </span>
                )}
              </button>
            );
          })}

          {/* Right-side action buttons */}
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
            <button type="button" onClick={() => void handleRefresh()} style={outlineButton({ height: 30, padding: "0 8px" })} title="Refresh">
              <ArrowsClockwise size={14} weight="bold" />
            </button>
            {onUnmap ? (
              <button
                type="button"
                disabled={unmapBusy}
                onClick={() => void onUnmap()}
                style={outlineButton({
                  height: 30,
                  padding: "0 10px",
                  color: COLORS.warning,
                  borderColor: "color-mix(in srgb, var(--color-warning) 38%, transparent)",
                  opacity: unmapBusy ? 0.55 : 1,
                })}
              >
                {unmapBusy ? "Unmapping..." : "Unmap"}
              </button>
            ) : null}
            {queueContext && onOpenQueueView ? (
              <button
                type="button"
                data-tour="prs.stackingIndicator"
                onClick={() => onOpenQueueView(queueContext.groupId)}
                style={outlineButton({ height: 30, padding: "0 10px", color: COLORS.accent, borderColor: "color-mix(in srgb, var(--color-accent) 40%, transparent)" })}
                title={queueContext.label ?? "Open queue"}
              >
                <Layers size={14} /> Queue
              </button>
            ) : null}
            {onShowInGraph ? (
              <button type="button" onClick={() => onShowInGraph(pr.laneId)} style={outlineButton({ height: 30, padding: "0 10px", color: COLORS.info, borderColor: "color-mix(in srgb, var(--color-info) 40%, transparent)" })}>
                <LaneIcon size={14} /> Graph
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                // Open the PR's GitHub URL directly. `openInGitHub(pr.id)`
                // resolves via a DB row and would fail for unmapped PRs.
                if (pr.githubUrl) {
                  void window.ade.app.openExternal(pr.githubUrl);
                } else {
                  void window.ade.prs.openInGitHub(pr.id);
                }
              }}
              style={outlineButton({ height: 30, padding: "0 10px" })}
            >
              <GithubLogo size={14} /> GitHub
            </button>
          </div>
        </div>
      </div>

      {/* ===== ERROR BAR ===== */}
      {actionError && (
        <div style={{ padding: "10px 20px", background: "color-mix(in srgb, var(--color-error) 5%, transparent)", borderBottom: "1px solid color-mix(in srgb, var(--color-error) 20%, transparent)", fontFamily: SANS_FONT, fontSize: 12, color: COLORS.danger, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <XCircle size={14} weight="fill" />
            <span>{actionError}</span>
          </div>
          <button type="button" onClick={() => setActionError(null)} style={{ background: "none", border: "none", cursor: "pointer", color: COLORS.danger, padding: 4 }}><X size={14} /></button>
        </div>
      )}
      {actionResult && (
        <div style={{
          padding: "10px 20px",
          background: actionResult.success ? "color-mix(in srgb, var(--color-success) 5%, transparent)" : "color-mix(in srgb, var(--color-error) 5%, transparent)",
          borderBottom: `1px solid ${actionResult.success ? "color-mix(in srgb, var(--color-success) 20%, transparent)" : "color-mix(in srgb, var(--color-error) 20%, transparent)"}`,
          fontFamily: SANS_FONT, fontSize: 12,
          color: actionResult.success ? COLORS.success : COLORS.danger,
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {actionResult.success ? <CheckCircle size={14} weight="fill" /> : <XCircle size={14} weight="fill" />}
            <span>{actionResult.success ? `Merged PR #${actionResult.prNumber}` : `Failed: ${actionResult.error ?? "unknown"}`}</span>
          </div>
          <button type="button" onClick={() => setActionResult(null)} style={{ background: "none", border: "none", cursor: "pointer", color: actionResult.success ? COLORS.success : COLORS.danger, padding: 4 }} aria-label="Dismiss merge result"><X size={14} /></button>
        </div>
      )}

      {/* ===== TAB CONTENT ===== */}
      <div style={{ position: "relative", flex: 1, minHeight: 0, overflow: overviewRailsActive ? "hidden" : "auto" }}>
        {showDetailLoadingPill ? <PrDetailLoadingPill /> : null}
        {activeTab === "overview" && (
          <TimelineRailsOverview
            ref={timelineRailsRef}
            pr={pr}
            detail={detail}
            status={status}
            checks={checks}
            reviews={reviews}
            comments={comments}
            activity={visibleActivity}
            commits={commits}
            files={files}
            reviewThreads={reviewThreadsForTimeline}
            deployments={deploymentsForTimeline}
            viewerLogin={viewerLogin}
            filters={timelineFilters}
            onFiltersChange={handleTimelineFiltersChange}
            aiSummary={timelineAiSummary}
            aiSummaryDismissed={aiSummaryDismissedForPr}
            onDismissAiSummary={handleDismissAiSummary}
            onRegenerateAiSummary={handleRegenerateAiSummary}
            commentDraft={commentDraft}
            setCommentDraft={setCommentDraft}
            actionBusy={actionBusy}
            onAddComment={handleAddComment}
            deepLink={deepLinkState}
            actionRuns={actionRuns}
            onSelectCheck={handleSelectCheckFromRail}
            onOpenChecksTab={handleOpenChecksTab}
            onRerunChecks={pr.laneId ? handleRerunChecks : undefined}
            onOpenFilesTab={() => setActiveTab("files")}
            mergeMethod={mergeMethod}
            showReviewerEditor={showReviewerEditor}
            setShowReviewerEditor={setShowReviewerEditor}
            reviewerInput={reviewerInput}
            setReviewerInput={setReviewerInput}
            showLabelEditor={showLabelEditor}
            setShowLabelEditor={setShowLabelEditor}
            labelInput={labelInput}
            setLabelInput={setLabelInput}
            onMerge={handleMerge}
            onUpdateBranch={pr.laneId ? handleUpdateBranch : undefined}
            updateBranchBusy={updateBranchBusy}
            updateBranchNotice={updateBranchNotice}
            onRequestReviewers={handleRequestReviewers}
            onSetLabels={handleSetLabels}
            onDeleteBranch={pr.laneId ? handleDeleteBranch : undefined}
            deleteBranchBusy={actionBusy}
            lane={laneForPr}
            onOpenManageLane={handleOpenManageLane}
            onClose={pr.laneId ? handleClosePr : undefined}
            onReopen={pr.laneId ? handleReopenPr : undefined}
            onSubmitReview={handleSubmitReview}
          />
        )}
        <PrManageLaneDialogHost
          open={manageLaneOpen}
          onOpenChange={setManageLaneOpen}
          lane={laneForPr}
        />
        {activeTab === "files" && (
          <FilesTab files={files} expandedFile={expandedFile} setExpandedFile={setExpandedFile} />
        )}
        {activeTab === "checks" && (
          <div data-tour="prs.checksPanel" style={{ display: "contents" }}>
          <PrChecksTab
            pr={pr}
            checks={checks}
            actionRuns={actionRuns}
            actionBusy={actionBusy}
            unmapped={isUnmapped}
            onRerunChecks={pr.laneId ? handleRerunChecks : undefined}
            focusedCheckId={focusedCheckId}
            onFocusedCheckConsumed={handleFocusedCheckConsumed}
            paletteRequest={checksPaletteRequest}
            onFixInChat={pr.laneId ? handleFixInChat : undefined}
          />
          </div>
        )}
      </div>
    </div>
  );
}

// ================================================================
// FILES TAB
// ================================================================

function FilesTab({ files, expandedFile, setExpandedFile }: { files: PrFile[]; expandedFile: string | null; setExpandedFile: (f: string | null) => void }) {
  const totalAdd = files.reduce((s, f) => s + f.additions, 0);
  const totalDel = files.reduce((s, f) => s + f.deletions, 0);
  const toPatchStatus = (status: PrFile["status"]): FilePatch["status"] => {
    if (status === "removed") return "deleted";
    if (status === "copied") return "added";
    return status;
  };
  const toPatch = (file: PrFile): FilePatch | null => {
    if (!file.patch) return null;
    return {
      path: file.filename,
      oldPath: file.previousFilename ?? undefined,
      mode: "commit",
      patch: file.patch,
      additions: file.additions,
      deletions: file.deletions,
      status: toPatchStatus(file.status),
    };
  };

  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ ...LABEL_STYLE, fontSize: 12, fontWeight: 600, color: COLORS.textSecondary }}>Files Changed ({files.length})</span>
          <span style={{ fontFamily: MONO_FONT, fontSize: 12, fontWeight: 600, color: COLORS.success, background: "color-mix(in srgb, var(--color-success) 12%, transparent)", padding: "2px 8px", borderRadius: 6 }}>+{totalAdd}</span>
          <span style={{ fontFamily: MONO_FONT, fontSize: 12, fontWeight: 600, color: COLORS.danger, background: "color-mix(in srgb, var(--color-error) 12%, transparent)", padding: "2px 8px", borderRadius: 6 }}>-{totalDel}</span>
        </div>
      </div>
      {files.length === 0 ? (
        <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textDim }}>No files changed</div>
      ) : (
        <div style={{ ...cardStyle(), padding: 0, overflow: "hidden" }}>
          {files.map((file, idx) => {
            const isExpanded = expandedFile === file.filename;
            const statusCol = fileStatusColor(file.status);
            const filePatch = toPatch(file);
            return (
              <div key={file.filename}>
                <button
                  type="button"
                  onClick={() => setExpandedFile(isExpanded ? null : file.filename)}
                  style={{
                    display: "flex", alignItems: "center", gap: 10, width: "100%",
                    padding: "10px 14px", border: "none", cursor: "pointer",
                    background: isExpanded ? `${statusCol}08` : "transparent",
                    borderBottom: idx < files.length - 1 || isExpanded ? `1px solid ${COLORS.border}` : "none",
                    textAlign: "left",
                    transition: "background 120ms ease",
                    borderLeft: isExpanded ? `3px solid ${statusCol}` : "3px solid transparent",
                  }}
                  onMouseEnter={(e) => { if (!isExpanded) e.currentTarget.style.background = COLORS.hoverBg; }}
                  onMouseLeave={(e) => { if (!isExpanded) e.currentTarget.style.background = "transparent"; }}
                >
                  {isExpanded ? <CaretDown size={12} style={{ color: statusCol }} /> : <CaretRight size={12} style={{ color: COLORS.textMuted }} />}
                  <span style={{
                    fontFamily: MONO_FONT, fontSize: 10, fontWeight: 700,
                    color: statusCol, width: 20, height: 20, textAlign: "center",
                    background: `${statusCol}15`, borderRadius: 4, lineHeight: "20px",
                  }}>
                    {fileStatusLabel(file.status)}
                  </span>
                  <span style={{ fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textPrimary, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {file.filename}
                  </span>
                  <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.success, fontWeight: 600 }}>+{file.additions}</span>
                  <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.danger, fontWeight: 600 }}>-{file.deletions}</span>
                </button>
                {isExpanded && filePatch ? (
                  <div style={{ borderBottom: `1px solid ${COLORS.border}`, height: 500 }}>
                    <AdeDiffViewer patch={filePatch} editable={false} className="h-full rounded-none border-0" />
                  </div>
                ) : isExpanded ? (
                  <div
                    style={{
                      borderBottom: `1px solid ${COLORS.border}`,
                      padding: "10px 14px",
                      fontFamily: MONO_FONT,
                      fontSize: 11,
                      color: COLORS.textDim,
                      background: COLORS.recessedBg,
                    }}
                  >
                    Patch unavailable for this file.
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
