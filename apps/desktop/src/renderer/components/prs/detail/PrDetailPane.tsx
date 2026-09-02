import React from "react";
import {
  CheckCircle, XCircle,
  CircleNotch,
  X,
  CaretDown, CaretRight,
} from "@phosphor-icons/react";
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
import { PrDetailHeader, type UnmappedAffordance } from "./PrDetailHeader";
import { PrChecksTab } from "./PrChecksTab";
import { resolveMergeabilityDeadline, type MergeabilityDeadline } from "./mergeabilityDeadline";
import { PrManageLaneDialogHost } from "../shared/PrManageLaneDialogHost";
import { COLORS, MONO_FONT, SANS_FONT, LABEL_STYLE, cardStyle } from "../../lanes/laneDesignTokens";
import { AdeDiffViewer } from "../../shared/AdeDiffViewer";
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
import { isWebClientMode } from "../../../lib/webClientMode";
import { PluginDetailSections, pluginPrContext } from "../../plugins/sockets";

// ---- Sub-tab type ----
type DetailTab = PrDetailRouteTab;
const DETAIL_TAB_STORAGE_KEY = "ade:prs:detailTabs:v1";
const DETAIL_BACKGROUND_ACTIVITY_DELAY_MS = 250;
const DETAIL_PANE_WARM_CACHE_TTL_MS = 5 * 60_000;
const DETAIL_PANE_WARM_CACHE_MAX_ENTRIES = 50;
// On the web client every poll tick is a relay round trip that serializes with
// the rest of the tab's reads, so the readiness polls run at a slower cadence
// there. Desktop talks to the host in-process and keeps the tight loop.
const checksPollPeriodMs = () => (isWebClientMode() ? 15_000 : 5_000);
const mergeabilityPollPeriodMs = () => (isWebClientMode() ? 10_000 : 2_500);

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
  /** The graph node's name, for the degraded reads that omit `jobName`. */
  fallbackJobName?: string | null,
): string {
  const logTail = excerpt.lines.slice(-80).join("\n").trim();
  const longestFence = Math.max(
    2,
    ...Array.from(logTail.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(longestFence + 1);
  const jobName = excerpt.jobName?.trim() || fallbackJobName?.trim() || `job ${excerpt.jobId}`;
  return [
    `Fix the failing CI job \`${jobName}\` on ${pr.repoOwner}/${pr.repoName} PR #${pr.githubPrNumber} (${pr.headBranch}).`,
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
  initialDetailTab?: DetailTab | null;
  onDetailTabChange?: (tab: DetailTab) => void;
  /**
   * When set, the PR is NOT mapped to an ADE lane. The pane routes all detail
   * fetches through the coordinate-based endpoints (which never require a DB
   * row) and shows a create/map affordance instead of lane-dependent controls.
   */
  githubCoords?: PrGithubCoords | null;
  unmapped?: boolean;
  /** The route has coordinates but GitHub has not resolved the row yet. */
  provisional?: boolean;
  /**
   * Create-lane / map-to-lane controls surfaced as an in-pane banner when the
   * PR is unmapped. Provided by GitHubTab so this pane stays presentational.
   */
  unmappedAffordance?: UnmappedAffordance | null;
};

export type { UnmappedAffordance };

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
  initialDetailTab,
  onDetailTabChange,
  githubCoords = null,
  unmapped = false,
  provisional = false,
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
    writeViewerLogin,
    setTimelineFilters,
    setAiSummaryDismissed,
    regeneratePrAiSummary,
    isGithubPollStoodDown,
    noteGithubReadFailure,
    noteGithubReadSuccess,
    githubPollPeriodFor,
    githubPollGeneration,
    markPrTerminalLocally,
    clearPrTerminalLocally,
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
  // Prefer the live status when we have it; fall back to the row. Both carry
  // the canonical rollup, which per-check bucket counts cannot see.
  const checksStatusForHeader = status?.checksStatus ?? pr.checksStatus;
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

  const handleFixInChat = React.useCallback(async (
    excerpt: PrCheckLogExcerpt,
    fallbackJobName?: string | null,
  ) => {
    if (!pr.laneId) return;
    const prompt = buildCiFixPrompt(pr, excerpt, fallbackJobName);
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

  const [windowVisible, setWindowVisible] = React.useState(
    () => (typeof document === "undefined" ? true : document.visibilityState !== "hidden"),
  );
  React.useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const onVisibility = () => setWindowVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Adaptive refresh for the PR detail readiness signals.
  //
  // Cadence: ~5s while the CI tab is open AND something is still queued or
  // running, 60s otherwise. It stops entirely when the window is hidden, and on
  // the CI tab once everything is terminal — there is nothing left to observe.
  // `getChecks` is included: it used to be missing, so third-party checks
  // (CodeRabbit, Vercel, …) never refreshed while the tab was open.
  //
  // The 5s rung is the most expensive loop in the app — roughly seven to ten
  // GitHub REST requests per tick, i.e. a whole hourly quota if it runs for an
  // hour, which is exactly what happened on 2026-08-17. It is now braked from
  // two sides: `getChecks` rejects instead of returning an empty list a failure
  // is indistinguishable from, and the shared governor turns any rejection or
  // the quota reserve into a longer period for this timer.
  React.useEffect(() => {
    if (!windowVisible) return undefined;
    const checksTabOpen = activeTab === "checks";
    if (checksTabOpen && checksTerminal) return undefined;
    const basePeriodMs = checksTabOpen && !checksTerminal ? checksPollPeriodMs() : 60_000;
    // Stretch the timer itself rather than waking every 5s to return early: a
    // guard that has to be re-checked on every tick is one refactor away from
    // being missed, and a slower interval cannot be.
    const periodMs = githubPollPeriodFor(basePeriodMs);

    let cancelled = false;
    const id = window.setInterval(() => {
      // Second line of defence — the period above already reflects the
      // stand-down, but a pause armed between ticks lands here.
      if (isGithubPollStoodDown()) return;
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
        const results = [arResult, thrResult, actResult, checksResult];
        // ANY rejection stands the loop down. The previous message-substring
        // test matched neither the 5xx responses of a GitHub outage nor a 403
        // rate-limit body, so the brake never armed while the quota drained.
        if (results.some((result) => result.status === "rejected")) {
          noteGithubReadFailure();
        } else {
          noteGithubReadSuccess();
        }
        // Whatever DID resolve is still applied: a partial answer keeps the
        // pane current instead of freezing it on the last complete one.
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
    githubPollGeneration, githubPollPeriodFor, isGithubPollStoodDown, noteGithubReadFailure,
    noteGithubReadSuccess, pr.id, updateDetailPaneWarmCache, windowVisible,
  ]);

  // While GitHub is still computing mergeability for the selected PR, re-poll
  // its status every ~2.5s until it resolves so the merge checklist stops
  // showing the "Checking mergeability…" shimmer once the merge box settles.
  // The result feeds `polledStatus`, which the status selector prefers while the
  // base status is still computing — so this resolves the spinner for BOTH
  // mapped (live-backed) and unmapped PRs. Bounded so it never polls forever.
  const mergeabilityComputing = Boolean(status?.mergeabilityComputing);
  // Carried across effect re-runs — see resolveMergeabilityDeadline for why a
  // per-mount deadline re-arms the ceiling forever during an outage.
  const mergeabilityDeadlineRef = React.useRef<MergeabilityDeadline | null>(null);
  React.useEffect(() => {
    if (!mergeabilityComputing) {
      mergeabilityDeadlineRef.current = null;
      return undefined;
    }
    // Unmapped PRs have a synthetic `gh:` id that getStatus(prId) can't resolve,
    // so re-poll them by coords instead. With neither reader available there is
    // nothing to ask, so the loop never starts — it used to resolve `null`
    // without making a request, which then recorded a governor *success* and
    // cleared the stand-down for every other loop on the surface.
    const readByCoords = isUnmapped && typeof window.ade.prs.getStatusByGithub === "function"
      ? window.ade.prs.getStatusByGithub
      : null;
    const readById = typeof window.ade.prs.getStatus === "function"
      ? window.ade.prs.getStatus
      : null;
    if (!(isUnmapped ? readByCoords : readById)) return undefined;
    const pollStatus = (): Promise<PrStatus | null> | null => {
      // Re-read the ref at tick time: it is reassigned every render, and a tick
      // landing between the render that nulled it and the effect cleanup would
      // otherwise pass null straight to the host.
      // An unmapped PR asks by coords or asks nothing: its `pr.id` is the
      // synthetic `gh:owner/repo#n`, which `getStatus` rejects locally. That
      // local rejection would arm the shared stand-down for every other loop on
      // the surface — a GitHub brake tripped by something GitHub never saw.
      if (isUnmapped) {
        const coords = coordsRef.current;
        return readByCoords && coords ? readByCoords(coords) : null;
      }
      return readById ? readById(pr.id) : null;
    };
    let cancelled = false;
    // Stands down with the governor like every other automatic loop, by
    // lengthening its period rather than skipping ticks. The ceiling is
    // wall-clock rather than an attempt count: skipped attempts against a
    // counter would have turned "~1 minute, then defer to the background poll"
    // into hours of a live 2.5s timer during an outage.
    const pollPeriodMs = githubPollPeriodFor(mergeabilityPollPeriodMs());
    mergeabilityDeadlineRef.current = resolveMergeabilityDeadline(
      mergeabilityDeadlineRef.current, pr.id, Date.now(),
    );
    const deadlineAtMs = mergeabilityDeadlineRef.current.deadlineAtMs;
    // A ceiling that already passed arms no timer at all: each governor
    // transition would otherwise create an interval whose first tick only
    // clears it.
    if (Date.now() >= deadlineAtMs) return undefined;
    const seqAtStart = detailLoadSeqRef.current;
    const id = window.setInterval(() => {
      if (Date.now() >= deadlineAtMs) {
        window.clearInterval(id);
        return;
      }
      if (isGithubPollStoodDown()) return;
      const request = pollStatus();
      if (!request) return;
      request
        .then((next) => {
          noteGithubReadSuccess();
          // Drop if cancelled, empty, or a newer detail load superseded us.
          if (cancelled || !next || seqAtStart !== detailLoadSeqRef.current) return;
          setPolledStatus(next);
          updateDetailPaneWarmCache({ status: next });
          if (!next.mergeabilityComputing) {
            window.clearInterval(id);
          }
        })
        .catch(() => {
          noteGithubReadFailure();
        });
    }, pollPeriodMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [
    mergeabilityComputing, isUnmapped, githubPollGeneration, githubPollPeriodFor,
    isGithubPollStoodDown, noteGithubReadFailure, noteGithubReadSuccess, pr.id,
    updateDetailPaneWarmCache,
  ]);

  // ---- Action helper to reduce repetitive try/catch/finally ----
  const runAction = React.useCallback(async (fn: () => Promise<void>) => {
    setActionBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  }, []);

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
      // No mapping check: `land` resolves a synthetic `gh:` id as readily as a
      // row id, because merging is a GitHub API call. A lane only decides
      // whether there is local bookkeeping to run afterwards.
      const res = await window.ade.prs.land({
        prId: pr.id,
        method,
        bypassRules: options?.bypassRules,
        commitTitle: options?.commitTitle,
        commitBody: options?.commitBody,
        expectedHeadSha: options?.expectedHeadSha,
      });
      setActionResult(res);
      // GitHub has accepted the merge. Move the row to Merged now rather than
      // leaving it in Open until the snapshot refetch agrees.
      if (res.success) markPrTerminalLocally(pr, "merged");
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

  const handleUpdateTitle = React.useCallback(() => {
    if (!titleDraft.trim()) return;
    void runAction(async () => {
      await window.ade.prs.updateTitle({ prId: pr.id, title: titleDraft });
      setEditingTitle(false);
      await onRefresh();
    });
  }, [onRefresh, pr.id, runAction, titleDraft]);

  const handleStartTitleEdit = React.useCallback(() => {
    setTitleDraft(pr.title);
    setEditingTitle(true);
  }, [pr.title]);

  const handleCancelTitleEdit = React.useCallback(() => setEditingTitle(false), []);

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
    markPrTerminalLocally(pr, "closed");
    await onRefresh();
  });

  const handleReopenPr = () => runAction(async () => {
    await window.ade.prs.reopen({ prId: pr.id });
    // Drop the optimistic "closed" this same pane may have recorded, or the row
    // and this pane both keep painting the PR as closed until it expires.
    clearPrTerminalLocally(pr);
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
  const showDetailLoadingPill = (detailLoading || detailBusy) && !hasVisibleDetailData;

  const overviewRailsActive = activeTab === "overview";

  // The detail pane's tab ids come from the route union `PrDetailRouteTab`, so a
  // plugin cannot add a tab without changing a shared route type. Its sections
  // land at the foot of Overview instead: after everything the product shows
  // about the PR, which is where the taxonomy puts contributed content anyway.
  const pluginPrSurfaceContext = React.useMemo(
    () => pluginPrContext({
      number: pr.githubPrNumber,
      title: pr.title,
      branch: pr.headBranch,
      state: pr.state,
      ciStatus: pr.checksStatus === "not_run" ? "none" : pr.checksStatus,
      id: pr.id,
      laneId: pr.laneId,
    }),
    [pr.checksStatus, pr.githubPrNumber, pr.headBranch, pr.id, pr.laneId, pr.state, pr.title],
  );

  /**
   * The CI tab's workflow-graph read is an automatic GitHub read, so it stands
   * down with every other one on this surface rather than keeping its own brake.
   */
  const checksPollGovernor = React.useMemo(() => ({
    isGithubPollStoodDown,
    noteGithubReadFailure,
    noteGithubReadSuccess,
    githubPollGeneration,
  }), [githubPollGeneration, isGithubPollStoodDown, noteGithubReadFailure, noteGithubReadSuccess]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, minWidth: 0, overflow: "hidden", background: COLORS.prSurface }}>
      {/* ===== HEADER ===== */}
      <PrDetailHeader
        pr={pr}
        provisional={provisional}
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        filesCount={files.length}
        checksCount={headerChecks.length}
        editingTitle={editingTitle}
        titleDraft={titleDraft}
        onTitleDraftChange={setTitleDraft}
        onStartTitleEdit={handleStartTitleEdit}
        onCancelTitleEdit={handleCancelTitleEdit}
        onSubmitTitle={handleUpdateTitle}
        onShowInGraph={onShowInGraph}
        unmappedAffordance={unmappedAffordance}
      />

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
            writeViewerLogin={writeViewerLogin}
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
            onRerunChecks={handleRerunChecks}
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
            onUpdateBranch={handleUpdateBranch}
            updateBranchBusy={updateBranchBusy}
            updateBranchNotice={updateBranchNotice}
            onRequestReviewers={handleRequestReviewers}
            onSetLabels={handleSetLabels}
            onDeleteBranch={handleDeleteBranch}
            deleteBranchBusy={actionBusy}
            lane={laneForPr}
            onOpenManageLane={handleOpenManageLane}
            onClose={handleClosePr}
            onReopen={handleReopenPr}
            onSubmitReview={handleSubmitReview}
            // ADE review needs a working tree, so when there is no lane the
            // button offers the checkout rather than going dead.
            onOpenAsLane={
              unmappedAffordance?.canCreateLane ? unmappedAffordance.onCreateLane : undefined
            }
          />
        )}
        {activeTab === "overview" ? (
          <div style={{ padding: "0 20px 20px" }}>
            <PluginDetailSections
              surface="prs"
              context={pluginPrSurfaceContext}
              active={overviewRailsActive}
            />
          </div>
        ) : null}
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
            checksStatus={checksStatusForHeader}
            onRerunChecks={handleRerunChecks}
            focusedCheckId={focusedCheckId}
            onFocusedCheckConsumed={handleFocusedCheckConsumed}
            paletteRequest={checksPaletteRequest}
            onFixInChat={pr.laneId ? handleFixInChat : undefined}
            pollGovernor={checksPollGovernor}
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
