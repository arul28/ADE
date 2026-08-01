import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type { AgentChatSession, LaneSummary, TerminalSessionSummary } from "../../../shared/types";
import {
  PROVIDER_TOOL_TYPE,
  type ExternalSessionImportResult,
  type ExternalSessionSummary,
} from "./importSessions/contract";
import {
  createDefaultWorkProjectViewState,
  selectActiveProjectStateKey,
  selectActiveProjectRoot,
  useAppStore,
  useAppStoreApi,
  useRootAppStore,
  type WorkDraftKind,
  type WorkGridSet,
  type WorkProjectViewState,
  type WorkSidebarTab,
  type WorkSessionListOrganization,
} from "../../state/appStore";
import { listSessionsCached, invalidateSessionListCache } from "../../lib/sessionListCache";
import {
  canonicalInputFromSummary,
  sessionCanonicalUiState,
  sessionFilingBucket,
} from "../../lib/terminalAttention";
import type { CanonicalStatusBucket } from "../../../shared/sessionCanonicalState";
import { nextSnoozeDeadlineMs } from "../../lib/sessionSnooze";
import { useLanePrsByLaneId } from "./useLanePrs";
import { applyWorkLaneManualMove, type WorkLaneSortMode } from "./workLaneOrder";
import {
  EMPTY_WORK_SESSION_FILTERS,
  isWorkSessionFilterEmpty,
  matchesWorkSessionFilters,
  type WorkSessionFilters,
} from "./workSessionFilters";
import { buildOptimisticChatSessionSummary } from "../../lib/sessions";
import {
  shouldRefreshSessionListForChatEvent,
  subscribeWorkChatSessionCreated,
} from "../../lib/chatSessionEvents";
import {
  LAUNCH_PROFILE_TITLE,
  LAUNCH_PROFILE_TOOL_TYPE,
  resolveLaunchFields,
  type WorkPtyLaunchArgs,
  type WorkPtyLaunchResult,
} from "./cliLaunch";
import { sortLanesForTabs } from "../lanes/laneUtils";
import { setPendingSessionAnchor } from "./pendingSessionAnchors";
import { useWorkMachineRouter } from "./useWorkMachineRouter";

type WorkStatusNavigation = "all" | "running" | "awaiting-input" | "ended" | "settled";

const DEFAULT_PROJECT_WORK_STATE: WorkProjectViewState = createDefaultWorkProjectViewState();

const OPTIMISTIC_PTY_SESSION_TTL_MS = 2 * 60 * 1000;
/** Upper bound on the single snooze-expiry timer (setTimeout overflows past ~24.8 days). */
const SNOOZE_TICK_MAX_DELAY_MS = 10 * 60 * 1000;
const STOPPED_RUNTIME_GUARD_TTL_MS = 12_000;
const EMPTY_STRING_ARRAY: string[] = [];
const EMPTY_LANE_SESSION_ORDER: Record<string, string[]> = {};
const EMPTY_GRID_SETS: WorkGridSet[] = [];

type WorkTabGroupKind = "lane" | "status" | "time";
type WorkTabGroupLane = Pick<LaneSummary, "id" | "name" | "laneType" | "createdAt" | "color">;

function compareSessionsByStartedAtDesc(left: TerminalSessionSummary, right: TerminalSessionSummary): number {
  return new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime();
}

/**
 * Settled rows are ranked by when they settled, not when they started. The list they are
 * partitioned out of is ordered by startedAt, so without this a session you started
 * yesterday and settle right now buries itself under sessions settled long before it.
 * Falls back to last activity, then start, so rows missing settledAt still sort stably.
 */
function settledRank(session: TerminalSessionSummary): number {
  for (const value of [session.settledAt, session.lastActivityAt, session.startedAt]) {
    if (!value) continue;
    const ms = new Date(value).getTime();
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

function compareSessionsBySettledAtDesc(left: TerminalSessionSummary, right: TerminalSessionSummary): number {
  return settledRank(right) - settledRank(left);
}

/**
 * Snoozed rows rank by when they come BACK — the whole point of the group is
 * "what returns first". Rows without a parseable deadline sink to the bottom.
 */
function snoozeWakeRank(session: TerminalSessionSummary): number {
  const ms = session.snoozedUntil ? new Date(session.snoozedUntil).getTime() : Number.NaN;
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
}

function compareSessionsByWakeAtAsc(left: TerminalSessionSummary, right: TerminalSessionSummary): number {
  return snoozeWakeRank(left) - snoozeWakeRank(right);
}

function upsertSessionByStartedAt(
  sessions: readonly TerminalSessionSummary[],
  session: TerminalSessionSummary,
): TerminalSessionSummary[] {
  return [session, ...sessions.filter((entry) => entry.id !== session.id)].sort(compareSessionsByStartedAtDesc);
}

function mergePendingOptimisticSession(
  persisted: TerminalSessionSummary,
  optimistic: TerminalSessionSummary,
): { session: TerminalSessionSummary; keepPending: boolean } {
  const optimisticPtyId = optimistic.ptyId?.trim() || null;
  if (!optimisticPtyId) return { session: persisted, keepPending: false };

  if (persisted.status !== "running") {
    return { session: persisted, keepPending: false };
  }

  const persistedPtyId = persisted.ptyId?.trim() || null;
  if (persistedPtyId === optimisticPtyId) {
    return { session: persisted, keepPending: false };
  }

  return {
    session: {
      ...persisted,
      ptyId: optimisticPtyId,
      toolType: persisted.toolType ?? optimistic.toolType,
      runtimeState: persisted.runtimeState ?? optimistic.runtimeState,
    },
    keepPending: true,
  };
}

export type WorkTabGroup = {
  id: string;
  label: string;
  kind: WorkTabGroupKind;
  collapsed: boolean;
  sessionIds: string[];
  sessions: TerminalSessionSummary[];
  /** From Lanes tab; only set for `kind === "lane"`. */
  laneColor: string | null;
};

export type WorkTabGroupModel = {
  groups: WorkTabGroup[];
  sessionIds: string[];
  visibleSessions: TerminalSessionSummary[];
};

function bucketByTime(session: TerminalSessionSummary): "today" | "yesterday" | "older" {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86400000;
  const startedAt = new Date(session.startedAt).getTime();
  if (startedAt >= todayStart) return "today";
  if (startedAt >= yesterdayStart) return "yesterday";
  return "older";
}

/**
 * Snoozed is a partition of the status grouping, not a canonical bucket — it is
 * derived from the snooze columns and pulls the row OUT of whichever status
 * bucket it would otherwise land in, unless the row is asking for you.
 */
type WorkStatusGroupBucket = CanonicalStatusBucket | "snoozed";

function getStatusBucketLabel(bucket: WorkStatusGroupBucket): string {
  if (bucket === "running") return "Running";
  if (bucket === "awaiting-input") return "Your move";
  if (bucket === "snoozed") return "Snoozed";
  if (bucket === "settled") return "Settled";
  return "Ended";
}

export function buildWorkTabGroupModel(args: {
  sessions: TerminalSessionSummary[];
  lanes: WorkTabGroupLane[];
  organization: WorkSessionListOrganization;
  collapsedGroupIds: string[];
  laneSessionOrder?: Record<string, string[]>;
  pinnedSessionIds?: string[];
  /** Injectable clock so snooze expiry stays testable (expiry is derived, never scheduled). */
  nowMs?: number;
}): WorkTabGroupModel {
  const orderedSessions = [...args.sessions].sort(compareSessionsByStartedAtDesc);
  const collapseSet = new Set(args.collapsedGroupIds);
  const pinnedSet = new Set(args.pinnedSessionIds ?? []);
  const laneOrderMap = args.laneSessionOrder ?? {};

  if (args.organization === "by-lane") {
    const laneOrder = new Map(sortLanesForTabs(args.lanes).map((lane, index) => [lane.id, index] as const));
    const laneGroups = new Map<string, { id: string; label: string; kind: WorkTabGroupKind; sessions: TerminalSessionSummary[] }>();

    for (const session of orderedSessions) {
      const lane = args.lanes.find((entry) => entry.id === session.laneId);
      const groupId = `lane:${session.laneId}`;
      const group = laneGroups.get(groupId) ?? {
        id: groupId,
        label: lane?.name ?? session.laneName,
        kind: "lane" as const,
        sessions: [],
      };
      group.sessions.push(session);
      laneGroups.set(groupId, group);
    }

    const groups = [...laneGroups.values()].sort((left, right) => {
      const leftIdx = laneOrder.get(left.id.slice("lane:".length)) ?? Number.MAX_SAFE_INTEGER;
      const rightIdx = laneOrder.get(right.id.slice("lane:".length)) ?? Number.MAX_SAFE_INTEGER;
      if (leftIdx !== rightIdx) return leftIdx - rightIdx;
      return left.label.localeCompare(right.label);
    });

    const visibleSessions: TerminalSessionSummary[] = [];
    const finalGroups = groups.map((group) => {
      const laneId = group.id.startsWith("lane:") ? group.id.slice("lane:".length) : null;
      const lane = laneId ? args.lanes.find((l) => l.id === laneId) : null;
      const collapsed = collapseSet.has(group.id);

      const customOrder = laneId ? laneOrderMap[laneId] : undefined;
      let arranged = group.sessions;
      if (customOrder && customOrder.length > 0) {
        const sessionById = new Map(group.sessions.map((s) => [s.id, s] as const));
        const used = new Set<string>();
        const ordered: TerminalSessionSummary[] = [];
        for (const id of customOrder) {
          const s = sessionById.get(id);
          if (s && !used.has(id)) {
            ordered.push(s);
            used.add(id);
          }
        }
        for (const s of group.sessions) {
          if (!used.has(s.id)) ordered.push(s);
        }
        arranged = ordered;
      }
      if (pinnedSet.size > 0) {
        const pinned: TerminalSessionSummary[] = [];
        const others: TerminalSessionSummary[] = [];
        for (const s of arranged) {
          if (pinnedSet.has(s.id)) pinned.push(s);
          else others.push(s);
        }
        arranged = [...pinned, ...others];
      }

      if (!collapsed) visibleSessions.push(...arranged);
      return {
        id: group.id,
        label: group.label,
        kind: group.kind,
        laneColor: group.kind === "lane" ? (lane?.color ?? null) : null,
        collapsed,
        sessionIds: arranged.map((session) => session.id),
        sessions: arranged,
      } satisfies WorkTabGroup;
    });
    return { groups: finalGroups, sessionIds: visibleSessions.map((session) => session.id), visibleSessions };
  }

  if (args.organization === "by-time") {
    const timeOrder: Array<"today" | "yesterday" | "older"> = ["today", "yesterday", "older"];
    const buckets = new Map<"today" | "yesterday" | "older", TerminalSessionSummary[]>();
    for (const session of orderedSessions) {
      const bucket = bucketByTime(session);
      const list = buckets.get(bucket) ?? [];
      list.push(session);
      buckets.set(bucket, list);
    }

    const visibleSessions: TerminalSessionSummary[] = [];
    const groups = timeOrder
      .filter((bucket) => (buckets.get(bucket)?.length ?? 0) > 0)
      .map((bucket) => {
        const sessions = buckets.get(bucket) ?? [];
        const groupId = `time:${bucket}`;
        const collapsed = collapseSet.has(groupId);
        if (!collapsed) visibleSessions.push(...sessions);
        return {
          id: groupId,
          label: bucket === "today" ? "Today" : bucket === "yesterday" ? "Yesterday" : "Older",
          kind: "time" as const,
          laneColor: null,
          collapsed,
          sessionIds: sessions.map((session) => session.id),
          sessions,
        } satisfies WorkTabGroup;
      });

    return { groups, sessionIds: visibleSessions.map((session) => session.id), visibleSessions };
  }

  const nowMs = args.nowMs ?? Date.now();
  const statusBuckets = new Map<WorkStatusGroupBucket, TerminalSessionSummary[]>();
  for (const session of orderedSessions) {
    // Snooze is a visibility overlay: it pulls the row out of its normal bucket
    // entirely — the same partitioning the flat sidebar list uses — EXCEPT when
    // the row's canonical phase is needs_you. The overlay yields to a raised
    // hand (`sessionFilingBucket`), which is the only thing that makes
    // "Until I'm asked" true for tracked CLI rows: their needs-input state is
    // derived, so no early-wake event ever fires for them.
    const bucket: WorkStatusGroupBucket = sessionFilingBucket(session, nowMs);
    const list = statusBuckets.get(bucket) ?? [];
    list.push(session);
    statusBuckets.set(bucket, list);
  }
  // Same rule as the flat list: the settled group ranks by settle time, not start
  // time, and the snoozed group ranks by when each row wakes.
  statusBuckets.get("settled")?.sort(compareSessionsBySettledAtDesc);
  statusBuckets.get("snoozed")?.sort(compareSessionsByWakeAtAsc);

  const statusOrder: WorkStatusGroupBucket[] = ["running", "awaiting-input", "ended", "snoozed", "settled"];
  const visibleSessions: TerminalSessionSummary[] = [];
  const groups = statusOrder
    .filter((bucket) => (statusBuckets.get(bucket)?.length ?? 0) > 0)
    .map((bucket) => {
      const sessions = statusBuckets.get(bucket) ?? [];
      const groupId = `status:${bucket}`;
      const collapsed = collapseSet.has(groupId);
      if (!collapsed) visibleSessions.push(...sessions);
      return {
        id: groupId,
        label: getStatusBucketLabel(bucket),
        kind: "status" as const,
        laneColor: null,
        collapsed,
        sessionIds: sessions.map((session) => session.id),
        sessions,
      } satisfies WorkTabGroup;
    });

  return { groups, sessionIds: visibleSessions.map((session) => session.id), visibleSessions };
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function reorderLaneSessionIdsForDisplay(args: {
  baseOrder: string[];
  pinnedSessionIds: string[];
  movedSessionId: string;
  targetSessionId: string;
  edge: "before" | "after";
}): string[] | null {
  if (!args.movedSessionId || !args.targetSessionId || args.movedSessionId === args.targetSessionId) {
    return null;
  }
  const pinned = new Set(args.pinnedSessionIds);
  const displayedOrder = [
    ...args.baseOrder.filter((id) => pinned.has(id)),
    ...args.baseOrder.filter((id) => !pinned.has(id)),
  ];
  const fromIndex = displayedOrder.indexOf(args.movedSessionId);
  const targetIndex = displayedOrder.indexOf(args.targetSessionId);
  if (fromIndex < 0 || targetIndex < 0) return null;

  const next = [...displayedOrder];
  const [moved] = next.splice(fromIndex, 1);
  if (!moved) return null;
  const targetAfterRemoval = next.indexOf(args.targetSessionId);
  if (targetAfterRemoval < 0) return null;
  next.splice(args.edge === "after" ? targetAfterRemoval + 1 : targetAfterRemoval, 0, moved);
  return arraysEqual(args.baseOrder, next) ? null : next;
}

function mapUrlStatusFilter(statusParamRaw: string): WorkStatusNavigation | null {
  const statusParam = statusParamRaw.trim().toLowerCase();
  if (!statusParam) return null;
  if (statusParam === "running") return "running";
  if (statusParam === "awaiting-input" || statusParam === "awaiting") return "awaiting-input";
  if (statusParam === "ended") return "ended";
  if (statusParam === "settled") return "settled";
  if (statusParam === "all") return "all";
  if (statusParam === "completed" || statusParam === "failed" || statusParam === "disposed" || statusParam === "detached") return "ended";
  return null;
}

function statusSectionId(status: WorkStatusNavigation): string | null {
  if (status === "running") return "status:running";
  if (status === "awaiting-input") return "status:awaiting";
  if (status === "ended") return "status:ended";
  if (status === "settled") return "status:settled";
  return null;
}

type QueuedRefresh = {
  showLoading: boolean;
  force: boolean;
  deferred: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (reason: unknown) => void;
  };
};

type PendingOptimisticSession = {
  session: TerminalSessionSummary;
  createdAtMs: number;
};

type StoppedRuntimeSession = {
  ptyId: string;
  endedAt: string;
  expiresAtMs: number;
};

type UseWorkSessionsOptions = {
  active?: boolean;
};

const LOCAL_RUNNING_SESSION_REFRESH_INTERVAL_MS = 5_000;
const REMOTE_RUNNING_SESSION_REFRESH_INTERVAL_MS = 15_000;

export function useWorkSessions({ active = true }: UseWorkSessionsOptions = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const appStore = useAppStoreApi();
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const projectStateKey = useAppStore(selectActiveProjectStateKey);
  const isRemoteProject = useAppStore((s) => s.projectBinding?.kind === "remote");
  const lanes = useAppStore((s) => s.lanes);
  const focusSession = useAppStore((s) => s.focusSession);
  const selectLane = useAppStore((s) => s.selectLane);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const workViewByProject = useAppStore((s) => s.workViewByProject);
  const setWorkViewState = useAppStore((s) => s.setWorkViewState);
  const crossMachineLanesByMachineId = useRootAppStore((s) => s.crossMachineLanesByMachineId);
  const machineRouter = useWorkMachineRouter();

  const [sessions, setSessions] = useState<TerminalSessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  /** Bumped when the soonest snooze deadline lapses so the partition re-derives. */
  const [snoozeEpoch, setSnoozeEpoch] = useState(0);
  const [closingPtyIds, setClosingPtyIds] = useState<Set<string>>(new Set());
  const sessionsRef = useRef<TerminalSessionSummary[]>([]);
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef<QueuedRefresh | null>(null);
  const pendingOptimisticSessionsRef = useRef<Map<string, PendingOptimisticSession>>(new Map());
  const stoppedRuntimeSessionsRef = useRef<Map<string, StoppedRuntimeSession>>(new Map());
  // A pin that differs from the active binding used to mean "stale detached
  // launch", so its updates were dropped. Under per-chat runtime routing that
  // is the normal, correct state for every chat whose lane lives on another
  // machine — the whole point is that those chats stream without rebinding the
  // tab. The question is no longer "is this the active binding?" but "is this
  // binding still open?", so updates for a foreign chat are applied and only a
  // pin for a closed project is discarded.
  const canMutatePinnedProjectUi = useCallback(
    (pin: WorkPtyLaunchArgs["pin"] | undefined) => machineRouter.isLivePin(pin),
    [machineRouter],
  );
  const hasRunningSessionsRef = useRef(false);
  const backgroundRefreshTimerRef = useRef<number | null>(null);
  const pendingHiddenSessionRefreshRef = useRef(false);
  const appliedQuerySessionIdRef = useRef<string | null>(null);
  const appliedUrlFilterKeyRef = useRef<string | null>(null);
  const partiallyAppliedUrlFilterKeyRef = useRef<string | null>(null);
  const hasLoadedOnceRef = useRef(false);
  /** True only after `refresh` has applied sessions for the active project (not cache-only). */
  const hasAuthoritativeSessionsRef = useRef(false);
  /** Blocks mirror/prune while `sessions` still reflects the previous project after `projectRoot` changes. */
  const pendingProjectSwitchRef = useRef<string | null>(null);
  const projectRootRef = useRef<string | null>(projectRoot);
  const laneRecoveryRefreshKeyRef = useRef<string | null>(null);
  const isWorkRoute = active && (location.pathname === "/work" || location.pathname.startsWith("/work/"));

  useEffect(() => {
    projectRootRef.current = projectRoot;
  }, [projectRoot]);

  /**
   * A `?laneId=`/`?status=` deeplink retargets the view for one navigation. It
   * must not be written to the persisted view state: now that grouping and
   * collapse survive tab switches, persisting it would mean a single
   * notification tap permanently replaced the grouping the user chose. Held as
   * a transient layer over the persisted state instead, dropped as soon as the
   * user touches the view themselves or leaves Work.
   */
  const [deeplinkViewOverride, setDeeplinkViewOverride] = useState<{
    laneFilter: string | null;
    sessionListOrganization: WorkSessionListOrganization | null;
    expandSectionId: string | null;
  } | null>(null);

  const projectViewState = useMemo(() => {
    const persisted = projectStateKey
      ? workViewByProject[projectStateKey] ?? DEFAULT_PROJECT_WORK_STATE
      : DEFAULT_PROJECT_WORK_STATE;
    if (!deeplinkViewOverride) return persisted;
    return {
      ...persisted,
      laneFilter: deeplinkViewOverride.laneFilter ?? persisted.laneFilter,
      sessionListOrganization:
        deeplinkViewOverride.sessionListOrganization ?? persisted.sessionListOrganization,
      workCollapsedSectionIds: deeplinkViewOverride.expandSectionId
        ? [
          ...(persisted.workCollapsedSectionIds ?? []).filter(
            (sectionId) => sectionId !== deeplinkViewOverride.expandSectionId,
          ),
          // The quiet shelves (`status:snoozed` / `status:settled`) default to
          // COLLAPSED, so dropping their id is not enough to open one — absence
          // is their closed state. They read an explicit `shelf-open:` marker
          // instead (see `quietShelfOpenMarker` in SessionListPane), which this
          // transient layer supplies for the navigation. Harmless for every
          // other section: nothing consults a marker they do not use.
          `shelf-open:${deeplinkViewOverride.expandSectionId}`,
        ]
        : persisted.workCollapsedSectionIds,
    };
  }, [deeplinkViewOverride, projectStateKey, workViewByProject]);

  const setProjectViewState = useCallback(
    (
      next:
        | Partial<WorkProjectViewState>
        | ((prev: WorkProjectViewState) => WorkProjectViewState),
    ) => {
      if (!projectStateKey) return;
      setWorkViewState(projectStateKey, next);
    },
    [projectStateKey, setWorkViewState],
  );

  /**
   * Re-asserts the user's own view over a deeplink's temporary framing. Called
   * from the setters for the fields the override shadows — not from every
   * `setProjectViewState`, since opening a tab or focusing a session writes
   * unrelated fields and must not cancel the navigation the user just followed.
   */
  const clearDeeplinkViewOverride = useCallback(() => {
    setDeeplinkViewOverride((prev) => (prev ? null : prev));
  }, []);

  // Leaving Work ends the deeplink's navigation context.
  useEffect(() => {
    if (!isWorkRoute) setDeeplinkViewOverride(null);
  }, [isWorkRoute]);

  const openItemIds = projectViewState.openItemIds;
  const activeItemId = projectViewState.activeItemId;
  const selectedSessionId = projectViewState.selectedItemId;
  const draftKind = projectViewState.draftKind;
  const orchestratorEnabled = projectViewState.orchestratorEnabled;
  const draftLaneId = projectViewState.draftLaneId;
  const draftMachineId = projectViewState.draftMachineId;
  const filterLaneId = projectViewState.laneFilter;
  const q = projectViewState.search;
  const sessionListOrganization: WorkSessionListOrganization =
    projectViewState.sessionListOrganization ?? "by-lane";
  const workCollapsedLaneIds = projectViewState.workCollapsedLaneIds ?? EMPTY_STRING_ARRAY;
  const workCollapsedTabGroupIds = projectViewState.workCollapsedTabGroupIds ?? EMPTY_STRING_ARRAY;
  const workCollapsedSectionIds = projectViewState.workCollapsedSectionIds ?? EMPTY_STRING_ARRAY;
  const workFocusSessionsHidden = projectViewState.workFocusSessionsHidden ?? false;
  const workSidebarOpen = projectViewState.workSidebarOpen ?? false;
  const workSidebarTab = projectViewState.workSidebarTab ?? "git";
  const workSidebarWidthPct = projectViewState.workSidebarWidthPct ?? 36;
  const laneSessionOrder = projectViewState.laneSessionOrder ?? EMPTY_LANE_SESSION_ORDER;
  const pinnedSessionIds = projectViewState.pinnedSessionIds ?? EMPTY_STRING_ARRAY;
  const workPinnedLaneIds = projectViewState.workPinnedLaneIds ?? EMPTY_STRING_ARRAY;
  const workLaneSortMode = projectViewState.workLaneSortMode ?? "created";
  const workLaneOrder = projectViewState.workLaneOrder ?? EMPTY_STRING_ARRAY;
  const workSessionFilters = projectViewState.workSessionFilters ?? EMPTY_WORK_SESSION_FILTERS;
  // This index is intentionally active-binding-only: local lane selection,
  // refresh cadence, and optimistic writes must never target a foreign slice.
  const localSessionsById = useMemo(() => {
    const map = new Map<string, TerminalSessionSummary>();
    for (const session of sessions) map.set(session.id, session);
    return map;
  }, [sessions]);
  const retainedCrossMachineSessionsRef = useRef<{
    projectStateKey: string | null;
    sessionsByMachineId: Map<string, Map<string, TerminalSessionSummary>>;
    /** Machines still waiting for an authoritative slice after a wholesale scope refill. */
    pendingMachineIds: Set<string> | null;
  }>({ projectStateKey: null, sessionsByMachineId: new Map(), pendingMachineIds: null });
  const crossMachineSessionsById = useMemo(() => {
    let retained = retainedCrossMachineSessionsRef.current;
    if (retained.projectStateKey !== projectStateKey) {
      retained = {
        projectStateKey,
        sessionsByMachineId: new Map(),
        pendingMachineIds: null,
      };
      retainedCrossMachineSessionsRef.current = retained;
    }

    const machines = Object.values(crossMachineLanesByMachineId);
    if (machines.length === 0) {
      // Scope reload clears the replace-on-refresh machine map before its next
      // slices arrive. Mark every previously listed machine pending so the first
      // slice to return cannot evict the other machines' tabs or grid members.
      // Project changes reset the ref above, preserving the same-project rule.
      if (retained.sessionsByMachineId.size > 0 && retained.pendingMachineIds == null) {
        retained.pendingMachineIds = new Set(retained.sessionsByMachineId.keys());
      }
    } else {
      const presentMachineIds = new Set(machines.map((machine) => machine.machineId));

      if (retained.pendingMachineIds == null) {
        // Outside a wholesale refill, the store's machine list is authoritative:
        // dropCrossMachineLanes removes a machine from this record deliberately.
        for (const machineId of retained.sessionsByMachineId.keys()) {
          if (!presentMachineIds.has(machineId)) retained.sessionsByMachineId.delete(machineId);
        }
      }

      for (const machine of machines) {
        const sessionsForMachine = new Map<string, TerminalSessionSummary>();
        for (const session of machine.sessions) {
          if (!sessionsForMachine.has(session.id)) sessionsForMachine.set(session.id, session);
        }
        // A present slice is authoritative for this machine alone. An empty slice
        // therefore removes its old members without touching still-pending peers.
        retained.sessionsByMachineId.set(machine.machineId, sessionsForMachine);
        retained.pendingMachineIds?.delete(machine.machineId);
      }

      if (retained.pendingMachineIds?.size === 0) retained.pendingMachineIds = null;
    }

    const map = new Map<string, TerminalSessionSummary>();
    for (const sessionsForMachine of retained.sessionsByMachineId.values()) {
      for (const session of sessionsForMachine.values()) {
        if (!map.has(session.id)) map.set(session.id, session);
      }
    }
    return map;
  }, [crossMachineLanesByMachineId, projectStateKey]);
  const sessionsById = useMemo(() => {
    const map = new Map(localSessionsById);
    for (const [sessionId, session] of crossMachineSessionsById) {
      if (!map.has(sessionId)) map.set(sessionId, session);
    }
    return map;
  }, [crossMachineSessionsById, localSessionsById]);
  const sessionsByIdRef = useRef(sessionsById);
  useLayoutEffect(() => {
    sessionsByIdRef.current = sessionsById;
  }, [sessionsById]);
  const missingSessionLaneIdsSignature = useMemo(() => {
    // Lane recovery refreshes only the active binding's lane service; foreign
    // rows are reconciled by their owning machine slice instead.
    if (sessions.length === 0) return "";
    const knownLaneIds = new Set(lanes.map((lane) => lane.id));
    const missingLaneIds = new Set<string>();
    for (const session of sessions) {
      const laneId = session.laneId?.trim();
      if (!laneId || knownLaneIds.has(laneId)) continue;
      missingLaneIds.add(laneId);
    }
    return Array.from(missingLaneIds).sort().join("\0");
  }, [lanes, sessions]);

  const selectLaneForActiveTab = useCallback(
    (sessionId: string | null) => {
      if (!sessionId) return;
      const session = localSessionsById.get(sessionId);
      if (!session) return;
      selectLane(session.laneId);
    },
    [localSessionsById, selectLane],
  );

  const openSessions = useMemo(() => {
    return openItemIds
      .map((id) => sessionsById.get(id))
      .filter((session): session is TerminalSessionSummary => session != null);
  }, [openItemIds, sessionsById]);

  useEffect(() => {
    if (!isWorkRoute) return;
    selectLaneForActiveTab(activeItemId);
  }, [activeItemId, isWorkRoute, selectLaneForActiveTab]);

  const tabGroupModel = useMemo(
    () => buildWorkTabGroupModel({
      sessions: openSessions,
      lanes,
      organization: sessionListOrganization,
      collapsedGroupIds: workCollapsedTabGroupIds,
      laneSessionOrder,
      pinnedSessionIds,
    }),
    // `snoozeEpoch` re-derives the by-status snoozed group when a deadline lapses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lanes, openSessions, sessionListOrganization, workCollapsedTabGroupIds, laneSessionOrder, pinnedSessionIds, snoozeEpoch],
  );

  const visibleSessions = openSessions;

  const tabVisibleSessionIds = tabGroupModel.sessionIds;

  const gridSets = projectViewState.gridSets ?? EMPTY_GRID_SETS;
  const setGridSets = useCallback(
    (next: WorkGridSet[] | ((prev: WorkGridSet[]) => WorkGridSet[])) => {
      setProjectViewState((prev) => ({
        ...prev,
        gridSets: typeof next === "function" ? next(prev.gridSets ?? []) : next,
      }));
    },
    [setProjectViewState],
  );

  const showDraftKind = useCallback(
    (nextKind: WorkDraftKind) => {
      setProjectViewState((prev) => ({
        ...prev,
        draftKind: nextKind,
        // CLI has no orchestrator form — switching to it forces the flag off
        // (lane/model/prompt persist via the shared draft bucket).
        orchestratorEnabled: nextKind === "cli" ? false : prev.orchestratorEnabled,
        activeItemId: null,
        selectedItemId: null,
      }));
    },
    [setProjectViewState],
  );

  const setOrchestratorEnabled = useCallback(
    (enabled: boolean) => {
      setProjectViewState((prev) => ({
        ...prev,
        orchestratorEnabled: enabled,
        // Orchestrator only exists for chat drafts; enabling it implies chat mode.
        draftKind: enabled ? "chat" : prev.draftKind,
        activeItemId: null,
        selectedItemId: null,
      }));
    },
    [setProjectViewState],
  );

  const setDraftLaneId = useCallback(
    (laneId: string) => {
      const normalizedLaneId = laneId.trim();
      setProjectViewState({ draftLaneId: normalizedLaneId || null });
      if (normalizedLaneId) selectLane(normalizedLaneId);
    },
    [selectLane, setProjectViewState],
  );

  const setDraftMachineId = useCallback(
    (machineId: string | null) => {
      const normalizedMachineId = machineId?.trim() ?? "";
      setProjectViewState({ draftMachineId: normalizedMachineId || null });
    },
    [setProjectViewState],
  );

  const setFilterLaneId = useCallback(
    (laneId: string) => {
      clearDeeplinkViewOverride();
      setProjectViewState({ laneFilter: laneId || "all" });
    },
    [clearDeeplinkViewOverride, setProjectViewState],
  );

  const setSessionListOrganization = useCallback(
    (org: WorkSessionListOrganization) => {
      clearDeeplinkViewOverride();
      setProjectViewState({ sessionListOrganization: org });
    },
    [clearDeeplinkViewOverride, setProjectViewState],
  );

  // Chip filters, lane pins and lane sort all clear the deeplink override for
  // the same reason `setFilterLaneId` does: touching a view control is the user
  // taking over the framing a deeplink temporarily imposed.
  const setWorkSessionFilters = useCallback(
    (next: WorkSessionFilters | ((prev: WorkSessionFilters) => WorkSessionFilters)) => {
      clearDeeplinkViewOverride();
      setProjectViewState((prev) => ({
        ...prev,
        workSessionFilters: typeof next === "function"
          ? next(prev.workSessionFilters ?? EMPTY_WORK_SESSION_FILTERS)
          : next,
      }));
    },
    [clearDeeplinkViewOverride, setProjectViewState],
  );

  const setWorkLaneSortMode = useCallback(
    (mode: WorkLaneSortMode) => {
      clearDeeplinkViewOverride();
      setProjectViewState({ workLaneSortMode: mode });
    },
    [clearDeeplinkViewOverride, setProjectViewState],
  );

  const toggleWorkLanePinned = useCallback(
    (laneId: string) => {
      clearDeeplinkViewOverride();
      setProjectViewState((prev) => {
        const current = prev.workPinnedLaneIds ?? [];
        return {
          ...prev,
          workPinnedLaneIds: current.includes(laneId)
            ? current.filter((id) => id !== laneId)
            : [...current, laneId],
        };
      });
    },
    [clearDeeplinkViewOverride, setProjectViewState],
  );

  /**
   * Move one lane beside another in the manual order.
   *
   * Dragging from any sort mode switches to "manual" and seeds the order from
   * what is currently on screen, so the drop lands where the user aimed instead
   * of against an empty (or stale) order. Dead ids are pruned here, on write —
   * pruning on read would cost a lane its slot whenever it is briefly absent
   * during a lane refresh.
   */
  const reorderWorkLanes = useCallback(
    (args: {
      movedLaneId: string;
      targetLaneId: string;
      edge: "before" | "after";
      renderedLaneIds: readonly string[];
    }) => {
      const { movedLaneId, targetLaneId, edge, renderedLaneIds } = args;
      clearDeeplinkViewOverride();
      setProjectViewState((prev) => {
        const liveIds = new Set(renderedLaneIds);
        const kept = (prev.workLaneOrder ?? []).filter((id) => liveIds.has(id));
        const base = kept.length > 0
          ? [...kept, ...renderedLaneIds.filter((id) => !kept.includes(id))]
          : [...renderedLaneIds];
        const next = applyWorkLaneManualMove({
          currentOrder: base,
          movedLaneId,
          targetLaneId,
          edge,
        });
        if (!next) {
          // No-op drop. Still adopt manual mode if the user dragged from another
          // mode, so the Sort control explains why nothing moved.
          return prev.workLaneSortMode === "manual"
            ? prev
            : { ...prev, workLaneSortMode: "manual", workLaneOrder: base };
        }
        return { ...prev, workLaneSortMode: "manual", workLaneOrder: next };
      });
    },
    [clearDeeplinkViewOverride, setProjectViewState],
  );

  const makeCollapsedToggle = useCallback(
    (key: "workCollapsedLaneIds" | "workCollapsedTabGroupIds" | "workCollapsedSectionIds") =>
      (itemId: string, options?: { preserveDeeplink?: boolean }) => {
        if (key === "workCollapsedSectionIds" && !options?.preserveDeeplink) {
          clearDeeplinkViewOverride();
        }
        setProjectViewState((prev) => {
          const cur = prev[key] ?? [];
          const has = cur.includes(itemId);
          return { ...prev, [key]: has ? cur.filter((id) => id !== itemId) : [...cur, itemId] };
        });
      },
    [clearDeeplinkViewOverride, setProjectViewState],
  );

  const toggleWorkLaneCollapsed = useMemo(
    () => makeCollapsedToggle("workCollapsedLaneIds"),
    [makeCollapsedToggle],
  );
  const toggleWorkTabGroupCollapsed = useMemo(
    () => makeCollapsedToggle("workCollapsedTabGroupIds"),
    [makeCollapsedToggle],
  );
  const toggleWorkSectionCollapsed = useMemo(
    () => makeCollapsedToggle("workCollapsedSectionIds"),
    [makeCollapsedToggle],
  );

  const reorderLaneSessions = useCallback(
    (laneId: string, movedSessionId: string, targetSessionId: string, edge: "before" | "after") => {
      if (!laneId || !movedSessionId || !targetSessionId || movedSessionId === targetSessionId) return;
      setProjectViewState((prev) => {
        const sessionsInLane = prev.openItemIds
          .map((id) => sessionsById.get(id))
          .filter((s): s is TerminalSessionSummary => s != null && s.laneId === laneId);
        if (sessionsInLane.length === 0) return prev;

        const existing = prev.laneSessionOrder?.[laneId];
        const baseOrder = existing && existing.length > 0
          ? [
              ...existing.filter((id) => sessionsInLane.some((s) => s.id === id)),
              ...sessionsInLane.filter((s) => !existing.includes(s.id)).map((s) => s.id),
            ]
          : sessionsInLane.map((s) => s.id);

        const next = reorderLaneSessionIdsForDisplay({
          baseOrder,
          pinnedSessionIds: prev.pinnedSessionIds ?? [],
          movedSessionId,
          targetSessionId,
          edge,
        });
        if (!next) return prev;

        return {
          ...prev,
          laneSessionOrder: {
            ...(prev.laneSessionOrder ?? {}),
            [laneId]: next,
          },
        };
      });
    },
    [sessionsById, setProjectViewState],
  );

  const togglePinnedSession = useCallback(
    (sessionId: string) => {
      if (!sessionId) return;
      setProjectViewState((prev) => {
        const cur = prev.pinnedSessionIds ?? [];
        const has = cur.includes(sessionId);
        return {
          ...prev,
          pinnedSessionIds: has ? cur.filter((id) => id !== sessionId) : [...cur, sessionId],
        };
      });
    },
    [setProjectViewState],
  );

  const setWorkFocusSessionsHidden = useCallback(
    (hidden: boolean) => {
      setProjectViewState({ workFocusSessionsHidden: hidden });
    },
    [setProjectViewState],
  );

  const setWorkSidebarOpen = useCallback(
    (open: boolean) => {
      setProjectViewState({ workSidebarOpen: open });
    },
    [setProjectViewState],
  );

  const setWorkSidebarTab = useCallback(
    (tab: WorkSidebarTab) => {
      setProjectViewState({ workSidebarTab: tab, workSidebarOpen: true });
    },
    [setProjectViewState],
  );

  const setWorkSidebarWidthPct = useCallback(
    (widthPct: number) => {
      // Mirror normalizeWorkSidebarWidthPct: a non-finite drag value would otherwise poison
      // the persisted layout — fall back to the default rather than persisting NaN/Infinity.
      const safeWidth = Number.isFinite(widthPct) ? widthPct : 36;
      setProjectViewState({ workSidebarWidthPct: Math.max(26, Math.min(55, safeWidth)) });
    },
    [setProjectViewState],
  );

  const setQ = useCallback(
    (search: string) => {
      setProjectViewState({ search });
    },
    [setProjectViewState],
  );

  const stripUrlFilterParams = useCallback(() => {
    if (!isWorkRoute) return;
    const nextParams = new URLSearchParams(searchParams);
    for (const key of ["laneId", "lane", "status", "sessionId", "event", "offset"]) {
      nextParams.delete(key);
    }
    // Use URLSearchParams.toString() as the stable comparison anchor: if stripping
    // the filter keys yields the same query string, no-op. This makes the effect
    // self-stabilizing — even if `searchParams` re-references on every render,
    // navigate() only fires when there's an actual URL change.
    const currentSearch = searchParams.toString();
    const nextSearch = nextParams.toString();
    if (currentSearch === nextSearch) return;
    navigate(
      `${location.pathname}${nextSearch ? `?${nextSearch}` : ""}${location.hash ?? ""}`,
      { replace: true },
    );
  }, [isWorkRoute, location.hash, location.pathname, navigate, searchParams]);

  const setSelectedSessionId = useCallback(
    (sessionId: string | null) => {
      selectLaneForActiveTab(sessionId);
      setProjectViewState((prev) => {
        const nextOpen =
          sessionId && !prev.openItemIds.includes(sessionId)
            ? [...prev.openItemIds, sessionId]
            : prev.openItemIds;
        return {
          ...prev,
          openItemIds: nextOpen,
          selectedItemId: sessionId,
          activeItemId: sessionId ?? prev.activeItemId,
        };
      });
    },
    [selectLaneForActiveTab, setProjectViewState],
  );

  const setActiveItemId = useCallback(
    (sessionId: string | null) => {
      selectLaneForActiveTab(sessionId);
      setProjectViewState((prev) => {
        if (!sessionId) {
          return {
            ...prev,
            activeItemId: null,
            selectedItemId: null,
          };
        }
        const nextOpen = prev.openItemIds.includes(sessionId)
          ? prev.openItemIds
          : [...prev.openItemIds, sessionId];
        return {
          ...prev,
          openItemIds: nextOpen,
          activeItemId: sessionId,
          selectedItemId: sessionId,
        };
      });
    },
    [selectLaneForActiveTab, setProjectViewState],
  );

  const openSessionTab = useCallback(
    (sessionId: string) => {
      selectLaneForActiveTab(sessionId);
      setProjectViewState((prev) => {
        const nextOpen = prev.openItemIds.includes(sessionId)
          ? prev.openItemIds
          : [...prev.openItemIds, sessionId];
        return {
          ...prev,
          openItemIds: nextOpen,
          activeItemId: sessionId,
          selectedItemId: sessionId,
        };
      });
    },
    [selectLaneForActiveTab, setProjectViewState],
  );

  const closeTab = useCallback(
    (sessionId: string) => {
      setProjectViewState((prev) => {
        const idx = tabVisibleSessionIds.indexOf(sessionId);
        if (idx < 0) return prev;
        const nextOpen = prev.openItemIds.filter((id) => id !== sessionId);
        const nextRendered = tabVisibleSessionIds.filter((id) => id !== sessionId);
        const fallbackActive = nextRendered.length > 0
          ? nextRendered[Math.min(idx, nextRendered.length - 1)] ?? nextRendered[0] ?? null
          : null;
        const nextActive = prev.activeItemId === sessionId ? fallbackActive : prev.activeItemId;
        const nextSelected = prev.selectedItemId === sessionId ? nextActive : prev.selectedItemId;
        return {
          ...prev,
          openItemIds: nextOpen,
          activeItemId: nextActive,
          selectedItemId: nextSelected,
          draftKind: prev.draftKind,
        };
      });
    },
    [setProjectViewState, tabVisibleSessionIds],
  );

  const refresh = useCallback(async (options: { showLoading?: boolean; force?: boolean } = {}) => {
    const requestedProjectRoot = projectRootRef.current;
    if (!requestedProjectRoot) {
      setSessions([]);
      hasLoadedOnceRef.current = false;
      hasAuthoritativeSessionsRef.current = false;
      return;
    }
    const showLoading = options.showLoading ?? true;
    if (refreshInFlightRef.current) {
      if (refreshQueuedRef.current) {
        refreshQueuedRef.current.showLoading = refreshQueuedRef.current.showLoading || showLoading;
        refreshQueuedRef.current.force = refreshQueuedRef.current.force || Boolean(options.force);
        return refreshQueuedRef.current.deferred.promise;
      }
      let resolve!: () => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<void>((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
      });
      refreshQueuedRef.current = {
        showLoading,
        force: Boolean(options.force),
        deferred: { promise, resolve, reject },
      };
      return promise;
    }
    refreshInFlightRef.current = true;
    if (showLoading) setLoading(true);
    try {
      const rows = (
        await listSessionsCached(
          { limit: 500 },
          options.force
            ? { force: true }
            : undefined,
        )
      );
      if (projectRootRef.current !== requestedProjectRoot) {
        return;
      }
      const pending = pendingOptimisticSessionsRef.current;
      if (pending.size > 0) {
        const now = Date.now();
        const rowIndexById = new Map(rows.map((session, index) => [session.id, index] as const));
        for (const [sessionId, entry] of [...pending.entries()]) {
          const expired = now - entry.createdAtMs > OPTIMISTIC_PTY_SESSION_TTL_MS;
          const existingIndex = rowIndexById.get(sessionId);
          if (existingIndex != null) {
            const persisted = rows[existingIndex];
            if (expired || !persisted) {
              pending.delete(sessionId);
              continue;
            }
            const merged = mergePendingOptimisticSession(persisted, entry.session);
            rows[existingIndex] = merged.session;
            if (!merged.keepPending) pending.delete(sessionId);
            continue;
          }
          if (expired) {
            pending.delete(sessionId);
            continue;
          }
          rows.push(entry.session);
          rowIndexById.set(sessionId, rows.length - 1);
        }
        rows.sort(compareSessionsByStartedAtDesc);
      }
      const stoppedRuntimeSessions = stoppedRuntimeSessionsRef.current;
      if (stoppedRuntimeSessions.size > 0) {
        const now = Date.now();
        for (const [sessionId, stopped] of [...stoppedRuntimeSessions.entries()]) {
          if (stopped.expiresAtMs <= now) stoppedRuntimeSessions.delete(sessionId);
        }
        if (stoppedRuntimeSessions.size > 0) {
          for (let index = 0; index < rows.length; index += 1) {
            const row = rows[index];
            if (!row) continue;
            const stopped = stoppedRuntimeSessions.get(row.id);
            if (!stopped) continue;
            if (row.status !== "running") {
              stoppedRuntimeSessions.delete(row.id);
              continue;
            }
            if (row.ptyId && row.ptyId !== stopped.ptyId) {
              stoppedRuntimeSessions.delete(row.id);
              continue;
            }
            rows[index] = {
              ...row,
              ptyId: null,
              status: "disposed",
              runtimeState: "killed",
              endedAt: row.endedAt ?? stopped.endedAt,
              exitCode: null,
            };
          }
        }
      }
      setSessions(rows);
      hasLoadedOnceRef.current = true;
      hasAuthoritativeSessionsRef.current = true;
      if (pendingProjectSwitchRef.current === requestedProjectRoot) {
        pendingProjectSwitchRef.current = null;
      }
    } finally {
      if (showLoading) setLoading(false);
      refreshInFlightRef.current = false;
      const queued = refreshQueuedRef.current;
      refreshQueuedRef.current = null;
      if (queued) {
        void refresh({ showLoading: queued.showLoading, force: queued.force })
          .then(queued.deferred.resolve, queued.deferred.reject);
      }
    }
  }, []);

  const upsertOptimisticChatSession = useCallback((session: AgentChatSession) => {
    const laneName = lanes.find((lane) => lane.id === session.laneId)?.name ?? session.laneId;
    const optimistic = buildOptimisticChatSessionSummary({
      session,
      laneName,
    });
    pendingOptimisticSessionsRef.current.set(optimistic.id, {
      session: optimistic,
      createdAtMs: Date.now(),
    });
    setSessions((prev) => upsertSessionByStartedAt(prev, optimistic));
  }, [lanes]);

  // Used by the CLI continuation flow to flip a stopped session straight to
  // the freshly-resumed snapshot returned by pty.sendToSession, so the Work
  // view swaps the closed snapshot for the live TerminalView without
  // waiting for the next list refresh.
  const upsertSessionSnapshot = useCallback((session: TerminalSessionSummary) => {
    setSessions((prev) => upsertSessionByStartedAt(prev, session));
  }, []);

  const scheduleBackgroundRefresh = useCallback((delayMs = 450) => {
    if (!isWorkRoute) return;
    if (backgroundRefreshTimerRef.current != null) return;
    backgroundRefreshTimerRef.current = window.setTimeout(() => {
      backgroundRefreshTimerRef.current = null;
      if (document.visibilityState !== "visible") {
        pendingHiddenSessionRefreshRef.current = true;
        return;
      }
      void refresh({ showLoading: false }).catch(() => {});
    }, delayMs);
  }, [isWorkRoute, refresh]);

  const markSessionListDirtyOrRefresh = useCallback((delayMs: number) => {
    invalidateSessionListCache();
    if (document.visibilityState !== "visible") {
      pendingHiddenSessionRefreshRef.current = true;
      return;
    }
    scheduleBackgroundRefresh(delayMs);
  }, [scheduleBackgroundRefresh]);

  useEffect(() => {
    if (!active) return undefined;
    return subscribeWorkChatSessionCreated((detail) => {
      if (detail.projectRoot !== projectRootRef.current) return;
      upsertOptimisticChatSession(detail.session);
      scheduleBackgroundRefresh(80);
    });
  }, [active, scheduleBackgroundRefresh, upsertOptimisticChatSession]);

  useEffect(() => {
    // Apply the per-project sessions cache immediately so switching back to a
    // warm project does NOT blank the chat tabs / terminal grid. Without this
    // we wipe `sessions` to `[]`, which unmounts every chat and terminal pane
    // until the IPC refresh returns — that's the "page goes blank for a
    // couple seconds" the user sees. The underlying IPC cache
    // (sessionListCache) is already keyed per project, so DON'T invalidate it
    // either — leave each project's hot cache alone.
    const cachedSessions =
      (projectStateKey
        ? appStore.getState().sessionsCacheByProject[projectStateKey]
        : undefined) ?? null;
    pendingProjectSwitchRef.current = projectStateKey;
    hasAuthoritativeSessionsRef.current = false;
    setSessions(cachedSessions ?? []);
    setLoading(false);
    if (refreshQueuedRef.current) {
      refreshQueuedRef.current.deferred.reject(new Error("projectRoot changed"));
      refreshQueuedRef.current = null;
    }
    // If we already have cached sessions, treat this as a "loaded" state so the
    // upcoming refresh runs silently in the background (no spinner).
    hasLoadedOnceRef.current = cachedSessions != null;
    hasRunningSessionsRef.current = (cachedSessions ?? []).some((s) => s.status === "running");
    laneRecoveryRefreshKeyRef.current = null;
    appliedQuerySessionIdRef.current = null;
    appliedUrlFilterKeyRef.current = null;
    partiallyAppliedUrlFilterKeyRef.current = null;
    pendingOptimisticSessionsRef.current.clear();
    pendingHiddenSessionRefreshRef.current = false;
  }, [appStore, projectStateKey]);

  useLayoutEffect(() => {
    if (pendingProjectSwitchRef.current !== projectStateKey) return;
    // `sessions` has caught up after hydrate's setState — safe to mirror again.
    pendingProjectSwitchRef.current = null;
  }, [projectStateKey, sessions]);

  // Mirror the locally-fetched sessions into the per-project cache in the
  // global store. The next time the user switches BACK to this project the
  // effect above can render these sessions instantly instead of blanking.
  useEffect(() => {
    if (!projectStateKey) return;
    // During a project switch, `sessions` can still be the previous project's list
    // for one render; mirroring it into the new project's cache poisons warm reload.
    if (pendingProjectSwitchRef.current != null) return;
    appStore.setState((prev) => ({
      sessionsCacheByProject: {
        ...prev.sessionsCacheByProject,
        [projectStateKey]: sessions,
      },
    }));
  }, [appStore, sessions, projectStateKey]);

  useEffect(() => {
    if (!projectRoot || !isWorkRoute) return;
    if (pendingProjectSwitchRef.current != null) return;
    if (!missingSessionLaneIdsSignature) {
      laneRecoveryRefreshKeyRef.current = null;
      return;
    }
    const recoveryKey = `${projectStateKey}:${missingSessionLaneIdsSignature}`;
    if (laneRecoveryRefreshKeyRef.current === recoveryKey) return;
    laneRecoveryRefreshKeyRef.current = recoveryKey;
    void refreshLanes({
      includeStatus: false,
      includeSnapshots: false,
      includeConflictStatus: false,
      includeRebaseSuggestions: false,
      includeAutoRebaseStatus: false,
    }).catch(() => {});
  }, [
    isWorkRoute,
    missingSessionLaneIdsSignature,
    projectRoot,
    projectStateKey,
    refreshLanes,
  ]);

  useEffect(() => {
    if (!projectRoot || !projectStateKey || !isWorkRoute) return;
    const isInitialLoad = !hasLoadedOnceRef.current;
    refresh({ showLoading: isInitialLoad, force: isInitialLoad }).catch(() => {});
  }, [isWorkRoute, projectRoot, projectStateKey, refresh]);

  useEffect(() => {
    if (isWorkRoute) return;
    if (backgroundRefreshTimerRef.current == null) return;
    window.clearTimeout(backgroundRefreshTimerRef.current);
    backgroundRefreshTimerRef.current = null;
  }, [isWorkRoute]);

  useEffect(() => {
    // Refresh scheduling is active-binding-only; foreign slices have their own
    // cross-machine sync cadence and must not drive this project's IPC polling.
    sessionsRef.current = sessions;
    hasRunningSessionsRef.current = sessions.some((s) => s.status === "running");
  }, [sessions]);

  useEffect(() => {
    if (!isWorkRoute) return;
    const sessionParam = (searchParams.get("sessionId") ?? "").trim();
    const laneParam = (searchParams.get("laneId") ?? searchParams.get("lane") ?? "").trim();
    const statusParam = (searchParams.get("status") ?? "").trim();
    if (pendingProjectSwitchRef.current != null) return;
    // When a sessionId is requested, only skip the lane/status navigation hint if
    // that session actually exists. If it's stale/missing (after the first
    // load completes) we fall through so the URL's laneId/status hints still
    // narrow the view instead of dumping the user into an unrelated context.
    if (sessionParam) {
      const sessionExists = sessionsById.has(sessionParam);
      if (sessionExists) {
        appliedUrlFilterKeyRef.current = `${sessionParam}|${laneParam}|${statusParam}`;
        partiallyAppliedUrlFilterKeyRef.current = null;
        stripUrlFilterParams();
        return;
      }
      if (!hasLoadedOnceRef.current) return;
    }
    // Apply URL-derived navigation at most once per URL signature so later
    // session-list refreshes don't stomp on the user's lane/grouping choices.
    const urlKey = `${sessionParam}|${laneParam}|${statusParam}`;
    if (appliedUrlFilterKeyRef.current === urlKey) {
      stripUrlFilterParams();
      return;
    }
    const laneExists = laneParam && lanes.some((lane) => lane.id === laneParam);
    const status = mapUrlStatusFilter(statusParam);
    if (!laneExists && !status) {
      appliedUrlFilterKeyRef.current = null;
      partiallyAppliedUrlFilterKeyRef.current = null;
      if (sessionParam || laneParam || statusParam) stripUrlFilterParams();
      return;
    }
    // When the URL specifies a laneId but lanes haven't populated yet (e.g. on
    // project open/switch the store resets lanes to [] then repopulates async),
    // we can't tell whether the lane is missing-for-good or just-not-yet-loaded.
    // In that case, apply any status navigation hint but don't cache the URL signature —
    // come back once lanes populate so the lane portion can apply too. We only
    // mark the key applied when the lane portion was definitively applied, or
    // when lanes are loaded (non-empty) so "not found" is an authoritative
    // negative signal.
    const laneDeterminable = !laneParam || laneExists || lanes.length > 0;
    const wasPartiallyApplied = partiallyAppliedUrlFilterKeyRef.current === urlKey;
    if (!laneDeterminable && wasPartiallyApplied) return;
    if (laneDeterminable) {
      appliedUrlFilterKeyRef.current = urlKey;
      partiallyAppliedUrlFilterKeyRef.current = null;
    } else {
      partiallyAppliedUrlFilterKeyRef.current = urlKey;
    }
    const shouldApplyStatus = Boolean(status && !wasPartiallyApplied);
    const targetSectionId = status ? statusSectionId(status) : null;
    setDeeplinkViewOverride((prev) => ({
      laneFilter: laneExists ? laneParam : prev?.laneFilter ?? null,
      // Status hints are navigation, not an invisible filter: show the
      // complete Status grouping and expand the requested section.
      sessionListOrganization: shouldApplyStatus
        ? "all-lanes-by-status"
        : prev?.sessionListOrganization ?? null,
      expandSectionId: shouldApplyStatus && targetSectionId
        ? targetSectionId
        : prev?.expandSectionId ?? null,
    }));
    if (laneDeterminable) stripUrlFilterParams();
  }, [isWorkRoute, lanes, searchParams, sessionsById, setProjectViewState, stripUrlFilterParams]);

  // Migrate legacy org modes to supported modes
  useEffect(() => {
    if (
      sessionListOrganization !== "all-lanes-by-status" &&
      sessionListOrganization !== "by-lane" &&
      sessionListOrganization !== "by-time"
    ) {
      setProjectViewState({ sessionListOrganization: "by-lane" });
    }
  }, [sessionListOrganization, setProjectViewState]);

  // Reset stale lane filter when the selected lane no longer exists
  useEffect(() => {
    if (filterLaneId === "all" || lanes.length === 0) return;
    if (!lanes.some((l) => l.id === filterLaneId)) {
      setProjectViewState({ laneFilter: "all" });
    }
  }, [filterLaneId, lanes, setProjectViewState]);

  useEffect(() => {
    if (!isWorkRoute) return;
    const sessionParam = (searchParams.get("sessionId") ?? "").trim();
    if (!sessionParam) {
      appliedQuerySessionIdRef.current = null;
      return;
    }
    // Key the apply-once guard by session AND anchor: re-opening the same
    // session at a different event/offset must set a fresh pending anchor.
    const eventRaw = (searchParams.get("event") ?? "").trim();
    const offsetRaw = (searchParams.get("offset") ?? "").trim();
    const applyKey = `${sessionParam}|${eventRaw}|${offsetRaw}`;
    if (appliedQuerySessionIdRef.current === applyKey) return;
    if (pendingProjectSwitchRef.current != null) return;

    const session = sessionsById.get(sessionParam);
    if (!session) return;

    appliedQuerySessionIdRef.current = applyKey;
    // Deeplink anchors (?event=<seq> for chat, ?offset=<bytes> for terminal
    // scrollback) are handed off one-shot to the session's content surface.
    setPendingSessionAnchor(session.id, {
      event: /^\d+$/.test(eventRaw) ? Number(eventRaw) : undefined,
      offset: /^\d+$/.test(offsetRaw) ? Number(offsetRaw) : undefined,
    });
    selectLaneForActiveTab(session.id);
    focusSession(session.id);
    setProjectViewState((prev) => {
      const nextOpen = prev.openItemIds.includes(session.id)
        ? prev.openItemIds
        : [...prev.openItemIds, session.id];
      if (
        arraysEqual(prev.openItemIds, nextOpen)
        && prev.activeItemId === session.id
        && prev.selectedItemId === session.id
      ) {
        return prev;
      }
      return {
        ...prev,
        openItemIds: nextOpen,
        activeItemId: session.id,
        selectedItemId: session.id,
      };
    });
  }, [focusSession, isWorkRoute, searchParams, selectLaneForActiveTab, sessionsById, setProjectViewState]);

  useEffect(() => {
    if (!isWorkRoute) return;
    const unsubExit = window.ade.pty.onExit((event) => {
      const currentProjectRoot = projectRootRef.current;
      if (event.projectRoot && event.projectRoot !== currentProjectRoot) return;
      markSessionListDirtyOrRefresh(120);
    });
    const intervalMs = isRemoteProject
      ? REMOTE_RUNNING_SESSION_REFRESH_INTERVAL_MS
      : LOCAL_RUNNING_SESSION_REFRESH_INTERVAL_MS;
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (!hasRunningSessionsRef.current) return;
      scheduleBackgroundRefresh(180);
    }, intervalMs);
    return () => {
      try {
        unsubExit();
      } catch {
        // ignore
      }
      clearInterval(t);
    };
  }, [isRemoteProject, isWorkRoute, markSessionListDirtyOrRefresh, projectRoot, scheduleBackgroundRefresh]);

  useEffect(() => {
    if (!isWorkRoute) return;
    const unsubscribe = window.ade.agentChat.onEvent((payload) => {
      if (!shouldRefreshSessionListForChatEvent(payload)) return;
      markSessionListDirtyOrRefresh(220);
    });
    return unsubscribe;
  }, [isWorkRoute, markSessionListDirtyOrRefresh]);

  useEffect(() => {
    if (!isWorkRoute) return;
    const unsubscribe = window.ade.sessions.onChanged(() => {
      markSessionListDirtyOrRefresh(80);
    });
    return unsubscribe;
  }, [isWorkRoute, markSessionListDirtyOrRefresh]);

  useEffect(() => {
    return () => {
      if (backgroundRefreshTimerRef.current != null) {
        window.clearTimeout(backgroundRefreshTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isWorkRoute) return;
    const refreshVisibleWork = () => {
      if (document.visibilityState !== "visible") return;
      const hadHiddenChanges = pendingHiddenSessionRefreshRef.current;
      pendingHiddenSessionRefreshRef.current = false;
      if (isRemoteProject && !hadHiddenChanges) return;
      invalidateSessionListCache();
      scheduleBackgroundRefresh(hadHiddenChanges ? 20 : 120);
    };
    window.addEventListener("focus", refreshVisibleWork);
    document.addEventListener("visibilitychange", refreshVisibleWork);
    return () => {
      window.removeEventListener("focus", refreshVisibleWork);
      document.removeEventListener("visibilitychange", refreshVisibleWork);
    };
  }, [isRemoteProject, isWorkRoute, scheduleBackgroundRefresh]);

  const filtered = useMemo(() => {
    // Filtering here is active-binding-only: SessionListPane applies the same
    // controls to its separately rendered cross-machine rows.
    const needle = q.trim().toLowerCase();
    return sessions.filter((session) => {
      if (filterLaneId !== "all" && session.laneId !== filterLaneId) return false;
      if (!needle) return true;

      if (needle.startsWith("lane:")) {
        const value = needle.slice(5).trim();
        return session.laneName.toLowerCase().includes(value);
      }
      if (needle.startsWith("type:")) {
        const value = needle.slice(5).trim();
        return (session.toolType ?? "").toLowerCase().includes(value);
      }
      if (needle.startsWith("tracked:")) {
        const value = needle.slice(8).trim();
        if (value === "yes" || value === "true") return session.tracked;
        if (value === "no" || value === "false") return !session.tracked;
        return true;
      }

      return (
        (session.goal ?? session.title).toLowerCase().includes(needle) ||
        session.laneName.toLowerCase().includes(needle) ||
        (session.toolType ?? "").toLowerCase().includes(needle) ||
        (session.lastOutputPreview ?? "").toLowerCase().includes(needle) ||
        (session.summary ?? "").toLowerCase().includes(needle) ||
        (session.claudeTag ?? "").toLowerCase().includes(needle) ||
        (session.resumeCommand ?? "").toLowerCase().includes(needle)
      );
    });
  }, [sessions, filterLaneId, q]);

  const prsByLaneId = useLanePrsByLaneId();
  const laneStatusById = useMemo(() => {
    const map = new Map<string, LaneSummary>();
    for (const lane of lanes) map.set(lane.id, lane);
    return map;
  }, [lanes]);

  /**
   * The chip-filtered view. Deliberately a SEPARATE memo layered on top of
   * `filtered` rather than an extra clause inside it: `filtered` is exported and
   * drives counts elsewhere, and the snooze-deadline effect below must keep
   * seeing rows a chip is hiding — otherwise a snoozed row filtered off screen
   * stops scheduling its own wake and never comes back.
   *
   * With no chips set this returns `filtered` BY REFERENCE, so every downstream
   * memo stays referentially stable and the feature costs nothing when unused.
   */
  const chipFiltered = useMemo(() => {
    if (isWorkSessionFilterEmpty(workSessionFilters)) return filtered;
    const ctx = {
      nowMs: Date.now(),
      laneHasPr: (laneId: string) => (prsByLaneId.get(laneId)?.length ?? 0) > 0,
      laneIsDirty: (laneId: string) => laneStatusById.get(laneId)?.status.dirty === true,
    };
    return filtered.filter((session) => matchesWorkSessionFilters(session, workSessionFilters, ctx));
    // `snoozeEpoch` matters here too: a lapsing snooze changes a row's filing
    // bucket, which is what the status chips match on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, workSessionFilters, prsByLaneId, laneStatusById, snoozeEpoch]);

  const {
    runningFiltered,
    awaitingInputFiltered,
    endedFiltered,
    settledFiltered,
    snoozedFiltered,
  } = useMemo(() => {
    const nowMs = Date.now();
    const running: TerminalSessionSummary[] = [];
    const loud: TerminalSessionSummary[] = [];
    const quiet: TerminalSessionSummary[] = [];
    const ended: TerminalSessionSummary[] = [];
    const settled: TerminalSessionSummary[] = [];
    const snoozed: TerminalSessionSummary[] = [];
    for (const session of chipFiltered) {
      // Snooze is a visibility overlay: it pulls the row OUT of whatever bucket
      // it would otherwise sit in, including Running — but it YIELDS to a raised
      // hand. A needs_you row is filed normally even while snoozed, which
      // keeps "Until I'm asked" honest.
      const phase = sessionCanonicalUiState(canonicalInputFromSummary(session)).phase;
      const filingBucket = sessionFilingBucket(session, nowMs);
      if (filingBucket === "snoozed") {
        snoozed.push(session);
        continue;
      }
      const bucket = filingBucket;
      if (bucket === "running") running.push(session);
      else if (bucket === "awaiting-input") {
        // Loud (Needs you) rows float to the top of the Your-move section; the
        // two partitions each keep startedAt order, so rows never jitter.
        if (phase === "needs_you") loud.push(session);
        else quiet.push(session);
      } else if (bucket === "settled") settled.push(session);
      else ended.push(session);
    }
    return {
      runningFiltered: running,
      awaitingInputFiltered: [...loud, ...quiet],
      endedFiltered: ended,
      settledFiltered: settled.sort(compareSessionsBySettledAtDesc),
      snoozedFiltered: snoozed.sort(compareSessionsByWakeAtAsc),
    };
    // `snoozeEpoch` re-partitions when the soonest snooze deadline lapses; there
    // is no snooze scheduler anywhere, expiry is always derived from now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chipFiltered, snoozeEpoch]);

  // Exactly one timer, armed only while something is actually snoozed, firing at
  // the soonest deadline (clamped so a 100-year "until I'm asked" snooze can't
  // overflow setTimeout). No polling and no document-level listener.
  //
  // Reads `filtered`, NOT `chipFiltered`, on purpose: a snoozed row hidden by a
  // status chip must still schedule its own wake, or it would never return.
  useEffect(() => {
    if (!isWorkRoute) return undefined;
    const deadlineMs = nextSnoozeDeadlineMs(filtered);
    if (deadlineMs == null) return undefined;
    const delay = Math.min(Math.max(deadlineMs - Date.now(), 250), SNOOZE_TICK_MAX_DELAY_MS);
    const timer = window.setTimeout(() => setSnoozeEpoch((value) => value + 1), delay);
    return () => window.clearTimeout(timer);
  }, [filtered, isWorkRoute, snoozeEpoch]);

  const sessionsGroupedByLane = useMemo(() => {
    if (sessionListOrganization !== "by-lane") return null;
    const map = new Map<string, TerminalSessionSummary[]>();
    for (const s of chipFiltered) {
      const list = map.get(s.laneId) ?? [];
      list.push(s);
      map.set(s.laneId, list);
    }
    return map;
  }, [sessionListOrganization, chipFiltered]);

  const runningSessions = useMemo(
    () => [...sessionsById.values()].filter((session) => session.status === "running"),
    [sessionsById],
  );

  const gridLayoutId = useMemo(
    () => `work:grid:tiling:v1:${projectStateKey ?? "global"}`,
    [projectStateKey],
  );

  const selectedSession = useMemo(
    () => (selectedSessionId ? sessionsById.get(selectedSessionId) ?? null : null),
    [selectedSessionId, sessionsById],
  );
  const canPruneSessionIndex = useCallback(
    () => pendingProjectSwitchRef.current == null && hasAuthoritativeSessionsRef.current,
    [],
  );

  useEffect(() => {
    if (!projectStateKey) return;
    // Don't prune open tabs until sessions have been fetched at least once for
    // this project. On remount or warm cache hydration, `sessions` can briefly
    // reflect the previous project — pruning then drops the destination tabs.
    if (pendingProjectSwitchRef.current != null) return;
    if (!hasAuthoritativeSessionsRef.current) return;
    // Open Work tabs are the cross-machine union, not just the active
    // project's refresh result. A foreign chat can stay open while the local
    // session list refreshes, so prune against the same combined index used to
    // render tabs instead of silently dropping every foreign tab.
    const validIds = new Set(sessionsById.keys());

    setProjectViewState((prev) => {
      const nextOpen = prev.openItemIds.filter((id) => validIds.has(id));
      const userIsViewingDraft = prev.activeItemId == null && prev.selectedItemId == null;
      const nextActive =
        userIsViewingDraft
          ? null
          : prev.activeItemId && validIds.has(prev.activeItemId) && nextOpen.includes(prev.activeItemId)
            ? prev.activeItemId
            : nextOpen[0] ?? null;
      const nextSelected =
        userIsViewingDraft
          ? null
          : prev.selectedItemId && validIds.has(prev.selectedItemId)
            ? prev.selectedItemId
            : nextActive;

      if (
        arraysEqual(prev.openItemIds, nextOpen) &&
        prev.activeItemId === nextActive &&
        prev.selectedItemId === nextSelected
      ) {
        return prev;
      }

      return {
        ...prev,
        openItemIds: nextOpen,
        activeItemId: nextActive,
        selectedItemId: nextSelected,
      };
    });
  }, [projectStateKey, sessionsById, setProjectViewState]);

  const rememberStoppedRuntime = (ptyId: string, sessionId: string | undefined, endedAt: string) => {
    if (!sessionId) return;
    stoppedRuntimeSessionsRef.current.set(sessionId, {
      ptyId,
      endedAt,
      expiresAtMs: Date.now() + STOPPED_RUNTIME_GUARD_TTL_MS,
    });
  };

  const forgetStoppedRuntime = (sessionId: string | undefined) => {
    if (!sessionId) return;
    stoppedRuntimeSessionsRef.current.delete(sessionId);
  };

  const restorePtyClosed = (previousSessions: readonly TerminalSessionSummary[]) => {
    if (previousSessions.length === 0) return;
    const previousById = new Map(previousSessions.map((session) => [session.id, session] as const));
    setSessions((prev) => prev.map((session) => previousById.get(session.id) ?? session));
  };

  const markPtyClosed = (ptyId: string, sessionId?: string): string => {
    const endedAt = new Date().toISOString();
    setSessions((prev) =>
      prev.map((session) =>
        session.ptyId === ptyId || (sessionId != null && session.id === sessionId)
          ? {
              ...session,
              ptyId: null,
              status: "disposed" as const,
              runtimeState: "killed" as const,
              endedAt,
              exitCode: null,
            }
          : session,
      ),
    );
    return endedAt;
  };

  const stopRuntime = useCallback(
    async (ptyId: string, sessionId?: string) => {
      const previousSessions = sessionsRef.current.filter((session) =>
        session.ptyId === ptyId || (sessionId != null && session.id === sessionId),
      );
      setClosingPtyIds((prev) => {
        const next = new Set(prev);
        next.add(ptyId);
        return next;
      });
      invalidateSessionListCache();
      const endedAt = markPtyClosed(ptyId, sessionId);
      const session = sessionId
        ? sessionsByIdRef.current.get(sessionId)
        : [...sessionsByIdRef.current.values()].find((candidate) => candidate.ptyId === ptyId);
      const pin = machineRouter.pinForSession(session ?? { ptyId, sessionId });

      let disposeError: unknown = null;
      try {
        const disposeArgs = { ptyId, ...(sessionId ? { sessionId } : {}) };
        const result = pin
          ? await window.ade.pty.dispose(disposeArgs, pin)
          : await window.ade.pty.dispose(disposeArgs);
        if (result?.disposed === false) {
          if (result.reason === "owned-by-peer" || result.reason === "session-mismatch") {
            forgetStoppedRuntime(sessionId);
            restorePtyClosed(previousSessions);
          } else {
            rememberStoppedRuntime(ptyId, sessionId, endedAt);
            machineRouter.forgetSessionPin({ ptyId, sessionId });
          }
        } else {
          rememberStoppedRuntime(ptyId, sessionId, endedAt);
          machineRouter.forgetSessionPin({ ptyId, sessionId });
        }
      } catch (error) {
        disposeError = error;
        forgetStoppedRuntime(sessionId);
        restorePtyClosed(previousSessions);
      } finally {
        setClosingPtyIds((prev) => {
          const next = new Set(prev);
          next.delete(ptyId);
          return next;
        });
        invalidateSessionListCache();
        // Reconcile with the real backend state using a forced read; otherwise
        // an older in-flight session list can briefly resurrect the stopped PTY.
        void refresh({ showLoading: false, force: true }).catch(() => {});
      }
      if (disposeError) throw disposeError;
    },
    [machineRouter, refresh],
  );

  const stopAllRuntimes = useCallback(async () => {
    // "Stop all" spans the combined Work union, including foreign rows. Each
    // stop goes through the same session resolver as an individual stop, so a
    // foreign PTY is disposed on its owning binding while local PTYs keep the
    // unpinned fast path. Chat rows without a PTY are intentionally skipped.
    await Promise.allSettled([
      ...[...sessionsByIdRef.current.values()]
        .filter((session) => Boolean(session.ptyId))
        .filter((session) => session.status === "running")
        .map((session) => stopRuntime(session.ptyId as string, session.id)),
    ]);
  }, [stopRuntime]);

  const launchPtySession = useCallback(
    async (args: WorkPtyLaunchArgs): Promise<WorkPtyLaunchResult> => {
      // resolveLaunchFields preserves caller intent: any caller-supplied
      // startupCommand/command/args is used as-is, never mixed with defaults
      // from the other fields. Only when the caller passes none of them do
      // we substitute the profile's default launch.
      const launchFields = resolveLaunchFields({
        profile: args.profile,
        ...(args.permissionMode !== undefined ? { permissionMode: args.permissionMode } : {}),
        ...(args.orchestrationRole !== undefined ? { orchestrationRole: args.orchestrationRole } : {}),
        ...(args.startupCommand !== undefined ? { startupCommand: args.startupCommand } : {}),
        ...(args.command !== undefined ? { command: args.command } : {}),
        ...(args.args !== undefined ? { args: args.args } : {}),
        ...(args.env !== undefined ? { env: args.env } : {}),
        ...(args.initialInput !== undefined ? { initialInput: args.initialInput } : {}),
        ...(args.initialInputDelayMs !== undefined ? { initialInputDelayMs: args.initialInputDelayMs } : {}),
      });
      const createArgs = {
        laneId: args.laneId,
        cols: 100,
        rows: 30,
        title: args.title ?? LAUNCH_PROFILE_TITLE[args.profile],
        tracked: args.tracked ?? true,
        toolType: LAUNCH_PROFILE_TOOL_TYPE[args.profile],
        ...(args.startupDelayMs !== undefined ? { startupDelayMs: args.startupDelayMs } : {}),
        ...(launchFields.initialInput !== undefined ? { initialInput: launchFields.initialInput } : {}),
        ...(launchFields.initialInputDelayMs !== undefined ? { initialInputDelayMs: launchFields.initialInputDelayMs } : {}),
        ...(args.linearIssues?.length ? { linearIssues: args.linearIssues } : {}),
        ...launchFields,
      };
      const result = args.pin
        ? await window.ade.pty.create(createArgs, args.pin)
        : await window.ade.pty.create(createArgs);
      machineRouter.rememberSessionPin(result, args.pin);
      if (!canMutatePinnedProjectUi(args.pin)) {
        return result;
      }
      const startedAt = new Date().toISOString();
      const optimisticSession: TerminalSessionSummary = {
        id: result.sessionId,
        laneId: args.laneId,
        laneName: lanes.find((lane) => lane.id === args.laneId)?.name ?? args.laneId,
        ptyId: result.ptyId,
        tracked: args.tracked ?? true,
        pinned: false,
        manuallyNamed: false,
        goal: null,
        toolType: LAUNCH_PROFILE_TOOL_TYPE[args.profile],
        title: args.title ?? LAUNCH_PROFILE_TITLE[args.profile],
        status: "running",
        startedAt,
        endedAt: null,
        archivedAt: null,
        exitCode: null,
        transcriptPath: "",
        headShaStart: null,
        headShaEnd: null,
        lastOutputPreview: null,
        lastActivityAt: null,
        summary: null,
        runtimeState: "running",
        resumeCommand: null,
        resumeMetadata: null,
        chatSessionId: null,
      };
      pendingOptimisticSessionsRef.current.set(result.sessionId, {
        session: optimisticSession,
        createdAtMs: Date.now(),
      });
      setSessions((prev) => upsertSessionByStartedAt(prev, optimisticSession));
      // Invalidate all cache entries so other views (e.g. Lanes tab) pick up
      // the new session on their next refresh.
      invalidateSessionListCache();
      if (args.disposition !== "background") {
        selectLane(args.laneId);
        focusSession(result.sessionId);
        openSessionTab(result.sessionId);
      }
      // Reconcile with persisted backend state in the background. The
      // optimistic row already has the returned pty/session ids. Foreground
      // launches open it immediately so TerminalView subscribes before fast
      // TUIs draw their initial frame; background launches leave focus alone.
      void refresh({ showLoading: false, force: true }).catch(() => {});
      return result;
    },
    [canMutatePinnedProjectUi, focusSession, lanes, machineRouter, openSessionTab, refresh, selectLane],
  );

  const removeSessionFromList = useCallback((sessionId: string) => {
    setSessions((prev) => prev.filter((session) => session.id !== sessionId));
  }, []);

  /**
   * Route an imported external session into the Work surface. Mirrors the
   * optimistic-inject + focus path of {@link launchPtySession} for the CLI
   * case (the backend already created the session/pty, so we skip pty.create
   * and adopt the returned ids) and the {@link upsertOptimisticChatSession}
   * focus path for the chat case.
   */
  const adoptImportedSession = useCallback(
    (summary: ExternalSessionSummary, result: ExternalSessionImportResult) => {
      invalidateSessionListCache();
      if (result.kind === "cli") {
        const startedAt = new Date().toISOString();
        const optimisticSession: TerminalSessionSummary = result.session ?? {
          id: result.sessionId,
          laneId: result.laneId,
          laneName: lanes.find((lane) => lane.id === result.laneId)?.name ?? result.laneId,
          ptyId: result.ptyId,
          tracked: true,
          pinned: false,
          manuallyNamed: false,
          goal: null,
          toolType: PROVIDER_TOOL_TYPE[summary.provider],
          title: summary.title || "Imported session",
          status: "running",
          startedAt,
          endedAt: null,
          archivedAt: null,
          exitCode: null,
          transcriptPath: "",
          headShaStart: null,
          headShaEnd: null,
          lastOutputPreview: null,
          lastActivityAt: null,
          summary: null,
          runtimeState: "running",
          resumeCommand: null,
          resumeMetadata: null,
          chatSessionId: null,
        };
        pendingOptimisticSessionsRef.current.set(result.sessionId, {
          session: optimisticSession,
          createdAtMs: Date.now(),
        });
        setSessions((prev) => upsertSessionByStartedAt(prev, optimisticSession));
        selectLane(result.laneId);
        focusSession(result.sessionId);
        openSessionTab(result.sessionId);
      } else {
        if (result.chatSummary) {
          const chat = result.chatSummary;
          const optimistic = buildOptimisticChatSessionSummary({
            session: {
              id: chat.sessionId,
              laneId: chat.laneId,
              provider: chat.provider,
              status: chat.status,
              createdAt: chat.startedAt,
              lastActivityAt: chat.lastActivityAt,
              idleSinceAt: chat.idleSinceAt,
              orchestrationRunId: chat.orchestrationRunId,
              orchestrationRole: chat.orchestrationRole,
              orchestrationTag: chat.orchestrationTag,
            },
            laneName: lanes.find((lane) => lane.id === chat.laneId)?.name ?? chat.laneId,
          });
          setSessions((prev) => upsertSessionByStartedAt(prev, {
            ...optimistic,
            goal: chat.goal ?? null,
            title: chat.title ?? optimistic.title,
            endedAt: chat.endedAt,
            archivedAt: chat.archivedAt ?? null,
            lastOutputPreview: chat.lastOutputPreview,
            summary: chat.summary,
          }));
        }
        selectLane(result.laneId);
        focusSession(result.chatSessionId);
        openSessionTab(result.chatSessionId);
        setSelectedSessionId(result.chatSessionId);
      }
      void refresh({ showLoading: false, force: true }).catch(() => {});
    },
    [focusSession, lanes, openSessionTab, refresh, selectLane, setSelectedSessionId],
  );

  /**
   * Focus an already-imported session (chat or CLI) that lives in the Work
   * surface, without re-importing. Mirrors the focus path of
   * {@link adoptImportedSession}; the session already exists in the list, so we
   * only select/open its tab. Lane selection is resolved from the session id by
   * {@link openSessionTab}.
   */
  const openExistingImportedSession = useCallback(
    (ref: { kind: "chat" | "cli"; sessionId: string }) => {
      focusSession(ref.sessionId);
      openSessionTab(ref.sessionId);
      if (ref.kind === "chat") setSelectedSessionId(ref.sessionId);
    },
    [focusSession, openSessionTab, setSelectedSessionId],
  );

  return {
    // Raw active-binding inventory; SessionListPane layers foreign rows from
    // the cross-machine store rather than treating them as local refresh data.
    sessions,
    sessionsById,
    canPruneSessionIndex,
    lanes,
    filtered,
    runningFiltered,
    awaitingInputFiltered,
    endedFiltered,
    settledFiltered,
    snoozedFiltered,
    runningSessions,
    visibleSessions,
    gridLayoutId,
    gridSets,
    setGridSets,
    selectedSession,
    loading,

    filterLaneId,
    setFilterLaneId,

    workSessionFilters,
    setWorkSessionFilters,
    workPinnedLaneIds,
    toggleWorkLanePinned,
    workLaneSortMode,
    setWorkLaneSortMode,
    workLaneOrder,
    reorderWorkLanes,
    q,
    setQ,

    sessionListOrganization,
    setSessionListOrganization,
    workCollapsedLaneIds,
    toggleWorkLaneCollapsed,
    workCollapsedTabGroupIds,
    toggleWorkTabGroupCollapsed,
    workCollapsedSectionIds,
    toggleWorkSectionCollapsed,
    sessionsGroupedByLane,
    tabGroups: tabGroupModel.groups,
    tabVisibleSessionIds,
    laneSessionOrder,
    pinnedSessionIds,
    reorderLaneSessions,
    togglePinnedSession,

    workFocusSessionsHidden,
    setWorkFocusSessionsHidden,
    workSidebarOpen,
    setWorkSidebarOpen,
    workSidebarTab,
    setWorkSidebarTab,
    workSidebarWidthPct,
    setWorkSidebarWidthPct,

    selectedSessionId,
    setSelectedSessionId,

    openItemIds,
    activeItemId,
    setActiveItemId,
    draftKind,
    orchestratorEnabled,
    setOrchestratorEnabled,
    draftLaneId,
    setDraftLaneId,
    draftMachineId,
    setDraftMachineId,
    showDraftKind,
    openSessionTab,
    closeTab,

    closingPtyIds,
    refresh,
    upsertOptimisticChatSession,
    upsertSessionSnapshot,
    removeSessionFromList,
    stopRuntime,
    stopAllRuntimes,
    launchPtySession,
    adoptImportedSession,
    openExistingImportedSession,

    navigate,
    selectLane,
    focusSession,
    machineRouter,
    resolveSessionRuntimePin: machineRouter.pinForSession,
  };
}
