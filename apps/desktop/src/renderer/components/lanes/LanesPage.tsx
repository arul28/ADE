import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useClickOutside } from "../../hooks/useClickOutside";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Group, Panel } from "react-resizable-panels";
import { Check, CaretDown, FileCode, GitBranch, House, Stack, Link, ArrowsOutSimple, ArrowsInSimple, PushPin, Plus, MagnifyingGlass, Terminal, X, ArrowSquareOut, Info } from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";
import { buildIntegrationSourcesByLaneId } from "../../lib/integrationLanes";
import { EmptyState } from "../ui/EmptyState";
import { Button } from "../ui/Button";
import { PaneTilingLayout } from "../ui/PaneTilingLayout";
import { listSessionsCached } from "../../lib/sessionListCache";
import { shouldRefreshSessionListForChatEvent } from "../../lib/chatSessionEvents";
import { COLORS, LABEL_STYLE, MONO_FONT, SANS_FONT, inlineBadge, outlineButton, primaryButton, conflictDotColor } from "./laneDesignTokens";
import { ResizeGutter } from "../ui/ResizeGutter";
import { LaneStackPane } from "./LaneStackPane";
import { LaneGitActionsPane } from "./LaneGitActionsPane";
import { LaneDiffPane } from "./LaneDiffPane";
import { LaneWorkPane } from "./LaneWorkPane";
import { CreateLaneDialog } from "./CreateLaneDialog";
import { AttachLaneDialog } from "./AttachLaneDialog";
import { ManageLaneDialog } from "./ManageLaneDialog";
import { LaneContextMenu } from "./LaneContextMenu";
import { LaneRebaseBanner } from "./LaneRebaseBanner";
import {
  sortLanesForTabs,
  sortLanesForStackGraph,
  mergeUnique,
  laneMatchesFilter,
  chipLabel,
  LANES_TILING_TREE,
  LANES_TILING_LAYOUT_VERSION,
  GIT_ACTIONS_FULLSCREEN_TREE,
  RESIZE_TARGET_MINIMUM_SIZE,
  EMPTY_LANE_PANE_DETAIL,
  formatBranchCheckoutError,
  type LanePaneDetailSelection,
  type LaneBranchOption
} from "./laneUtils";
import { sessionStatusBucket } from "../../lib/terminalAttention";
import { isRunOwnedSession } from "../../lib/sessions";
import type {
  ConflictChip,
  ConflictStatus,
  DeleteLaneArgs,
  GitCommitSummary,
  LaneEnvInitEvent,
  LaneEnvInitProgress,
  LaneSummary,
  RebaseRun,
  RebaseScope,
  RebaseSuggestion,
  AutoRebaseLaneStatus,
  IntegrationProposal,
  TerminalSessionSummary,
  LaneTemplate
} from "../../../shared/types";
import { eventMatchesBinding, getEffectiveBinding } from "../../lib/keybindings";

type LaneRuntimeBucket = "running" | "awaiting-input" | "ended" | "none";

type LaneRuntimeSummary = {
  bucket: LaneRuntimeBucket;
  runningCount: number;
  awaitingInputCount: number;
  endedCount: number;
  sessionCount: number;
};

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

const ADOPT_HINT_DISMISSED_KEY = "ade.lanes.adoptHintDismissed.v1";

/* ---- Component ---- */

export function LanesPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const selectLane = useAppStore((s) => s.selectLane);
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);
  const focusSession = useAppStore((s) => s.focusSession);
  const lanes = useAppStore((s) => s.lanes);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const keybindings = useAppStore((s) => s.keybindings);
  const project = useAppStore((s) => s.project);

  const [activeLaneIds, setActiveLaneIds] = useState<string[]>([]);
  const [pinnedLaneIds, setPinnedLaneIds] = useState<Set<string>>(new Set());
  const [laneFilter, setLaneFilter] = useState("");
  const [laneStatusFilter, setLaneStatusFilter] = useState<"all" | "running" | "awaiting-input" | "ended">("all");
  const [manageOpen, setManageOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createLaneName, setCreateLaneName] = useState("");
  const [createParentLaneId, setCreateParentLaneId] = useState<string>("");
  const [createAsChild, setCreateAsChild] = useState(false);
  const [createBaseBranch, setCreateBaseBranch] = useState("");
  const [createBranches, setCreateBranches] = useState<LaneBranchOption[]>([]);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createEnvInitProgress, setCreateEnvInitProgress] = useState<LaneEnvInitProgress | null>(null);
  const createEnvInitLaneIdRef = useRef<string | null>(null);
  const [templates, setTemplates] = useState<LaneTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachName, setAttachName] = useState("");
  const [attachPath, setAttachPath] = useState("");
  const [attachBusy, setAttachBusy] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const canCreateLane = Boolean(project?.rootPath);
  const [adoptBusy, setAdoptBusy] = useState(false);
  const [adoptError, setAdoptError] = useState<string | null>(null);
  const [adoptConfirmOpen, setAdoptConfirmOpen] = useState(false);
  const [adoptTargetLaneId, setAdoptTargetLaneId] = useState<string | null>(null);
  const [adoptHintDismissed, setAdoptHintDismissed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(ADOPT_HINT_DISMISSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [deleteMode, setDeleteMode] = useState<"worktree" | "local_branch" | "remote_branch">("worktree");
  const [deleteRemoteName, setDeleteRemoteName] = useState("origin");
  const [deleteForce, setDeleteForce] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [laneActionBusy, setLaneActionBusy] = useState(false);
  const [laneActionError, setLaneActionError] = useState<string | null>(null);
  const [managedLaneIds, setManagedLaneIds] = useState<string[]>([]);
  const [conflictStatusByLane, setConflictStatusByLane] = useState<Record<string, ConflictStatus>>({});
  const [conflictChipsByLane, setConflictChipsByLane] = useState<Record<string, ConflictChip[]>>({});
  const chipTimersRef = useRef<Map<string, number>>(new Map());
  const hasActiveLaneSessionsRef = useRef(false);
  const [rebaseSuggestions, setRebaseSuggestions] = useState<RebaseSuggestion[]>([]);
  const [autoRebaseStatuses, setAutoRebaseStatuses] = useState<AutoRebaseLaneStatus[]>([]);
  const [autoRebaseEnabled, setAutoRebaseEnabled] = useState(false);
  const [rebaseBusyLaneId, setRebaseBusyLaneId] = useState<string | null>(null);
  const [rebaseSuggestionError, setRebaseSuggestionError] = useState<string | null>(null);
  const [rebaseScopePrompt, setRebaseScopePrompt] = useState<RebaseScopePromptState | null>(null);
  const [rebasePushReview, setRebasePushReview] = useState<RebasePushReviewState | null>(null);

  const [primaryBranches, setPrimaryBranches] = useState<LaneBranchOption[]>([]);
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);
  const [branchCheckoutBusy, setBranchCheckoutBusy] = useState(false);
  const [branchCheckoutError, setBranchCheckoutError] = useState<string | null>(null);
  const branchDropdownRef = useRef<HTMLDivElement>(null);

  const [addLaneDropdownOpen, setAddLaneDropdownOpen] = useState(false);
  const addLaneDropdownRef = useRef<HTMLDivElement>(null);

  const [lanePaneDetails, setLanePaneDetails] = useState<Record<string, LanePaneDetailSelection>>({});
  const [laneContextMenu, setLaneContextMenu] = useState<{ laneId: string; x: number; y: number } | null>(null);
  const [expandedLaneId, setExpandedLaneId] = useState<string | null>(null);
  const [expandedGitActionsLaneId, setExpandedGitActionsLaneId] = useState<string | null>(null);
  const [allSessions, setAllSessions] = useState<TerminalSessionSummary[]>([]);
  const [integrationProposals, setIntegrationProposals] = useState<IntegrationProposal[]>([]);

  const sortedLanes = useMemo(() => sortLanesForTabs(lanes), [lanes]);
  const lanesById = useMemo(() => new Map(sortedLanes.map((lane) => [lane.id, lane])), [sortedLanes]);
  const integrationSourcesByLaneId = useMemo(
    () => buildIntegrationSourcesByLaneId(integrationProposals, lanesById),
    [integrationProposals, lanesById],
  );
  const rebaseByLaneId = useMemo(
    () => new Map(rebaseSuggestions.map((s) => [s.laneId, s] as const)),
    [rebaseSuggestions]
  );
  const autoRebaseByLaneId = useMemo(
    () => new Map(autoRebaseStatuses.map((s) => [s.laneId, s] as const)),
    [autoRebaseStatuses]
  );

  const laneRuntimeById = useMemo(() => {
    const summaryByLane = new Map<string, LaneRuntimeSummary>();
    for (const lane of sortedLanes) {
      summaryByLane.set(lane.id, {
        bucket: "none",
        runningCount: 0,
        awaitingInputCount: 0,
        endedCount: 0,
        sessionCount: 0,
      });
    }
    for (const session of allSessions) {
      const laneSummary = summaryByLane.get(session.laneId);
      if (!laneSummary) continue;
      laneSummary.sessionCount += 1;
      const bucket = sessionStatusBucket({
        status: session.status,
        lastOutputPreview: session.lastOutputPreview,
        runtimeState: session.runtimeState,
      });
      if (bucket === "running") laneSummary.runningCount += 1;
      else if (bucket === "awaiting-input") laneSummary.awaitingInputCount += 1;
      else laneSummary.endedCount += 1;
    }
    for (const laneSummary of summaryByLane.values()) {
      if (laneSummary.runningCount > 0) laneSummary.bucket = "running";
      else if (laneSummary.awaitingInputCount > 0) laneSummary.bucket = "awaiting-input";
      else if (laneSummary.endedCount > 0) laneSummary.bucket = "ended";
      else laneSummary.bucket = "none";
    }
    return summaryByLane;
  }, [sortedLanes, allSessions]);

  const laneFilterMatchedLanes = useMemo(
    () => sortedLanes.filter((lane) => laneMatchesFilter(lane, pinnedLaneIds.has(lane.id), laneFilter)),
    [sortedLanes, laneFilter, pinnedLaneIds],
  );

  const laneStatusCounts = useMemo(() => {
    const counts = {
      all: laneFilterMatchedLanes.length,
      running: 0,
      "awaiting-input": 0,
      ended: 0,
      none: 0,
    };
    for (const lane of laneFilterMatchedLanes) {
      const bucket = laneRuntimeById.get(lane.id)?.bucket ?? "none";
      if (bucket === "running") counts.running += 1;
      else if (bucket === "awaiting-input") counts["awaiting-input"] += 1;
      else if (bucket === "ended") counts.ended += 1;
      else counts.none += 1;
    }
    return counts;
  }, [laneFilterMatchedLanes, laneRuntimeById]);

  const laneOrderById = useMemo(() => {
    const map = new Map<string, number>();
    sortedLanes.forEach((lane, index) => map.set(lane.id, index));
    return map;
  }, [sortedLanes]);

  useEffect(() => {
    return window.ade.lanes.onEnvEvent((event: LaneEnvInitEvent) => {
      if (event.progress.laneId !== createEnvInitLaneIdRef.current) return;
      setCreateEnvInitProgress(event.progress);
    });
  }, []);

  const filteredLanes = useMemo(() => {
    const bucketRank: Record<LaneRuntimeBucket, number> = {
      running: 0,
      "awaiting-input": 1,
      ended: 2,
      none: 3,
    };
    const base = [...laneFilterMatchedLanes];
    if (laneStatusFilter !== "all") {
      return base.filter((lane) => (laneRuntimeById.get(lane.id)?.bucket ?? "none") === laneStatusFilter);
    }
    return base.sort((a, b) => {
      const aPrimary = a.laneType === "primary" ? 0 : 1;
      const bPrimary = b.laneType === "primary" ? 0 : 1;
      if (aPrimary !== bPrimary) return aPrimary - bPrimary;
      const aBucket = laneRuntimeById.get(a.id)?.bucket ?? "none";
      const bBucket = laneRuntimeById.get(b.id)?.bucket ?? "none";
      const byBucket = bucketRank[aBucket] - bucketRank[bBucket];
      if (byBucket !== 0) return byBucket;
      return (laneOrderById.get(a.id) ?? 0) - (laneOrderById.get(b.id) ?? 0);
    });
  }, [laneFilterMatchedLanes, laneRuntimeById, laneStatusFilter, laneOrderById]);
  const stackGraphLanes = useMemo(() => sortLanesForStackGraph(filteredLanes), [filteredLanes]);

  const filteredLaneIds = useMemo(() => filteredLanes.map((lane) => lane.id), [filteredLanes]);
  const filteredSet = useMemo(() => new Set(filteredLaneIds), [filteredLaneIds]);
  const visibleRebaseSuggestions = useMemo(() => {
    const laneIdSet = new Set(filteredLaneIds);
    return rebaseSuggestions.filter((s) => laneIdSet.has(s.laneId));
  }, [rebaseSuggestions, filteredLaneIds]);
  const visibleAutoRebaseNeedsAttention = useMemo(() => {
    const laneIdSet = new Set(filteredLaneIds);
    return autoRebaseStatuses.filter((s) => laneIdSet.has(s.laneId) && s.state !== "autoRebased");
  }, [autoRebaseStatuses, filteredLaneIds]);
  const showAutoRebaseSettingsHint = !autoRebaseEnabled && (visibleRebaseSuggestions.length > 0 || visibleAutoRebaseNeedsAttention.length > 0);

  const activeWithPins = useMemo(
    () => mergeUnique(activeLaneIds, Array.from(pinnedLaneIds).filter((id) => lanesById.has(id))),
    [activeLaneIds, pinnedLaneIds, lanesById]
  );
  const visibleLaneIds = useMemo(
    () => activeWithPins.filter((id) => lanesById.has(id) && filteredSet.has(id)),
    [activeWithPins, lanesById, filteredSet]
  );

  const managedLane = selectedLaneId ? lanesById.get(selectedLaneId) ?? null : null;
  const managedLanes = useMemo(
    () => managedLaneIds.map((id) => lanesById.get(id)).filter((l): l is LaneSummary => l != null && l.laneType !== "primary"),
    [managedLaneIds, lanesById],
  );
  const isBatchManage = managedLanes.length > 1;
  const deletePhrase = isBatchManage
    ? `delete ${managedLanes.length} lanes`
    : managedLane
      ? `delete ${managedLane.name}`
      : "";
  const selectedAttachedLane = managedLane?.laneType === "attached" ? managedLane : null;
  const shouldShowAdoptHint = Boolean(selectedAttachedLane && !adoptHintDismissed);
  const adoptTargetLane = adoptTargetLaneId ? lanesById.get(adoptTargetLaneId) ?? null : null;

  const primaryLane = useMemo(() => lanes.find((l) => l.laneType === "primary") ?? null, [lanes]);

  /* ---- Primary branch management ---- */

  useEffect(() => {
    if (!primaryLane) return;
    window.ade.git.listBranches({ laneId: primaryLane.id })
      .then(setPrimaryBranches)
      .catch(() => {});
  }, [primaryLane?.id, primaryLane?.branchRef]);

  useEffect(() => {
    if (!primaryLane) return;
    const current = primaryBranches.find((branch) => branch.isCurrent && !branch.isRemote)?.name ?? null;
    if (!current || current === primaryLane.branchRef) return;
    refreshLanes().catch(() => {});
  }, [primaryBranches, primaryLane?.id, primaryLane?.branchRef, refreshLanes]);

  useClickOutside(branchDropdownRef, () => setBranchDropdownOpen(false), branchDropdownOpen);
  useClickOutside(addLaneDropdownRef, () => setAddLaneDropdownOpen(false), addLaneDropdownOpen);

  /* ---- Conflict loading ---- */

  const loadConflictStatuses = useCallback(async () => {
    try {
      const assessment = await window.ade.conflicts.getBatchAssessment();
      const next: Record<string, ConflictStatus> = {};
      for (const status of assessment.lanes) next[status.laneId] = status;
      setConflictStatusByLane(next);
    } catch { /* best effort */ }
  }, []);

  const refreshRebaseSuggestions = useCallback(async () => {
    try {
      const next = await window.ade.lanes.listRebaseSuggestions();
      setRebaseSuggestions(next);
    } catch { /* best effort */ }
  }, []);

  const refreshAutoRebaseStatuses = useCallback(async () => {
    try {
      const next = await window.ade.lanes.listAutoRebaseStatuses();
      setAutoRebaseStatuses(next);
    } catch { /* best effort */ }
  }, []);

  const refreshAutoRebaseEnabled = useCallback(async () => {
    try {
      const snapshot = await window.ade.projectConfig.get();
      const enabled =
        typeof snapshot.effective.git?.autoRebaseOnHeadChange === "boolean"
          ? snapshot.effective.git.autoRebaseOnHeadChange
          : false;
      setAutoRebaseEnabled(enabled);
    } catch {
      setAutoRebaseEnabled(false);
    }
  }, []);

  const refreshAllSessions = useCallback(async () => {
    try {
      const rows = await listSessionsCached({ limit: 500 });
      setAllSessions(rows.filter((session) => !isRunOwnedSession(session)));
    } catch {
      setAllSessions([]);
    }
  }, []);

  const refreshIntegrationProposals = useCallback(async () => {
    try {
      const proposals = await window.ade.prs.listProposals();
      setIntegrationProposals(proposals);
    } catch {
      setIntegrationProposals([]);
    }
  }, []);

  const pushConflictChips = useCallback((chips: ConflictChip[]) => {
    if (chips.length === 0) return;
    setConflictChipsByLane((prev) => {
      const next: Record<string, ConflictChip[]> = { ...prev };
      for (const chip of chips) {
        const laneList = next[chip.laneId] ? [...next[chip.laneId]!] : [];
        laneList.unshift(chip);
        next[chip.laneId] = laneList.slice(0, 3);
      }
      return next;
    });
    for (const chip of chips) {
      const key = `${chip.laneId}:${chip.peerId ?? "base"}:${chip.kind}`;
      const existing = chipTimersRef.current.get(key);
      if (existing) window.clearTimeout(existing);
      const now = Date.now();
      const timer = window.setTimeout(() => {
        setConflictChipsByLane((prev) => {
          const laneChips = prev[chip.laneId] ?? [];
          const filtered = laneChips.filter((entry) => {
            return !(entry.kind === chip.kind && entry.peerId === chip.peerId && entry.overlapCount === chip.overlapCount);
          });
          if (filtered.length === laneChips.length) return prev;
          return { ...prev, [chip.laneId]: filtered };
        });
        chipTimersRef.current.delete(key);
      }, Math.max(8_000, 12_000 - (Date.now() - now)));
      chipTimersRef.current.set(key, timer);
    }
  }, []);

  /* ---- Effects ---- */

  useEffect(() => {
    const laneId = params.get("laneId");
    const sessionId = params.get("sessionId");
    if (laneId) {
      selectLane(laneId);
      if (params.get("focus") === "single") {
        setActiveLaneIds([laneId]);
      }
    }
    if (sessionId) focusSession(sessionId);
  }, [params, selectLane, focusSession]);

  useEffect(() => { void loadConflictStatuses(); }, [loadConflictStatuses, lanes.length]);

  useEffect(() => {
    const unsubscribe = window.ade.conflicts.onEvent((event) => {
      if (event.type !== "prediction-complete") return;
      void loadConflictStatuses();
      pushConflictChips(event.chips);
    });
    return unsubscribe;
  }, [loadConflictStatuses, pushConflictChips]);

  useEffect(() => {
    void refreshRebaseSuggestions();
    const unsubscribe = window.ade.lanes.onRebaseSuggestionsEvent((event) => {
      if (event.type !== "rebase-suggestions-updated") return;
      setRebaseSuggestions(event.suggestions);
    });
    return unsubscribe;
  }, [refreshRebaseSuggestions]);

  useEffect(() => {
    void refreshAutoRebaseStatuses();
    const unsubscribe = window.ade.lanes.onAutoRebaseEvent((event) => {
      if (event.type !== "auto-rebase-updated") return;
      setAutoRebaseStatuses(event.statuses);
    });
    return unsubscribe;
  }, [refreshAutoRebaseStatuses]);

  useEffect(() => {
    const unsubscribe = window.ade.lanes.rebaseSubscribe((event) => {
      if (event.type !== "rebase-run-updated") return;
      if (event.run.state !== "failed" || !event.run.failedLaneId) return;
      const failedLane = lanesById.get(event.run.failedLaneId)?.name ?? event.run.failedLaneId;
      setRebaseSuggestionError(`Rebase needs attention for ${failedLane}. ${event.run.error ?? ""}`.trim());
    });
    return unsubscribe;
  }, [lanesById]);

  useEffect(() => { void refreshAutoRebaseEnabled(); }, [refreshAutoRebaseEnabled]);

  useEffect(() => {
    void refreshAllSessions();
  }, [refreshAllSessions, project?.rootPath]);

  useEffect(() => {
    hasActiveLaneSessionsRef.current = allSessions.some((session) => {
      const bucket = sessionStatusBucket({
        status: session.status,
        lastOutputPreview: session.lastOutputPreview,
        runtimeState: session.runtimeState,
      });
      return bucket === "running" || bucket === "awaiting-input";
    });
  }, [allSessions]);

  useEffect(() => {
    void refreshIntegrationProposals();
  }, [refreshIntegrationProposals, lanes.length, project?.rootPath]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (document.visibilityState !== "visible") return;
      if (timer) return; // already scheduled
      timer = setTimeout(() => {
        timer = null;
        void refreshAllSessions();
      }, 300);
    };
    const unsubPtyData = window.ade.pty.onData(scheduleRefresh);
    const unsubPtyExit = window.ade.pty.onExit(scheduleRefresh);
    const unsubChat = window.ade.agentChat.onEvent((payload) => {
      if (!shouldRefreshSessionListForChatEvent(payload)) return;
      scheduleRefresh();
    });
    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (!hasActiveLaneSessionsRef.current) return;
      void refreshAllSessions();
    }, 15_000);
    return () => {
      if (timer) clearTimeout(timer);
      try {
        unsubPtyData();
      } catch {
        // ignore
      }
      try {
        unsubPtyExit();
      } catch {
        // ignore
      }
      try {
        unsubChat();
      } catch {
        // ignore
      }
      window.clearInterval(intervalId);
    };
  }, [refreshAllSessions]);

  useEffect(() => {
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
  }, [refreshAutoRebaseEnabled]);

  useEffect(() => {
    return () => {
      for (const timer of chipTimersRef.current.values()) window.clearTimeout(timer);
      chipTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!laneContextMenu) return;
    const onPointerDown = () => setLaneContextMenu(null);
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [laneContextMenu]);

  useEffect(() => {
    if (!adoptTargetLaneId) return;
    if (lanesById.has(adoptTargetLaneId)) return;
    setAdoptConfirmOpen(false);
    setAdoptTargetLaneId(null);
    setAdoptError(null);
  }, [adoptTargetLaneId, lanesById]);

  useEffect(() => {
    setPinnedLaneIds((prev) => {
      const next = new Set<string>();
      for (const laneId of prev) {
        if (lanesById.has(laneId)) next.add(laneId);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [lanesById]);

  useEffect(() => {
    const pinned = Array.from(pinnedLaneIds).filter((laneId) => lanesById.has(laneId));
    setActiveLaneIds((prev) => {
      const validPrev = prev.filter((laneId) => lanesById.has(laneId));
      const selected = selectedLaneId && lanesById.has(selectedLaneId) ? [selectedLaneId] : [];
      const fallback = selected.length
        ? []
        : validPrev.length
          ? [validPrev[0]!]
          : sortedLanes[0]?.id
            ? [sortedLanes[0]!.id]
            : [];
      return mergeUnique(selected, fallback, validPrev, pinned);
    });
  }, [selectedLaneId, lanesById, sortedLanes, pinnedLaneIds]);

  useEffect(() => {
    setLanePaneDetails((prev) => {
      const next: Record<string, LanePaneDetailSelection> = {};
      for (const [laneId, detail] of Object.entries(prev)) {
        if (lanesById.has(laneId)) next[laneId] = detail;
      }
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [lanesById]);

  /* ---- Keyboard navigation ---- */

  const stepLaneSelection = useCallback((direction: -1 | 1) => {
    if (filteredLaneIds.length === 0) return;
    const currentId = selectedLaneId && filteredSet.has(selectedLaneId) ? selectedLaneId : filteredLaneIds[0]!;
    const currentIdx = filteredLaneIds.indexOf(currentId);
    const nextIdx = (currentIdx + direction + filteredLaneIds.length) % filteredLaneIds.length;
    const nextId = filteredLaneIds[nextIdx];
    if (!nextId) return;
    const pinned = Array.from(pinnedLaneIds).filter((laneId) => laneId !== nextId && lanesById.has(laneId));
    setActiveLaneIds(mergeUnique([nextId], pinned));
    selectLane(nextId);
  }, [filteredLaneIds, selectedLaneId, filteredSet, pinnedLaneIds, lanesById, selectLane]);

  const kbFilterFocus = useMemo(() => getEffectiveBinding(keybindings, "lanes.filter.focus", "/,Mod+F"), [keybindings]);
  const kbNext = useMemo(() => getEffectiveBinding(keybindings, "lanes.select.next", "J,ArrowDown"), [keybindings]);
  const kbPrev = useMemo(() => getEffectiveBinding(keybindings, "lanes.select.prev", "K,ArrowUp"), [keybindings]);
  const kbNextTab = useMemo(() => getEffectiveBinding(keybindings, "lanes.select.nextTab", "]"), [keybindings]);
  const kbPrevTab = useMemo(() => getEffectiveBinding(keybindings, "lanes.select.prevTab", "["), [keybindings]);
  const kbConfirm = useMemo(() => getEffectiveBinding(keybindings, "lanes.select.confirm", "Enter"), [keybindings]);

  useEffect(() => {
    if (expandedGitActionsLaneId && !lanesById.has(expandedGitActionsLaneId)) {
      setExpandedGitActionsLaneId(null);
    }
  }, [expandedGitActionsLaneId, lanesById]);

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const targetIsTyping = isTypingTarget(event.target);
      if (!targetIsTyping && eventMatchesBinding(event, kbFilterFocus)) {
        event.preventDefault();
        const input = document.getElementById("lanes-filter-input");
        if (input instanceof HTMLInputElement) { input.focus(); input.select(); }
        return;
      }
      if (event.key === "Escape" && expandedGitActionsLaneId) {
        event.preventDefault();
        setExpandedGitActionsLaneId(null);
        return;
      }
      if (event.key === "Escape" && expandedLaneId) {
        event.preventDefault();
        setExpandedLaneId(null);
        return;
      }
      if (targetIsTyping) {
        if (event.key === "Escape") {
          const active = document.activeElement;
          if (active instanceof HTMLInputElement && active.id === "lanes-filter-input") {
            event.preventDefault();
            if (laneFilter.length > 0) setLaneFilter("");
            else active.blur();
          }
        }
        return;
      }
      if (eventMatchesBinding(event, kbPrevTab) || eventMatchesBinding(event, kbNextTab)) {
        event.preventDefault();
        stepLaneSelection(eventMatchesBinding(event, kbNextTab) ? 1 : -1);
        return;
      }
      if (eventMatchesBinding(event, kbNext)) { event.preventDefault(); stepLaneSelection(1); return; }
      if (eventMatchesBinding(event, kbPrev)) { event.preventDefault(); stepLaneSelection(-1); return; }
      if (eventMatchesBinding(event, kbConfirm) && filteredLaneIds.length > 0) {
        event.preventDefault();
        const laneId = selectedLaneId && filteredSet.has(selectedLaneId) ? selectedLaneId : filteredLaneIds[0]!;
        const pinned = Array.from(pinnedLaneIds).filter((lane) => lane !== laneId && lanesById.has(lane));
        setActiveLaneIds(mergeUnique([laneId], pinned));
        selectLane(laneId);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [filteredLaneIds, filteredSet, selectedLaneId, pinnedLaneIds, lanesById, selectLane, laneFilter, stepLaneSelection, kbFilterFocus, kbNext, kbPrev, kbNextTab, kbPrevTab, kbConfirm, expandedLaneId, expandedGitActionsLaneId]);

  /* ---- Lane management actions ---- */

  const currentPrimaryBranch = useMemo(
    () => primaryBranches.find((branch) => branch.isCurrent)?.name ?? primaryLane?.branchRef ?? "",
    [primaryBranches, primaryLane?.branchRef]
  );
  const localPrimaryBranches = useMemo(
    () => primaryBranches.filter((branch) => !branch.isRemote),
    [primaryBranches]
  );
  const remotePrimaryBranches = useMemo(
    () => primaryBranches.filter((branch) => branch.isRemote),
    [primaryBranches]
  );

  const runLaneAction = async (fn: () => Promise<void>) => {
    setLaneActionBusy(true);
    setLaneActionError(null);
    try {
      await fn();
      await refreshLanes();
      setManageOpen(false);
    } catch (err) {
      setLaneActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setLaneActionBusy(false);
    }
  };

  const dismissAdoptHint = useCallback(() => {
    setAdoptHintDismissed(true);
    try {
      window.localStorage.setItem(ADOPT_HINT_DISMISSED_KEY, "1");
    } catch {
      // ignore persistence failures
    }
  }, []);

  const reopenAdoptHint = useCallback(() => {
    setAdoptHintDismissed(false);
    try {
      window.localStorage.removeItem(ADOPT_HINT_DISMISSED_KEY);
    } catch {
      // ignore persistence failures
    }
  }, []);

  const requestAdoptAttachedLane = useCallback((laneId: string) => {
    setAdoptError(null);
    setAdoptTargetLaneId(laneId);
    setAdoptConfirmOpen(true);
  }, []);

  const confirmAdoptAttachedLane = useCallback(async () => {
    const laneId = adoptTargetLaneId;
    if (!laneId) return;
    setAdoptBusy(true);
    setAdoptError(null);
    try {
      const lane = await window.ade.lanes.adoptAttached({ laneId });
      await refreshLanes();
      selectLane(lane.id);
      setAdoptConfirmOpen(false);
      setAdoptTargetLaneId(null);
    } catch (err) {
      setAdoptError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdoptBusy(false);
    }
  }, [adoptTargetLaneId, refreshLanes, selectLane]);

  const checkoutPrimaryBranch = useCallback(async (branchName: string) => {
    if (!primaryLane) return;
    if (primaryLane.status.dirty) {
      setBranchCheckoutError("Cannot switch branches while primary lane has uncommitted changes. Commit, stash, or discard changes first.");
      return;
    }
    setBranchCheckoutBusy(true);
    setBranchCheckoutError(null);
    let succeeded = false;
    try {
      await window.ade.git.checkoutBranch({ laneId: primaryLane.id, branchName });
      await refreshLanes();
      const updated = await window.ade.git.listBranches({ laneId: primaryLane.id });
      setPrimaryBranches(updated);
      succeeded = true;
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      setBranchCheckoutError(formatBranchCheckoutError(raw));
    } finally {
      setBranchCheckoutBusy(false);
      if (succeeded) setBranchDropdownOpen(false);
    }
  }, [primaryLane, refreshLanes]);

  const archiveManagedLanes = async () => {
    const targets = isBatchManage ? managedLanes : managedLane ? [managedLane] : [];
    const actionable = targets.filter((l) => l.laneType !== "primary");
    if (actionable.length === 0) return;
    await runLaneAction(async () => {
      for (const lane of actionable) {
        await window.ade.lanes.archive({ laneId: lane.id });
      }
    });
  };

  const deleteManagedLanes = async () => {
    const targets = isBatchManage ? managedLanes : managedLane ? [managedLane] : [];
    const actionable = targets.filter((l) => l.laneType !== "primary");
    if (actionable.length === 0) return;
    if (deleteConfirmText.trim().toLowerCase() !== deletePhrase.toLowerCase()) return;
    await runLaneAction(async () => {
      const errors: string[] = [];
      for (const lane of actionable) {
        try {
          const args: DeleteLaneArgs = { laneId: lane.id, force: deleteForce };
          if (deleteMode === "worktree") {
            args.deleteBranch = false;
          } else {
            args.deleteBranch = true;
            if (deleteMode === "remote_branch") {
              args.deleteRemoteBranch = true;
              args.remoteName = deleteRemoteName.trim() || "origin";
            }
          }
          await window.ade.lanes.delete(args);
        } catch (err) {
          errors.push(`${lane.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (errors.length > 0) {
        throw new Error(errors.join("\n"));
      }
      const deletedIds = new Set(actionable.map((l) => l.id));
      if (deletedIds.has(selectedLaneId ?? "")) selectLane(null);
      setActiveLaneIds((prev) => prev.filter((id) => !deletedIds.has(id)));
    });
  };

  const openBatchManage = useCallback((laneIds: string[]) => {
    const manageable = laneIds.filter((id) => {
      const lane = lanesById.get(id);
      return lane && lane.laneType !== "primary";
    });
    if (manageable.length === 0) return;
    setManagedLaneIds(manageable);
    setLaneActionError(null);
    setDeleteForce(false);
    setDeleteMode("worktree");
    setDeleteRemoteName("origin");
    setDeleteConfirmText("");
    setManageOpen(true);
  }, [lanesById]);

  const handleLaneSelect = useCallback((laneId: string, args: { extend: boolean }) => {
    const lane = lanesById.get(laneId);
    if (!lane) return;

    if (!args.extend) {
      const pinned = Array.from(pinnedLaneIds).filter((id) => id !== laneId && lanesById.has(id));
      setActiveLaneIds(mergeUnique([laneId], pinned));
      selectLane(laneId);
      return;
    }

    const isPinned = pinnedLaneIds.has(laneId);
    const isActive = activeWithPins.includes(laneId);
    if (isPinned && isActive) {
      selectLane(laneId);
      return;
    }

    const next = isActive ? activeWithPins.filter((id) => id !== laneId) : [...activeWithPins, laneId];
    const pinned = Array.from(pinnedLaneIds).filter((id) => lanesById.has(id));
    setActiveLaneIds(mergeUnique(next.length ? next : [laneId], pinned));
    selectLane(laneId);
  }, [lanesById, pinnedLaneIds, activeWithPins, selectLane]);

  const removeSplitLane = useCallback((laneId: string) => {
    if (pinnedLaneIds.has(laneId)) return;
    const pinned = Array.from(pinnedLaneIds).filter((id) => lanesById.has(id));
    const next = activeWithPins.filter((id) => id !== laneId);
    const normalized = mergeUnique(next, pinned);
    setActiveLaneIds(normalized);
    if (!normalized.includes(selectedLaneId ?? "")) {
      selectLane(normalized[0] ?? null);
    }
  }, [pinnedLaneIds, lanesById, activeWithPins, selectedLaneId, selectLane]);

  const togglePinnedLane = useCallback((laneId: string) => {
    const lane = lanesById.get(laneId);
    if (!lane || lane.laneType === "primary") return;
    const isPinned = pinnedLaneIds.has(laneId);
    setPinnedLaneIds((prev) => {
      const next = new Set(prev);
      if (next.has(laneId)) next.delete(laneId);
      else next.add(laneId);
      return next;
    });
    if (!isPinned) {
      setActiveLaneIds((prev) => mergeUnique(prev, [laneId]));
    }
  }, [lanesById, pinnedLaneIds]);

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
    setRebaseBusyLaneId(laneId);
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
        navigate("/prs?tab=rebase");
        return;
      }

      if (mode === "local_and_remote") {
        const laneIds = await requestPushSelection(start.run);
        if (laneIds == null) return;
        if (laneIds.length > 0) {
          await window.ade.lanes.rebasePush({ runId: start.runId, laneIds });
        }
      }

      await Promise.all([refreshLanes(), refreshRebaseSuggestions(), refreshAutoRebaseStatuses()]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRebaseSuggestionError(message);
      navigate("/prs?tab=rebase");
    } finally {
      setRebaseBusyLaneId(null);
    }
  }, [lanesById, navigate, refreshAutoRebaseStatuses, refreshLanes, refreshRebaseSuggestions, requestPushSelection, requestRebaseScope]);

  const dismissRebaseSuggestion = async (laneId: string) => {
    setRebaseSuggestionError(null);
    setRebaseBusyLaneId(laneId);
    try {
      await window.ade.lanes.dismissRebaseSuggestion({ laneId });
      await refreshRebaseSuggestions();
    } catch (err) {
      setRebaseSuggestionError(err instanceof Error ? err.message : String(err));
    } finally {
      setRebaseBusyLaneId(null);
    }
  };

  const deferRebaseSuggestion = async (laneId: string, minutes: number) => {
    setRebaseSuggestionError(null);
    setRebaseBusyLaneId(laneId);
    try {
      await window.ade.lanes.deferRebaseSuggestion({ laneId, minutes });
      await refreshRebaseSuggestions();
    } catch (err) {
      setRebaseSuggestionError(err instanceof Error ? err.message : String(err));
    } finally {
      setRebaseBusyLaneId(null);
    }
  };

  const openAutoRebaseSettings = useCallback(() => { navigate("/settings?tab=lane-templates"); }, [navigate]);
  const openRebaseDetails = useCallback(() => { navigate("/prs?tab=rebase"); }, [navigate]);

  const openRebaseConflictResolver = useCallback((laneId: string, parentLaneId: string | null) => {
    const search = new URLSearchParams({ tab: "rebase", laneId });
    if (parentLaneId) search.set("parentLaneId", parentLaneId);
    navigate(`/prs?${search.toString()}`);
  }, [navigate]);

  /* ---- Detail handlers ---- */

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

  /* ---- Create/Attach lane submit handlers ---- */

  const resetCreateDialogState = useCallback(() => {
    createEnvInitLaneIdRef.current = null;
    setCreateLaneName("");
    setCreateParentLaneId("");
    setCreateAsChild(false);
    setCreateBaseBranch("");
    setCreateBusy(false);
    setCreateError(null);
    setCreateEnvInitProgress(null);
    setSelectedTemplateId("");
  }, []);

  const prepareCreateDialog = useCallback(() => {
    setCreateLaneName("");
    setCreateParentLaneId("");
    setCreateAsChild(false);
    setCreateBaseBranch("");
    const primary = lanes.find((l) => l.laneType === "primary");
    if (primary) {
      window.ade.git.listBranches({ laneId: primary.id })
        .then((branches) => {
          setCreateBranches(branches);
          const current = branches.find((b) => b.isCurrent && !b.isRemote);
          if (current) setCreateBaseBranch(current.name);
        })
        .catch(() => {});
    }
    Promise.all([
      window.ade.lanes.listTemplates().catch(() => [] as LaneTemplate[]),
      window.ade.lanes.getDefaultTemplate().catch(() => null),
    ]).then(([nextTemplates, defaultTemplateId]) => {
      setTemplates(nextTemplates);
      setSelectedTemplateId(
        defaultTemplateId && nextTemplates.some((template) => template.id === defaultTemplateId)
          ? defaultTemplateId
          : ""
      );
    });
    setCreateOpen(true);
  }, [lanes]);

  const handleCreateDialogOpenChange = useCallback((open: boolean) => {
    if (!open && createBusy) return;
    if (!open) resetCreateDialogState();
    setCreateOpen(open);
  }, [createBusy, resetCreateDialogState]);

  const handleCreateSubmit = useCallback(async () => {
    const name = createLaneName.trim();
    if (!name || createBusy || (createAsChild && !createParentLaneId)) return;
    if (selectedTemplateId && !templates.some((template) => template.id === selectedTemplateId)) {
      setCreateError("The selected lane template no longer exists. Refresh templates or choose a different option.");
      return;
    }

    setCreateBusy(true);
    setCreateError(null);
    setCreateEnvInitProgress(null);
    createEnvInitLaneIdRef.current = null;

    try {
      const lane = createAsChild && createParentLaneId
        ? await window.ade.lanes.createChild({ name, parentLaneId: createParentLaneId })
        : await (() => {
            const primary = lanes.find((entry) => entry.laneType === "primary");
            return primary
              ? window.ade.lanes.create({ name, parentLaneId: primary.id })
              : window.ade.lanes.create({ name });
          })();

      await refreshLanes();
      navigate(`/lanes?laneId=${encodeURIComponent(lane.id)}&focus=single`);

      createEnvInitLaneIdRef.current = lane.id;
      const envProgress = selectedTemplateId
        ? await window.ade.lanes.applyTemplate({ laneId: lane.id, templateId: selectedTemplateId })
        : await window.ade.lanes.initEnv({ laneId: lane.id });
      setCreateEnvInitProgress(envProgress);

      if (envProgress.overallStatus === "failed") {
        setCreateError("Lane was created, but environment setup failed. Review the progress log and retry manually if needed.");
        return;
      }

      resetCreateDialogState();
      setCreateOpen(false);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreateBusy(false);
    }
  }, [createLaneName, createAsChild, createParentLaneId, createBusy, lanes, navigate, refreshLanes, resetCreateDialogState, selectedTemplateId, templates]);

  const handleAttachSubmit = useCallback(async () => {
    const name = attachName.trim();
    const attachedPath = attachPath.trim();
    if (!name || !attachedPath || attachBusy) return;
    setAttachBusy(true);
    setAttachError(null);
    try {
      const lane = await window.ade.lanes.attach({ name, attachedPath });
      await refreshLanes();
      setAttachOpen(false);
      setAttachName("");
      setAttachPath("");
      setAttachError(null);
      navigate(`/lanes?laneId=${encodeURIComponent(lane.id)}&focus=single`);
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : String(err));
    } finally {
      setAttachBusy(false);
    }
  }, [attachName, attachPath, attachBusy, refreshLanes, navigate]);

  const openManageDialog = useCallback((laneId: string) => {
    selectLane(laneId);
    setManagedLaneIds([laneId]);
    setLaneActionError(null);
    setAdoptError(null);
    setDeleteForce(false);
    setDeleteMode("worktree");
    setDeleteRemoteName("origin");
    setDeleteConfirmText("");
    setManageOpen(true);
  }, [selectLane]);

  /* ---- Pane configs ---- */

  const getPaneConfigs = useCallback((laneId: string | null) => {
    const laneDetail = laneId ? lanePaneDetails[laneId] ?? EMPTY_LANE_PANE_DETAIL : EMPTY_LANE_PANE_DETAIL;
    return {
      "stack": {
        title: "Stack",
        icon: Stack,
        bodyClassName: "overflow-hidden",
        children: (
          <LaneStackPane
            lanes={stackGraphLanes}
            selectedLaneId={laneId}
            onSelect={(id) => handleLaneSelect(id, { extend: false })}
            runtimeByLaneId={laneRuntimeById}
            integrationSourcesByLaneId={integrationSourcesByLaneId}
          />
        )
      },
      "git-actions": {
        title: "Git Actions",
        icon: FileCode,
        headerActions: laneId ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-5 w-5 p-0"
            title={expandedGitActionsLaneId === laneId ? "Minimize Git Actions pane" : "Expand Git Actions pane"}
            onClick={(event) => {
              event.stopPropagation();
              setExpandedLaneId(null);
              setExpandedGitActionsLaneId((prev) => (prev === laneId ? null : laneId));
            }}
          >
            {expandedGitActionsLaneId === laneId ? <ArrowsInSimple size={12} /> : <ArrowsOutSimple size={12} />}
          </Button>
        ) : null,
        bodyClassName: "overflow-hidden",
        children: (
          <LaneGitActionsPane
            laneId={laneId}
            autoRebaseEnabled={autoRebaseEnabled}
            onOpenSettings={openAutoRebaseSettings}
            onRebaseNowLocal={(targetLaneId) => runRebaseFlow(targetLaneId, "local_only")}
            onRebaseAndPush={(targetLaneId) => runRebaseFlow(targetLaneId, "local_and_remote")}
            onViewRebaseDetails={openRebaseDetails}
            onResolveRebaseConflict={openRebaseConflictResolver}
            selectedPath={laneDetail.selectedFilePath}
            selectedMode={laneDetail.selectedFileMode}
            selectedCommitSha={laneDetail.selectedCommit?.sha ?? null}
            onSelectFile={(path, mode) => { if (laneId) handleSelectFile(laneId, path, mode); }}
            onSelectCommit={(commit) => { if (laneId) handleSelectCommit(laneId, commit); }}
          />
        )
      },
      "diff-viewer": {
        title: "Diff",
        icon: FileCode,
        bodyClassName: "overflow-hidden",
        children: (
          <LaneDiffPane
            laneId={laneId}
            selectedPath={laneDetail.selectedFilePath}
            selectedFileMode={laneDetail.selectedFileMode}
            selectedCommit={laneDetail.selectedCommit}
          />
        )
      },
      "work": {
        title: "Work",
        icon: Terminal as any,
        bodyClassName: "overflow-hidden",
        children: <LaneWorkPane laneId={laneId} />
      },
    };
  }, [lanePaneDetails, stackGraphLanes, handleLaneSelect, handleSelectFile, handleSelectCommit, expandedGitActionsLaneId, autoRebaseEnabled, openAutoRebaseSettings, runRebaseFlow, openRebaseDetails, openRebaseConflictResolver, laneRuntimeById, integrationSourcesByLaneId]);

  /* ---- Render ---- */

  return (
    <div className="flex h-full min-w-0 flex-col" style={{ background: COLORS.pageBg }}>
      {/* Header bar */}
      <div style={{ padding: "0 24px", height: 64, display: "flex", alignItems: "center", gap: 24, background: COLORS.cardBg, backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", borderBottom: `1px solid ${COLORS.border}` }}>
        {/* Numbered title group */}
        <div className="flex items-center gap-2 shrink-0">
          <span style={{ fontFamily: MONO_FONT, fontSize: 10, fontWeight: 700, letterSpacing: "1px", color: COLORS.accent }}>05</span>
          <GitBranch size={18} style={{ color: COLORS.accent }} />
          <span style={{ fontFamily: SANS_FONT, fontSize: 20, fontWeight: 700, color: COLORS.textPrimary }}>LANES</span>
          <span style={inlineBadge(COLORS.accent, { fontSize: 9 })}>{filteredLanes.length}</span>
        </div>

        {/* Branch selector */}
        {primaryLane && selectedLaneId === primaryLane.id ? (
          <div className="relative shrink-0" ref={branchDropdownRef}>
            <button
              type="button"
              style={{
                display: "inline-flex", alignItems: "center", gap: 8,
                padding: "0 12px", height: 32, fontSize: 12, fontFamily: MONO_FONT, fontWeight: 600,
                color: COLORS.success, background: "rgba(255,255,255,0.03)",
                border: `1px solid ${COLORS.outlineBorder}`, borderRadius: 8, cursor: "pointer",
              }}
              onClick={() => setBranchDropdownOpen((prev) => !prev)}
              disabled={branchCheckoutBusy}
            >
              <GitBranch size={14} />
              <span>{currentPrimaryBranch || primaryLane.branchRef}</span>
              <CaretDown size={12} style={{ opacity: 0.6 }} />
            </button>
            {branchDropdownOpen ? (
              <div className="absolute left-0 top-full z-[200] mt-1 max-h-80 overflow-auto" style={{ width: 288, background: COLORS.cardBgSolid, backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", border: `1px solid ${COLORS.outlineBorder}`, borderRadius: 12, padding: "4px 0" }}>
                <div style={{ padding: "6px 12px", ...LABEL_STYLE }}>LOCAL BRANCHES</div>
                {localPrimaryBranches.map((branch) => (
                  <button
                    key={`local:${branch.name}`}
                    type="button"
                    className="flex w-full items-center gap-2 text-left"
                    style={{
                      padding: "6px 12px", fontSize: 12, fontFamily: MONO_FONT,
                      color: branch.isCurrent ? COLORS.success : COLORS.textMuted,
                      fontWeight: branch.isCurrent ? 600 : 400,
                      background: "transparent", border: "none", cursor: "pointer",
                    }}
                    disabled={branchCheckoutBusy || branch.isCurrent}
                    onClick={async () => {
                      if (branch.isCurrent) return;
                      await checkoutPrimaryBranch(branch.name);
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  >
                    {branch.isCurrent ? <Check size={12} className="shrink-0" /> : <span className="shrink-0" style={{ width: 12 }} />}
                    <span className="truncate">{branch.name}</span>
                    {branch.upstream ? <span className="ml-auto shrink-0" style={{ fontSize: 11, color: COLORS.textDim }}>tracked</span> : null}
                  </button>
                ))}
                {remotePrimaryBranches.length > 0 ? (
                  <>
                    <div style={{ margin: "4px 0", height: 1, background: COLORS.border }} />
                    <div style={{ padding: "6px 12px", ...LABEL_STYLE }}>REMOTE BRANCHES</div>
                    {remotePrimaryBranches.map((branch) => (
                      <button
                        key={`remote:${branch.name}`}
                        type="button"
                        className="flex w-full items-center gap-2 text-left"
                        style={{
                          padding: "6px 12px", fontSize: 12, fontFamily: MONO_FONT,
                          color: COLORS.textMuted, background: "transparent", border: "none", cursor: "pointer",
                        }}
                        disabled={branchCheckoutBusy}
                        onClick={async () => { await checkoutPrimaryBranch(branch.name); }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.hoverBg; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                      >
                        <span className="shrink-0" style={{ width: 12 }} />
                        <span className="truncate">{branch.name}</span>
                        <span className="ml-auto shrink-0" style={{ fontSize: 11, color: COLORS.info }}>remote</span>
                      </button>
                    ))}
                  </>
                ) : null}
                {localPrimaryBranches.length === 0 && remotePrimaryBranches.length === 0 ? (
                  <div style={{ padding: "6px 12px", fontSize: 12, color: COLORS.textMuted }}>No branches found.</div>
                ) : null}
                {branchCheckoutError ? (
                  <div style={{ padding: "6px 12px", fontSize: 11, color: COLORS.danger }}>{branchCheckoutError}</div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {branchCheckoutError && primaryLane && selectedLaneId === primaryLane.id ? (
          <div className="inline-flex items-center gap-2 shrink-0" style={{ border: `1px solid ${COLORS.danger}30`, background: `${COLORS.danger}15`, borderRadius: 8, padding: "4px 8px", fontSize: 12, color: COLORS.danger }}>
            <span>{branchCheckoutError}</span>
            <button
              type="button"
              style={{ background: "transparent", border: "none", padding: "0 4px", color: COLORS.danger, cursor: "pointer", fontSize: 14 }}
              onClick={() => setBranchCheckoutError(null)}
              title="Dismiss"
            >
              ×
            </button>
          </div>
        ) : null}

        {/* Filter input */}
        <div className="relative flex items-center shrink-0">
          <MagnifyingGlass size={14} className="pointer-events-none absolute" style={{ left: 8, color: COLORS.textDim }} />
          <input
            id="lanes-filter-input"
            value={laneFilter}
            onChange={(event) => setLaneFilter(event.target.value)}
            placeholder="FILTER LANES"
            title="Filter lanes (is:dirty is:pinned type:worktree)"
            style={{
              height: 32, width: 200, padding: "0 28px 0 28px", fontSize: 11,
              fontFamily: MONO_FONT, background: "rgba(255,255,255,0.03)",
              border: `1px solid ${COLORS.outlineBorder}`, borderRadius: 8, color: COLORS.textSecondary,
              outline: "none", textTransform: "uppercase", letterSpacing: "1px",
            }}
          />
          {laneFilter.trim().length > 0 ? (
            <button
              type="button"
              className="absolute"
              style={{ right: 4, top: "50%", transform: "translateY(-50%)", display: "inline-flex", width: 20, height: 20, alignItems: "center", justifyContent: "center", background: "transparent", border: "none", color: COLORS.textMuted, cursor: "pointer" }}
              onClick={() => setLaneFilter("")}
              title="Clear filter"
            >
              <X size={12} />
            </button>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1 overflow-x-auto pb-0.5">
          {([
            { key: "all", label: "ALL", color: COLORS.accent, count: laneStatusCounts.all },
            { key: "running", label: "RUNNING", color: COLORS.success, count: laneStatusCounts.running },
            { key: "awaiting-input", label: "AWAITING INPUT", color: COLORS.warning, count: laneStatusCounts["awaiting-input"] },
            { key: "ended", label: "ENDED", color: COLORS.danger, count: laneStatusCounts.ended },
          ] as const).map((chip) => {
            const active = laneStatusFilter === chip.key;
            return (
              <button
                key={chip.key}
                type="button"
                onClick={() => setLaneStatusFilter(chip.key)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  height: 24,
                  padding: "0 8px",
                  fontFamily: MONO_FONT,
                  fontSize: 9,
                  fontWeight: 700,
                  letterSpacing: "1px",
                  textTransform: "uppercase",
                  borderRadius: 6,
                  border: active ? `1px solid ${chip.color}60` : `1px solid ${COLORS.outlineBorder}`,
                  background: active ? `${chip.color}20` : "rgba(255,255,255,0.02)",
                  color: active ? chip.color : COLORS.textMuted,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
                title={`${chip.count} lane${chip.count === 1 ? "" : "s"}`}
              >
                <span>{chip.label}</span>
                <span style={{ color: active ? chip.color : COLORS.textDim }}>{chip.count}</span>
              </button>
            );
          })}
        </div>

        {/* NEW LANE button + dropdown */}
        <div className="relative shrink-0" ref={addLaneDropdownRef}>
          <button type="button" style={primaryButton({ height: 32, padding: "0 12px", fontSize: 10 })} disabled={!canCreateLane} onClick={() => setAddLaneDropdownOpen((prev) => !prev)}>
            <Plus size={12} /> NEW LANE
          </button>
          {addLaneDropdownOpen ? (
            <div className="absolute left-0 top-full z-[200] mt-2 w-60 rounded-xl border border-white/[0.06] bg-bg/80 p-1 shadow-float backdrop-blur-xl">
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-muted-fg transition-colors hover:bg-white/[0.04] hover:text-fg"
                onClick={() => {
                  setAddLaneDropdownOpen(false);
                  prepareCreateDialog();
                }}
              >
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.03] text-accent">
                  <Plus size={14} />
                </span>
                <span>
                  <span className="block font-medium">Create new lane</span>
                  <span className="block text-xs text-muted-fg/70">Start from primary or stack from another lane.</span>
                </span>
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-muted-fg transition-colors hover:bg-white/[0.04] hover:text-fg"
                onClick={() => {
                  setAddLaneDropdownOpen(false);
                  setAttachName("");
                  setAttachPath("");
                  setAttachBusy(false);
                  setAttachError(null);
                  setAttachOpen(true);
                }}
              >
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.03] text-info">
                  <Link size={14} />
                </span>
                <span>
                  <span className="block font-medium">Add existing worktree as lane</span>
                  <span className="block text-xs text-muted-fg/70">Track a worktree that already exists on disk.</span>
                </span>
              </button>
            </div>
          ) : null}
        </div>

        {shouldShowAdoptHint && selectedAttachedLane ? (
          <div
            className="shrink-0 flex items-center gap-2 rounded-lg border px-2 py-1"
            style={{ borderColor: `${COLORS.info}55`, background: `${COLORS.info}15` }}
          >
            <button
              type="button"
              className="inline-flex items-center gap-1"
              style={{
                fontFamily: MONO_FONT,
                fontSize: 10,
                letterSpacing: "0.8px",
                color: COLORS.info,
                background: "transparent",
                border: "none",
                cursor: "pointer"
              }}
              title={`Move '${selectedAttachedLane.name}' to .ade/worktrees`}
              onClick={() => requestAdoptAttachedLane(selectedAttachedLane.id)}
            >
              <ArrowSquareOut size={12} />
              MOVE TO .ADE
            </button>
            <div className="relative group">
              <Info size={12} style={{ color: COLORS.info }} />
              <div
                className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 -translate-x-1/2 whitespace-nowrap rounded-lg border px-2 py-1 text-[10px] opacity-0 transition-opacity group-hover:opacity-100"
                style={{
                  borderColor: `${COLORS.border}`,
                  background: COLORS.cardBg,
                  color: COLORS.textSecondary
                }}
              >
                Uses git worktree move. Branch/history stay the same.
              </div>
            </div>
            <button
              type="button"
              className="inline-flex items-center justify-center"
              style={{ width: 16, height: 16, border: "none", background: "transparent", color: COLORS.textMuted, cursor: "pointer" }}
              onClick={dismissAdoptHint}
              title="Dismiss this hint"
            >
              <X size={10} />
            </button>
          </div>
        ) : null}

        {/* Spacer */}
        <div style={{ flex: 1, height: 1 }} />

        {/* Stats */}
        <span style={{ fontFamily: MONO_FONT, fontSize: 10, fontWeight: 700, letterSpacing: "1px", color: COLORS.textMuted, textTransform: "uppercase", whiteSpace: "nowrap" }}>
          {filteredLanes.length}/{sortedLanes.length} LANES
        </span>
      </div>

      {/* Lane tabs -- horizontal numbered tab bar */}
      <div className="flex select-none overflow-x-auto" style={{ background: "rgba(255,255,255,0.01)", borderBottom: `1px solid ${COLORS.border}` }}>
        {filteredLanes.map((lane, index) => {
          const isVisible = visibleLaneIds.includes(lane.id);
          const isSelected = selectedLaneId === lane.id;
          const isInSplit = isVisible && !isSelected;
          const isPrimary = lane.laneType === "primary";
          const isPinned = pinnedLaneIds.has(lane.id);
          const closable = isVisible && visibleLaneIds.length > 1 && !isPinned;
          const conflictStatus = conflictStatusByLane[lane.id];
          const chips = conflictChipsByLane[lane.id] ?? [];
          const laneRuntime = laneRuntimeById.get(lane.id) ?? {
            bucket: "none",
            runningCount: 0,
            awaitingInputCount: 0,
            endedCount: 0,
            sessionCount: 0,
          };
          const rebaseSuggestion = rebaseByLaneId.get(lane.id) ?? null;
          const autoRebaseStatus = autoRebaseByLaneId.get(lane.id) ?? null;
          const tabNumber = String(index + 1).padStart(2, "0");

          return (
            <div
              key={lane.id}
              role="button"
              tabIndex={0}
              className="group flex items-center gap-2 cursor-pointer shrink-0"
              style={{
                padding: "0 16px",
                height: 44,
                borderLeft: isSelected
                  ? `2px solid ${COLORS.accent}`
                  : isInSplit
                    ? `2px solid rgba(167,139,250,0.35)`
                    : "2px solid transparent",
                background: isSelected
                  ? COLORS.accentSubtle
                  : isInSplit
                    ? "rgba(167,139,250,0.06)"
                    : "transparent",
                borderBottom: isInSplit
                  ? `1px solid rgba(167,139,250,0.18)`
                  : "1px solid transparent",
              }}
              onClick={(event) => {
                handleLaneSelect(lane.id, {
                  extend: Boolean(event.shiftKey || event.metaKey || event.ctrlKey)
                });
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setLaneContextMenu({ laneId: lane.id, x: event.clientX, y: event.clientY });
              }}
              onMouseEnter={(e) => {
                if (!isSelected && !isInSplit) e.currentTarget.style.background = COLORS.hoverBg;
              }}
              onMouseLeave={(e) => {
                if (!isSelected) e.currentTarget.style.background = isInSplit ? "rgba(167,139,250,0.06)" : "transparent";
              }}
            >
              {/* Tab number */}
              <span style={{
                fontFamily: MONO_FONT, fontSize: 10, fontWeight: 600, letterSpacing: "1px",
                color: isSelected ? COLORS.accent : COLORS.textDim,
              }}>{tabNumber}</span>
              {/* Primary: house icon; Non-primary: conflict status dot */}
              {isPrimary ? (
                <House size={12} className="shrink-0" style={{ color: COLORS.accent }} />
              ) : (
                <span className="shrink-0" style={{ width: 10, height: 10, borderRadius: "50%", background: conflictDotColor(conflictStatus?.status) }} />
              )}
              {/* Terminal attention spinner */}
              {laneRuntime.bucket === "running" || laneRuntime.bucket === "awaiting-input" ? (
                <span
                  title={
                    laneRuntime.bucket === "awaiting-input"
                      ? `${laneRuntime.awaitingInputCount} session${laneRuntime.awaitingInputCount === 1 ? "" : "s"} awaiting input`
                      : `${laneRuntime.runningCount} session${laneRuntime.runningCount === 1 ? "" : "s"} running`
                  }
                  className="shrink-0 animate-spin"
                  style={{
                    width: 8, height: 8, borderRadius: "50%",
                    border: `1.5px solid ${laneRuntime.bucket === "awaiting-input" ? COLORS.warning : COLORS.success}`,
                    borderTopColor: "transparent",
                  }}
                />
              ) : laneRuntime.bucket === "ended" ? (
                <span
                  title={`${laneRuntime.endedCount} ended session${laneRuntime.endedCount === 1 ? "" : "s"}`}
                  className="shrink-0"
                  style={{ width: 8, height: 8, borderRadius: "50%", background: COLORS.danger }}
                />
              ) : null}
              {/* Lane name */}
              <span className="truncate" style={{
                maxWidth: 180,
                fontFamily: SANS_FONT, fontSize: 12, letterSpacing: "0.5px", textTransform: "uppercase",
                fontWeight: isSelected ? 600 : 500,
                color: isSelected ? COLORS.textPrimary : COLORS.textMuted,
              }}>{lane.name}</span>
              {/* Branch ref pill for primary */}
              {isPrimary ? (
                <span style={{
                  display: "inline-flex", alignItems: "center", padding: "2px 6px",
                  fontFamily: MONO_FONT, fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px",
                  borderRadius: 6, color: COLORS.accent, background: COLORS.accentSubtle, border: `1px solid ${COLORS.accentBorder}`,
                }}>{lane.branchRef}</span>
              ) : null}
              {/* Behind badge (rebase suggestion) */}
              {rebaseSuggestion ? (
                <span style={{
                  display: "inline-flex", alignItems: "center", padding: "2px 6px", borderRadius: 6,
                  fontFamily: MONO_FONT, fontSize: 9, fontWeight: 700,
                  color: COLORS.warning, background: `${COLORS.warning}18`, border: `1px solid ${COLORS.warning}30`,
                }} title={`Behind ${rebaseSuggestion.baseLabel?.trim() || "base"} by ${rebaseSuggestion.behindCount} commit(s)`}>
                  ↑{rebaseSuggestion.behindCount}
                </span>
              ) : null}
              {/* Pinned badge */}
              {!isPrimary && isPinned ? (
                <span style={{
                  display: "inline-flex", alignItems: "center", padding: "2px 6px", borderRadius: 6,
                  fontFamily: MONO_FONT, fontSize: 9, fontWeight: 700,
                  color: COLORS.textMuted, background: "rgba(255,255,255,0.04)", border: `1px solid ${COLORS.border}`,
                }}>PINNED</span>
              ) : null}
              {/* Auto-rebase status badges */}
              {autoRebaseStatus?.state === "autoRebased" ? (
                <span style={inlineBadge(COLORS.success, { fontSize: 9 })} title={autoRebaseStatus.message ?? "Lane was rebased automatically."}>
                  REBASED
                </span>
              ) : null}
              {autoRebaseStatus?.state === "rebasePending" ? (
                <span style={inlineBadge(COLORS.warning, { fontSize: 9 })} title={autoRebaseStatus.message ?? "Auto-rebase is pending manual action."}>
                  PENDING
                </span>
              ) : null}
              {autoRebaseStatus?.state === "rebaseConflict" ? (
                <span
                  style={inlineBadge(COLORS.danger, { fontSize: 9 })}
                  title={autoRebaseStatus.message ?? "Auto-rebase stopped due to conflicts."}
                >
                  CONFLICT{autoRebaseStatus.conflictCount > 0 ? ` ${autoRebaseStatus.conflictCount}` : ""}
                </span>
              ) : null}
              {chips.slice(0, 1).map((chip, chipIndex) => (
                <span
                  key={`${chip.kind}:${chip.peerId ?? "base"}:${chipIndex}`}
                  style={inlineBadge(chip.kind === "high-risk" ? COLORS.danger : COLORS.warning, { fontSize: 9 })}
                >
                  {chipLabel(chip.kind)}
                </span>
              ))}
              {/* Pin toggle — appears on hover */}
              {!isPrimary ? (
                <button
                  type="button"
                  className="shrink-0 transition-opacity"
                  style={{
                    display: "inline-flex", width: 16, height: 16, alignItems: "center", justifyContent: "center",
                    background: isPinned ? `${COLORS.warning}25` : "transparent",
                    color: isPinned ? COLORS.warning : COLORS.textDim,
                    border: "none", cursor: "pointer",
                    opacity: isPinned ? 1 : 0,
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    togglePinnedLane(lane.id);
                  }}
                  title={isPinned ? "Unpin lane" : "Pin lane"}
                >
                  <PushPin size={10} />
                </button>
              ) : null}
              {/* Close from split — appears on hover */}
              {closable ? (
                <button
                  type="button"
                  className="shrink-0 transition-opacity opacity-0 group-hover:opacity-100"
                  style={{
                    display: "inline-flex", width: 16, height: 16, alignItems: "center", justifyContent: "center",
                    background: "transparent", color: COLORS.textDim, border: "none", cursor: "pointer",
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    removeSplitLane(lane.id);
                  }}
                  title="Remove from split"
                >
                  <X size={10} />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* Rebase / auto-rebase banners */}
      <LaneRebaseBanner
        visibleRebaseSuggestions={visibleRebaseSuggestions}
        visibleAutoRebaseNeedsAttention={visibleAutoRebaseNeedsAttention}
        showAutoRebaseSettingsHint={showAutoRebaseSettingsHint}
        lanesById={lanesById}
        rebaseBusyLaneId={rebaseBusyLaneId}
        rebaseSuggestionError={rebaseSuggestionError}
        onRebaseNowLocal={(laneId) => { void runRebaseFlow(laneId, "local_only"); }}
        onRebaseAndPush={(laneId) => { void runRebaseFlow(laneId, "local_and_remote"); }}
        onViewRebaseDetails={openRebaseDetails}
        onDismissRebase={(laneId) => { void dismissRebaseSuggestion(laneId); }}
        onDeferRebase={(laneId, minutes) => { void deferRebaseSuggestion(laneId, minutes); }}
        onOpenAutoRebaseSettings={openAutoRebaseSettings}
        onOpenRebaseConflictResolver={openRebaseConflictResolver}
      />

      {/* Floating pane tiling layout */}
      {visibleLaneIds.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          {sortedLanes.length === 0 ? (
            <EmptyState
              title="No lanes created yet"
              description="Lanes let you work on multiple features in parallel."
            >
              <Button
                size="sm"
                variant="primary"
                className="mt-3"
                disabled={!canCreateLane}
                onClick={() => {
                  prepareCreateDialog();
                }}
              >
                Create Lane
              </Button>
            </EmptyState>
          ) : (
            <EmptyState
              title={filteredLanes.length === 0 ? "No lanes match" : "No lane selected"}
              description={
                filteredLanes.length === 0
                  ? laneStatusFilter === "all"
                    ? "Adjust the lane filter."
                    : "Try a different status filter or adjust the lane filter."
                  : "Select a lane tab to begin."
              }
            />
          )}
        </div>
      ) : visibleLaneIds.length === 1 ? (
        <PaneTilingLayout
          layoutId={`lanes:tiling:${LANES_TILING_LAYOUT_VERSION}:${visibleLaneIds[0]}`}
          tree={LANES_TILING_TREE}
          panes={getPaneConfigs(visibleLaneIds[0] ?? null)}
          className="flex-1 min-h-0"
        />
      ) : (
        <Group
          key={`lanes-split-columns:${visibleLaneIds.join(",")}`}
          id="lanes-split-columns"
          orientation="horizontal"
          resizeTargetMinimumSize={RESIZE_TARGET_MINIMUM_SIZE}
          className="flex-1 min-h-0 min-w-0"
        >
          {visibleLaneIds.map((laneId, index) => {
            const defaultSize = Math.max(20, 100 / Math.max(1, visibleLaneIds.length));
            return (
              <Fragment key={laneId}>
                <Panel id={`lane-column:${laneId}`} minSize="18%" defaultSize={`${defaultSize}%`} className="min-h-0 min-w-0">
                  <PaneTilingLayout
                    layoutId={`lanes:tiling:${LANES_TILING_LAYOUT_VERSION}:${laneId}`}
                    tree={LANES_TILING_TREE}
                    panes={getPaneConfigs(laneId)}
                    className="h-full min-h-0"
                  />
                </Panel>
                {index < visibleLaneIds.length - 1 ? <ResizeGutter orientation="vertical" laneDivider /> : null}
              </Fragment>
            );
          })}
        </Group>
      )}

      {/* Fullscreen Git Actions pane overlay */}
      {expandedGitActionsLaneId && lanesById.has(expandedGitActionsLaneId) ? (
        <div className="fixed inset-0 z-[110] flex flex-col" style={{ background: COLORS.pageBg }}>
          <PaneTilingLayout
            layoutId={`lanes:git-actions:fullscreen:v1:${expandedGitActionsLaneId}`}
            tree={GIT_ACTIONS_FULLSCREEN_TREE}
            panes={getPaneConfigs(expandedGitActionsLaneId)}
            className="flex-1 min-h-0"
          />
        </div>
      ) : null}

      {/* Fullscreen lane overlay */}
      {expandedLaneId && lanesById.has(expandedLaneId) ? (
        <div className="fixed inset-0 z-[100] flex flex-col" style={{ background: COLORS.pageBg }}>
          <div className="absolute top-2 right-3 z-10">
            <button
              type="button"
              style={outlineButton({ height: 28, padding: "0 8px" })}
              onClick={() => setExpandedLaneId(null)}
              title="Exit fullscreen (Esc)"
            >
              <X size={16} />
            </button>
          </div>
          <PaneTilingLayout
            layoutId={`lanes:tiling:${LANES_TILING_LAYOUT_VERSION}:${expandedLaneId}`}
            tree={LANES_TILING_TREE}
            panes={getPaneConfigs(expandedLaneId)}
            className="flex-1 min-h-0"
          />
        </div>
      ) : null}

      {/* Lane tab context menu */}
      {laneContextMenu ? (
        <LaneContextMenu
          laneContextMenu={laneContextMenu}
          lanesById={lanesById}
          visibleLaneIds={visibleLaneIds}
          onClose={() => setLaneContextMenu(null)}
          onAdoptAttached={(laneId) => {
            reopenAdoptHint();
            requestAdoptAttachedLane(laneId);
          }}
          onManage={openManageDialog}
          selectLane={selectLane}
          onRemoveFromSplit={removeSplitLane}
          onCloseOtherSplits={(keepLaneId) => {
            const pinned = Array.from(pinnedLaneIds).filter((id) => lanesById.has(id));
            setActiveLaneIds(mergeUnique([keepLaneId], pinned));
            selectLane(keepLaneId);
          }}
          onSelectAll={() => {
            const allIds = filteredLanes.map((lane) => lane.id);
            setActiveLaneIds(allIds);
          }}
          onBatchManage={openBatchManage}
        />
      ) : null}

      {/* Manage Lane dialog */}
      <ManageLaneDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        managedLane={managedLane}
        managedLanes={managedLanes}
        deleteMode={deleteMode}
        setDeleteMode={setDeleteMode}
        deleteRemoteName={deleteRemoteName}
        setDeleteRemoteName={setDeleteRemoteName}
        deleteForce={deleteForce}
        setDeleteForce={setDeleteForce}
        deleteConfirmText={deleteConfirmText}
        setDeleteConfirmText={setDeleteConfirmText}
        deletePhrase={deletePhrase}
        laneActionBusy={laneActionBusy}
        laneActionError={laneActionError}
        onAdoptAttached={() => {
          if (!managedLane || managedLane.laneType !== "attached") return;
          reopenAdoptHint();
          requestAdoptAttachedLane(managedLane.id);
        }}
        onArchive={() => { archiveManagedLanes().catch(() => {}); }}
        onDelete={() => { deleteManagedLanes().catch(() => {}); }}
      />



      {/* Create Lane dialog */}
      <CreateLaneDialog
        open={createOpen}
        onOpenChange={handleCreateDialogOpenChange}
        createLaneName={createLaneName}
        setCreateLaneName={setCreateLaneName}
        createAsChild={createAsChild}
        setCreateAsChild={setCreateAsChild}
        createParentLaneId={createParentLaneId}
        setCreateParentLaneId={setCreateParentLaneId}
        createBaseBranch={createBaseBranch}
        setCreateBaseBranch={setCreateBaseBranch}
        createBranches={createBranches}
        lanes={lanes}
        onSubmit={handleCreateSubmit}
        busy={createBusy}
        error={createError}
        envInitProgress={createEnvInitProgress}
        templates={templates}
        selectedTemplateId={selectedTemplateId}
        setSelectedTemplateId={setSelectedTemplateId}
        onNavigateToTemplates={() => navigate("/settings?tab=lane-templates")}
      />

      {/* Attach Lane dialog */}
      <AttachLaneDialog
        open={attachOpen}
        onOpenChange={(open) => {
          setAttachOpen(open);
          if (!open) {
            setAttachBusy(false);
            setAttachError(null);
          }
        }}
        attachName={attachName}
        setAttachName={setAttachName}
        attachPath={attachPath}
        setAttachPath={setAttachPath}
        busy={attachBusy}
        error={attachError}
        onSubmit={handleAttachSubmit}
      />

      {adoptConfirmOpen ? (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.55)" }}>
          <div style={{ width: "min(620px, 100%)", background: COLORS.cardBgSolid, backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", border: `1px solid ${COLORS.outlineBorder}`, borderRadius: 16, padding: 20 }}>
            <div style={{ ...LABEL_STYLE, color: COLORS.info }}>MOVE ATTACHED LANE</div>
            <div style={{ marginTop: 10, fontSize: 13, color: COLORS.textPrimary }}>
              Move <strong>{adoptTargetLane?.name ?? "this lane"}</strong> into <code>.ade/worktrees</code>.
            </div>
            <div style={{ marginTop: 8, fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.5 }}>
              ADE uses <code>git worktree move</code>, so branch history and commits stay exactly the same.
            </div>
            {adoptTargetLane ? (
              <div style={{ marginTop: 10, padding: "8px 10px", background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, borderRadius: 12 }}>
                <div style={{ fontSize: 11, color: COLORS.textSecondary }}>Current path</div>
                <div className="truncate" style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textPrimary }}>
                  {adoptTargetLane.worktreePath}
                </div>
              </div>
            ) : null}
            {adoptError ? (
              <div style={{ marginTop: 10, padding: "8px 10px", background: `${COLORS.danger}12`, border: `1px solid ${COLORS.danger}40`, borderRadius: 8, color: "#FCA5A5", fontSize: 12 }}>
                {adoptError}
              </div>
            ) : null}
            <div className="flex justify-end gap-2" style={{ marginTop: 12 }}>
              <button
                type="button"
                style={outlineButton({ height: 30, padding: "0 10px", fontSize: 10 })}
                disabled={adoptBusy}
                onClick={() => {
                  setAdoptConfirmOpen(false);
                  setAdoptTargetLaneId(null);
                  setAdoptError(null);
                }}
              >
                CANCEL
              </button>
              <button
                type="button"
                style={primaryButton({ height: 30, padding: "0 10px", fontSize: 10 })}
                disabled={adoptBusy || !adoptTargetLane}
                onClick={() => { void confirmAdoptAttachedLane(); }}
              >
                {adoptBusy ? "MOVING..." : "MOVE TO .ADE"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

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
