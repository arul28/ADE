import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { X } from "@phosphor-icons/react";
import {
  selectActiveProjectRoot,
  selectActiveProjectStateKey,
  useAppStore,
  useAppStoreApi,
  type LaneInspectorTab,
} from "../../state/appStore";
import { isTypingTarget } from "../../lib/typingTarget";
import { COLORS, LABEL_STYLE, outlineButton, primaryButton } from "./laneDesignTokens";
import { useLaneAgents, type LaneAgent } from "./laneAgents";
import { useStartChatInLane } from "../../hooks/useStartChatInLane";
import {
  consumeLaunchedLanesHighlight,
  subscribeLaunchedLanesHighlight,
  consumeCreatingIssues,
  subscribeCreatingIssues,
  clearCreatingIssue,
  type CreatingIssuePlaceholder,
} from "../../lib/launchedLanesHighlight";
import { LaneGitActionsPane } from "./LaneGitActionsPane";
import { CreateLaneDialogHost, type CreateLanePrefill } from "./CreateLaneDialogHost";
import { ManageLaneDialog, EMPTY_LANE_DELETE_SELECTION, type LaneDeleteSelection, type ManageLaneTab } from "./ManageLaneDialog";
import { LaneDashboard } from "./overview/LaneDashboard";
import { useDialogBus } from "../../lib/useDialogBus";
import {
  buildLaneActionClearedSearch,
  laneHasAncestor,
  lanePrTagRoutePath,
  planLaneDeleteBatches,
  resolveLaneIdsDeepLinkSelection,
  resolveLaneSelectionAfterDelete,
  runLaneDeleteBatchWithConcurrency,
  selectLanePrs,
  selectLaneTabPrTags,
  selectVisibleLanePrRefreshIds,
  shouldApplyLaneIdsDeepLink,
  VISIBLE_LANE_PR_REFRESH_LIMIT,
  type LaneTabPrTag,
} from "./lanePageModel";
import {
  EMPTY_LANE_PANE_DETAIL,
  laneMatchesFilter,
  mergeUnique,
  type LanePaneDetailSelection,
} from "./laneUtils";
import { ProjectSidebarSlot, useHasProjectSidebar } from "../app/projectSidebar/ProjectSidebarSlot";
import { LaneSidebarList, LANES_FILTER_INPUT_ID } from "./sidebar/LaneSidebarList";
import { LaneSidebarContextMenu } from "./sidebar/LaneSidebarContextMenu";
import { LaneSidebarBulkRebaseDialog, type LaneBulkRebaseTarget } from "./sidebar/LaneSidebarBulkRebaseDialog";
import {
  buildLaneSidebarLayout,
  buildLaneSidebarRows,
  classifyLaneState,
  laneNeedsYouReason,
  laneSidebarRange,
  laneSidebarVisibleLaneIds,
  laneStateGroupSectionId,
  stepLaneSidebarSelection,
  type LaneGroupBulkAction,
  type LaneSidebarGroupBy,
  type LaneStateGroupId,
} from "./sidebar/laneSidebarModel";
import { LaneSplitBody } from "./detail/LaneSplitBody";
import { buildPrsRouteSearch } from "../prs/prsRouteState";
import { getProjectConfigCached } from "../../lib/projectConfigCache";
import {
  DEFAULT_REBASE_SUGGESTIONS,
  type RebaseSuggestionDisplay,
} from "../../../shared/types/config";
import { getGitHubSnapshotCoalesced, listPrsCoalesced, refreshPrsCoalesced } from "../../lib/prReadCache";
import { logRendererDebugEvent } from "../../lib/debugLog";
import { shouldRefreshSessionListForChatEvent } from "../../lib/chatSessionEvents";
import { useLaneListInvalidation } from "../../hooks/useLaneListInvalidation";
import {
  createPendingLaneDeleteProgress,
  isLaneDeleteProgressActive,
} from "../../lib/laneDeleteProgress";
import type {
  DeleteLaneArgs,
  GitCommitSummary,
  GitHubPrListItem,
  LaneListSnapshot,
  LaneSummary,
  PrSummary,
  RebaseRun,
  RebaseScope,
  LaneDeleteProgress,
} from "../../../shared/types";
import { machineIdForBinding } from "../../../shared/machineIdentity";
import { eventMatchesBinding, getEffectiveBinding } from "../../lib/keybindings";
import { settingsRouteFor } from "../settings/settingsManifest";

type RebaseScopePromptState = {
  laneId: string;
  laneName: string;
  resolve: (scope: RebaseScope | null) => void;
};

type RebasePushReviewState = {
  runId: string;
  lanes: Array<{ laneId: string; laneName: string; selected: boolean }>;
  resolve: (laneIds: string[] | null) => void;
};

export function shouldRetryLaneGithubSnapshotForceRefresh({
  currentProjectRoot,
  markedProjectRoot,
  refreshSucceeded,
  startedProjectRoot,
}: {
  currentProjectRoot: string | null;
  markedProjectRoot: string | null;
  refreshSucceeded: boolean;
  startedProjectRoot: string;
}): boolean {
  return !refreshSucceeded
    && currentProjectRoot === startedProjectRoot
    && markedProjectRoot === startedProjectRoot;
}

const LANE_DELETE_REFRESH_DEBOUNCE_MS = 160;
const LANE_VISIBLE_PR_REFRESH_DEBOUNCE_MS = 260;
const LANE_RUNTIME_LIFECYCLE_REFRESH_DEBOUNCE_MS = 300;
const LANE_RUNTIME_DATA_REFRESH_DEBOUNCE_MS = 5_000;
const EMPTY_LANE_IDS: string[] = [];
const EMPTY_LANE_ID_SET: ReadonlySet<string> = new Set();
const EMPTY_GROUP_IDS: string[] = [];

function mergePrSummariesById(current: PrSummary[], refreshed: PrSummary[]): PrSummary[] {
  if (refreshed.length === 0) return current;
  const refreshedById = new Map(refreshed.map((pr) => [pr.id, pr] as const));
  const seen = new Set<string>();
  const next = current.map((pr) => {
    seen.add(pr.id);
    return refreshedById.get(pr.id) ?? pr;
  });
  for (const pr of refreshed) {
    if (!seen.has(pr.id)) next.push(pr);
  }
  return next;
}

function isTrustedGitHubUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && url.hostname === "github.com";
  } catch {
    return false;
  }
}

function isLaneDeleteProgressHydratable(progress: LaneDeleteProgress | null | undefined): boolean {
  return progress?.overallStatus === "running"
    || progress?.overallStatus === "completed"
    || progress?.overallStatus === "completed_with_warnings";
}

const LANE_DELETE_STEP_LABELS: Record<string, string> = {
  git_status: "dirty-state check",
  cancel_auto_rebase: "auto-rebase cancellation",
  stop_chats: "chat shutdown",
  stop_ptys: "terminal shutdown",
  stop_watchers: "file watcher shutdown",
  cleanup_env: "environment cleanup",
  git_worktree_remove: "worktree removal",
  git_branch_delete: "local branch delete",
  git_remote_branch_delete: "remote branch delete",
  pack_dir_remove: "pack folder cleanup",
  database_cleanup: "database cleanup",
};

function formatLaneDeleteProgressError(progress: LaneDeleteProgress, laneName: string): string {
  const failedStep = progress.steps.find((step) => step.status === "failed");
  const warningSteps = progress.steps.filter((step) => step.status === "warning");
  if (failedStep) {
    const label = LANE_DELETE_STEP_LABELS[failedStep.name] ?? failedStep.name;
    const detail = failedStep.errorMessage ? `: ${failedStep.errorMessage}` : "";
    return `${laneName} delete failed during ${label}${detail}`;
  }
  if (warningSteps.length > 0) {
    const first = warningSteps[0]!;
    const label = LANE_DELETE_STEP_LABELS[first.name] ?? first.name;
    const detail = first.errorMessage ? `: ${first.errorMessage}` : "";
    const extra = warningSteps.length > 1 ? ` (+${warningSteps.length - 1} more)` : "";
    return `${laneName} was deleted, but ${label} needs attention${detail}${extra}`;
  }
  return `${laneName} delete failed.`;
}

function formatLaneDeleteWarningMessages(messagesByLaneId: Map<string, string>): string | null {
  const messages = [...messagesByLaneId.values()];
  return messages.length > 0 ? messages.join("\n") : null;
}

/* ---- Component ---- */

export function LanesPage({ active = true }: { active?: boolean } = {}) {
  const appStore = useAppStoreApi();
  const location = useLocation();
  const navigate = useNavigate();
  const hasProjectSidebar = useHasProjectSidebar();
  const selectLane = useAppStore((s) => s.selectLane);
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);
  const focusSession = useAppStore((s) => s.focusSession);
  const lanes = useAppStore((s) => s.lanes);
  const lanesLoading = useAppStore((s) => s.lanesLoading);

  const urlLaneDeeplinks = useMemo(() => {
    const p = new URLSearchParams(location.search);
    return {
      action: p.get("action"),
      laneIdsRaw: p.get("laneIds"),
      laneId: p.get("laneId"),
      sessionId: p.get("sessionId"),
      inspectorTab: p.get("inspectorTab"),
      commitSha: p.get("commitSha"),
    };
  }, [location.search]);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const setLaneInspectorTab = useAppStore((s) => s.setLaneInspectorTab);
  const clearLaneInspectorTab = useAppStore((s) => s.clearLaneInspectorTab);
  const setWorkViewState = useAppStore((s) => s.setWorkViewState);
  const keybindings = useAppStore((s) => s.keybindings);
  const activeProjectRoot = useAppStore(selectActiveProjectRoot);
  const activeProjectStateKey = useAppStore(selectActiveProjectStateKey);
  const projectBinding = useAppStore((s) => s.projectBinding);
  const getActiveProjectRoot = useCallback(() => {
    return selectActiveProjectRoot(appStore.getState());
  }, [appStore]);
  const [pulsingLaneId, setPulsingLaneId] = useState<string | null>(null);
  // Lanes freshly launched from the Linear batch flow that have not yet shown a
  // live agent session. Their rows show a spinner until a session appears (or
  // a safety TTL below runs out).
  const [creatingLaneIds, setCreatingLaneIds] = useState<Set<string>>(new Set());
  // Optimistic rows keyed by Linear ISSUE id, recorded by the batch launcher
  // BEFORE the real lanes exist. Each drops once the real lane carrying that
  // issue id appears.
  const [creatingIssues, setCreatingIssues] = useState<CreatingIssuePlaceholder[]>(() => consumeCreatingIssues());
  // The filter is persisted per project: the Lanes route unmounts whenever it
  // isn't the active tab, so component state would be thrown away.
  const laneFilter = useAppStore(
    (s) => (activeProjectStateKey
      ? s.workViewByProject[activeProjectStateKey]?.lanesFilter
      : undefined) ?? "",
  );
  const setLaneFilter = useCallback(
    (next: string) => {
      if (!activeProjectStateKey) return;
      setWorkViewState(activeProjectStateKey, { lanesFilter: next });
    },
    [activeProjectStateKey, setWorkViewState],
  );
  // Sidebar grouping and collapsed State groups, persisted per project like
  // the filter.
  const laneGroupBy = useAppStore(
    (s): LaneSidebarGroupBy => (activeProjectStateKey
      ? s.workViewByProject[activeProjectStateKey]?.lanesGroupBy
      : undefined) ?? "state",
  );
  const laneCollapsedGroupIds = useAppStore(
    (s) => (activeProjectStateKey
      ? s.workViewByProject[activeProjectStateKey]?.lanesCollapsedGroupIds
      : undefined) ?? EMPTY_GROUP_IDS,
  );
  const laneCollapsedGroupSet = useMemo(() => new Set(laneCollapsedGroupIds), [laneCollapsedGroupIds]);
  const setLaneGroupBy = useCallback(
    (next: LaneSidebarGroupBy) => {
      if (!activeProjectStateKey) return;
      setWorkViewState(activeProjectStateKey, { lanesGroupBy: next });
    },
    [activeProjectStateKey, setWorkViewState],
  );
  const toggleLaneGroupCollapsed = useCallback(
    (sectionId: string) => {
      if (!activeProjectStateKey) return;
      const current = appStore.getState().workViewByProject[activeProjectStateKey]?.lanesCollapsedGroupIds ?? [];
      const next = current.includes(sectionId) ? current.filter((id) => id !== sectionId) : [...current, sectionId];
      setWorkViewState(activeProjectStateKey, { lanesCollapsedGroupIds: next });
    },
    [activeProjectStateKey, appStore, setWorkViewState],
  );
  // Rows picked with Cmd/Ctrl/Shift-click, for "Manage N lanes" in the menu.
  const [multiSelectedLaneIds, setMultiSelectedLaneIds] = useState<ReadonlySet<string>>(EMPTY_LANE_ID_SET);
  const selectionAnchorRef = useRef<string | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  // Tab the manage dialog opens on; set by the sidebar's group bulk actions.
  const [manageInitialTab, setManageInitialTab] = useState<ManageLaneTab | null>(null);
  // Lanes the Behind group's "Rebase all" confirm step lists.
  const [bulkRebaseLaneIds, setBulkRebaseLaneIds] = useState<string[] | null>(null);
  // Create-lane dialog is hosted by CreateLaneDialogHost, which owns the form,
  // submit and env-setup state. The page tracks only whether it is open, the
  // prefill, and (via a ref) whether a create is in flight so a forced close
  // from the dialog bus can be blocked.
  const [createOpen, setCreateOpen] = useState(false);
  const [createPrefill, setCreatePrefill] = useState<CreateLanePrefill | null>(null);
  const createBusyRef = useRef(false);
  const canCreateLane = Boolean(activeProjectRoot);
  const [deleteSelection, setDeleteSelection] = useState<LaneDeleteSelection>(EMPTY_LANE_DELETE_SELECTION);
  const [deleteForce, setDeleteForce] = useState(true);
  const [laneActionBusy, setLaneActionBusy] = useState(false);
  const [laneActionStatus, setLaneActionStatus] = useState<string | null>(null);
  const [laneActionError, setLaneActionError] = useState<string | null>(null);
  const [laneActionKind, setLaneActionKind] = useState<"delete" | "archive" | null>(null);
  const deleteProgressByLaneId = useAppStore((s) => s.laneDeleteProgressByLaneId);
  const setDeleteProgressByLaneId = useAppStore((s) => s.setLaneDeleteProgressByLaneId);
  const laneDeleteWarningMessagesRef = useRef<Map<string, string>>(new Map());
  const [managedLaneIds, setManagedLaneIds] = useState<string[]>([]);
  const lanePrTagsRequestRef = useRef(0);
  const laneGithubPrTagsRequestRef = useRef(0);
  const laneVisiblePrRefreshRequestedAtRef = useRef<Map<string, number>>(new Map());
  const laneVisiblePrRefreshProjectRootRef = useRef<string | null>(null);
  const laneGithubSnapshotForceRefreshProjectRootRef = useRef<string | null>(null);
  const [laneVisiblePrRefreshVisibilityToken, setLaneVisiblePrRefreshVisibilityToken] = useState(0);
  const hasActiveLaneRuntimeRef = useRef(false);
  const [autoRebaseEnabled, setAutoRebaseEnabled] = useState(false);
  const [rebaseSuggestionDisplay, setRebaseSuggestionDisplay] =
    useState<RebaseSuggestionDisplay>(DEFAULT_REBASE_SUGGESTIONS);
  const [rebaseSuggestionError, setRebaseSuggestionError] = useState<string | null>(null);
  const [rebaseScopePrompt, setRebaseScopePrompt] = useState<RebaseScopePromptState | null>(null);
  const [rebasePushReview, setRebasePushReview] = useState<RebasePushReviewState | null>(null);

  const completedLaneDeleteRefreshesRef = useRef<Set<string>>(new Set());
  const pendingLaneDeleteRefreshIdsRef = useRef<Set<string>>(new Set());
  const laneDeleteRefreshTimerRef = useRef<number | null>(null);
  const hydratedLaneDeleteProgressProjectRef = useRef<string | null>(null);
  const deleteProgressProjectRootRef = useRef<string | null>(activeProjectRoot);
  const activeLanePresenceSignatureRef = useRef<string | null>(null);
  // Refs for the onDeleteEvent IPC handler. Capturing high-churn values in
  // refs lets the subscription keep a minimal dep array so it doesn't tear
  // down and re-subscribe to the IPC bridge on every render.
  const selectedLaneIdRef = useRef<string | null>(null);
  const lanesByIdRef = useRef<Map<string, LaneSummary> | null>(null);
  const managedLaneIdsRef = useRef<string[]>([]);
  const manageOpenRef = useRef<boolean>(false);

  const [lanePaneDetails, setLanePaneDetails] = useState<Record<string, LanePaneDetailSelection>>({});
  const [laneContextMenu, setLaneContextMenu] = useState<{ laneId: string; x: number; y: number } | null>(null);
  const [lanePrTags, setLanePrTags] = useState<PrSummary[]>([]);
  const [laneGithubPrTags, setLaneGithubPrTags] = useState<GitHubPrListItem[]>([]);
  const laneSnapshots = useAppStore((s) => s.laneSnapshots);
  const laneListFreshnessKey = useMemo(() => ({ lanes, laneSnapshots }), [lanes, laneSnapshots]);
  useLaneListInvalidation({ active: active && Boolean(activeProjectRoot), refreshLanes, freshnessKey: laneListFreshnessKey });
  const consumedLaneIdsDeepLinkSignatureRef = useRef<string | null>(null);
  const consumedCommitDeepLinkSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    logRendererDebugEvent("renderer.lanes.page_mount", {
      projectRoot: activeProjectRoot,
    });
    return () => {
      logRendererDebugEvent("renderer.lanes.page_unmount", {
        projectRoot: activeProjectRoot,
      });
    };
  }, [activeProjectRoot]);

  useEffect(() => {
    if (!active) return;
    const projectRoot = activeProjectRoot;
    const previousProjectRoot = deleteProgressProjectRootRef.current;
    deleteProgressProjectRootRef.current = projectRoot;
    hydratedLaneDeleteProgressProjectRef.current = null;
    completedLaneDeleteRefreshesRef.current.clear();
    pendingLaneDeleteRefreshIdsRef.current.clear();
    if (laneDeleteRefreshTimerRef.current != null) {
      window.clearTimeout(laneDeleteRefreshTimerRef.current);
      laneDeleteRefreshTimerRef.current = null;
    }
    if (previousProjectRoot !== projectRoot) {
      setDeleteProgressByLaneId({});
    }
  }, [activeProjectRoot, setDeleteProgressByLaneId]);

  const laneSnapshotByLaneId = useMemo(
    () => new Map(laneSnapshots.map((snapshot) => [snapshot.lane.id, snapshot] as const)),
    [laneSnapshots],
  );
  const dedupedLanes = useMemo(() => {
    // The lanes store can momentarily hold a duplicate lane id (an optimistic
    // create racing the refreshed list), which would produce duplicate React
    // keys. Dedupe by id first.
    const seen = new Set<string>();
    return lanes.filter((lane) => {
      if (seen.has(lane.id)) return false;
      seen.add(lane.id);
      return true;
    });
  }, [lanes]);
  const sortedLanesRef = useRef(dedupedLanes);
  useEffect(() => {
    sortedLanesRef.current = dedupedLanes;
  }, [dedupedLanes]);
  const lanePrBranchSignature = useMemo(
    () => dedupedLanes
      .map((lane) => `${lane.id}:${lane.laneType}:${lane.branchRef ?? ""}:${lane.baseRef ?? ""}`)
      .sort()
      .join("\0"),
    [dedupedLanes],
  );
  const lanesById = useMemo(() => new Map(dedupedLanes.map((lane) => [lane.id, lane])), [dedupedLanes]);
  const deletingLaneIds = useMemo(() => {
    const ids = new Set<string>();
    for (const progress of Object.values(deleteProgressByLaneId)) {
      if (isLaneDeleteProgressActive(progress)) ids.add(progress.laneId);
    }
    return ids;
  }, [deleteProgressByLaneId]);

  const allRows = useMemo(() => buildLaneSidebarRows(dedupedLanes), [dedupedLanes]);
  const sortedSelectableLaneIds = useMemo(
    () => allRows.map((row) => row.lane.id).filter((laneId) => !deletingLaneIds.has(laneId)),
    [allRows, deletingLaneIds],
  );
  // Content-stable key: changes only when the id set changes.
  const availableLaneIdsKey = useMemo(
    () => sortedSelectableLaneIds.slice().sort().join("\0"),
    [sortedSelectableLaneIds],
  );
  const availableLaneIds = useMemo(
    () => (availableLaneIdsKey ? availableLaneIdsKey.split("\0") : []),
    [availableLaneIdsKey],
  );
  const lanePrTagsByLaneId = useMemo(() => {
    const map = new Map<string, LaneTabPrTag[]>();
    for (const lane of dedupedLanes) {
      const tags = selectLaneTabPrTags(lane, lanePrTags, laneGithubPrTags);
      if (tags.length > 0) map.set(lane.id, tags);
    }
    return map;
  }, [dedupedLanes, lanePrTags, laneGithubPrTags]);

  const laneRuntimeById = useMemo(() => {
    const summaryByLane = new Map<string, LaneListSnapshot["runtime"]>();
    for (const snapshot of laneSnapshots) {
      summaryByLane.set(snapshot.lane.id, snapshot.runtime);
    }
    return summaryByLane;
  }, [laneSnapshots]);

  const filteredLanes = useMemo(() => {
    if (!laneFilter.trim()) return dedupedLanes;
    return dedupedLanes.filter((lane) => laneMatchesFilter(lane, laneFilter));
  }, [dedupedLanes, laneFilter]);
  const filteredLaneIds = useMemo(() => filteredLanes.map((lane) => lane.id), [filteredLanes]);
  // Rows are on screen, so their agents are too. The page unmounts off-tab,
  // and `active` gates the roster while it is hidden.
  const agentsByLaneId = useLaneAgents(active ? filteredLaneIds : EMPTY_LANE_IDS);

  // State group per lane, from data the list already holds (git status,
  // snapshots, PR tags, agents). Pure and cheap; no extra requests.
  const { laneStateById, needsYouReasonByLaneId } = useMemo(() => {
    const nowMs = Date.now();
    const states = new Map<string, LaneStateGroupId | "primary">();
    const reasons = new Map<string, string>();
    for (const lane of filteredLanes) {
      const snapshot = laneSnapshotByLaneId.get(lane.id);
      const input = {
        lane,
        agents: agentsByLaneId.get(lane.id) ?? [],
        runtime: laneRuntimeById.get(lane.id) ?? null,
        prs: lanePrTagsByLaneId.get(lane.id),
        rebaseSuggestion: snapshot?.rebaseSuggestion ?? null,
        autoRebaseStatus: snapshot?.autoRebaseStatus ?? null,
        nowMs,
      };
      states.set(lane.id, classifyLaneState(input));
      const reason = laneNeedsYouReason(input);
      if (reason) reasons.set(lane.id, reason);
    }
    return { laneStateById: states, needsYouReasonByLaneId: reasons };
  }, [agentsByLaneId, filteredLanes, laneRuntimeById, lanePrTagsByLaneId, laneSnapshotByLaneId]);

  const sidebarLayout = useMemo(
    () => buildLaneSidebarLayout({ lanes: filteredLanes, groupBy: laneGroupBy, stateByLaneId: laneStateById, lanesById }),
    [filteredLanes, laneGroupBy, laneStateById, lanesById],
  );
  // On-screen order (collapsed groups skipped): what J/K, Shift-click and the
  // default selection walk.
  const selectableFilteredLaneIds = useMemo(
    () => laneSidebarVisibleLaneIds(sidebarLayout, laneCollapsedGroupSet).filter((laneId) => !deletingLaneIds.has(laneId)),
    [sidebarLayout, laneCollapsedGroupSet, deletingLaneIds],
  );

  // The lane in the main area: the store selection when it is usable,
  // otherwise the first lane in the list.
  const detailLaneId = useMemo(() => {
    if (selectedLaneId && lanesById.has(selectedLaneId) && !deletingLaneIds.has(selectedLaneId)) return selectedLaneId;
    return selectableFilteredLaneIds[0] ?? sortedSelectableLaneIds[0] ?? null;
  }, [selectedLaneId, lanesById, deletingLaneIds, selectableFilteredLaneIds, sortedSelectableLaneIds]);
  const detailLane = detailLaneId ? lanesById.get(detailLaneId) ?? null : null;
  const detailLaneIds = useMemo(() => (detailLaneId ? [detailLaneId] : EMPTY_LANE_IDS), [detailLaneId]);

  // When the selection moves to a lane inside a collapsed State group (a deep
  // link, a click in the overview's stack), open that group so the row shows.
  // Only on a selection change, so collapsing the selected lane's group sticks.
  const revealedLaneIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!detailLaneId || revealedLaneIdRef.current === detailLaneId) return;
    revealedLaneIdRef.current = detailLaneId;
    if (sidebarLayout.groupBy !== "state") return;
    const group = sidebarLayout.groups.find((candidate) => candidate.rows.some((row) => row.lane.id === detailLaneId));
    if (!group) return;
    const sectionId = laneStateGroupSectionId(group.id);
    if (laneCollapsedGroupSet.has(sectionId)) toggleLaneGroupCollapsed(sectionId);
  }, [detailLaneId, laneCollapsedGroupSet, sidebarLayout, toggleLaneGroupCollapsed]);
  const colorIndexByLaneId = useMemo(
    () => new Map(allRows.map((row, index) => [row.lane.id, index] as const)),
    [allRows],
  );
  const detailColorIndex = detailLaneId ? colorIndexByLaneId.get(detailLaneId) ?? 0 : 0;

  useEffect(() => {
    const syncApi = window.ade.sync;
    if (!syncApi?.setActiveLanePresence) {
      return;
    }
    const laneIds = active && activeProjectRoot ? [...detailLaneIds] : [];
    const signature = laneIds.join("\0");
    if (activeLanePresenceSignatureRef.current === signature) {
      return;
    }
    activeLanePresenceSignatureRef.current = signature;
    void syncApi.setActiveLanePresence({ laneIds }).catch(() => {});
  }, [active, activeProjectRoot, detailLaneIds]);

  useEffect(() => {
    const syncApi = window.ade.sync;
    if (!syncApi?.setActiveLanePresence) {
      return;
    }
    return () => {
      if (activeLanePresenceSignatureRef.current === "") {
        return;
      }
      activeLanePresenceSignatureRef.current = "";
      void syncApi.setActiveLanePresence({ laneIds: [] }).catch(() => {});
    };
  }, []);

  const managedLane = selectedLaneId ? lanesById.get(selectedLaneId) ?? null : null;
  const managedLanes = useMemo(
    () => managedLaneIds.map((id) => lanesById.get(id)).filter((l): l is LaneSummary => l != null && l.laneType !== "primary"),
    [managedLaneIds, lanesById],
  );
  const refreshAutoRebaseEnabled = useCallback(async () => {
    try {
      const snapshot = await getProjectConfigCached({ projectRoot: activeProjectRoot });
      const git = snapshot.effective.git;
      const enabled = typeof git?.autoRebaseOnHeadChange === "boolean" ? git.autoRebaseOnHeadChange : false;
      setAutoRebaseEnabled(enabled);
      // Read the rebase-suggestion setting from the same snapshot rather than
      // opening a second config read on the Lanes load path.
      setRebaseSuggestionDisplay(
        git?.rebaseSuggestions === "off" || git?.rebaseSuggestions === "badge" || git?.rebaseSuggestions === "banner"
          ? git.rebaseSuggestions
          : DEFAULT_REBASE_SUGGESTIONS,
      );
    } catch {
      setAutoRebaseEnabled(false);
    }
  }, [activeProjectRoot]);

  const refreshLanePrTags = useCallback(async (options?: { refreshMapped?: boolean }) => {
    const requestId = ++lanePrTagsRequestRef.current;
    const startedRoot = getActiveProjectRoot();
    const stillCurrent = () =>
      requestId === lanePrTagsRequestRef.current
      && getActiveProjectRoot() === startedRoot;
    try {
      const prs = await listPrsCoalesced({ projectRoot: startedRoot });
      if (!stillCurrent()) return;
      setLanePrTags(prs);
      if (options?.refreshMapped !== true) return;

      // Refresh only rows that can render in a lane's PR chip. PR history
      // stays in the PR workspace and should not cause background refreshes.
      const matchedPrIds = [...new Set(sortedLanesRef.current.flatMap((lane) => (
        selectLanePrs(lane, prs)
          .slice(0, VISIBLE_LANE_PR_REFRESH_LIMIT)
          .map((pr) => pr.id)
      )))];
      if (matchedPrIds.length === 0) return;

      try {
        const refreshed = await refreshPrsCoalesced({ prIds: matchedPrIds }, { projectRoot: startedRoot });
        if (!stillCurrent()) return;
        const refreshedById = new Map(refreshed.map((pr) => [pr.id, pr] as const));
        setLanePrTags(prs.map((pr) => refreshedById.get(pr.id) ?? pr));
      } catch {
        // Keep the immediate local rows visible; the GitHub snapshot below
        // still has a chance to provide terminal state for branch-matched PRs.
      }
    } catch {
      if (!stillCurrent()) return;
      setLanePrTags([]);
    }
  }, [getActiveProjectRoot]);

  const refreshLaneGithubPrTags = useCallback(async (
    options?: { force?: boolean; automaticRefresh?: boolean },
  ): Promise<boolean> => {
    const requestId = ++laneGithubPrTagsRequestRef.current;
    const startedRoot = getActiveProjectRoot();
    try {
      const snapshot = await getGitHubSnapshotCoalesced(
        {
          force: options?.force === true,
          ...(options?.automaticRefresh === true ? { automaticRefresh: true } : {}),
        },
        { projectRoot: startedRoot },
      );
      if (requestId !== laneGithubPrTagsRequestRef.current) return false;
      if (getActiveProjectRoot() !== startedRoot) return false;
      setLaneGithubPrTags(snapshot.repoPullRequests);
      return true;
    } catch {
      if (requestId !== laneGithubPrTagsRequestRef.current) return false;
      if (getActiveProjectRoot() !== startedRoot) return false;
      // Keep the last usable GitHub snapshot visible on transient refresh failures.
      return false;
    }
  }, [getActiveProjectRoot]);

  const scheduleLaneDeleteRefresh = useCallback(() => {
    if (laneDeleteRefreshTimerRef.current != null) return;
    laneDeleteRefreshTimerRef.current = window.setTimeout(() => {
      laneDeleteRefreshTimerRef.current = null;
      const laneIds = Array.from(pendingLaneDeleteRefreshIdsRef.current);
      pendingLaneDeleteRefreshIdsRef.current.clear();
      if (laneIds.length === 0) return;

      void refreshLanes({ includeStatus: false })
        .then(() => {
          const selectedId = selectedLaneIdRef.current;
          const managedIds = managedLaneIdsRef.current;
          if (manageOpenRef.current && laneIds.some((laneId) => selectedId === laneId || managedIds.includes(laneId))) {
            setManageOpen(false);
          }
        })
        .catch((err) => {
          setLaneActionError(`Lane was deleted, but refresh failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    }, LANE_DELETE_REFRESH_DEBOUNCE_MS);
  }, [refreshLanes]);

  const queueLaneDeleteRefresh = useCallback((laneIds: string[]) => {
    for (const laneId of laneIds) {
      if (laneId) pendingLaneDeleteRefreshIdsRef.current.add(laneId);
    }
    if (pendingLaneDeleteRefreshIdsRef.current.size > 0) {
      scheduleLaneDeleteRefresh();
    }
  }, [scheduleLaneDeleteRefresh]);

  /* ---- Effects ---- */

  useEffect(() => { selectedLaneIdRef.current = selectedLaneId; }, [selectedLaneId]);
  useEffect(() => { lanesByIdRef.current = lanesById; }, [lanesById]);
  useEffect(() => { managedLaneIdsRef.current = managedLaneIds; }, [managedLaneIds]);
  useEffect(() => { manageOpenRef.current = manageOpen; }, [manageOpen]);

  useEffect(() => {
    if (!active) return;
    const unsubscribe = window.ade.lanes.onDeleteEvent((event) => {
      const { laneId, overallStatus } = event.progress;
      setDeleteProgressByLaneId((prev) => {
        if (isLaneDeleteProgressActive(event.progress)) {
          return { ...prev, [laneId]: event.progress };
        }
        if (!prev[laneId]) return prev;
        const next = { ...prev };
        delete next[laneId];
        return next;
      });
      if (overallStatus === "failed" || overallStatus === "cancelled") {
        laneDeleteWarningMessagesRef.current.delete(laneId);
        completedLaneDeleteRefreshesRef.current.delete(laneId);
        const laneName = lanesByIdRef.current?.get(laneId)?.name ?? laneId;
        setLaneActionError(
          overallStatus === "cancelled"
            ? `${laneName} delete was cancelled.`
            : formatLaneDeleteProgressError(event.progress, laneName),
        );
        return;
      }
      if (overallStatus !== "completed" && overallStatus !== "completed_with_warnings") return;
      if (completedLaneDeleteRefreshesRef.current.has(laneId)) return;
      completedLaneDeleteRefreshesRef.current.add(laneId);

      if (selectedLaneIdRef.current === laneId) selectLane(null);
      setManagedLaneIds((prev) => prev.filter((id) => id !== laneId));
      clearLaneInspectorTab(laneId);
      if (overallStatus === "completed_with_warnings") {
        const laneName = lanesByIdRef.current?.get(laneId)?.name ?? laneId;
        laneDeleteWarningMessagesRef.current.set(laneId, formatLaneDeleteProgressError(event.progress, laneName));
        setLaneActionError(formatLaneDeleteWarningMessages(laneDeleteWarningMessagesRef.current));
      } else {
        laneDeleteWarningMessagesRef.current.delete(laneId);
        const remainingWarnings = formatLaneDeleteWarningMessages(laneDeleteWarningMessagesRef.current);
        // Rebuild from the tracked warnings only: every delete warning we show
        // is mirrored into laneDeleteWarningMessagesRef, so this clears a stale
        // one without nulling an unrelated standing error.
        setLaneActionError((current) => remainingWarnings ?? current);
      }
      queueLaneDeleteRefresh([laneId]);
    });
    return unsubscribe;
  }, [active, clearLaneInspectorTab, queueLaneDeleteRefresh, selectLane, setDeleteProgressByLaneId]);

  useEffect(() => {
    if (!active) return;
    const unsubscribe = window.ade.lanes.onRebaseSuggestionsEvent((event) => {
      if (event.type !== "rebase-suggestions-updated") return;
      void refreshLanes().catch(() => {});
    });
    return unsubscribe;
  }, [active, refreshLanes]);

  useEffect(() => {
    if (!active) return;
    const unsubscribe = window.ade.lanes.onAutoRebaseEvent((event) => {
      if (event.type !== "auto-rebase-updated") return;
      void refreshLanes().catch(() => {});
    });
    return unsubscribe;
  }, [active, refreshLanes]);

  useEffect(() => {
    if (!active) return;
    const unsubscribe = window.ade.lanes.rebaseSubscribe((event) => {
      if (event.type !== "rebase-run-updated") return;
      if (event.run.state !== "failed" || !event.run.failedLaneId) return;
      const failedLane = lanesById.get(event.run.failedLaneId)?.name ?? event.run.failedLaneId;
      setRebaseSuggestionError(`Rebase needs attention for ${failedLane}. ${event.run.error ?? ""}`.trim());
    });
    return unsubscribe;
  }, [active, lanesById]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => {
      void refreshAutoRebaseEnabled();
    }, 120);
    return () => window.clearTimeout(timer);
  }, [active, refreshAutoRebaseEnabled]);

  useEffect(() => {
    lanePrTagsRequestRef.current += 1;
    laneGithubPrTagsRequestRef.current += 1;
    laneGithubSnapshotForceRefreshProjectRootRef.current = null;
    setLanePrTags([]);
    setLaneGithubPrTags([]);
    if (!active || !activeProjectRoot) {
      return;
    }
    // Keep the lane surface local-first. The selected lane's stale rows are
    // refreshed by the debounced pass below; a forced snapshot here made
    // opening the next PR surface compete with GitHub work.
    void refreshLanePrTags();
    void refreshLaneGithubPrTags();
    return () => {
      lanePrTagsRequestRef.current += 1;
      laneGithubPrTagsRequestRef.current += 1;
    };
  }, [active, refreshLanePrTags, refreshLaneGithubPrTags, activeProjectRoot, lanePrBranchSignature]);

  useEffect(() => {
    if (!active || !activeProjectRoot || document.visibilityState !== "visible") return;
    if (laneGithubSnapshotForceRefreshProjectRootRef.current === activeProjectRoot) return;
    const hasGithubOnlyPr = detailLaneIds.some((laneId) =>
      lanePrTagsByLaneId.get(laneId)?.some((tag) => tag.source === "github" && !tag.linkedPrId) ?? false,
    );
    if (!hasGithubOnlyPr) return;

    const startedRoot = activeProjectRoot;
    const timer = window.setTimeout(() => {
      if (getActiveProjectRoot() !== startedRoot) return;
      laneGithubSnapshotForceRefreshProjectRootRef.current = startedRoot;
      void refreshLaneGithubPrTags({ force: true, automaticRefresh: true }).then((refreshSucceeded) => {
        if (shouldRetryLaneGithubSnapshotForceRefresh({
          currentProjectRoot: getActiveProjectRoot(),
          markedProjectRoot: laneGithubSnapshotForceRefreshProjectRootRef.current,
          refreshSucceeded,
          startedProjectRoot: startedRoot,
        })) {
          laneGithubSnapshotForceRefreshProjectRootRef.current = null;
        }
      });
    }, 750);
    return () => window.clearTimeout(timer);
  }, [
    active,
    activeProjectRoot,
    getActiveProjectRoot,
    lanePrTagsByLaneId,
    laneVisiblePrRefreshVisibilityToken,
    refreshLaneGithubPrTags,
    detailLaneIds,
  ]);

  useEffect(() => {
    if (!active) return;
    return window.ade.prs.onEvent((event) => {
      if (event.type === "prs-updated") {
        lanePrTagsRequestRef.current += 1;
        setLanePrTags(event.prs);
        // This event already carries ADE rows; use the cached repo snapshot unless a PR notification asks for a forced refresh.
        void refreshLaneGithubPrTags();
      } else if (event.type === "pr-notification") {
        void refreshLanePrTags({ refreshMapped: true });
        void refreshLaneGithubPrTags({ force: true, automaticRefresh: true });
      }
    });
  }, [active, refreshLanePrTags, refreshLaneGithubPrTags]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        setLaneVisiblePrRefreshVisibilityToken((value) => value + 1);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  // Opportunistically refresh the selected lane's stale linked PRs. Rows in the
  // list only need PR state, which the list read already carries.
  useEffect(() => {
    const projectRoot = activeProjectRoot;
    if (laneVisiblePrRefreshProjectRootRef.current !== projectRoot) {
      laneVisiblePrRefreshProjectRootRef.current = projectRoot;
      laneVisiblePrRefreshRequestedAtRef.current.clear();
    }
    if (!active || !projectRoot || document.visibilityState !== "visible") return;

    const nowMs = Date.now();
    const prIds = selectVisibleLanePrRefreshIds({
      visibleLaneIds: detailLaneIds,
      lanePrByLaneId: lanePrTagsByLaneId,
      prs: lanePrTags,
      recentlyRequestedAtByPrId: laneVisiblePrRefreshRequestedAtRef.current,
      nowMs,
    });
    if (prIds.length === 0) return;

    for (const prId of prIds) {
      laneVisiblePrRefreshRequestedAtRef.current.set(prId, nowMs);
    }

    const startedRoot = projectRoot;
    const timer = window.setTimeout(() => {
      void window.ade.prs.refresh({ prIds })
        .then((refreshed) => {
          if (getActiveProjectRoot() !== startedRoot) return;
          if (refreshed.length === 0) return;
          setLanePrTags((current) => mergePrSummariesById(current, refreshed));
        })
        .catch(() => {
          // Background PR refresh is opportunistic; the normal PR poller remains the fallback.
        });
    }, LANE_VISIBLE_PR_REFRESH_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [
    active,
    getActiveProjectRoot,
    activeProjectRoot,
    detailLaneIds,
    lanePrTagsByLaneId,
    lanePrTags,
    laneVisiblePrRefreshVisibilityToken,
  ]);

  // Runtime buckets drive each row's status dot. Refresh them without Git
  // status when sessions start, stop or produce output.
  useEffect(() => {
    if (!active) return;
    let lifecycleTimer: ReturnType<typeof setTimeout> | null = null;
    let dataTimer: ReturnType<typeof setTimeout> | null = null;
    const refreshRuntimeOnly = () =>
      refreshLanes({
        includeStatus: false,
        includeSnapshots: true,
        includeConflictStatus: false,
        includeRebaseSuggestions: false,
        includeAutoRebaseStatus: false,
      });
    const scheduleRefresh = (kind: "lifecycle" | "data") => {
      if (document.visibilityState !== "visible") return;
      const delayMs =
        kind === "data"
          ? LANE_RUNTIME_DATA_REFRESH_DEBOUNCE_MS
          : LANE_RUNTIME_LIFECYCLE_REFRESH_DEBOUNCE_MS;
      const getTimer = () => (kind === "data" ? dataTimer : lifecycleTimer);
      const setTimer = (timer: ReturnType<typeof setTimeout> | null) => {
        if (kind === "data") dataTimer = timer;
        else lifecycleTimer = timer;
      };
      if (getTimer()) return; // already scheduled
      setTimer(setTimeout(() => {
        setTimer(null);
        void refreshRuntimeOnly().catch(() => {});
      }, delayMs));
    };
    const currentProjectRoot = activeProjectRoot;
    const isCurrentProjectEvent = (event: { projectRoot?: string | null }) =>
      !event.projectRoot || event.projectRoot === currentProjectRoot;
    const unsubPtyData = window.ade.pty.onData((event) => {
      if (isCurrentProjectEvent(event)) scheduleRefresh("data");
    });
    const unsubPtyExit = window.ade.pty.onExit((event) => {
      if (isCurrentProjectEvent(event)) scheduleRefresh("lifecycle");
    });
    const unsubChat = window.ade.agentChat.onEvent((event) => {
      if (shouldRefreshSessionListForChatEvent(event)) scheduleRefresh("lifecycle");
    });
    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (!hasActiveLaneRuntimeRef.current) return;
      void refreshRuntimeOnly().catch(() => {});
    }, 15_000);
    return () => {
      if (lifecycleTimer) clearTimeout(lifecycleTimer);
      if (dataTimer) clearTimeout(dataTimer);
      for (const unsubscribe of [unsubPtyData, unsubPtyExit, unsubChat]) {
        try {
          unsubscribe();
        } catch {
          // ignore
        }
      }
      window.clearInterval(intervalId);
    };
  }, [active, activeProjectRoot, refreshLanes]);

  useEffect(() => {
    hasActiveLaneRuntimeRef.current = laneSnapshots.some((snapshot) =>
      snapshot.runtime.bucket === "running" || snapshot.runtime.bucket === "awaiting-input",
    );
  }, [laneSnapshots]);

  useEffect(() => {
    if (!active) return;
    const onFocus = () => { void refreshAutoRebaseEnabled(); };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refreshAutoRebaseEnabled();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [active, refreshAutoRebaseEnabled]);

  useEffect(() => {
    const pendingLaneDeleteRefreshIds = pendingLaneDeleteRefreshIdsRef.current;
    return () => {
      if (laneDeleteRefreshTimerRef.current != null) {
        window.clearTimeout(laneDeleteRefreshTimerRef.current);
        laneDeleteRefreshTimerRef.current = null;
      }
      pendingLaneDeleteRefreshIds.clear();
    };
  }, []);

  const startChatInLane = useStartChatInLane({
    projectStateKey: activeProjectStateKey,
    setWorkViewState,
    selectLane,
    navigate,
    boundMachineId: machineIdForBinding(projectBinding),
  });

  useEffect(() => {
    setDeleteProgressByLaneId((prev) => {
      const next: Record<string, LaneDeleteProgress> = {};
      for (const [laneId, progress] of Object.entries(prev)) {
        // Once the deleted lane has left the list its progress entry no longer
        // renders, so drop it — including completed_with_warnings, whose text
        // is surfaced through laneActionError.
        if (isLaneDeleteProgressActive(progress) && lanesById.has(laneId)) {
          next[laneId] = progress;
        }
      }
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [lanesById, setDeleteProgressByLaneId]);

  useEffect(() => {
    setLanePaneDetails((prev) => {
      const next: Record<string, LanePaneDetailSelection> = {};
      for (const [laneId, detail] of Object.entries(prev)) {
        if (lanesById.has(laneId)) next[laneId] = detail;
      }
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [lanesById]);

  // Drop multi-selected lanes that left the list or started deleting.
  useEffect(() => {
    setMultiSelectedLaneIds((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set([...prev].filter((laneId) => lanesById.has(laneId) && !deletingLaneIds.has(laneId)));
      return next.size === prev.size ? prev : next;
    });
  }, [lanesById, deletingLaneIds]);

  /* ---- Selection ---- */

  const selectDetailLane = useCallback((laneId: string) => {
    if (deletingLaneIds.has(laneId) || !lanesById.has(laneId)) return;
    selectionAnchorRef.current = laneId;
    selectLane(laneId);
  }, [deletingLaneIds, lanesById, selectLane]);

  const stepLaneSelection = useCallback((direction: -1 | 1) => {
    const nextId = stepLaneSidebarSelection(selectableFilteredLaneIds, detailLaneId, direction);
    if (!nextId) return;
    setMultiSelectedLaneIds(EMPTY_LANE_ID_SET);
    selectDetailLane(nextId);
  }, [detailLaneId, selectDetailLane, selectableFilteredLaneIds]);

  // Plain click selects. Cmd/Ctrl-click toggles a row in the multi-selection;
  // Shift-click selects the range from the last clicked row.
  const handleRowSelect = useCallback((laneId: string, event: React.MouseEvent) => {
    if (deletingLaneIds.has(laneId) || !lanesById.has(laneId)) return;
    if (event.metaKey || event.ctrlKey) {
      setMultiSelectedLaneIds((prev) => {
        const next = new Set(prev.size === 0 && detailLaneId ? [detailLaneId] : prev);
        if (next.has(laneId)) next.delete(laneId);
        else next.add(laneId);
        return next;
      });
      selectionAnchorRef.current = laneId;
      return;
    }
    if (event.shiftKey) {
      const range = laneSidebarRange(selectableFilteredLaneIds, selectionAnchorRef.current ?? detailLaneId, laneId);
      setMultiSelectedLaneIds(new Set(range));
      return;
    }
    setMultiSelectedLaneIds(EMPTY_LANE_ID_SET);
    selectDetailLane(laneId);
  }, [deletingLaneIds, detailLaneId, lanesById, selectDetailLane, selectableFilteredLaneIds]);

  const handleRowContextMenu = useCallback((laneId: string, event: React.MouseEvent) => {
    setLaneContextMenu({ laneId, x: event.clientX, y: event.clientY });
  }, []);

  // The overview's "…" button opens the same menu, just under the button.
  const openLaneMenuAt = useCallback((laneId: string, anchor: DOMRect) => {
    setLaneContextMenu({ laneId, x: anchor.left, y: anchor.bottom + 4 });
  }, []);

  const handleOpenPr = useCallback((pr: LaneTabPrTag) => {
    const prRoute = lanePrTagRoutePath(pr);
    if (prRoute) {
      navigate(prRoute);
      return;
    }
    if (pr.githubUrl && isTrustedGitHubUrl(pr.githubUrl)) {
      void window.ade?.app?.openExternal?.(pr.githubUrl);
    }
  }, [navigate]);

  // Agents live in the Work tab; an avatar click opens the session there.
  const handleOpenAgent = useCallback((agent: LaneAgent) => {
    if (deletingLaneIds.has(agent.laneId) || !lanesById.has(agent.laneId)) return;
    window.dispatchEvent(
      new CustomEvent("ade:work:select-session", {
        detail: { sessionId: agent.sessionId, laneId: agent.laneId },
      }),
    );
    navigate(`/work?sessionId=${encodeURIComponent(agent.sessionId)}&laneId=${encodeURIComponent(agent.laneId)}`);
  }, [deletingLaneIds, lanesById, navigate]);

  /* ---- Keyboard ---- */

  const kbFilterFocus = useMemo(() => getEffectiveBinding(keybindings, "lanes.filter.focus", "/,Mod+F"), [keybindings]);
  const kbNext = useMemo(() => getEffectiveBinding(keybindings, "lanes.select.next", "J,ArrowDown"), [keybindings]);
  const kbPrev = useMemo(() => getEffectiveBinding(keybindings, "lanes.select.prev", "K,ArrowUp"), [keybindings]);
  const kbNextTab = useMemo(() => getEffectiveBinding(keybindings, "lanes.select.nextTab", "]"), [keybindings]);
  const kbPrevTab = useMemo(() => getEffectiveBinding(keybindings, "lanes.select.prevTab", "["), [keybindings]);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const targetIsTyping = isTypingTarget(event.target);
      if (!targetIsTyping && eventMatchesBinding(event, kbFilterFocus)) {
        event.preventDefault();
        const input = document.getElementById(LANES_FILTER_INPUT_ID);
        if (input instanceof HTMLInputElement) { input.focus(); input.select(); }
        return;
      }
      if (targetIsTyping) {
        if (event.key === "Escape") {
          const focused = document.activeElement;
          if (focused instanceof HTMLInputElement && focused.id === LANES_FILTER_INPUT_ID) {
            event.preventDefault();
            if (laneFilter.length > 0) setLaneFilter("");
            else focused.blur();
          }
        }
        return;
      }
      if (eventMatchesBinding(event, kbPrevTab) || eventMatchesBinding(event, kbNextTab)) {
        event.preventDefault();
        stepLaneSelection(eventMatchesBinding(event, kbNextTab) ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, laneFilter, setLaneFilter, stepLaneSelection, kbFilterFocus, kbNextTab, kbPrevTab]);

  const isNextKey = useCallback((event: React.KeyboardEvent) => eventMatchesBinding(event.nativeEvent, kbNext), [kbNext]);
  const isPrevKey = useCallback((event: React.KeyboardEvent) => eventMatchesBinding(event.nativeEvent, kbPrev), [kbPrev]);

  /* ---- Lane management actions ---- */

  const runLaneAction = async (
    fn: () => Promise<void>,
    status: string,
    kind: "delete" | "archive" = "delete",
  ) => {
    setLaneActionBusy(true);
    setLaneActionKind(kind);
    setLaneActionStatus(status);
    setLaneActionError(null);
    try {
      await fn();
      await refreshLanes();
      setManageOpen(false);
    } catch (err) {
      setLaneActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setLaneActionBusy(false);
      setLaneActionStatus(null);
      setLaneActionKind(null);
    }
  };

  const archiveManagedLanes = async () => {
    // The dialog lists `managedLanes`, so act on exactly those. The selected
    // lane is only a fallback for callers that never set them.
    const targets = managedLanes.length > 0 ? managedLanes : managedLane ? [managedLane] : [];
    const actionable = targets.filter((l) => l.laneType !== "primary");
    if (actionable.length === 0) return;
    await runLaneAction(async () => {
      for (const lane of actionable) {
        await window.ade.lanes.archive({ laneId: lane.id });
      }
    }, actionable.length > 1 ? `Archiving ${actionable.length} lanes...` : "Archiving lane...", "archive");
  };

  const moveAwayFromDeletingLanes = useCallback((laneIds: string[]) => {
    const nextLaneId = resolveLaneSelectionAfterDelete({
      deletingLaneIds: new Set([...deletingLaneIds, ...laneIds]),
      selectedLaneId,
      candidateLaneIds: [...filteredLaneIds, ...sortedSelectableLaneIds],
    });
    selectLane(nextLaneId);
    for (const laneId of laneIds) {
      clearLaneInspectorTab(laneId);
    }
    const nextSearch = nextLaneId ? `?laneId=${encodeURIComponent(nextLaneId)}` : "";
    navigate(`/lanes${nextSearch}`, { replace: true });
  }, [
    clearLaneInspectorTab,
    deletingLaneIds,
    filteredLaneIds,
    navigate,
    selectLane,
    selectedLaneId,
    sortedSelectableLaneIds,
  ]);

  useEffect(() => {
    const projectRoot = activeProjectRoot;
    if (!projectRoot) return;
    if (hydratedLaneDeleteProgressProjectRef.current === projectRoot) return;
    hydratedLaneDeleteProgressProjectRef.current = projectRoot;
    let cancelled = false;
    const getStoredActiveLaneIds = () => Object.values(appStore.getState().laneDeleteProgressByLaneId)
      .filter(isLaneDeleteProgressActive)
      .map((progress) => progress.laneId);
    const recoverStoredActiveLaneDeletes = () => {
      const storedActiveLaneIds = getStoredActiveLaneIds();
      if (storedActiveLaneIds.length === 0) return;
      moveAwayFromDeletingLanes(storedActiveLaneIds);
      queueLaneDeleteRefresh(storedActiveLaneIds);
    };
    if (!window.ade.lanes.listDeleteProgress) {
      recoverStoredActiveLaneDeletes();
      return;
    }
    void window.ade.lanes.listDeleteProgress()
      .then((progresses) => {
        if (cancelled) return;
        const activeProgresses = (Array.isArray(progresses) ? progresses : []).filter(isLaneDeleteProgressHydratable);
        const activeProgressLaneIds = new Set(activeProgresses.map((progress) => progress.laneId));
        const storedActiveLaneIds = getStoredActiveLaneIds();
        const laneIdsWithoutBackendProgress = storedActiveLaneIds.filter((laneId) => !activeProgressLaneIds.has(laneId));
        const laneIds = mergeUnique(
          activeProgresses.map((progress) => progress.laneId),
          laneIdsWithoutBackendProgress,
        );
        if (laneIds.length === 0) return;
        if (activeProgresses.length > 0) {
          setDeleteProgressByLaneId((prev) => {
            const next = { ...prev };
            for (const progress of activeProgresses) {
              next[progress.laneId] = progress;
            }
            return next;
          });
        }
        moveAwayFromDeletingLanes(laneIds);
        const refreshLaneIds = [...laneIdsWithoutBackendProgress];
        for (const progress of activeProgresses) {
          if (progress.overallStatus !== "completed" && progress.overallStatus !== "completed_with_warnings") continue;
          if (completedLaneDeleteRefreshesRef.current.has(progress.laneId)) continue;
          completedLaneDeleteRefreshesRef.current.add(progress.laneId);
          if (progress.overallStatus === "completed_with_warnings") {
            const laneName = lanesByIdRef.current?.get(progress.laneId)?.name ?? progress.laneId;
            laneDeleteWarningMessagesRef.current.set(
              progress.laneId,
              formatLaneDeleteProgressError(progress, laneName),
            );
          }
          refreshLaneIds.push(progress.laneId);
        }
        const warningMessage = formatLaneDeleteWarningMessages(laneDeleteWarningMessagesRef.current);
        if (warningMessage) setLaneActionError(warningMessage);
        queueLaneDeleteRefresh(refreshLaneIds);
      })
      .catch((error) => {
        if (cancelled) return;
        recoverStoredActiveLaneDeletes();
        console.debug("Failed to hydrate lane delete progress:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [active, activeProjectRoot, appStore, moveAwayFromDeletingLanes, queueLaneDeleteRefresh, setDeleteProgressByLaneId]);

  const deleteManagedLanes = async () => {
    const targets = managedLanes.length > 0 ? managedLanes : managedLane ? [managedLane] : [];
    const actionable = targets.filter((l) => l.laneType !== "primary");
    if (actionable.length === 0) return;

    const deleteArgsByLaneId = new Map<string, DeleteLaneArgs>();
    for (const lane of actionable) {
      const args: DeleteLaneArgs = { laneId: lane.id, force: deleteForce };
      args.deleteBranch = deleteSelection.localBranch;
      if (deleteSelection.remoteBranch) {
        args.deleteRemoteBranch = true;
        args.remoteName = "origin";
      }
      deleteArgsByLaneId.set(lane.id, args);
    }

    const laneIds = actionable.map((lane) => lane.id);
    completedLaneDeleteRefreshesRef.current = new Set(
      Array.from(completedLaneDeleteRefreshesRef.current).filter((laneId) => !laneIds.includes(laneId)),
    );
    setDeleteProgressByLaneId((prev) => {
      const next = { ...prev };
      for (const laneId of laneIds) {
        next[laneId] = createPendingLaneDeleteProgress(laneId);
      }
      return next;
    });
    setManageOpen(false);
    setLaneActionBusy(false);
    setLaneActionStatus(null);
    setLaneActionKind(null);
    laneDeleteWarningMessagesRef.current.clear();
    setLaneActionError(null);
    setDeleteSelection(EMPTY_LANE_DELETE_SELECTION);
    setMultiSelectedLaneIds(EMPTY_LANE_ID_SET);
    moveAwayFromDeletingLanes(laneIds);

    void (async () => {
      const errors: string[] = [];
      const blockedLaneIds = new Set<string>();
      const hasBlockedSelectedDescendant = (laneId: string): boolean => {
        for (const blockedLaneId of blockedLaneIds) {
          if (laneHasAncestor(blockedLaneId, laneId, lanesById)) return true;
        }
        return false;
      };

      for (const batch of planLaneDeleteBatches(actionable)) {
        const runnable = batch.filter((lane) => {
          if (!hasBlockedSelectedDescendant(lane.id)) return true;
          blockedLaneIds.add(lane.id);
          errors.push(`${lane.name}: skipped because a selected child lane did not delete.`);
          setDeleteProgressByLaneId((prev) => {
            const next = { ...prev };
            delete next[lane.id];
            return next;
          });
          return false;
        });
        if (runnable.length === 0) continue;

        const results = await runLaneDeleteBatchWithConcurrency(
          runnable,
          async (lane) => {
            const args = deleteArgsByLaneId.get(lane.id);
            if (!args) return;
            await window.ade.lanes.delete(args);
          },
        );
        results.forEach((result) => {
          if (result.status === "fulfilled") return;
          const lane = result.lane;
          blockedLaneIds.add(lane.id);
          errors.push(`${lane.name}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
          setDeleteProgressByLaneId((prev) => {
            const next = { ...prev };
            delete next[lane.id];
            return next;
          });
        });
      }
      if (errors.length > 0) {
        setLaneActionError(errors.join("\n"));
      }
    })();
  };

  const openBatchManage = useCallback((laneIds: string[], initialTab: ManageLaneTab | null = null) => {
    const manageable = laneIds.filter((id) => {
      const lane = lanesById.get(id);
      return lane && lane.laneType !== "primary" && !deletingLaneIds.has(id);
    });
    if (manageable.length === 0) return;
    setManageInitialTab(initialTab);
    setManagedLaneIds(manageable);
    setLaneActionError(null);
    setDeleteForce(true);
    setDeleteSelection(EMPTY_LANE_DELETE_SELECTION);
    setManageOpen(true);
  }, [lanesById, deletingLaneIds]);

  const requestRebaseScope = useCallback((laneId: string) => {
    const laneName = lanesById.get(laneId)?.name ?? laneId;
    return new Promise<RebaseScope | null>((resolve) => {
      setRebaseScopePrompt({ laneId, laneName, resolve });
    });
  }, [lanesById]);

  const requestPushSelection = useCallback((run: RebaseRun) => {
    const succeededLanes = run.lanes
      .filter((lane) => lane.status === "succeeded")
      .map((lane) => ({ laneId: lane.laneId, laneName: lane.laneName, selected: true }));
    if (succeededLanes.length === 0) return Promise.resolve<string[] | null>([]);
    return new Promise<string[] | null>((resolve) => {
      setRebasePushReview({
        runId: run.runId,
        lanes: succeededLanes,
        resolve
      });
    });
  }, []);

  const runRebaseFlow = useCallback(async (laneId: string, mode: "local_only" | "local_and_remote") => {
    setRebaseSuggestionError(null);
    try {
      const scope = await requestRebaseScope(laneId);
      if (!scope) return;

      const start = await window.ade.lanes.rebaseStart({
        laneId,
        scope,
        pushMode: mode === "local_and_remote" ? "review_then_push" : "none",
        actor: "user"
      });

      if (start.run.state === "failed" || start.run.failedLaneId || start.run.error) {
        const failedLane = start.run.failedLaneId ? lanesById.get(start.run.failedLaneId)?.name ?? start.run.failedLaneId : null;
        const detail = start.run.error ?? "Rebase failed.";
        setRebaseSuggestionError(`Rebase needs attention${failedLane ? ` for ${failedLane}` : ""}. ${detail}`);
        navigate("/prs?tab=workflows&workflow=rebase");
        return;
      }

      if (mode === "local_and_remote") {
        const laneIds = await requestPushSelection(start.run);
        if (laneIds == null) return;
        if (laneIds.length > 0) {
          await window.ade.lanes.rebasePush({ runId: start.runId, laneIds });
        }
      }

      try {
        await refreshLanes();
      } catch (refreshErr) {
        console.error("Lane refresh failed:", refreshErr);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRebaseSuggestionError(message);
      navigate("/prs?tab=workflows&workflow=rebase");
    }
  }, [lanesById, navigate, refreshLanes, requestPushSelection, requestRebaseScope]);

  // Group header bulk actions. Archive and delete go through the same batch
  // manage dialog as Cmd-click (it lists the lanes and confirms); rebase has
  // its own confirm step. Primary is never in a group, and is filtered again.
  const handleGroupBulkAction = useCallback((action: LaneGroupBulkAction, laneIds: string[]) => {
    if (action === "rebase") {
      const targets = laneIds.filter((id) => {
        const lane = lanesById.get(id);
        return lane && lane.laneType !== "primary" && !deletingLaneIds.has(id);
      });
      if (targets.length > 0) setBulkRebaseLaneIds(targets);
      return;
    }
    openBatchManage(laneIds, action);
  }, [deletingLaneIds, lanesById, openBatchManage]);

  // One lane of "Rebase all": the rebase the Git pane's "Rebase now" runs,
  // scoped to this lane only and without a push.
  const rebaseLaneForBulk = useCallback(async (laneId: string): Promise<string | null> => {
    const start = await window.ade.lanes.rebaseStart({ laneId, scope: "lane_only", pushMode: "none", actor: "user" });
    if (start.run.state === "failed" || start.run.failedLaneId || start.run.error) {
      return start.run.error ?? "Rebase failed.";
    }
    return null;
  }, []);

  const bulkRebaseTargets = useMemo((): LaneBulkRebaseTarget[] => {
    if (!bulkRebaseLaneIds) return [];
    return bulkRebaseLaneIds.flatMap((laneId) => {
      const lane = lanesById.get(laneId);
      if (!lane) return [];
      const behind = Math.max(lane.status.behind, laneSnapshotByLaneId.get(laneId)?.rebaseSuggestion?.behindCount ?? 0);
      return [{ lane, colorIndex: colorIndexByLaneId.get(laneId) ?? 0, behind }];
    });
  }, [bulkRebaseLaneIds, colorIndexByLaneId, laneSnapshotByLaneId, lanesById]);

  const patchLaneSnapshot = useCallback((
    laneId: string,
    patch: (snapshot: LaneListSnapshot) => LaneListSnapshot,
  ) => {
    appStore.setState((prev) => ({
      laneSnapshots: prev.laneSnapshots.map((snapshot) => (snapshot.lane.id === laneId ? patch(snapshot) : snapshot)),
    }));
  }, [appStore]);

  const dismissRebaseSuggestion = async (laneId: string) => {
    const previous = appStore.getState().laneSnapshots.find((snapshot) => snapshot.lane.id === laneId)?.rebaseSuggestion ?? null;
    setRebaseSuggestionError(null);
    patchLaneSnapshot(laneId, (snapshot) => ({ ...snapshot, rebaseSuggestion: null }));
    try {
      await window.ade.lanes.dismissRebaseSuggestion({ laneId });
    } catch (err) {
      if (previous) {
        patchLaneSnapshot(laneId, (snapshot) => (snapshot.rebaseSuggestion == null ? { ...snapshot, rebaseSuggestion: previous } : snapshot));
      }
      setRebaseSuggestionError(err instanceof Error ? err.message : String(err));
    }
  };

  const dismissAutoRebaseStatus = async (laneId: string) => {
    const previous = appStore.getState().laneSnapshots.find((snapshot) => snapshot.lane.id === laneId)?.autoRebaseStatus ?? null;
    setRebaseSuggestionError(null);
    patchLaneSnapshot(laneId, (snapshot) => ({ ...snapshot, autoRebaseStatus: null }));
    try {
      await window.ade.lanes.dismissAutoRebaseStatus({ laneId });
    } catch (err) {
      if (previous) {
        patchLaneSnapshot(laneId, (snapshot) => (snapshot.autoRebaseStatus == null ? { ...snapshot, autoRebaseStatus: previous } : snapshot));
      }
      setRebaseSuggestionError(err instanceof Error ? err.message : String(err));
    }
  };

  const openAutoRebaseSettings = useCallback(() => { navigate(settingsRouteFor("lanes-git.lane-templates")); }, [navigate]);
  const openRebaseDetails = useCallback((laneId?: string | null) => {
    const trimmedLaneId = typeof laneId === "string" ? laneId.trim() : "";
    if (trimmedLaneId.length) {
      const search = buildPrsRouteSearch({
        activeTab: "rebase",
        selectedPrId: null,
        selectedRebaseItemId: trimmedLaneId,
      });
      navigate(`/prs${search}`);
      return;
    }
    navigate("/prs?tab=workflows&workflow=rebase");
  }, [navigate]);

  const openRebaseConflictResolver = useCallback((laneId: string, parentLaneId: string | null) => {
    const search = new URLSearchParams(
      buildPrsRouteSearch({
        activeTab: "rebase",
        selectedPrId: null,
        selectedRebaseItemId: laneId,
      }).slice(1),
    );
    if (parentLaneId) search.set("parentLaneId", parentLaneId);
    navigate(`/prs?${search.toString()}`);
  }, [navigate]);

  /* ---- Git pane selection ---- */

  const handleSelectFile = useCallback((laneId: string, path: string, mode: "staged" | "unstaged") => {
    setLanePaneDetails((prev) => ({
      ...prev,
      [laneId]: { selectedFilePath: path, selectedFileMode: mode, selectedCommit: null }
    }));
  }, []);

  const handleSelectCommit = useCallback((laneId: string, commit: GitCommitSummary | null) => {
    setLanePaneDetails((prev) => {
      const prevDetail = prev[laneId] ?? EMPTY_LANE_PANE_DETAIL;
      const nextDetail: LanePaneDetailSelection = commit
        ? { selectedFilePath: null, selectedFileMode: null, selectedCommit: commit }
        : { ...prevDetail, selectedCommit: null };
      return { ...prev, [laneId]: nextDetail };
    });
  }, []);

  const handleClearLanePaneDetailSelection = useCallback((laneId: string) => {
    setLanePaneDetails((prev) => ({ ...prev, [laneId]: EMPTY_LANE_PANE_DETAIL }));
  }, []);

  /* ---- Create / manage dialogs ---- */

  const openCreateDialog = useCallback((prefill?: CreateLanePrefill | null) => {
    setCreatePrefill(prefill ?? null);
    setCreateOpen(true);
  }, []);

  // Deep links must not re-run on lane list refreshes, or a stale ?laneId from
  // the URL would overwrite the user's current selection. Multi-lane
  // ?laneIds= re-tries as `availableLaneIds` changes.

  useEffect(() => {
    if (!active) return;
    if (urlLaneDeeplinks.action !== "create") return;
    openCreateDialog();
    const next = new URLSearchParams(location.search);
    next.delete("action");
    const search = next.toString();
    navigate(`${location.pathname}${search ? `?${search}` : ""}`, { replace: true });
  }, [
    location.pathname,
    location.search,
    navigate,
    openCreateDialog,
    urlLaneDeeplinks.action,
    active,
  ]);

  // ?action=manage&laneId=X opens ManageLaneDialog for that lane. Used by other
  // pages (PR cleanup, Work-tab lane right-click) to reach the canonical delete
  // surface.
  useEffect(() => {
    if (!active) return;
    if (urlLaneDeeplinks.action !== "manage") return;
    const targetId = urlLaneDeeplinks.laneId;
    if (!targetId) return;
    const lane = lanesById.get(targetId);
    if (!lane || lane.laneType === "primary" || deletingLaneIds.has(targetId)) return;
    setManagedLaneIds([targetId]);
    setLaneActionError(null);
    setDeleteForce(true);
    setDeleteSelection(EMPTY_LANE_DELETE_SELECTION);
    setManageOpen(true);
    setPulsingLaneId(targetId);
    navigate(`${location.pathname}${buildLaneActionClearedSearch(location.search)}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, urlLaneDeeplinks.action, urlLaneDeeplinks.laneId, lanesById, deletingLaneIds]);

  // Clear the pulse marker shortly after it is set so the animation can replay.
  useEffect(() => {
    if (!pulsingLaneId) return;
    const t = window.setTimeout(() => setPulsingLaneId(null), 700);
    return () => window.clearTimeout(t);
  }, [pulsingLaneId]);

  // Work-tab lane menu actions that route here. The split/tab actions are gone
  // with the lane columns; opening one now just selects the lane.
  useEffect(() => {
    if (!active) return;
    const action = urlLaneDeeplinks.action;
    if (!action || action === "create" || action === "manage") return;
    const laneId = urlLaneDeeplinks.laneId;
    let handled = false;
    if ((action === "split-open" || action === "split-close-others") && laneId) {
      if (!deletingLaneIds.has(laneId) && lanesById.has(laneId)) {
        selectDetailLane(laneId);
        handled = true;
      }
    } else if (action === "split-remove" || action === "select-all") {
      handled = true;
    } else if (action === "batch") {
      const ids = (urlLaneDeeplinks.laneIdsRaw ?? "").split(",").map((id) => id.trim()).filter(Boolean);
      if (ids.length > 0) {
        openBatchManage(ids);
        handled = true;
      }
    }
    if (!handled) return;
    if (laneId) setPulsingLaneId(laneId);
    navigate(`${location.pathname}${buildLaneActionClearedSearch(location.search)}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    urlLaneDeeplinks.action,
    urlLaneDeeplinks.laneId,
    urlLaneDeeplinks.laneIdsRaw,
    lanesById,
    deletingLaneIds,
    active,
  ]);

  useEffect(() => {
    if (!active) return;
    if (!shouldApplyLaneIdsDeepLink({
      action: urlLaneDeeplinks.action,
      laneIdsRaw: urlLaneDeeplinks.laneIdsRaw,
    })) return;
    const laneIdsSelection = resolveLaneIdsDeepLinkSelection({
      laneIdsRaw: urlLaneDeeplinks.laneIdsRaw,
      inspectorTabParam: urlLaneDeeplinks.inspectorTab,
      availableLaneIds,
      consumedSignature: consumedLaneIdsDeepLinkSignatureRef.current,
    });
    if (laneIdsSelection) {
      consumedLaneIdsDeepLinkSignatureRef.current = laneIdsSelection.signature;
      const first = laneIdsSelection.laneIds[0]!;
      selectLane(first);
      if (urlLaneDeeplinks.inspectorTab) {
        setLaneInspectorTab(first, urlLaneDeeplinks.inspectorTab as LaneInspectorTab);
      }
    }
  }, [
    active,
    availableLaneIds,
    selectLane,
    setLaneInspectorTab,
    urlLaneDeeplinks.action,
    urlLaneDeeplinks.laneIdsRaw,
    urlLaneDeeplinks.inspectorTab,
  ]);

  useEffect(() => {
    if (!active) return;
    if (urlLaneDeeplinks.action) return;
    if (urlLaneDeeplinks.laneIdsRaw) return;
    consumedLaneIdsDeepLinkSignatureRef.current = null;
    const laneId = urlLaneDeeplinks.laneId;
    if (!laneId) return;
    if (deletingLaneIds.has(laneId)) return;
    selectLane(laneId);
    if (urlLaneDeeplinks.inspectorTab) {
      setLaneInspectorTab(laneId, urlLaneDeeplinks.inspectorTab as LaneInspectorTab);
    }
  }, [
    active,
    urlLaneDeeplinks.action,
    urlLaneDeeplinks.laneIdsRaw,
    urlLaneDeeplinks.laneId,
    urlLaneDeeplinks.inspectorTab,
    deletingLaneIds,
    selectLane,
    setLaneInspectorTab,
  ]);

  // ?laneId=X&commitSha=Y selects that commit in the lane's Git pane.
  useEffect(() => {
    if (!active) return;
    if (urlLaneDeeplinks.action) return;
    if (urlLaneDeeplinks.laneIdsRaw) return;

    const laneId = urlLaneDeeplinks.laneId?.trim();
    const commitSha = urlLaneDeeplinks.commitSha?.trim();
    if (!laneId || !commitSha) {
      consumedCommitDeepLinkSignatureRef.current = null;
      return;
    }
    if (deletingLaneIds.has(laneId) || !lanesById.has(laneId)) return;

    const signature = `${laneId}:${commitSha}`;
    if (consumedCommitDeepLinkSignatureRef.current === signature) return;
    consumedCommitDeepLinkSignatureRef.current = signature;

    selectLane(laneId);

    let cancelled = false;
    void window.ade.git
      .listRecentCommits({ laneId, limit: 500 })
      .then((rows) => {
        if (cancelled) return;
        const requested = commitSha.toLowerCase();
        const commit = rows.find(
          (row) =>
            row.sha.toLowerCase().startsWith(requested) ||
            row.shortSha.toLowerCase() === requested,
        );
        if (!commit) return;
        setLanePaneDetails((prev) => ({
          ...prev,
          [laneId]: {
            selectedFilePath: null,
            selectedFileMode: null,
            selectedCommit: commit,
          },
        }));
        setPulsingLaneId(laneId);
      })
      .catch(() => {
        if (!cancelled) consumedCommitDeepLinkSignatureRef.current = null;
      });
    return () => {
      cancelled = true;
    };
  }, [
    active,
    deletingLaneIds,
    lanesById,
    selectLane,
    urlLaneDeeplinks.action,
    urlLaneDeeplinks.commitSha,
    urlLaneDeeplinks.laneId,
    urlLaneDeeplinks.laneIdsRaw,
  ]);

  useEffect(() => {
    if (!urlLaneDeeplinks.sessionId) return;
    focusSession(urlLaneDeeplinks.sessionId);
  }, [urlLaneDeeplinks.sessionId, focusSession]);

  // Consume the "just launched" marker so new lanes show a spinner until
  // their headless agent session lands. A safety TTL drops the marker even if
  // the session never surfaces (e.g. the launch failed after the lane existed).
  useEffect(() => {
    const apply = (highlight: { laneIds: string[]; sessionIds: string[] }) => {
      if (!highlight.laneIds.length) return;
      const newLaneIds = highlight.laneIds;
      setCreatingLaneIds((prev) => {
        const next = new Set(prev);
        for (const laneId of newLaneIds) next.add(laneId);
        return next;
      });
      window.setTimeout(() => {
        setCreatingLaneIds((prev) => {
          if (!newLaneIds.some((id) => prev.has(id))) return prev;
          const next = new Set(prev);
          for (const laneId of newLaneIds) next.delete(laneId);
          return next;
        });
      }, 30_000);
    };
    const pending = consumeLaunchedLanesHighlight();
    if (pending) apply(pending);
    return subscribeLaunchedLanesHighlight(apply);
  }, []);

  // Drop the "creating" marker once a lane has a live agent session, or when
  // the lane is gone.
  useEffect(() => {
    if (creatingLaneIds.size === 0) return;
    setCreatingLaneIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const laneId of prev) {
        const runtime = laneRuntimeById.get(laneId);
        if (!lanesById.has(laneId) || (runtime?.sessionCount ?? 0) > 0) {
          next.delete(laneId);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [creatingLaneIds, laneRuntimeById, lanesById]);

  useEffect(() => {
    setCreatingIssues(consumeCreatingIssues());
    return subscribeCreatingIssues(setCreatingIssues);
  }, []);

  // Index real lanes by the Linear issue they carry so a placeholder row can
  // resolve into its real lane the moment that lane materializes.
  const laneIdByLinearIssueId = useMemo(() => {
    const map = new Map<string, string>();
    for (const lane of dedupedLanes) {
      const issueId = lane.linearIssue?.id;
      if (issueId && !map.has(issueId)) map.set(issueId, lane.id);
    }
    return map;
  }, [dedupedLanes]);

  const pendingCreatingIssues = useMemo(
    () => creatingIssues.filter((placeholder) => !laneIdByLinearIssueId.has(placeholder.issueId)),
    [creatingIssues, laneIdByLinearIssueId],
  );
  useEffect(() => {
    for (const placeholder of creatingIssues) {
      if (laneIdByLinearIssueId.has(placeholder.issueId)) clearCreatingIssue(placeholder.issueId);
    }
  }, [creatingIssues, laneIdByLinearIssueId]);

  const handleCreateDialogOpenChange = useCallback((open: boolean) => {
    setCreateOpen(open);
  }, []);

  // Blocked by the dialog bus while a create/setup is in flight; the host owns
  // the busy state and mirrors it into the ref.
  const handleCreateDialogBusClose = useCallback(() => {
    if (createBusyRef.current) return;
    setCreateOpen(false);
  }, []);

  // After the lane record exists and the list is refreshed, select the new
  // lane (the host keeps streaming env-setup progress in the dialog).
  const handleLaneCreated = useCallback((lane: LaneSummary) => {
    navigate(`/lanes?laneId=${encodeURIComponent(lane.id)}`);
  }, [navigate]);

  const openManageDialog = useCallback((laneId: string) => {
    if (deletingLaneIds.has(laneId)) return;
    selectLane(laneId);
    setManageInitialTab(null);
    setManagedLaneIds([laneId]);
    setLaneActionError(null);
    setDeleteForce(true);
    setDeleteSelection(EMPTY_LANE_DELETE_SELECTION);
    setManageOpen(true);
  }, [deletingLaneIds, selectLane]);

  const handleCreateDialogBusOpen = useCallback((props?: Record<string, unknown>) => {
    const name = typeof props?.name === "string" ? props.name.trim() : "";
    openCreateDialog(name ? { name } : null);
  }, [openCreateDialog]);

  const handleManageDialogBusOpen = useCallback((props?: Record<string, unknown>) => {
    const requestedLaneId = typeof props?.laneId === "string" ? props.laneId : null;
    const requested = requestedLaneId ? lanesById.get(requestedLaneId) ?? null : null;
    const selected = selectedLaneId ? lanesById.get(selectedLaneId) ?? null : null;
    const fallback = dedupedLanes.find((lane) => lane.laneType !== "primary") ?? null;
    const target =
      requested && requested.laneType !== "primary"
        ? requested
        : selected && selected.laneType !== "primary"
          ? selected
          : fallback;
    if (!target) return;
    openManageDialog(target.id);
  }, [dedupedLanes, lanesById, openManageDialog, selectedLaneId]);

  useDialogBus("lanes.create", {
    onOpen: handleCreateDialogBusOpen,
    onClose: handleCreateDialogBusClose,
  });

  useDialogBus("lanes.manage", {
    onOpen: handleManageDialogBusOpen,
    onClose: () => setManageOpen(false),
  });

  const refreshLaneAppearance = useCallback(() => refreshLanes({ includeStatus: false }).catch(() => {}), [refreshLanes]);
  const clearMultiSelection = useCallback(() => setMultiSelectedLaneIds(EMPTY_LANE_ID_SET), []);
  const closeContextMenu = useCallback(() => setLaneContextMenu(null), []);
  const multiSelectedList = useMemo(() => [...multiSelectedLaneIds], [multiSelectedLaneIds]);

  /* ---- Render ---- */

  const laneList = (
    <LaneSidebarList
      layout={sidebarLayout}
      onGroupByChange={setLaneGroupBy}
      collapsedGroupIds={laneCollapsedGroupSet}
      onToggleGroupCollapsed={toggleLaneGroupCollapsed}
      onGroupBulkAction={handleGroupBulkAction}
      colorIndexByLaneId={colorIndexByLaneId}
      needsYouReasonByLaneId={needsYouReasonByLaneId}
      selectedLaneId={detailLaneId}
      multiSelectedLaneIds={multiSelectedLaneIds}
      filter={laneFilter}
      onFilterChange={setLaneFilter}
      canCreateLane={canCreateLane}
      onCreateLane={() => openCreateDialog()}
      loading={lanesLoading}
      totalLaneCount={dedupedLanes.length}
      laneRuntimeById={laneRuntimeById}
      laneSnapshotByLaneId={laneSnapshotByLaneId}
      agentsByLaneId={agentsByLaneId}
      lanePrTagsByLaneId={lanePrTagsByLaneId}
      deleteProgressByLaneId={deleteProgressByLaneId}
      creatingLaneIds={creatingLaneIds}
      pendingCreatingIssues={pendingCreatingIssues}
      pulsingLaneId={pulsingLaneId}
      onSelectRow={handleRowSelect}
      onStepSelection={stepLaneSelection}
      isNextKey={isNextKey}
      isPrevKey={isPrevKey}
      onContextMenu={handleRowContextMenu}
      onOpenPr={handleOpenPr}
      onOpenAgent={handleOpenAgent}
      onClearMultiSelection={clearMultiSelection}
    />
  );

  const laneDetail = detailLaneId && detailLane ? lanePaneDetails[detailLaneId] ?? EMPTY_LANE_PANE_DETAIL : EMPTY_LANE_PANE_DETAIL;

  return (
    <div data-route="lanes" className="flex h-full min-w-0" style={{ background: COLORS.pageBg }}>
      {hasProjectSidebar ? (
        <ProjectSidebarSlot active={active}>{laneList}</ProjectSidebarSlot>
      ) : (
        <div
          className="flex w-[280px] shrink-0 flex-col pt-2"
          style={{ borderRight: "1px solid color-mix(in srgb, var(--color-border) 70%, transparent)" }}
        >
          {laneList}
        </div>
      )}

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {detailLane && detailLaneId ? (
          <>
            {laneActionError ? (
              <div
                className="flex shrink-0 items-center gap-2 px-4 py-1.5 text-[11.5px]"
                style={{ color: COLORS.danger, background: "color-mix(in srgb, var(--color-error) 8%, transparent)" }}
                title={laneActionError}
              >
                <span className="min-w-0 flex-1 truncate">{laneActionError.split(/\r?\n/)[0]?.trim() || "Lane action failed"}</span>
                <button
                  type="button"
                  className="shrink-0"
                  onClick={() => {
                    laneDeleteWarningMessagesRef.current.clear();
                    setLaneActionError(null);
                  }}
                  aria-label="Dismiss"
                >
                  <X size={11} />
                </button>
              </div>
            ) : null}
            <LaneSplitBody
              left={(
                <LaneDashboard
                  laneId={detailLaneId}
                  colorIndex={detailColorIndex}
                  active={active}
                  agents={agentsByLaneId.get(detailLaneId)}
                  colorIndexByLaneId={colorIndexByLaneId}
                  prTagsByLaneId={lanePrTagsByLaneId}
                  onSelectLane={selectDetailLane}
                  onOpenPrTag={handleOpenPr}
                  onOpenLaneMenu={openLaneMenuAt}
                  showRebaseSuggestions={rebaseSuggestionDisplay !== "off"}
                  rebaseError={rebaseSuggestionError}
                  onOpenRebase={openRebaseDetails}
                  onDismissRebaseSuggestion={(laneId) => { void dismissRebaseSuggestion(laneId); }}
                  onDismissAutoRebase={(laneId) => { void dismissAutoRebaseStatus(laneId); }}
                  onStartChat={startChatInLane}
                  onSelectCommit={(commit) => handleSelectCommit(detailLaneId, commit)}
                />
              )}
              right={(
                // Mounted like Work -> Tools -> Git: the same pane, keyed per
                // lane, with the same header row and the same in-place diffs.
                <div className="flex h-full min-h-0 flex-col" data-tour="lanes.gitActionsPane">
                  <LaneGitActionsPane
                    key={`lanes-git:${detailLaneId}`}
                    laneId={detailLaneId}
                    active={active}
                    autoRebaseEnabled={autoRebaseEnabled}
                    autoRebaseStatusSnapshot={laneSnapshotByLaneId.get(detailLaneId)?.autoRebaseStatus}
                    onOpenSettings={openAutoRebaseSettings}
                    onRebaseNowLocal={(targetLaneId) => runRebaseFlow(targetLaneId, "local_only")}
                    onRebaseAndPush={(targetLaneId) => runRebaseFlow(targetLaneId, "local_and_remote")}
                    onViewRebaseDetails={openRebaseDetails}
                    onResolveRebaseConflict={openRebaseConflictResolver}
                    selectedPath={laneDetail.selectedFilePath}
                    selectedMode={laneDetail.selectedFileMode}
                    selectedCommit={laneDetail.selectedCommit ?? null}
                    selectedCommitSha={laneDetail.selectedCommit?.sha ?? null}
                    onSelectFile={(path, mode) => handleSelectFile(detailLaneId, path, mode)}
                    onSelectCommit={(commit) => handleSelectCommit(detailLaneId, commit)}
                    onClearDiffSelection={() => handleClearLanePaneDetailSelection(detailLaneId)}
                  />
                </div>
              )}
            />
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3">
            <div className="text-[13px]" style={{ color: COLORS.textMuted }}>
              {lanesLoading && dedupedLanes.length === 0
                ? "Loading lanes…"
                : dedupedLanes.length === 0
                  ? "No lanes yet."
                  : "No lane matches the filter."}
            </div>
            {!lanesLoading || dedupedLanes.length > 0 ? (
              <button
                type="button"
                data-tour={hasProjectSidebar ? undefined : "lanes.newLane"}
                style={primaryButton({ height: 30, padding: "0 12px", fontSize: 11 })}
                disabled={!canCreateLane}
                onClick={() => openCreateDialog()}
              >
                New lane
              </button>
            ) : null}
          </div>
        )}
      </main>

      {laneContextMenu ? (
        <LaneSidebarContextMenu
          menu={laneContextMenu}
          lanesById={lanesById}
          selectedLaneIds={multiSelectedList}
          onClose={closeContextMenu}
          onManage={openManageDialog}
          onBatchManage={openBatchManage}
          selectLane={selectDetailLane}
          onAppearanceChanged={refreshLaneAppearance}
          onStartChatInLane={startChatInLane}
        />
      ) : null}

      <ManageLaneDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        managedLane={managedLane}
        managedLanes={managedLanes}
        allLanes={lanes}
        deleteSelection={deleteSelection}
        setDeleteSelection={setDeleteSelection}
        deleteForce={deleteForce}
        setDeleteForce={setDeleteForce}
        chatSessionCount={managedLane ? (laneRuntimeById.get(managedLane.id)?.sessionCount ?? 0) : undefined}
        laneActionBusy={laneActionBusy}
        laneActionStatus={laneActionStatus}
        laneActionError={laneActionError}
        laneActionKind={laneActionKind}
        onArchive={() => { archiveManagedLanes().catch(() => {}); }}
        onDelete={() => { deleteManagedLanes().catch(() => {}); }}
        onAppearanceChanged={refreshLaneAppearance}
        onStackReorganized={() => { refreshLanes().catch(() => {}); }}
        initialTab={manageInitialTab}
      />

      <LaneSidebarBulkRebaseDialog
        open={bulkRebaseLaneIds != null}
        targets={bulkRebaseTargets}
        onOpenChange={(open) => { if (!open) setBulkRebaseLaneIds(null); }}
        rebaseLane={rebaseLaneForBulk}
        onFinished={() => { refreshLanes().catch(() => {}); }}
      />

      <CreateLaneDialogHost
        open={createOpen}
        onOpenChange={handleCreateDialogOpenChange}
        behavior="stay-open-setup"
        prefill={createPrefill}
        onCreated={handleLaneCreated}
        onBusyChange={(busy) => { createBusyRef.current = busy; }}
        onOpenLinearSettings={() => navigate(settingsRouteFor("integrations.linear"))}
        onNavigateToTemplates={() => navigate(settingsRouteFor("lanes-git.lane-templates"))}
      />

      {rebaseScopePrompt ? (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.55)" }}>
          <div style={{ width: "min(520px, 100%)", background: COLORS.cardBgSolid, backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", border: `1px solid ${COLORS.outlineBorder}`, borderRadius: 16, padding: 20 }}>
            <div style={{ ...LABEL_STYLE, color: COLORS.accent }}>REBASE SCOPE</div>
            <div style={{ marginTop: 10, fontSize: 13, color: COLORS.textPrimary }}>
              Choose how to rebase <strong>{rebaseScopePrompt.laneName}</strong>.
            </div>
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
              <button
                type="button"
                style={outlineButton({ height: 34, padding: "0 10px", fontSize: 11 })}
                onClick={() => {
                  rebaseScopePrompt.resolve("lane_only");
                  setRebaseScopePrompt(null);
                }}
              >
                CURRENT LANE ONLY
              </button>
              <button
                type="button"
                style={primaryButton({ height: 34, padding: "0 10px", fontSize: 11 })}
                onClick={() => {
                  rebaseScopePrompt.resolve("lane_and_descendants");
                  setRebaseScopePrompt(null);
                }}
              >
                LANE + CHILDREN
              </button>
            </div>
            <div className="flex justify-end" style={{ marginTop: 12 }}>
              <button
                type="button"
                style={outlineButton({ height: 30, padding: "0 10px", fontSize: 10 })}
                onClick={() => {
                  rebaseScopePrompt.resolve(null);
                  setRebaseScopePrompt(null);
                }}
              >
                CANCEL
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {rebasePushReview ? (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.55)" }}>
          <div style={{ width: "min(620px, 100%)", background: COLORS.cardBgSolid, backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", border: `1px solid ${COLORS.outlineBorder}`, borderRadius: 16, padding: 20 }}>
            <div style={{ ...LABEL_STYLE, color: COLORS.accent }}>REVIEW THEN PUSH</div>
            <div style={{ marginTop: 10, fontSize: 13, color: COLORS.textPrimary }}>
              Select rebased lanes to push to remote.
            </div>
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8, maxHeight: 240, overflowY: "auto" }}>
              {rebasePushReview.lanes.map((lane) => (
                <label
                  key={lane.laneId}
                  className="flex items-center gap-2"
                  style={{ fontSize: 12, color: COLORS.textSecondary, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "8px 10px" }}
                >
                  <input
                    type="checkbox"
                    checked={lane.selected}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setRebasePushReview((prev) => {
                        if (!prev) return prev;
                        return {
                          ...prev,
                          lanes: prev.lanes.map((entry) => entry.laneId === lane.laneId ? { ...entry, selected: checked } : entry)
                        };
                      });
                    }}
                  />
                  <span className="truncate">{lane.laneName}</span>
                </label>
              ))}
            </div>
            <div className="flex items-center justify-end gap-2" style={{ marginTop: 12 }}>
              <button
                type="button"
                style={outlineButton({ height: 30, padding: "0 10px", fontSize: 10 })}
                onClick={() => {
                  rebasePushReview.resolve(null);
                  setRebasePushReview(null);
                }}
              >
                CANCEL
              </button>
              <button
                type="button"
                style={primaryButton({ height: 30, padding: "0 10px", fontSize: 10 })}
                onClick={() => {
                  const laneIds = rebasePushReview.lanes.filter((lane) => lane.selected).map((lane) => lane.laneId);
                  rebasePushReview.resolve(laneIds);
                  setRebasePushReview(null);
                }}
              >
                PUSH SELECTED
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
