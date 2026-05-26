import React from "react";
import {
  GithubLogo, CheckCircle, XCircle, Circle,
  CircleNotch, Sparkle, ArrowRight, Eye, Code,
  PencilSimple, X, Check, ArrowsClockwise, Play,
  CaretDown, CaretRight, Stack as Layers,
} from "@phosphor-icons/react";
import { BranchIcon, LaneIcon } from "../../ui/vcsIcons";
import type {
  PrWithConflicts, PrCheck, PrReview, PrComment, PrStatus, PrDetail,
  PrFile, PrCommit, PrActionRun, PrActivityEvent, PrReviewThread,
  LaneSummary, MergeMethod, LandResult,
  FilePatch,
  IssueInventorySnapshot,
  PipelineSettings,
  PrConvergenceState,
  PrConvergenceStatePatch,
  PrSnapshotHydration,
  PrChecksStatus,
  PrReviewStatus,
} from "../../../../shared/types";
import { DEFAULT_PR_TIMELINE_FILTERS, type PrTimelineFilters } from "../shared/PrTimeline";
import type { PaletteKind } from "../shared/PrCommandPalettes";
import { parsePrsRouteState, type PrDetailRouteTab } from "../prsRouteState";
import { PrDetailTimelineRails as TimelineRailsOverview, type PrDetailTimelineRailsRef } from "./PrDetailTimelineRails";
import { PrManageLaneDialogHost } from "../shared/PrManageLaneDialogHost";
import { DEFAULT_PIPELINE_SETTINGS } from "../../../../shared/types";
import { defaultPrIssueResolutionScope, getPrIssueResolutionAvailability } from "../../../../shared/prIssueResolution";
import { COLORS, MONO_FONT, SANS_FONT, LABEL_STYLE, cardStyle, inlineBadge, outlineButton, primaryButton, dangerButton } from "../../lanes/laneDesignTokens";
import { AdeDiffViewer } from "../../shared/AdeDiffViewer";
import { PrCiRunningIndicator } from "../shared/prVisuals";
import { PrIssueResolverModal } from "../shared/PrIssueResolverModal";
import { PrConvergencePanel } from "../shared/PrConvergencePanel";
import type { IssueInventoryItem as PanelIssueItem, ConvergenceStatus as PanelConvergence, AutoConvergeWaitState } from "../shared/PrConvergencePanel";
import { findMatchingRebaseNeed, rebaseNeedItemKey } from "../shared/rebaseNeedUtils";
import { usePrs } from "../state/PrsContext";
import { modifierKeyLabel } from "../../../lib/platform";
import {
  buildUnifiedChecks,
  findUnifiedCheckId,
  formatCheckDuration,
  unifiedChecksToPrChecks,
} from "../shared/prUnifiedChecks";
import type { PrReviewEvent } from "../shared/PrReviewSubmitModal";

// ---- Sub-tab type ----
type DetailTab = PrDetailRouteTab;
const DETAIL_TAB_STORAGE_KEY = "ade:prs:detailTabs:v1";
const DETAIL_BACKGROUND_ACTIVITY_DELAY_MS = 250;

function isDetailTab(value: unknown): value is DetailTab {
  return value === "overview" || value === "convergence" || value === "files" || value === "checks";
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
};

export function PrDetailPane({
  pr,
  status: liveStatus,
  checks: liveChecks,
  reviews: liveReviews,
  comments: liveComments,
  snapshotHydration = null,
  snapshotHydrationOwnedByContext = false,
  liveDetailReady = false,
  detailBusy,
  lanes,
  mergeMethod,
  onRefresh,
  onNavigate,
  onShowInGraph,
  onOpenRebaseTab,
  queueContext,
  onOpenQueueView,
  initialDetailTab,
  onDetailTabChange,
  onUnmap,
  unmapBusy = false,
}: PrDetailPaneProps) {
  const {
    convergenceStatesByPrId,
    loadConvergenceState,
    saveConvergenceState,
    resetConvergenceState,
    rebaseNeeds,
    resolverModel,
    resolverReasoningLevel,
    resolverPermissionMode,
    setResolverModel,
    setResolverReasoningLevel,
    setResolverPermissionMode,
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
  } = usePrs();
  const initialSnapshotHydration = snapshotHydration?.prId === pr.id ? snapshotHydration : null;
  const [activeTab, setActiveTabState] = React.useState<DetailTab>(
    () => normalizeDetailTab(initialDetailTab ?? readStoredDetailTab(pr.id)),
  );
  const [focusedCheckId, setFocusedCheckId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<PrDetail | null>(() => initialSnapshotHydration?.detail ?? null);
  const [files, setFiles] = React.useState<PrFile[]>(() => initialSnapshotHydration?.files ?? []);
  const [commits, setCommits] = React.useState<PrCommit[]>(() => initialSnapshotHydration?.commits ?? []);
  const [snapshotStatus, setSnapshotStatus] = React.useState<PrStatus | null>(() => initialSnapshotHydration?.status ?? null);
  const [snapshotChecks, setSnapshotChecks] = React.useState<PrCheck[]>(() => initialSnapshotHydration?.checks ?? []);
  const [snapshotReviews, setSnapshotReviews] = React.useState<PrReview[]>(() => initialSnapshotHydration?.reviews ?? []);
  const [snapshotComments, setSnapshotComments] = React.useState<PrComment[]>(() => initialSnapshotHydration?.comments ?? []);
  const [actionRuns, setActionRuns] = React.useState<PrActionRun[]>([]);
  const [activity, setActivity] = React.useState<PrActivityEvent[]>([]);
  const [reviewThreads, setReviewThreads] = React.useState<PrReviewThread[]>([]);
  const timelineRailsRef = React.useRef<PrDetailTimelineRailsRef | null>(null);
  const hasSnapshotDetail =
    snapshotStatus !== null
    || snapshotChecks.length > 0
    || snapshotReviews.length > 0
    || snapshotComments.length > 0;
  const status = liveDetailReady ? liveStatus : (hasSnapshotDetail ? snapshotStatus : liveStatus);
  const checks = liveDetailReady ? liveChecks : (hasSnapshotDetail ? snapshotChecks : liveChecks);
  const reviews = liveDetailReady ? liveReviews : (hasSnapshotDetail ? snapshotReviews : liveReviews);
  const comments = liveDetailReady ? liveComments : (hasSnapshotDetail ? snapshotComments : liveComments);

  const setActiveTab = React.useCallback((tab: DetailTab) => {
    setActiveTabState(tab);
    writeStoredDetailTab(pr.id, tab);
    onDetailTabChange?.(tab);
  }, [onDetailTabChange, pr.id]);

  const handleOpenChecksTab = React.useCallback(() => {
    setActiveTab("checks");
  }, [setActiveTab]);

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

  React.useEffect(() => {
    const onTourTab = (event: Event) => {
      const tab = (event as CustomEvent<DetailTab | "activity">).detail;
      if (tab === "overview" || tab === "convergence" || tab === "files" || tab === "checks" || tab === "activity") {
        setActiveTab(normalizeDetailTab(tab));
      }
    };
    window.addEventListener("ade:tour-pr-detail-tab", onTourTab);
    return () => window.removeEventListener("ade:tour-pr-detail-tab", onTourTab);
  }, [setActiveTab]);

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
      if (activeTab !== "overview") return;

      const rails = timelineRailsRef.current;
      if (!rails) return;

      const now = Date.now();
      const inChord = lastKey === "g" && now - lastKeyAt < CHORD_WINDOW_MS;

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
  }, [activeTab]);
  const [showIssueResolverModal, setShowIssueResolverModal] = React.useState(false);
  const [issueResolverBusy, setIssueResolverBusy] = React.useState(false);
  const [issueResolverCopyBusy, setIssueResolverCopyBusy] = React.useState(false);
  const [issueResolverCopyNotice, setIssueResolverCopyNotice] = React.useState<string | null>(null);
  const [issueResolverError, setIssueResolverError] = React.useState<string | null>(null);

  // Convergence panel state
  const [inventorySnapshot, setInventorySnapshot] = React.useState<IssueInventorySnapshot | null>(null);
  const [convergenceChecks, setConvergenceChecks] = React.useState<PrCheck[]>(checks);
  const [convergenceBusy, setConvergenceBusy] = React.useState(false);
  const [autoConverge, setAutoConverge] = React.useState(false);
  const [pathToMergeActive, setPathToMergeActive] = React.useState(false);
  const [convergenceSessionId, setConvergenceSessionId] = React.useState<string | null>(null);
  const [, setConvergenceMerged] = React.useState(false);
  const [, setConvergencePauseReason] = React.useState<string | null>(null);
  const [convergenceSessionHref, setConvergenceSessionHref] = React.useState<string | null>(null);
  const autoConvergeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const convergenceSessionPollerRef = React.useRef<number | null>(null);
  const convergenceLoadSeqRef = React.useRef(0);
  const convergenceTabLoadSeqRef = React.useRef(0);
  const cachedConvergenceRuntimeRef = React.useRef<PrConvergenceState | null>(null);
  const behindCountRef = React.useRef<number>(0);
  const [autoConvergeWaitState, setAutoConvergeWaitState] = React.useState<AutoConvergeWaitState>({ phase: "idle" });
  const [pipelineSettings, setPipelineSettings] = React.useState<PipelineSettings>(DEFAULT_PIPELINE_SETTINGS);
  const pipelineSettingsRef = React.useRef<PipelineSettings>(DEFAULT_PIPELINE_SETTINGS);
  const mergeMethodRef = React.useRef<MergeMethod>(mergeMethod);
  mergeMethodRef.current = mergeMethod;
  const onRefreshRef = React.useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  cachedConvergenceRuntimeRef.current = convergenceStatesByPrId[pr.id] ?? null;
  const convergenceChecksPrIdRef = React.useRef(pr.id);

  React.useEffect(() => {
    const prChanged = convergenceChecksPrIdRef.current !== pr.id;
    convergenceChecksPrIdRef.current = pr.id;

    // Always sync on PR change (even if empty — new PR starts fresh).
    // Within the same PR, only sync when the prop has data so that
    // transient PrsContext failures / rate-limits don't wipe out a
    // known-good convergence checks list.
    setConvergenceChecks((prev) => {
      if (prChanged) return checks;
      if (checks.length > 0) return checks;
      if (prev.length > 0) return prev;
      return checks;
    });
  }, [checks, pr.id]);

  const buildSessionHref = React.useCallback((laneId: string, sessionId: string) => {
    const lane = encodeURIComponent(laneId);
    const session = encodeURIComponent(sessionId);
    return `/work?laneId=${lane}&sessionId=${session}`;
  }, []);

  const deriveWaitStateFromRuntime = React.useCallback((runtime: PrConvergenceState): AutoConvergeWaitState => {
    if (runtime.status === "merged") return { phase: "merged" };
    if (runtime.status === "converged") return { phase: "complete" };
    if (runtime.status === "paused") {
      return {
        phase: "paused",
        reason: runtime.pauseReason ?? "Auto-converge paused",
        repeatCount: runtime.pauseRepeatCount,
      };
    }
    if (runtime.status === "stopped") {
      return { phase: "idle" };
    }
    if (runtime.status === "failed" || runtime.status === "cancelled") {
      return {
        phase: "paused",
        reason: runtime.errorMessage ?? runtime.pauseReason ?? `Auto-converge ${runtime.status}`,
      };
    }
    if (runtime.activeSessionId) {
      return { phase: "agent_running", sessionId: runtime.activeSessionId };
    }
    if (runtime.pollerStatus === "waiting_for_checks") {
      return { phase: "waiting_checks", pendingCount: 0, totalCount: 0 };
    }
    if (runtime.pollerStatus === "waiting_for_comments") {
      return { phase: "waiting_comments", stablePollCount: 0 };
    }
    if (runtime.autoConvergeEnabled && (runtime.status === "launching" || runtime.status === "running" || runtime.status === "polling")) {
      return { phase: "waiting_checks", pendingCount: 0, totalCount: 0 };
    }
    return { phase: "idle" };
  }, []);

  const applyConvergenceRuntime = React.useCallback((runtime: PrConvergenceState | null) => {
    if (!runtime) {
      setConvergenceBusy(false);
      setAutoConverge(false);
      setPathToMergeActive(false);
      setConvergenceSessionId(null);
      setConvergenceSessionHref(null);
      setConvergenceMerged(false);
      setConvergencePauseReason(null);
      setAutoConvergeWaitState({ phase: "idle" });
      return;
    }

    const nextHref = runtime.activeHref ?? (
      runtime.activeLaneId && runtime.activeSessionId
        ? buildSessionHref(runtime.activeLaneId, runtime.activeSessionId)
        : null
    );

    setAutoConverge(runtime.autoConvergeEnabled);
    setPathToMergeActive(Boolean(runtime.pathToMergeActive));
    setConvergenceBusy(Boolean(runtime.activeSessionId) || runtime.status === "launching" || runtime.status === "running" || runtime.status === "polling");
    setConvergenceSessionId(runtime.activeSessionId);
    setConvergenceSessionHref(nextHref);
    setConvergenceMerged(runtime.status === "merged");
    setConvergencePauseReason(runtime.pauseReason);
    setAutoConvergeWaitState(deriveWaitStateFromRuntime(runtime));
  }, [buildSessionHref, deriveWaitStateFromRuntime]);

  const saveConvergenceRuntime = React.useCallback((partial: PrConvergenceStatePatch) => {
    void saveConvergenceState(pr.id, partial).catch((error: unknown) => {
      console.error("pr_detail.save_convergence_runtime_failed", {
        prId: pr.id,
        state: partial,
        error,
      });
    });
  }, [pr.id, saveConvergenceState]);

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
  const inventoryLoadSeqRef = React.useRef(0);
  const snapshotHydrationRef = React.useRef<PrSnapshotHydration | null>(snapshotHydration);
  const snapshotPrefillPendingRef = React.useRef(false);
  const visibleActivityCountRef = React.useRef(0);
  const activityFetchKeyRef = React.useRef<string | null>(null);
  const liveDetailLoadedForPrRef = React.useRef<string | null>(null);
  const liveFilesLoadedForPrRef = React.useRef<string | null>(null);
  const liveCommitsLoadedForPrRef = React.useRef<string | null>(null);

  const applySnapshotHydration = React.useCallback((cachedSnapshot: PrSnapshotHydration) => {
    setSnapshotStatus(cachedSnapshot.status);
    setSnapshotChecks(cachedSnapshot.checks);
    setSnapshotReviews(cachedSnapshot.reviews);
    setSnapshotComments(cachedSnapshot.comments);
    if (liveDetailLoadedForPrRef.current !== cachedSnapshot.prId) {
      setDetail(cachedSnapshot.detail);
    }
    if (liveFilesLoadedForPrRef.current !== cachedSnapshot.prId) {
      setFiles(cachedSnapshot.files);
    }
    if (liveCommitsLoadedForPrRef.current !== cachedSnapshot.prId) {
      setCommits(cachedSnapshot.commits);
    }
  }, []);

  React.useEffect(() => {
    snapshotHydrationRef.current = snapshotHydration;
    if (snapshotHydration?.prId === pr.id) {
      applySnapshotHydration(snapshotHydration);
    }
  }, [applySnapshotHydration, pr.id, snapshotHydration]);

  const loadDetail = React.useCallback(async (options: { hydrateSnapshot?: boolean; forceLive?: boolean } = {}) => {
    const requestId = ++detailLoadSeqRef.current;
    try {
      if (options.hydrateSnapshot && !options.forceLive) {
        const contextSnapshot = snapshotHydrationRef.current?.prId === pr.id ? snapshotHydrationRef.current : null;
        const cachedSnapshot = contextSnapshot ?? (typeof window.ade.prs.listSnapshots === "function"
          ? (await window.ade.prs.listSnapshots({ prId: pr.id }).catch(() => []))[0]
          : null);
        if (requestId !== detailLoadSeqRef.current) return;
        if (cachedSnapshot) {
          applySnapshotHydration(cachedSnapshot);
        }
      }
      const applyIfCurrent = <T,>(apply: (value: T) => void) => (value: T) => {
        if (requestId === detailLoadSeqRef.current) apply(value);
        return value;
      };
      const detailPromise = window.ade.prs.getDetail(pr.id)
        .then(applyIfCurrent((value) => {
          liveDetailLoadedForPrRef.current = pr.id;
          setDetail(value);
        }))
        .catch(() => null);
      const filesPromise = window.ade.prs.getFiles(pr.id)
        .then(applyIfCurrent((value) => {
          liveFilesLoadedForPrRef.current = pr.id;
          setFiles(value);
        }))
        .catch(() => []);
      const commitsPromise = (typeof window.ade.prs.getCommits === "function"
        ? window.ade.prs.getCommits(pr.id)
            .then(applyIfCurrent((value) => {
              liveCommitsLoadedForPrRef.current = pr.id;
              setCommits(value);
            }))
            .catch(() => [])
        : Promise.resolve([]));
      const actionRunsPromise = window.ade.prs.getActionRuns(pr.id)
        .then(applyIfCurrent((value) => setActionRuns(value)))
        .catch(() => []);
      await Promise.allSettled([detailPromise, filesPromise, commitsPromise, actionRunsPromise]);
    } catch {
      // silently fail - basic data still available from context
    } finally {
      if (requestId === detailLoadSeqRef.current) {
        snapshotPrefillPendingRef.current = false;
      }
    }
  }, [applySnapshotHydration, pr.id]);

  const refreshReviewThreads = React.useCallback(async () => {
    const requestId = detailLoadSeqRef.current;
    const threads = await window.ade.prs.getReviewThreads(pr.id).catch(() => null);
    if (threads && requestId === detailLoadSeqRef.current) {
      setReviewThreads(threads);
    }
    return threads;
  }, [pr.id]);

  // Load detail on PR change
  React.useEffect(() => {
    setActionError(null);
    setActionResult(null);
    setIssueResolverError(null);
    setIssueResolverBusy(false);
    setIssueResolverCopyBusy(false);
    setIssueResolverCopyNotice(null);
    setShowIssueResolverModal(false);
    setInventorySnapshot(null);
    setConvergenceBusy(false);
    setPipelineSettings(DEFAULT_PIPELINE_SETTINGS);
    pipelineSettingsRef.current = DEFAULT_PIPELINE_SETTINGS;
    if (autoConvergeTimerRef.current) {
      clearTimeout(autoConvergeTimerRef.current);
      autoConvergeTimerRef.current = null;
    }
    if (autoConvergePollerRef.current) {
      clearTimeout(autoConvergePollerRef.current);
      autoConvergePollerRef.current = null;
    }
    lastCommentCountRef.current = -1;
    stableCountRef.current = 0;
    behindCountRef.current = 0;
    autoConvergeAdditionalRef.current = "";
    setEditingTitle(false);
    setShowLabelEditor(false);
    setShowReviewerEditor(false);
    setActivity([]);
    activityFetchKeyRef.current = null;
    liveDetailLoadedForPrRef.current = null;
    liveFilesLoadedForPrRef.current = null;
    liveCommitsLoadedForPrRef.current = null;
    const contextSnapshot = snapshotHydrationRef.current?.prId === pr.id ? snapshotHydrationRef.current : null;
    if (contextSnapshot) {
      applySnapshotHydration(contextSnapshot);
    } else {
      setDetail(null);
      setFiles([]);
      setCommits([]);
      setSnapshotStatus(null);
      setSnapshotChecks([]);
      setSnapshotReviews([]);
      setSnapshotComments([]);
    }
    setActionRuns([]);
    setReviewThreads([]);

    const requestId = ++convergenceLoadSeqRef.current;
    const cachedRuntime = cachedConvergenceRuntimeRef.current;
    applyConvergenceRuntime(cachedRuntime);
    void loadConvergenceState(pr.id, { force: true })
      .then((runtime) => {
        if (requestId !== convergenceLoadSeqRef.current) return;
        applyConvergenceRuntime(runtime);
      })
      .catch(() => {
        if (requestId !== convergenceLoadSeqRef.current) return;
        if (!cachedRuntime) {
          applyConvergenceRuntime(null);
        }
      });

    snapshotPrefillPendingRef.current = true;
    void loadDetail({ hydrateSnapshot: true });
    void refreshReviewThreads();
    return () => {
      detailLoadSeqRef.current += 1;
      inventoryLoadSeqRef.current += 1;
      convergenceLoadSeqRef.current += 1;
    };
  }, [applyConvergenceRuntime, applySnapshotHydration, loadConvergenceState, loadDetail, pr.id, refreshReviewThreads]);

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
      window.ade.prs.getActivity(pr.id).then((events) => {
        if (!cancelled) setActivity(events);
      }).catch(() => {});
    }, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [activeTab, deepLinkState.eventId, pr.id]);

  // Poll checks + actionRuns + reviewThreads every 60s so the
  // Path to Merge readiness panel stays fresh without requiring a manual refresh.
  // Full activity fetches include comments/reviews/checks again, so only do that
  // while the Overview thread is actually visible.
  React.useEffect(() => {
    let cancelled = false;
    const id = window.setInterval(() => {
      const activityPromise = activeTab === "overview"
        ? window.ade.prs.getActivity(pr.id)
        : Promise.resolve(null);
      Promise.allSettled([
        window.ade.prs.getChecks(pr.id),
        window.ade.prs.getActionRuns(pr.id),
        window.ade.prs.getReviewThreads(pr.id),
        activityPromise,
      ]).then(([checksResult, arResult, thrResult, actResult]) => {
        if (cancelled) return;
        if (checksResult.status === "fulfilled" && checksResult.value.length > 0) {
          setConvergenceChecks(checksResult.value);
        }
        if (arResult.status === "fulfilled") setActionRuns(arResult.value);
        if (thrResult.status === "fulfilled") setReviewThreads(thrResult.value);
        if (actResult.status === "fulfilled" && actResult.value) setActivity(actResult.value);
      });
    }, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [activeTab, pr.id]);

  React.useEffect(() => {
    if (!issueResolverCopyNotice) return;
    const timer = window.setTimeout(() => setIssueResolverCopyNotice(null), 2500);
    return () => window.clearTimeout(timer);
  }, [issueResolverCopyNotice]);

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
  const handleMerge = (method: MergeMethod, options?: { bypassRules?: boolean }) => {
    setActionResult(null);
    return runAction(async () => {
      const res = await window.ade.prs.land({ prId: pr.id, method, bypassRules: options?.bypassRules });
      setActionResult(res);
      await onRefresh();
    });
  };

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
      const activityPromise = window.ade.prs.getActivity(pr.id)
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

  const handleRequestReviewers = (reviewers: string[]) => runAction(async () => {
    await window.ade.prs.requestReviewers({ prId: pr.id, reviewers });
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

  const handleRerunChecks = () => runAction(async () => {
    await window.ade.prs.rerunChecks({ prId: pr.id });
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
  const matchingRebaseItemId = React.useMemo(() => {
    const need = findMatchingRebaseNeed({
      rebaseNeeds,
      laneId: pr.laneId,
      baseBranch: pr.baseBranch,
      prId: pr.id,
    });
    return need ? rebaseNeedItemKey(need) : null;
  }, [pr.baseBranch, pr.id, pr.laneId, rebaseNeeds]);
  const issueResolutionAvailability = React.useMemo(() => {
    const availability = getPrIssueResolutionAvailability(checks, reviewThreads, comments);
    if (laneForPr) return availability;
    return {
      ...availability,
      hasActionableChecks: false,
      hasActionableComments: false,
      hasAnyActionableIssues: false,
    };
  }, [checks, comments, laneForPr, reviewThreads]);

  const handleOpenIssueResolver = React.useCallback(() => {
    setIssueResolverError(null);
    setIssueResolverCopyNotice(null);
    setShowIssueResolverModal(true);
    void refreshReviewThreads();
    void onRefresh(); // Also refresh checks/status from PrsContext
  }, [onRefresh, refreshReviewThreads]);

  const handleLaunchIssueResolver = React.useCallback(async (
    args: { scope: "checks" | "comments" | "both"; additionalInstructions: string },
  ) => {
    setIssueResolverBusy(true);
    setIssueResolverError(null);
    try {
      const result = await window.ade.prs.issueResolutionStart({
        prId: pr.id,
        scope: args.scope,
        modelId: resolverModel,
        reasoning: resolverReasoningLevel || null,
        permissionMode: resolverPermissionMode,
        additionalInstructions: args.additionalInstructions,
      });
      setShowIssueResolverModal(false);
      setConvergenceSessionId(result.sessionId);
      setConvergenceSessionHref(result.href);
      saveConvergenceRuntime({
        autoConvergeEnabled: autoConverge,
        status: "running",
        pollerStatus: "idle",
        activeSessionId: result.sessionId,
        activeLaneId: pr.laneId,
        activeHref: result.href,
        pauseReason: null,
        errorMessage: null,
        lastStartedAt: new Date().toISOString(),
      });
      onNavigate(result.href);
    } catch (err: unknown) {
      setIssueResolverError(err instanceof Error ? err.message : String(err));
    } finally {
      setIssueResolverBusy(false);
    }
  }, [autoConverge, onNavigate, pr.id, pr.laneId, resolverModel, resolverPermissionMode, resolverReasoningLevel, saveConvergenceRuntime]);

  const handleCopyIssueResolverPrompt = React.useCallback(async (
    args: { scope: "checks" | "comments" | "both"; additionalInstructions: string },
  ) => {
    setIssueResolverCopyBusy(true);
    setIssueResolverError(null);
    setIssueResolverCopyNotice(null);
    try {
      const preview = await window.ade.prs.issueResolutionPreviewPrompt({
        prId: pr.id,
        scope: args.scope,
        modelId: resolverModel,
        reasoning: resolverReasoningLevel || null,
        permissionMode: resolverPermissionMode,
        additionalInstructions: args.additionalInstructions,
      });
      if (window.ade?.app?.writeClipboardText) {
        await window.ade.app.writeClipboardText(preview.prompt);
      } else if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(preview.prompt);
      } else {
        throw new Error("Clipboard access is not available in this environment.");
      }
      setIssueResolverCopyNotice("Prompt copied to clipboard.");
    } catch (err: unknown) {
      setIssueResolverError(err instanceof Error ? err.message : String(err));
    } finally {
      setIssueResolverCopyBusy(false);
    }
  }, [pr.id, resolverModel, resolverPermissionMode, resolverReasoningLevel]);

  // ---------------------------------------------------------------------------
  // Convergence panel: inventory sync & type mapping
  // ---------------------------------------------------------------------------

  const syncInventory = React.useCallback(async () => {
    if (pr.state === "merged" || pr.state === "closed") {
      return null;
    }
    const requestId = ++inventoryLoadSeqRef.current;
    try {
      const [snapshot, freshChecks, freshActionRuns] = await Promise.all([
        window.ade.prs.issueInventorySync(pr.id),
        window.ade.prs.getChecks(pr.id).catch(() => checks),
        window.ade.prs.getActionRuns(pr.id).catch(() => null),
      ]);
      if (requestId !== inventoryLoadSeqRef.current) return null;
      setInventorySnapshot(snapshot);
      // Only update convergence checks if we got real data back — avoid
      // overwriting a known-good list with an empty one from a transient
      // API failure or rate-limit.
      if (freshChecks.length > 0) {
        setConvergenceChecks(freshChecks);
      }
      if (freshActionRuns && freshActionRuns.length > 0) {
        setActionRuns(freshActionRuns);
      }
      return snapshot;
    } catch {
      return null;
    }
  }, [checks, pr.id, pr.state]);

  const refreshDetailSurface = React.useCallback(async (options: { includeInventory?: boolean } = {}) => {
    const tasks: Array<Promise<unknown>> = [onRefresh({ prId: pr.id }), loadDetail({ forceLive: true }), refreshReviewThreads()];
    if (options.includeInventory && pr.state !== "merged" && pr.state !== "closed") {
      tasks.push(syncInventory());
    }
    await Promise.all(tasks);
  }, [loadDetail, onRefresh, pr.id, pr.state, refreshReviewThreads, syncInventory]);

  const handleRefresh = React.useCallback(async () => {
    try {
      await refreshDetailSurface({ includeInventory: activeTab === "convergence" });
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }, [activeTab, refreshDetailSurface]);

  const formatReviewThreadContext = React.useCallback((threadId: string): string | null => {
    const thread = reviewThreads.find((entry) => `thread:${entry.id}` === threadId || entry.id === threadId);
    if (!thread) return null;
    const parts = thread.comments.map((comment, index) => {
      const author = comment.author || "unknown";
      const body = (comment.body ?? "").trim() || "(empty comment)";
      const label = thread.comments.length > 1
        ? `${author} (${index + 1}/${thread.comments.length})`
        : author;
      return `${label}:\n${body}`;
    });
    return parts.length > 0 ? parts.join("\n\n") : null;
  }, [reviewThreads]);

  const mapInventoryItems = React.useCallback((snapshot: IssueInventorySnapshot | null): PanelIssueItem[] => {
    if (!snapshot) return [];
    return snapshot.items.map((item) => {
      const fullThreadContext = item.type === "review_thread"
        ? formatReviewThreadContext(item.externalId)
        : null;
      return {
        id: item.id,
        type: item.type,
        externalId: item.externalId,
        state: item.state === "sent_to_agent" ? "in_progress" : item.state,
        severity: item.severity ?? "minor",
        headline: item.headline,
        filePath: item.filePath,
        line: item.line,
        source: item.source === "unknown" ? "human" : item.source,
        dismissReason: item.dismissReason,
        agentSessionId: item.agentSessionId,
        url: item.url,
        body: fullThreadContext ?? item.body,
        author: item.author,
        threadCommentCount: item.threadCommentCount ?? null,
        threadLatestCommentAuthor: item.threadLatestCommentAuthor ?? null,
        threadLatestCommentAt: item.threadLatestCommentAt ?? null,
      };
    }) as PanelIssueItem[];
  }, [formatReviewThreadContext]);

  const handleOpenInventorySource = React.useCallback((item: PanelIssueItem) => {
    if (!item.url) return;
    try {
      const parsed = new URL(item.url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
      void window.ade.app.openExternal(parsed.toString());
    } catch {
      // ignore malformed URLs
    }
  }, []);

  const mapConvergenceStatus = React.useCallback((snapshot: IssueInventorySnapshot | null): PanelConvergence => {
    if (!snapshot) return { state: "not_started", currentRound: 1, maxRounds: 5 };
    const c = snapshot.convergence;
    const displayRound = Math.max(1, c.currentRound);
    let state: PanelConvergence["state"] = "not_started";
    if (c.currentRound > 0) {
      if (c.totalNew === 0 && c.totalSentToAgent === 0) {
        state = "complete";
      } else if (c.isConverging) {
        state = "converging";
      } else {
        state = "stalled";
      }
    }
    return { state, currentRound: displayRound, maxRounds: c.maxRounds };
  }, []);

  // Sync inventory and load pipeline settings on convergence tab open
  React.useEffect(() => {
    if (activeTab === "convergence") {
      const runId = ++convergenceTabLoadSeqRef.current;
      const capturedPrId = pr.id;
      void loadConvergenceState(capturedPrId, { force: true }).then((runtime) => {
        if (runId !== convergenceTabLoadSeqRef.current) return; // stale
        applyConvergenceRuntime(runtime);
      }).catch(() => undefined);
      if (pr.state !== "merged" && pr.state !== "closed") void syncInventory();
      void window.ade.prs.pipelineSettingsGet(capturedPrId).then((s) => {
        if (runId !== convergenceTabLoadSeqRef.current) return; // stale
        setPipelineSettings(s);
        pipelineSettingsRef.current = s;
      }).catch(() => undefined);
    }
  }, [activeTab, applyConvergenceRuntime, loadConvergenceState, syncInventory, pr.id, pr.state]);

  // Auto-converge: hybrid polling (checks complete + comment stabilization)
  // After agent session completes, polls every 60s. Triggers next round when:
  //   1. All GitHub checks are done (no queued/in_progress), AND
  //   2. Comment/thread count hasn't changed for 2 consecutive polls (~2 min stability)
  const autoConvergePollerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const startAutoConvergePollerRef = React.useRef<() => void>(() => undefined);
  const lastCommentCountRef = React.useRef<number>(-1);
  const stableCountRef = React.useRef<number>(0);
  const autoConvergeAdditionalRef = React.useRef<string>("");
  const handleRunNextRoundRef = React.useRef<(instructions: string) => Promise<void>>();

  // Refs for mutable values read inside the poller tick so we never
  // capture stale closure values.
  const autoConvergeRef = React.useRef(autoConverge);
  autoConvergeRef.current = autoConverge;
  const pathToMergeActiveRef = React.useRef(pathToMergeActive);
  pathToMergeActiveRef.current = pathToMergeActive;
  const convergenceSessionIdRef = React.useRef(convergenceSessionId);
  convergenceSessionIdRef.current = convergenceSessionId;
  const convergenceSessionHrefRef = React.useRef<string | null>(convergenceSessionHref);
  convergenceSessionHrefRef.current = convergenceSessionHref;
  const pathToMergeActionSeqRef = React.useRef(0);

  const stopAutoConvergePoller = React.useCallback(() => {
    if (autoConvergePollerRef.current) {
      clearTimeout(autoConvergePollerRef.current);
      autoConvergePollerRef.current = null;
    }
    lastCommentCountRef.current = -1;
    stableCountRef.current = 0;
    behindCountRef.current = 0;
  }, []);

  const stopConvergenceSessionPoller = React.useCallback(() => {
    if (convergenceSessionPollerRef.current) {
      clearTimeout(convergenceSessionPollerRef.current);
      convergenceSessionPollerRef.current = null;
    }
  }, []);

  const getConvergencePublishBlocker = React.useCallback(async (sessionId: string): Promise<string | null> => {
    const sessionDetailPromise = typeof window.ade?.sessions?.get === "function"
      ? window.ade.sessions.get(sessionId).catch(() => null)
      : Promise.resolve(null);
    const syncStatusPromise = typeof window.ade?.git?.getSyncStatus === "function"
      ? window.ade.git.getSyncStatus({ laneId: pr.laneId }).catch(() => null)
      : Promise.resolve(null);
    const laneListPromise = typeof window.ade?.lanes?.list === "function"
      ? window.ade.lanes.list({ includeStatus: true }).catch(() => lanes)
      : Promise.resolve(lanes);
    const [sessionDetail, syncStatus, freshLanes] = await Promise.all([
      sessionDetailPromise,
      syncStatusPromise,
      laneListPromise,
    ]);
    const lane = freshLanes.find((entry) => entry.id === pr.laneId) ?? lanes.find((entry) => entry.id === pr.laneId) ?? null;
    const hasDirtyChanges = Boolean(lane?.status.dirty);
    const sessionHeadChanged = Boolean(sessionDetail?.headShaStart)
      && Boolean(sessionDetail?.headShaEnd)
      && sessionDetail?.headShaStart !== sessionDetail?.headShaEnd;
    const hasUnpublishedCommits = syncStatus
      ? syncStatus.ahead > 0
        || syncStatus.recommendedAction === "force_push_lease"
        || (
          !syncStatus.hasUpstream
          && sessionHeadChanged
        )
      : false;

    if (!hasDirtyChanges && !hasUnpublishedCommits) return null;

    const pendingStates: string[] = [];
    if (hasDirtyChanges) pendingStates.push("uncommitted changes");
    if (hasUnpublishedCommits) {
      pendingStates.push(
        syncStatus?.recommendedAction === "force_push_lease"
          ? "commits that still need a force push"
          : "commits that are not pushed to the PR branch",
      );
    }
    return `Agent session exited, but the lane still has ${pendingStates.join(" and ")}. Commit and push the lane before continuing.`;
  }, [lanes, pr.laneId]);

  const handleConvergenceSessionTerminal = React.useCallback(async (
    args: { sessionId: string; status: "completed" | "failed" | "cancelled" | "disposed"; message?: string | null },
  ) => {
    if (convergenceSessionIdRef.current !== args.sessionId) return;
    if (pathToMergeActiveRef.current) {
      stopConvergenceSessionPoller();
      const runtime = await loadConvergenceState(pr.id, { force: true }).catch(() => null);
      applyConvergenceRuntime(runtime);
      return;
    }

    const now = new Date().toISOString();
    const activeHref = convergenceSessionHrefRef.current;
    const failureReason = (() => {
      const message = args.message?.trim();
      if (message) return message;
      if (args.status === "cancelled") return "Agent session was cancelled.";
      if (args.status === "disposed") return "Agent session stopped before completion.";
      if (args.status === "failed") return "Agent session failed before completion.";
      return null;
    })();

    setConvergenceBusy(false);
    setConvergenceSessionId(null);
    stopConvergenceSessionPoller();

    await refreshDetailSurface({ includeInventory: true }).catch(() => {});

    if (args.status === "completed") {
      const publishBlocker = await getConvergencePublishBlocker(args.sessionId).catch(() => null);
      if (publishBlocker) {
        if (autoConvergeRef.current) {
          stopAutoConvergePoller();
          setConvergencePauseReason(publishBlocker);
          setAutoConvergeWaitState({ phase: "paused", reason: publishBlocker });
          saveConvergenceRuntime({
            status: "paused",
            pollerStatus: "paused",
            activeSessionId: null,
            activeHref,
            pauseReason: publishBlocker,
            errorMessage: publishBlocker,
            lastPausedAt: now,
            lastStoppedAt: now,
          });
        } else {
          setActionError(publishBlocker);
          saveConvergenceRuntime({
            status: "failed",
            pollerStatus: "stopped",
            activeSessionId: null,
            activeHref,
            pauseReason: null,
            errorMessage: publishBlocker,
            lastStoppedAt: now,
          });
          setAutoConvergeWaitState({ phase: "idle" });
        }
        return;
      }

      if (autoConvergeRef.current) {
        saveConvergenceRuntime({
          status: "polling",
          pollerStatus: "waiting_for_checks",
          activeSessionId: null,
          activeHref,
          pauseReason: null,
          errorMessage: null,
          lastPolledAt: now,
        });
        setAutoConvergeWaitState({ phase: "waiting_checks", pendingCount: 0, totalCount: 0 });
        startAutoConvergePollerRef.current();
      } else {
        saveConvergenceRuntime({
          status: "idle",
          pollerStatus: "idle",
          activeSessionId: null,
          activeHref,
          pauseReason: null,
          errorMessage: null,
          lastStoppedAt: now,
        });
        setAutoConvergeWaitState({ phase: "idle" });
      }
      return;
    }

    if (autoConvergeRef.current) {
      const reason = failureReason ?? "Agent session ended unexpectedly.";
      stopAutoConvergePoller();
      setConvergencePauseReason(reason);
      setAutoConvergeWaitState({ phase: "paused", reason });
      saveConvergenceRuntime({
        status: "paused",
        pollerStatus: "paused",
        activeSessionId: null,
        activeHref,
        pauseReason: reason,
        errorMessage: reason,
        lastPausedAt: now,
        lastStoppedAt: now,
      });
      return;
    }

    saveConvergenceRuntime({
      status: args.status === "cancelled" ? "cancelled" : "failed",
      pollerStatus: "stopped",
      activeSessionId: null,
      activeHref,
      pauseReason: null,
      errorMessage: failureReason,
      lastStoppedAt: now,
    });
    setAutoConvergeWaitState({ phase: "idle" });
  }, [applyConvergenceRuntime, getConvergencePublishBlocker, loadConvergenceState, pr.id, refreshDetailSurface, saveConvergenceRuntime, stopAutoConvergePoller, stopConvergenceSessionPoller]);

  const startAutoConvergePoller = React.useCallback(() => {
    stopAutoConvergePoller();
    if (pathToMergeActiveRef.current) return;

    const scheduleTick = (delayMs = 60_000) => {
      autoConvergePollerRef.current = setTimeout(async () => {
        if (pathToMergeActiveRef.current) { stopAutoConvergePoller(); return; }
        if (!autoConvergeRef.current) { stopAutoConvergePoller(); return; }
        try {
          // Poll checks and inventory
          const [freshChecks, snapshot, freshActionRuns] = await Promise.all([
            window.ade.prs.getChecks(pr.id),
            window.ade.prs.issueInventorySync(pr.id),
            window.ade.prs.getActionRuns(pr.id).catch(() => null),
          ]);
          setInventorySnapshot(snapshot);
          if (freshChecks.length > 0) {
            setConvergenceChecks(freshChecks);
          }
          if (freshActionRuns && freshActionRuns.length > 0) {
            setActionRuns(freshActionRuns);
          }

          // Skip rebase logic while an agent session is still active
          if (!convergenceSessionIdRef.current) {
            // Rebase detection: check if the PR is behind its base branch
            const freshStatus = await window.ade.prs.getStatus(pr.id);
            const isBehind = (freshStatus?.behindBaseBy ?? 0) > 0;

            if (isBehind) {
              const rebasePolicy = pipelineSettingsRef.current.onRebaseNeeded;
              if (rebasePolicy === "pause") {
                stopAutoConvergePoller();
                setConvergencePauseReason("PR is behind base branch. Rebase needed to continue.");
                setAutoConvergeWaitState({ phase: "paused", reason: "PR is behind base branch. Rebase needed to continue." });
                saveConvergenceRuntime({
                  status: "paused",
                  pollerStatus: "paused",
                  activeSessionId: null,
                  activeHref: convergenceSessionHref,
                  pauseReason: "PR is behind base branch. Rebase needed to continue.",
                  errorMessage: null,
                  lastPausedAt: new Date().toISOString(),
                });
                return;
              }
              // rebasePolicy === "auto_rebase"
              // The existing auto-rebase system should handle this. After rebase push,
              // checks go to in_progress and Gate 1 naturally blocks until they finish.
              // If the PR has been behind for 3+ consecutive polls (~3 min), rebase is stuck.
              behindCountRef.current++;
              if (behindCountRef.current >= 3) {
                stopAutoConvergePoller();
                setConvergencePauseReason("PR needs rebase but auto-rebase appears stuck. Resolve conflicts manually.");
                setAutoConvergeWaitState({ phase: "paused", reason: "PR needs rebase but auto-rebase appears stuck. Resolve conflicts manually." });
                saveConvergenceRuntime({
                  status: "paused",
                  pollerStatus: "paused",
                  activeSessionId: null,
                  activeHref: convergenceSessionHref,
                  pauseReason: "PR needs rebase but auto-rebase appears stuck. Resolve conflicts manually.",
                  errorMessage: null,
                  lastPausedAt: new Date().toISOString(),
                });
                return;
              }
              scheduleTick(); // Keep polling, give auto-rebase time to work
              return;
            }
            behindCountRef.current = 0; // Reset if not behind
          }

          // Check 1: Are all GitHub checks done?
          const checksStillRunning = freshChecks.some(
            (c: PrCheck) => c.status === "queued" || c.status === "in_progress",
          );
          if (checksStillRunning) {
            const pendingCount = freshChecks.filter((c: PrCheck) => c.status === "queued" || c.status === "in_progress").length;
            setAutoConvergeWaitState({ phase: "waiting_checks", pendingCount, totalCount: freshChecks.length });
            saveConvergenceRuntime({
              status: "polling",
              pollerStatus: "waiting_for_checks",
              currentRound: snapshot.convergence.currentRound,
              activeSessionId: null,
              activeHref: convergenceSessionHref,
              pauseReason: null,
              errorMessage: null,
              lastPolledAt: new Date().toISOString(),
            });
            lastCommentCountRef.current = -1;
            stableCountRef.current = 0;
            scheduleTick(); // Keep polling
            return;
          }

          // Check 2: Has the comment count stabilized?
          const currentCount = snapshot.items.filter((i) => i.state === "new").length;
          if (currentCount === lastCommentCountRef.current) {
            stableCountRef.current++;
          } else {
            stableCountRef.current = 0;
          }
          lastCommentCountRef.current = currentCount;

          // Trigger next round: checks done + 2 consecutive stable polls + has new items
          if (stableCountRef.current < 2) {
            setAutoConvergeWaitState({ phase: "waiting_comments", stablePollCount: stableCountRef.current });
            saveConvergenceRuntime({
              status: "polling",
              pollerStatus: "waiting_for_comments",
              currentRound: snapshot.convergence.currentRound,
              activeSessionId: null,
              activeHref: convergenceSessionHref,
              pauseReason: null,
              errorMessage: null,
              lastPolledAt: new Date().toISOString(),
            });
          }
          if (stableCountRef.current >= 2 && currentCount > 0) {
            stopAutoConvergePoller();
            setAutoConvergeWaitState({ phase: "ready" });
            const convergence = snapshot.convergence;
            if (convergence.currentRound >= convergence.maxRounds) {
              const reason = "Maximum auto-converge rounds reached.";
              setConvergencePauseReason(reason);
              setAutoConvergeWaitState({ phase: "paused", reason });
              saveConvergenceRuntime({
                status: "paused",
                pollerStatus: "paused",
                currentRound: snapshot.convergence.currentRound,
                activeSessionId: null,
                activeHref: convergenceSessionHrefRef.current,
                pauseReason: reason,
                errorMessage: null,
                lastPausedAt: new Date().toISOString(),
              });
              return;
            }
            // Launch next round
            void handleRunNextRoundRef.current?.(autoConvergeAdditionalRef.current);
          } else if (stableCountRef.current >= 2 && currentCount === 0) {
            // No new items after stabilization — convergence is done
            stopAutoConvergePoller();
            setAutoConvergeWaitState({ phase: "complete" });
            saveConvergenceRuntime({
              status: "converged",
              pollerStatus: "idle",
              currentRound: snapshot.convergence.currentRound,
              activeSessionId: null,
              activeHref: convergenceSessionHref,
              pauseReason: null,
              errorMessage: null,
              lastStoppedAt: new Date().toISOString(),
            });

            // Auto-merge if enabled
            const settings = pipelineSettingsRef.current;
            if (settings.autoMerge) {
              // Verify all checks are passing
              const hasCheckData = freshChecks.length > 0;
              const allChecksPassed = hasCheckData && freshChecks.every(
                (c: PrCheck) =>
                  c.conclusion === "success" ||
                  c.conclusion === "neutral" ||
                  c.conclusion === "skipped",
              );
              if (!hasCheckData) {
                const reason = "Auto-merge paused because GitHub returned no check data for this PR.";
                setActionError(reason);
                setConvergencePauseReason(reason);
                setAutoConvergeWaitState({ phase: "paused", reason });
                saveConvergenceRuntime({
                  status: "paused",
                  pollerStatus: "paused",
                  activeSessionId: null,
                  activeHref: convergenceSessionHref,
                  pauseReason: reason,
                  errorMessage: null,
                  lastPausedAt: new Date().toISOString(),
                });
              } else if (allChecksPassed) {
                try {
                  // Map pipeline merge method to MergeMethod for the land call
                  const method: MergeMethod =
                    settings.mergeMethod === "repo_default"
                      ? mergeMethodRef.current // fall back to the repo/component-level default
                      : settings.mergeMethod;
                  const res = await window.ade.prs.land({ prId: pr.id, method });
                  if (res.success) {
                    setAutoConvergeWaitState({ phase: "merged" });
                    setConvergenceMerged(true);
                    setAutoConverge(false);
                    saveConvergenceRuntime({
                      status: "merged",
                      pollerStatus: "idle",
                      activeSessionId: null,
                      activeHref: convergenceSessionHref,
                      pauseReason: null,
                      errorMessage: null,
                      lastStoppedAt: new Date().toISOString(),
                    });
                    await onRefreshRef.current();
                  } else {
                    setActionError(res.error ?? "Auto-merge failed");
                    setAutoConverge(false);
                    saveConvergenceRuntime({
                      status: "failed",
                      pollerStatus: "idle",
                      activeSessionId: null,
                      activeHref: convergenceSessionHref,
                      pauseReason: null,
                      errorMessage: res.error ?? "Auto-merge failed",
                      lastStoppedAt: new Date().toISOString(),
                    });
                  }
                } catch (err: unknown) {
                  setActionError(
                    err instanceof Error ? err.message : "Auto-merge failed",
                  );
                  setAutoConverge(false);
                  saveConvergenceRuntime({
                    status: "failed",
                    pollerStatus: "idle",
                    activeSessionId: null,
                    activeHref: convergenceSessionHref,
                    pauseReason: null,
                    errorMessage: err instanceof Error ? err.message : "Auto-merge failed",
                    lastStoppedAt: new Date().toISOString(),
                  });
                }
              } else {
                // Checks not passing — cannot auto-merge
                setActionError("Auto-merge skipped: some checks are not passing");
                setAutoConverge(false);
                saveConvergenceRuntime({
                  status: "failed",
                  pollerStatus: "idle",
                  activeSessionId: null,
                  activeHref: convergenceSessionHref,
                  pauseReason: null,
                  errorMessage: "Auto-merge skipped: some checks are not passing",
                  lastStoppedAt: new Date().toISOString(),
                });
              }
            } else {
              setAutoConverge(false);
            }
          } else {
            scheduleTick(); // Not yet stable, keep polling
          }
        } catch {
          // Poll failed, schedule retry
          scheduleTick();
        }
      }, delayMs); // Poll every delayMs (default 60 s)
    };

    scheduleTick(0);
  }, [convergenceSessionHref, pr.id, saveConvergenceRuntime, stopAutoConvergePoller]);
  startAutoConvergePollerRef.current = startAutoConvergePoller;

  // Listen for agent session completion to start polling
  React.useEffect(() => {
    if (!convergenceSessionId) return;
    const unsubscribe = window.ade.prs.onAiResolutionEvent((event) => {
      if (event.sessionId !== convergenceSessionId) return;
      if (event.status === "completed" || event.status === "failed" || event.status === "cancelled") {
        void handleConvergenceSessionTerminal({
          sessionId: event.sessionId,
          status: event.status,
          message: event.message,
        });
      }
    });
    return unsubscribe;
  }, [convergenceSessionId, handleConvergenceSessionTerminal]);

  React.useEffect(() => {
    stopConvergenceSessionPoller();
    if (!convergenceSessionId) return;

    let cancelled = false;
    const pollSessionState = async () => {
      try {
        const detail = await window.ade.sessions.get(convergenceSessionId);
        if (cancelled || convergenceSessionIdRef.current !== convergenceSessionId) return;
        if (!detail || detail.status === "running") {
          convergenceSessionPollerRef.current = window.setTimeout(() => {
            void pollSessionState();
          }, 2_000);
          return;
        }
        const terminalStatus: "completed" | "failed" | "disposed" =
          detail.status === "completed"
            ? "completed"
            : detail.status === "disposed"
              ? "disposed"
              : "failed";
        void handleConvergenceSessionTerminal({
          sessionId: convergenceSessionId,
          status: terminalStatus,
        });
      } catch {
        if (cancelled || convergenceSessionIdRef.current !== convergenceSessionId) return;
        convergenceSessionPollerRef.current = window.setTimeout(() => {
          void pollSessionState();
        }, 5_000);
      }
    };

    void pollSessionState();
    return () => {
      cancelled = true;
      stopConvergenceSessionPoller();
    };
  }, [convergenceSessionId, handleConvergenceSessionTerminal, stopConvergenceSessionPoller]);

  React.useEffect(() => {
    if (pathToMergeActive) {
      stopAutoConvergePoller();
      return;
    }
    if (!autoConverge || convergenceSessionId) {
      if (!convergenceSessionId) stopAutoConvergePoller();
      return;
    }
    if (autoConvergeWaitState.phase === "waiting_checks" || autoConvergeWaitState.phase === "waiting_comments") {
      if (!autoConvergePollerRef.current) {
        startAutoConvergePoller();
      }
      return;
    }
    if (
      autoConvergeWaitState.phase === "idle"
      || autoConvergeWaitState.phase === "paused"
      || autoConvergeWaitState.phase === "complete"
      || autoConvergeWaitState.phase === "merged"
    ) {
      stopAutoConvergePoller();
    }
  }, [autoConverge, autoConvergeWaitState.phase, convergenceSessionId, pathToMergeActive, startAutoConvergePoller, stopAutoConvergePoller]);

  React.useEffect(() => {
    if (!pathToMergeActive) return;
    let cancelled = false;
    let inFlight = false;
    const pollRuntime = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const runtime = await loadConvergenceState(pr.id, { force: true });
        if (cancelled) return;
        applyConvergenceRuntime(runtime);
      } catch {
        // Keep the last known PtM runtime and retry on the next interval.
      } finally {
        inFlight = false;
      }
    };
    const id = window.setInterval(() => {
      void pollRuntime();
    }, 10_000);
    void pollRuntime();
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [applyConvergenceRuntime, loadConvergenceState, pathToMergeActive, pr.id]);

  // Cleanup poller on unmount
  React.useEffect(() => {
    return () => {
      if (autoConvergeTimerRef.current) clearTimeout(autoConvergeTimerRef.current);
      stopAutoConvergePoller();
      stopConvergenceSessionPoller();
    };
  }, [stopAutoConvergePoller, stopConvergenceSessionPoller]);

  const resolveIssueScope = React.useCallback((): "both" | "checks" | "comments" => {
    return defaultPrIssueResolutionScope(issueResolutionAvailability) ?? "comments";
  }, [issueResolutionAvailability]);

  const handleRunNextRound = React.useCallback(async (additionalInstructions: string) => {
    const launchingAutoConverge = autoConverge;
    setConvergenceBusy(true);
    setActionError(null);
    autoConvergeAdditionalRef.current = additionalInstructions;
    try {
      const snapshot = await syncInventory();
      if (!snapshot) throw new Error("Failed to sync inventory");
      const hasNew = snapshot.items.some((item) => item.state === "new");
      if (!hasNew) {
        if (launchingAutoConverge) {
          setAutoConvergeWaitState({ phase: "complete" });
          saveConvergenceRuntime({
            autoConvergeEnabled: true,
            status: "converged",
            pollerStatus: "idle",
            currentRound: snapshot.convergence.currentRound,
            activeSessionId: null,
            activeHref: convergenceSessionHrefRef.current,
            pauseReason: null,
            errorMessage: null,
            lastStoppedAt: new Date().toISOString(),
          });
        }
        setConvergenceBusy(false);
        return;
      }

      const result = await window.ade.prs.issueResolutionStart({
        prId: pr.id,
        scope: resolveIssueScope(),
        modelId: resolverModel,
        reasoning: resolverReasoningLevel || null,
        permissionMode: resolverPermissionMode,
        additionalInstructions,
      });

      const currentRound = snapshot.convergence.currentRound + 1;
      setConvergenceSessionId(result.sessionId);
      setConvergenceSessionHref(result.href);
      setAutoConvergeWaitState({ phase: "agent_running", sessionId: result.sessionId });
      setConvergencePauseReason(null);
      setConvergenceMerged(false);
      saveConvergenceRuntime({
        autoConvergeEnabled: launchingAutoConverge,
        status: "running",
        pollerStatus: "idle",
        currentRound,
        activeSessionId: result.sessionId,
        activeLaneId: pr.laneId,
        activeHref: result.href,
        pauseReason: null,
        errorMessage: null,
        lastStartedAt: new Date().toISOString(),
      });
      void syncInventory();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to launch agent";
      setActionError(message);
      setConvergenceBusy(false);
      if (launchingAutoConverge) {
        setConvergencePauseReason(message);
        setAutoConvergeWaitState({ phase: "paused", reason: message });
        saveConvergenceRuntime({
          autoConvergeEnabled: true,
          status: "paused",
          pollerStatus: "paused",
          activeSessionId: null,
          activeHref: convergenceSessionHrefRef.current,
          pauseReason: message,
          errorMessage: message,
          lastPausedAt: new Date().toISOString(),
        });
      }
    }
  }, [autoConverge, pr.id, pr.laneId, resolverModel, resolverPermissionMode, resolverReasoningLevel, resolveIssueScope, saveConvergenceRuntime, syncInventory]);

  // Keep ref in sync for the auto-converge poller
  handleRunNextRoundRef.current = handleRunNextRound;

  const handleConvergenceCopyPrompt = React.useCallback(async (additionalInstructions: string) => {
    try {
      const preview = await window.ade.prs.issueResolutionPreviewPrompt({
        prId: pr.id,
        scope: resolveIssueScope(),
        modelId: resolverModel,
        reasoning: resolverReasoningLevel || null,
        permissionMode: resolverPermissionMode,
        additionalInstructions,
      });
      if (window.ade?.app?.writeClipboardText) {
        await window.ade.app.writeClipboardText(preview.prompt);
      }
    } catch {
      // silently fail
    }
  }, [pr.id, resolverModel, resolverPermissionMode, resolverReasoningLevel, resolveIssueScope]);

  const handleAutoConvergeToggle = React.useCallback(async (enabled: boolean) => {
    if (!enabled) {
      const previousSessionHref = convergenceSessionHrefRef.current;
      pathToMergeActionSeqRef.current += 1;
      // Tear down the orchestrator's per-PR scheduling so a re-enable starts
      // fresh instead of resuming with stale args.
      try {
        const stopped = await window.ade.prs.pathToMergeStop({ prId: pr.id, reason: "user disabled auto-converge" });
        applyConvergenceRuntime(stopped.runtime);
      } catch (err: unknown) {
        setActionError(`Failed to stop Path to Merge: ${err instanceof Error ? err.message : String(err)}`);
        const runtime = await loadConvergenceState(pr.id, { force: true }).catch(() => null);
        applyConvergenceRuntime(runtime);
        return;
      }
      setAutoConverge(false);
      autoConvergeRef.current = false;
      setPathToMergeActive(false);
      pathToMergeActiveRef.current = false;
      stopAutoConvergePoller();
      const activeSessionId = convergenceSessionIdRef.current;
      if (activeSessionId) {
        // Try to stop the running session. Only clear the session handle on
        // confirmed success so the user retains the ability to retry if the
        // stop call fails.
        try {
          await window.ade.prs.aiResolutionStop({ sessionId: activeSessionId });
          // Stop succeeded -- clear session handle and mark stopped.
          setConvergenceBusy(false);
          setConvergenceSessionId(null);
          setConvergenceSessionHref(null);
          setAutoConvergeWaitState({ phase: "idle" });
          setConvergencePauseReason(null);
          saveConvergenceRuntime({
            autoConvergeEnabled: false,
            status: "stopped",
            pollerStatus: "stopped",
            activeSessionId: null,
            activeHref: null,
            pauseReason: null,
            errorMessage: null,
            lastStoppedAt: new Date().toISOString(),
          });
        } catch (err: unknown) {
          // Stop failed -- keep the session handle so the user can retry.
          setActionError(
            `Failed to stop session: ${err instanceof Error ? err.message : String(err)}`,
          );
          saveConvergenceRuntime({
            autoConvergeEnabled: false,
            status: "running",
            pollerStatus: "idle",
            activeSessionId,
            activeHref: previousSessionHref,
            pauseReason: null,
            errorMessage: err instanceof Error ? err.message : String(err),
          });
          setConvergenceSessionHref(previousSessionHref);
        }
      } else {
        setAutoConvergeWaitState({ phase: "idle" });
        setConvergenceSessionHref(null);
        setConvergencePauseReason(null);
        saveConvergenceRuntime({
          autoConvergeEnabled: false,
          status: "stopped",
          pollerStatus: "stopped",
          activeSessionId: null,
          activeHref: null,
          pauseReason: null,
          errorMessage: null,
          lastStoppedAt: new Date().toISOString(),
        });
      }
      if (autoConvergeTimerRef.current) {
        clearTimeout(autoConvergeTimerRef.current);
        autoConvergeTimerRef.current = null;
      }
    } else {
      // Register the active model + reasoning with the orchestrator so it has
      // dispatch args when it wakes. Without this, the loop pauses with
      // "No modelId available to dispatch fix agent."
      try {
        const startRequestId = ++pathToMergeActionSeqRef.current;
        const result = await window.ade.prs.pathToMergeStart({
          prId: pr.id,
          scope: resolveIssueScope(),
          modelId: resolverModel,
          reasoning: resolverReasoningLevel || null,
          permissionMode: resolverPermissionMode,
        });
        if (startRequestId !== pathToMergeActionSeqRef.current) {
          await window.ade.prs.pathToMergeStop({
            prId: pr.id,
            reason: "start superseded by a newer Path to Merge action",
          }).catch(() => undefined);
          return;
        }
        applyConvergenceRuntime(result.runtime);
        if (!result.scheduled) {
          const message = result.blockedBy?.message ?? "Auto-converge is blocked by another lane task.";
          setAutoConverge(false);
          setAutoConvergeWaitState({ phase: "paused", reason: message });
          setConvergencePauseReason(message);
          setActionError(message);
          return;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        setAutoConverge(false);
        setAutoConvergeWaitState({ phase: "idle" });
        try {
          const stopped = await window.ade.prs.pathToMergeStop({
            prId: pr.id,
            reason: `start failed: ${message}`,
          });
          applyConvergenceRuntime(stopped.runtime);
        } catch {
          saveConvergenceRuntime({
            autoConvergeEnabled: false,
            status: "stopped",
            pollerStatus: "stopped",
            activeSessionId: null,
            activeLaneId: null,
            activeHref: null,
            pauseReason: null,
            errorMessage: null,
            waitForCiStartedAt: null,
            lastStoppedAt: new Date().toISOString(),
          });
        }
        setActionError(
          `Failed to start auto-converge: ${message}`,
        );
      }
    }
  }, [applyConvergenceRuntime, loadConvergenceState, pr.id, resolverModel, resolverPermissionMode, resolverReasoningLevel, resolveIssueScope, saveConvergenceRuntime, stopAutoConvergePoller]);

  const handleMarkDismissed = React.useCallback(async (itemIds: string[], reason: string) => {
    try {
      await window.ade.prs.issueInventoryMarkDismissed(pr.id, itemIds, reason);
      void syncInventory();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }, [pr.id, syncInventory]);

  const handleMarkEscalated = React.useCallback(async (itemIds: string[]) => {
    try {
      await window.ade.prs.issueInventoryMarkEscalated(pr.id, itemIds);
      void syncInventory();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }, [pr.id, syncInventory]);

  const handleResetInventory = React.useCallback(async () => {
    try {
      await window.ade.prs.issueInventoryReset(pr.id);
      await resetConvergenceState(pr.id);
      setInventorySnapshot(null);
      setConvergenceBusy(false);
      setAutoConverge(false);
      setConvergenceSessionId(null);
      setConvergenceSessionHref(null);
      setConvergenceMerged(false);
      setConvergencePauseReason(null);
      setAutoConvergeWaitState({ phase: "idle" });
      await refreshDetailSurface({ includeInventory: true });
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      if (autoConvergeTimerRef.current) {
        clearTimeout(autoConvergeTimerRef.current);
        autoConvergeTimerRef.current = null;
      }
      stopAutoConvergePoller();
    }
  }, [pr.id, refreshDetailSurface, resetConvergenceState, stopAutoConvergePoller]);

  const localBehindCount = laneForPr?.status?.behind ?? 0;

  const TAB_ACTIVE_COLORS: Record<DetailTab, string> = {
    overview: COLORS.accent,
    convergence: COLORS.accent,
    files: COLORS.info,
    checks: COLORS.success,
  };

  const isTerminalPr = pr.state === "merged" || pr.state === "closed";
  const newIssueCount = isTerminalPr ? 0 : (inventorySnapshot?.items.filter(i => i.state === "new").length ?? 0);

  // Merge convergence checks with action runs so the Path to Merge panel
  // shows the same unified view as the CI / Checks tab.  Raw check-runs
  // from getChecks() can be empty when all CI data comes through the
  // Actions workflow-runs API.
  const unifiedConvergenceChecks: PrCheck[] = React.useMemo(
    () => unifiedChecksToPrChecks(convergenceChecks, actionRuns),
    [convergenceChecks, actionRuns],
  );

  const DETAIL_TABS: Array<{ id: DetailTab; label: string; icon: React.ElementType; count?: number }> = [
    { id: "overview", label: "Overview", icon: Eye },
    { id: "convergence", label: "Path to Merge", icon: Sparkle, count: newIssueCount > 0 ? newIssueCount : undefined },
    { id: "files", label: "Files", icon: Code, count: files.length },
    { id: "checks", label: "CI / Checks", icon: Play, count: buildUnifiedChecks(checks, actionRuns).length },
  ];

  const overviewRailsActive = activeTab === "overview";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, minWidth: 0, overflow: "hidden", background: COLORS.pageBg }}>
      {/* ===== HEADER ===== */}
      <div style={{ padding: "18px 20px 0", borderBottom: `1px solid ${COLORS.border}`, flexShrink: 0, background: `linear-gradient(180deg, rgba(167,139,250,0.04) 0%, transparent 100%)` }}>
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
                <button
                  type="button"
                  onClick={() => { setTitleDraft(pr.title); setEditingTitle(true); }}
                  style={{ background: "none", border: "none", cursor: "pointer", padding: 2, color: COLORS.textMuted, flexShrink: 0, opacity: 0.6 }}
                  title="Edit title"
                >
                  <PencilSimple size={14} />
                </button>
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
            </div>
          </div>
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
            <button type="button" onClick={() => void window.ade.prs.openInGitHub(pr.id)} style={outlineButton({ height: 30, padding: "0 10px" })}>
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
          display: "flex", alignItems: "center", gap: 8,
        }}>
          {actionResult.success ? <CheckCircle size={14} weight="fill" /> : <XCircle size={14} weight="fill" />}
          {actionResult.success ? `Merged PR #${actionResult.prNumber}` : `Failed: ${actionResult.error ?? "unknown"}`}
        </div>
      )}

      {/* ===== TAB CONTENT ===== */}
      <div style={{ flex: 1, minHeight: 0, overflow: overviewRailsActive ? "hidden" : "auto" }}>
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
            onSelectCheck={handleSelectCheckFromRail}
            onOpenChecksTab={handleOpenChecksTab}
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
            onRequestReviewers={handleRequestReviewers}
            onSetLabels={handleSetLabels}
            onDeleteBranch={handleDeleteBranch}
            deleteBranchBusy={actionBusy}
            lane={laneForPr}
            onOpenManageLane={handleOpenManageLane}
            onClose={handleClosePr}
            onReopen={handleReopenPr}
            onSubmitReview={handleSubmitReview}
          />
        )}
        <PrManageLaneDialogHost
          open={manageLaneOpen}
          onOpenChange={setManageLaneOpen}
          lane={laneForPr}
        />
        {activeTab === "convergence" && (
          // tour anchor — closest viable: PrConvergencePanel surfaces the rebase/conflict simulation UI.
          <div data-tour="prs.conflictSim" style={{ display: "contents" }}>
          <PrConvergencePanel
            prNumber={pr.githubPrNumber}
            prTitle={pr.title}
            headBranch={pr.headBranch}
            baseBranch={pr.baseBranch}
            items={mapInventoryItems(inventorySnapshot)}
            convergence={mapConvergenceStatus(inventorySnapshot)}
            checks={unifiedConvergenceChecks}
            modelId={resolverModel}
            reasoningEffort={resolverReasoningLevel}
            permissionMode={resolverPermissionMode}
            busy={convergenceBusy}
            autoConverge={autoConverge}
            pathToMergeActive={pathToMergeActive}
            pipelineSettings={pipelineSettings}
            waitState={autoConvergeWaitState}
            terminalState={pr.state === "merged" || pr.state === "closed" ? pr.state : null}
            onPipelineSettingsChange={(partial) => {
              const prev = pipelineSettings;
              const next = { ...pipelineSettings, ...partial };
              setPipelineSettings(next);
              pipelineSettingsRef.current = next;
              window.ade.prs.pipelineSettingsSave(pr.id, partial).catch((err: unknown) => {
                setPipelineSettings(prev);
                pipelineSettingsRef.current = prev;
                setActionError(err instanceof Error ? err.message : String(err));
              });
            }}
            onModelChange={setResolverModel}
            onReasoningEffortChange={setResolverReasoningLevel}
            onPermissionModeChange={setResolverPermissionMode}
            onRunNextRound={handleRunNextRound}
            onAutoConvergeChange={handleAutoConvergeToggle}
            onCopyPrompt={handleConvergenceCopyPrompt}
            onMarkDismissed={handleMarkDismissed}
            onMarkEscalated={handleMarkEscalated}
            onResetInventory={handleResetInventory}
            onOpenSource={handleOpenInventorySource}
            onViewAgentSession={(sessionId) => {
              const href = convergenceSessionHref
                ?? (sessionId.startsWith("http://") || sessionId.startsWith("https://") || sessionId.startsWith("/")
                  ? sessionId
                  : (pr.laneId ? buildSessionHref(pr.laneId, sessionId) : null));
              if (href && onNavigate) {
                onNavigate(href);
              }
            }}
            onStopAutoConverge={() => handleAutoConvergeToggle(false)}
            onResumePause={() => {
              setConvergencePauseReason(null);
              setAutoConvergeWaitState({ phase: "idle" });
              behindCountRef.current = 0;
              saveConvergenceRuntime({
                status: "polling",
                pollerStatus: "scheduled",
                pauseReason: null,
              });
              startAutoConvergePoller();
            }}
            onDismissPause={() => {
              setConvergencePauseReason(null);
              setAutoConvergeWaitState({ phase: "idle" });
              behindCountRef.current = 0;
              setAutoConverge(false);
              saveConvergenceRuntime({
                autoConvergeEnabled: false,
                status: "stopped",
                pollerStatus: "stopped",
                pauseReason: null,
                errorMessage: null,
              });
            }}
            onDismissMerged={() => {
              setConvergenceMerged(false);
              setAutoConvergeWaitState({ phase: "idle" });
              saveConvergenceRuntime({
                status: "idle",
                pollerStatus: "idle",
                pauseReason: null,
                errorMessage: null,
              });
            }}
          />
          </div>
        )}
        {activeTab === "files" && (
          <FilesTab files={files} expandedFile={expandedFile} setExpandedFile={setExpandedFile} />
        )}
        {activeTab === "checks" && (
          <div data-tour="prs.checksPanel" style={{ display: "contents" }}>
          <ChecksTab
            checks={checks} actionRuns={actionRuns}
            actionBusy={actionBusy}
            onRerunChecks={handleRerunChecks}
            showIssueResolverAction={issueResolutionAvailability.hasAnyActionableIssues}
            onOpenIssueResolver={handleOpenIssueResolver}
            focusedCheckId={focusedCheckId}
            onFocusedCheckConsumed={() => setFocusedCheckId(null)}
          />
          </div>
        )}
      </div>

      <PrIssueResolverModal
        open={showIssueResolverModal}
        prNumber={pr.githubPrNumber}
        prTitle={pr.title}
        availability={issueResolutionAvailability}
        checks={checks}
        reviewThreads={reviewThreads}
        modelId={resolverModel}
        reasoningEffort={resolverReasoningLevel}
        permissionMode={resolverPermissionMode}
        busy={issueResolverBusy}
        copyBusy={issueResolverCopyBusy}
        copyNotice={issueResolverCopyNotice}
        error={issueResolverError}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setIssueResolverError(null);
            setIssueResolverCopyNotice(null);
          }
          setShowIssueResolverModal(nextOpen);
        }}
        onModelChange={setResolverModel}
        onReasoningEffortChange={setResolverReasoningLevel}
        onPermissionModeChange={setResolverPermissionMode}
        onLaunch={handleLaunchIssueResolver}
        onCopyPrompt={handleCopyIssueResolverPrompt}
      />
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

// ================================================================
// CHECKS TAB
// ================================================================

function ChecksTab({
  checks,
  actionRuns,
  actionBusy,
  onRerunChecks,
  showIssueResolverAction,
  onOpenIssueResolver,
  focusedCheckId,
  onFocusedCheckConsumed,
}: {
  checks: PrCheck[];
  actionRuns: PrActionRun[];
  actionBusy: boolean;
  onRerunChecks: () => void;
  showIssueResolverAction: boolean;
  onOpenIssueResolver: () => void;
  focusedCheckId?: string | null;
  onFocusedCheckConsumed?: () => void;
}) {
  const [expandedItems, setExpandedItems] = React.useState<Set<string>>(new Set());
  const [highlightedCheckId, setHighlightedCheckId] = React.useState<string | null>(null);
  const checkCardRefs = React.useRef<Map<string, HTMLDivElement>>(new Map());

  const unifiedChecks = React.useMemo(() => buildUnifiedChecks(checks, actionRuns), [checks, actionRuns]);

  React.useEffect(() => {
    if (!focusedCheckId) return;
    const target = unifiedChecks.find((item) => item.id === focusedCheckId);
    if (!target) {
      onFocusedCheckConsumed?.();
      return;
    }

    setExpandedItems((prev) => {
      const next = new Set(prev);
      next.add(focusedCheckId);
      return next;
    });
    setHighlightedCheckId(focusedCheckId);

    const frame = window.requestAnimationFrame(() => {
      checkCardRefs.current.get(focusedCheckId)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      onFocusedCheckConsumed?.();
    });

    const highlightTimer = window.setTimeout(() => {
      setHighlightedCheckId((current) => (current === focusedCheckId ? null : current));
    }, 2400);

    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(highlightTimer);
    };
  }, [focusedCheckId, onFocusedCheckConsumed, unifiedChecks]);

  const passing = unifiedChecks.filter(c => c.conclusion === "success").length;
  const failing = unifiedChecks.filter(c => c.conclusion === "failure").length;
  const pending = unifiedChecks.filter(c => c.status !== "completed" && !c.conclusion).length;
  const skipped = unifiedChecks.filter(c => c.conclusion === "neutral" || c.conclusion === "skipped" || c.conclusion === "cancelled").length;
  const total = unifiedChecks.length;

  const toggleExpand = (id: string) => {
    setExpandedItems(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const summaryText = total === 0
    ? "No checks"
    : failing > 0
      ? `${failing} failing, ${passing} passing${pending > 0 ? `, ${pending} pending` : ""}${skipped > 0 ? `, ${skipped} skipped` : ""}`
      : pending > 0
        ? `${passing} passing, ${pending} pending${skipped > 0 ? `, ${skipped} skipped` : ""}`
        : skipped > 0 && passing === 0
          ? `All ${total} checks skipped`
          : skipped > 0
            ? `${passing} passing, ${skipped} skipped`
            : `All ${total} checks passing`;

  return (
    <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Summary bar */}
      <div style={cardStyle({ padding: 0, overflow: "hidden" })}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px" }}>
          <span style={{ fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>
            {summaryText}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {showIssueResolverAction && (
              <button type="button" onClick={onOpenIssueResolver} style={outlineButton({ height: 30, padding: "0 10px", color: COLORS.accent, borderColor: "color-mix(in srgb, var(--color-accent) 40%, transparent)" })}>
                <Sparkle size={14} weight="fill" /> Resolve issues with agent
              </button>
            )}
            <button type="button" disabled={actionBusy} onClick={onRerunChecks} style={outlineButton({ height: 30, color: COLORS.warning, borderColor: "color-mix(in srgb, var(--color-warning) 40%, transparent)" })}>
              <ArrowsClockwise size={14} /> Re-run Failed
            </button>
          </div>
        </div>
        {total > 0 && (
          <div style={{ display: "flex", height: 4 }}>
            {passing > 0 && <div style={{ flex: passing, background: "#22C55E", transition: "flex 300ms ease" }} />}
            {failing > 0 && <div style={{ flex: failing, background: "#EF4444", transition: "flex 300ms ease" }} />}
            {pending > 0 && <div style={{ flex: pending, background: "#F59E0B", transition: "flex 300ms ease" }} />}
            {skipped > 0 && <div style={{ flex: skipped, background: "#6B7280", transition: "flex 300ms ease" }} />}
          </div>
        )}
      </div>

      {/* Unified check list */}
      {total === 0 ? (
        <div style={cardStyle()}>
          <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textDim }}>No checks found</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {unifiedChecks.map((item) => {
            const isExpanded = expandedItems.has(item.id);
            const hasSteps = item.source === "actions_job" && item.steps && item.steps.length > 0;
            const stateColor = item.conclusion === "success" ? COLORS.success
              : item.conclusion === "failure" ? COLORS.danger
              : item.status === "in_progress" ? COLORS.warning
              : item.status === "queued" ? COLORS.textMuted
              : COLORS.textMuted;

            const conclusionLabel = item.conclusion === "failure" ? "FAILED"
              : item.conclusion === "success" ? "PASSED"
              : item.conclusion === "neutral" ? "NEUTRAL"
              : item.conclusion === "skipped" ? "SKIPPED"
              : item.conclusion === "cancelled" ? "CANCELLED"
              : item.status === "in_progress" ? "RUNNING"
              : item.status === "queued" ? "QUEUED"
              : "PENDING";

            const isHighlighted = highlightedCheckId === item.id;
            return (
              <div
                key={item.id}
                ref={(node) => {
                  if (node) checkCardRefs.current.set(item.id, node);
                  else checkCardRefs.current.delete(item.id);
                }}
                data-testid="pr-checks-tab-item"
                data-check-id={item.id}
                style={cardStyle({
                  padding: 0,
                  overflow: "hidden",
                  borderColor: isHighlighted ? COLORS.accent : undefined,
                  boxShadow: isHighlighted ? `0 0 0 1px color-mix(in srgb, ${COLORS.accent} 45%, transparent)` : undefined,
                })}
              >
                <div
                  role={hasSteps ? "button" : undefined}
                  tabIndex={hasSteps ? 0 : undefined}
                  onClick={hasSteps ? () => toggleExpand(item.id) : undefined}
                  onKeyDown={hasSteps ? (e) => { if (e.key === "Enter") toggleExpand(item.id); } : undefined}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "10px 16px",
                    background: item.conclusion === "failure"
                      ? "color-mix(in srgb, var(--color-error) 6%, transparent)"
                      : isHighlighted
                        ? `color-mix(in srgb, ${COLORS.accent} 8%, transparent)`
                        : "transparent",
                    cursor: hasSteps ? "pointer" : "default",
                    transition: "background 100ms ease",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1 }}>
                    {hasSteps && (
                      isExpanded
                        ? <CaretDown size={11} style={{ color: stateColor, flexShrink: 0 }} />
                        : <CaretRight size={11} style={{ color: COLORS.textMuted, flexShrink: 0 }} />
                    )}
                    {item.conclusion === "success" ? <CheckCircle size={15} weight="fill" style={{ color: COLORS.success, flexShrink: 0 }} /> :
                     item.conclusion === "failure" ? <XCircle size={15} weight="fill" style={{ color: COLORS.danger, flexShrink: 0 }} /> :
                     item.status === "in_progress" ? <CircleNotch size={15} className="animate-spin" style={{ color: COLORS.warning, flexShrink: 0 }} /> :
                     <Circle size={15} style={{ color: COLORS.textMuted, flexShrink: 0 }} />}
                    <span style={{ fontFamily: SANS_FONT, fontSize: 12, fontWeight: 500, color: COLORS.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {item.displayName}
                    </span>
                    {item.source === "check" && (
                      <span style={{ fontFamily: MONO_FONT, fontSize: 9, color: COLORS.textDim, flexShrink: 0, padding: "1px 5px", border: `1px solid ${COLORS.border}` }}>
                        3RD PARTY
                      </span>
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                    {item.duration != null && (
                      <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textMuted }}>
                        {formatCheckDuration(item.duration)}
                      </span>
                    )}
                    <span style={{
                      fontFamily: MONO_FONT, fontSize: 9, fontWeight: 600, textTransform: "uppercase",
                      color: stateColor, padding: "2px 8px",
                      background: `${stateColor}14`, border: `1px solid ${stateColor}30`,
                    }}>
                      {conclusionLabel}
                    </span>
                    {item.detailsUrl && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); void window.ade.app.openExternal(item.detailsUrl!); }}
                        style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10, gap: 4 })}
                      >
                        <GithubLogo size={11} /> View
                      </button>
                    )}
                  </div>
                </div>

                {/* Expanded steps for GitHub Actions jobs */}
                {isExpanded && hasSteps && (
                  <div style={{ borderTop: `1px solid ${COLORS.border}`, background: "rgba(0,0,0,0.08)", padding: "8px 16px 8px 52px" }}>
                    {item.steps!.map((step) => {
                      return (
                        <div key={step.number} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
                          {step.conclusion === "success" ? <CheckCircle size={12} weight="fill" style={{ color: COLORS.success }} /> :
                           step.conclusion === "failure" ? <XCircle size={12} weight="fill" style={{ color: COLORS.danger }} /> :
                           step.conclusion === "skipped" ? <Circle size={12} style={{ color: COLORS.textDim }} /> :
                           <CircleNotch size={12} className="animate-spin" style={{ color: COLORS.warning }} />}
                          <span style={{
                            fontFamily: SANS_FONT, fontSize: 11,
                            color: step.conclusion === "failure" ? COLORS.danger
                              : step.conclusion === "success" ? COLORS.textSecondary
                              : COLORS.textMuted,
                          }}>{step.name}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

