import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CaretDown, CaretRight, CircleNotch, Funnel, MagnifyingGlass, Plus, Square, Terminal, Trash, X } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { BranchIcon, LaneIcon } from "../ui/vcsIcons";
import type { LaneSummary, PrSummary, TerminalSessionSummary } from "../../../shared/types";
import { listPrsCoalesced } from "../../lib/prReadCache";
import { selectPrimaryLanePr, lanePrStateColor, lanePrStateLabel } from "../../lib/lanePrBadge";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";
import { SessionCard } from "./SessionCard";
import { ToolLogo } from "./ToolLogos";
import { LaneCombobox } from "./LaneCombobox";
import { sortLanesForTabs } from "../lanes/laneUtils";
import { CreateLaneDialogHost } from "../lanes/CreateLaneDialogHost";
import type { WorkDraftKind, WorkGridSet, WorkSessionListOrganization } from "../../state/appStore";
import { findGridSetForSession } from "../../lib/workGrid";
import { iconGlyph } from "../graph/graphHelpers";
import { SmartTooltip } from "../ui/SmartTooltip";
import { cn } from "../ui/cn";
import { branchNameFromRef } from "../prs/shared/laneBranchTargets";
import { laneSurfaceTint } from "../lanes/laneDesignTokens";
import { canBulkDeleteSession, canBulkStopSession } from "../../lib/sessions";
import { useWorkLaneContextMenu } from "./useWorkLaneContextMenu";
import { relativeTimeCompact } from "../../lib/format";
import {
  handoffLaunchMatchesQuery,
  handoffLaunchStatusMessage,
  handoffLaunchTitle,
  type HandoffLaunchJob,
} from "../../lib/handoffLaunchJobs";


const EMPTY_GRID_SETS: WorkGridSet[] = [];
const FILTER_OPTION_GRID_CLASS = "grid min-w-0 flex-1 gap-0.5 [grid-template-columns:repeat(auto-fit,minmax(2.4rem,1fr))]";
const FILTER_OPTION_BUTTON_CLASS = "ade-chat-drawer-row min-w-0 truncate rounded-md px-1.5 py-1 text-center text-[10px] font-medium";

function bucketByTime(sessions: TerminalSessionSummary[]) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86400000;
  const today: TerminalSessionSummary[] = [];
  const yesterday: TerminalSessionSummary[] = [];
  const older: TerminalSessionSummary[] = [];
  const sorted = [...sessions].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  for (const s of sorted) {
    const t = new Date(s.startedAt).getTime();
    if (t >= todayStart) today.push(s);
    else if (t >= yesterdayStart) yesterday.push(s);
    else older.push(s);
  }
  return { today, yesterday, older };
}

function bucketHandoffJobsByTime(jobs: HandoffLaunchJob[]) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86400000;
  const today: HandoffLaunchJob[] = [];
  const yesterday: HandoffLaunchJob[] = [];
  const older: HandoffLaunchJob[] = [];
  const sorted = [...jobs].sort((a, b) => b.createdAtMs - a.createdAtMs);
  for (const job of sorted) {
    if (job.createdAtMs >= todayStart) today.push(job);
    else if (job.createdAtMs >= yesterdayStart) yesterday.push(job);
    else older.push(job);
  }
  return { today, yesterday, older };
}

function HandoffSessionPlaceholderCard({ job }: { job: HandoffLaunchJob }) {
  const title = handoffLaunchTitle(job);
  const status = handoffLaunchStatusMessage(job.status);
  return (
    <motion.div
      key={job.id}
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      className="group relative"
      data-testid="handoff-launch-placeholder"
    >
      <div
        className="relative w-full overflow-hidden rounded-lg text-left"
        style={{
          border: "1px solid rgba(255,255,255,0.08)",
          background: "rgba(255,255,255,0.035)",
        }}
        aria-label={`${title}: ${status}`}
      >
        <motion.div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          animate={{ opacity: [0.2, 0.42, 0.2] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
          style={{
            background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent)",
          }}
        />
        <div className="relative flex items-stretch gap-2.5 px-2.5 py-2">
          <div className="flex shrink-0 self-stretch items-center justify-center">
            <ToolLogo toolType={job.targetToolType} size={26} className="opacity-90" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-fg/90" title={title}>
                {title}
              </span>
              <div className="flex shrink-0 items-center gap-1.5">
                <CircleNotch size={11} className="animate-spin text-muted-fg/55" />
                <span className="shrink-0 text-[10px] tabular-nums text-muted-fg/45">
                  {relativeTimeCompact(new Date(job.createdAtMs).toISOString())}
                </span>
              </div>
            </div>
            <div className="mt-0.5 min-w-0">
              <span className="block truncate text-[10px] leading-snug text-muted-fg/55">
                {status}
              </span>
            </div>
            <div className="mt-0.5 min-w-0">
              <span className="block truncate text-[10px] leading-snug text-muted-fg/40">
                First message: Chat handoff from previous session
              </span>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function StickyGroupHeader({
  sectionId,
  icon,
  label,
  count,
  collapsed,
  onToggleCollapsed,
  onContextMenu,
  accentColor,
  children,
  subLabel,
  prBadge = null,
  variant = "default",
}: {
  sectionId: string;
  icon: React.ReactNode;
  label: string;
  count: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onContextMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  accentColor?: string | null;
  children: React.ReactNode;
  /** Branch label shown on the right for `variant="lane"` (e.g. from `branchNameFromRef`). */
  subLabel?: string | null;
  /** Compact PR badge shown left of the count for `variant="lane"`. */
  prBadge?: React.ReactNode;
  /** `lane` uses a larger header and pads the nested session list. */
  variant?: "default" | "lane";
}) {
  if (count === 0) return null;
  const isLane = variant === "lane";
  const branchText = subLabel?.trim() ?? "";
  const showBranchCluster = branchText.length > 0;
  const laneTint = laneSurfaceTint(accentColor, isLane ? "pastel" : "soft");
  const laneLabelColor = isLane && laneTint.text ? laneTint.text : accentColor ?? undefined;
  return (
    <div className={cn(isLane ? "mb-1.5" : "mt-0.5 first:mt-0")}>
      {isLane ? (
        // The lane header is a flex row, NOT one big <button>: the PR badge is
        // itself interactive, and nesting interactive elements inside a native
        // button is invalid HTML (breaks focus order / assistive tech). The
        // collapse toggle button spans everything left of the badge cluster.
        <div
          className={cn(
            "ade-lane-group-header sticky top-0 z-10 flex w-full items-center gap-1.5 rounded-lg px-3 py-2 transition-colors backdrop-blur-xl select-none",
            laneTint.text ? "hover:brightness-[1.03]" : "hover:bg-white/[0.04]",
          )}
          style={{
            background: laneTint.background,
            border: laneTint.border ?? "1px solid rgba(255, 255, 255, 0.08)",
            boxShadow: "0 1px 6px -2px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.04)",
          }}
          data-section-id={sectionId}
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
            onClick={onToggleCollapsed}
            onContextMenu={onContextMenu}
          >
            {collapsed ? (
              <CaretRight size={12} className="shrink-0 text-muted-fg/35" />
            ) : (
              <CaretDown size={12} className="shrink-0 text-muted-fg/35" />
            )}
            {icon}
            <span
              className="ade-lane-group-header-lane ade-lane-branch-inline-lane min-w-0 max-w-[60%] shrink truncate text-[13px] font-semibold leading-tight text-fg/90"
              style={laneLabelColor ? { color: laneLabelColor } : undefined}
              title={label}
            >
              {label}
            </span>
            {/* Branch sits immediately right of the lane name and expands to fill
                whatever space is free, truncating only when it runs out. */}
            {showBranchCluster ? (
              <div
                className="ade-lane-group-header-branch ade-lane-branch-inline-branch flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden"
                style={{ color: "var(--color-muted-fg)" }}
              >
                <BranchIcon size={10} weight="regular" className="shrink-0 opacity-55" />
                <span className="min-w-0 truncate text-[10px] font-medium leading-tight text-muted-fg/70" title={branchText}>
                  {branchText}
                </span>
              </div>
            ) : null}
          </button>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {prBadge}
            <span className="rounded-full bg-white/[0.08] px-1.5 py-px text-[10px] font-semibold tabular-nums text-muted-fg/60">
              {count}
            </span>
          </div>
        </div>
      ) : (
      <button
        type="button"
        className={cn(
          "ade-lane-group-header sticky top-0 z-10 flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors backdrop-blur-xl cursor-pointer select-none",
          laneTint.text ? "hover:brightness-[1.03]" : "hover:bg-white/[0.04]",
        )}
        style={{
          background: laneTint.background,
          borderBottom: "1px solid rgba(255, 255, 255, 0.04)",
        }}
        onClick={onToggleCollapsed}
        onContextMenu={onContextMenu}
        data-section-id={sectionId}
      >
        {(
          <>
            {collapsed ? (
              <CaretRight size={10} className="shrink-0 text-muted-fg/30" />
            ) : (
              <CaretDown size={10} className="shrink-0 text-muted-fg/30" />
            )}
            {icon}
            <span
              className="min-w-0 flex-1 truncate text-[11px] font-semibold text-fg/90"
              style={accentColor ? { color: accentColor } : undefined}
            >
              {label}
            </span>
            <span className="shrink-0 rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[9px] font-medium text-muted-fg/50">
              {count}
            </span>
          </>
        )}
      </button>
      )}
      {/* Children slide out/retract smoothly; the header stays put (no reflow jump). */}
      <AnimatePresence initial={false}>
        {!collapsed && count > 0 ? (
          <motion.div
            key="lane-group-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            style={{ overflow: "hidden" }}
          >
            <div className={cn("space-y-px pb-0.5", isLane && "mt-1 pl-2.5")}>
              {children}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/**
 * ADE-mapped PRs grouped by lane id for the Work tab's lane dividers. One lazy
 * read plus the `prs-updated` push keeps it fresh without polling.
 *
 * TODO: iOS merges GitHub-by-branch (unmapped) PRs into the same badge; the
 * desktop Work tab has no external-PR cache here, so this is ADE-mapped only.
 */
function useLanePrsByLaneId(): Map<string, PrSummary[]> {
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const [prs, setPrs] = useState<PrSummary[]>([]);
  useEffect(() => {
    // `window.ade.prs` is absent in some renders (e.g. tests with a partial
    // `window.ade` mock); no-op gracefully so the badge just doesn't render.
    if (!window.ade?.prs) return;
    let cancelled = false;
    void listPrsCoalesced({ projectRoot })
      .then((list) => {
        if (!cancelled) setPrs(list);
      })
      .catch(() => {});
    const unsubscribe = window.ade.prs.onEvent((event) => {
      if (event.type === "prs-updated") setPrs(event.prs);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [projectRoot]);
  return useMemo(() => {
    const byLane = new Map<string, PrSummary[]>();
    for (const pr of prs) {
      const list = byLane.get(pr.laneId);
      if (list) list.push(pr);
      else byLane.set(pr.laneId, [pr]);
    }
    return byLane;
  }, [prs]);
}

/**
 * Compact PR status badge on a lane divider: state-colored dot + `#<number>` +
 * one-word state. Clicking deep-links into the PRs tab. Rendered inside the
 * header button, so it stops propagation to avoid also toggling the section.
 */
function LanePrHeaderBadge({ pr, onOpen }: { pr: PrSummary; onOpen: () => void }) {
  const color = lanePrStateColor(pr.state);
  const label = lanePrStateLabel(pr.state);
  const open = (event: React.SyntheticEvent) => {
    event.stopPropagation();
    onOpen();
  };
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open(event);
        }
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-1.5 py-px text-[10px] font-medium leading-none text-muted-fg/70 transition-colors hover:bg-white/[0.09]"
      title={`Pull request #${pr.githubPrNumber} · ${label}`}
      aria-label={`Pull request #${pr.githubPrNumber}, ${label}`}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
      <span className="tabular-nums">#{pr.githubPrNumber}</span>
      <span style={{ color }}>{label}</span>
    </span>
  );
}

export const SessionListPane = React.memo(function SessionListPane({
  lanes,
  runningFiltered,
  awaitingInputFiltered,
  endedFiltered,
  allSessionsUnfiltered,
  loading: _loading,
  filterLaneId,
  setFilterLaneId,
  q,
  setQ,
  selectedSessionId,
  selectedSessionIds,
  draftKind: _draftKind,
  showingDraft: _showingDraft,
  onShowDraftKind,
  onSelectSession,
  onClearSelection,
  onBulkClose,
  onBulkDelete,
  onBulkStopAndDelete,
  onContextMenu,
  sessionListOrganization,
  setSessionListOrganization,
  workCollapsedLaneIds,
  toggleWorkLaneCollapsed,
  workCollapsedSectionIds,
  toggleWorkSectionCollapsed,
  sessionsGroupedByLane,
  gridSets = EMPTY_GRID_SETS,
  activeItemId = null,
  handoffJobs = [],
}: {
  lanes: LaneSummary[];
  runningFiltered: TerminalSessionSummary[];
  awaitingInputFiltered: TerminalSessionSummary[];
  endedFiltered: TerminalSessionSummary[];
  /** All sessions before the search/lane filter — the live-children badge counts
   * from this so a filtered-out running child doesn't undercount its parent. */
  allSessionsUnfiltered: TerminalSessionSummary[];
  loading: boolean;
  filterLaneId: string;
  setFilterLaneId: (v: string) => void;
  q: string;
  setQ: (v: string) => void;
  selectedSessionId: string | null;
  selectedSessionIds?: Set<string>;
  gridSets?: WorkGridSet[];
  activeItemId?: string | null;
  draftKind: WorkDraftKind;
  showingDraft: boolean;
  onShowDraftKind: (kind: WorkDraftKind) => void;
  onSelectSession: (id: string, event: React.MouseEvent, visibleSessionIds: string[]) => void;
  onClearSelection?: () => void;
  onBulkClose?: () => void;
  onBulkDelete?: () => void;
  onBulkStopAndDelete?: () => void;
  onContextMenu: (session: TerminalSessionSummary, e: React.MouseEvent) => void;
  sessionListOrganization: WorkSessionListOrganization;
  setSessionListOrganization: (v: WorkSessionListOrganization) => void;
  workCollapsedLaneIds: string[];
  toggleWorkLaneCollapsed: (laneId: string) => void;
  workCollapsedSectionIds: string[];
  toggleWorkSectionCollapsed: (sectionId: string) => void;
  sessionsGroupedByLane: Map<string, TerminalSessionSummary[]> | null;
  handoffJobs?: HandoffLaunchJob[];
}) {
  const navigate = useNavigate();
  const prsByLaneId = useLanePrsByLaneId();
  const [createLaneOpen, setCreateLaneOpen] = useState(false);
  const orderedLanes = useMemo(() => sortLanesForTabs(lanes), [lanes]);
  const { trigger: triggerLaneContextMenu, menu: laneContextMenuPortal } = useWorkLaneContextMenu();

  const isByLane = sessionListOrganization === "by-lane";
  const isByTime = sessionListOrganization === "by-time";
  const normalizedFilterLaneId = filterLaneId.trim();
  const laneFilterActive = normalizedFilterLaneId.length > 0 && normalizedFilterLaneId !== "all";
  const [filterOpen, setFilterOpen] = useState(false);
  const filteredHandoffJobs = useMemo(() => {
    const filtered = handoffJobs.filter((job) => {
      if (laneFilterActive && job.laneId !== normalizedFilterLaneId) return false;
      return handoffLaunchMatchesQuery(job, q);
    });
    return filtered.sort((a, b) => b.createdAtMs - a.createdAtMs);
  }, [handoffJobs, laneFilterActive, normalizedFilterLaneId, q]);

  const hasAnySessions =
    runningFiltered.length + awaitingInputFiltered.length + endedFiltered.length + filteredHandoffJobs.length > 0;

  const allSessions = useMemo(
    () => [...runningFiltered, ...awaitingInputFiltered, ...endedFiltered],
    [runningFiltered, awaitingInputFiltered, endedFiltered],
  );
  const visibleSessionIdSet = useMemo(
    () => new Set(allSessions.map((session) => session.id)),
    [allSessions],
  );
  // Build parent → children index. A child is a tracked terminal that records the
  // chat session id of its parent (e.g. App Control launches, in-chat terminal
  // drawer tabs). Children render indented under the parent when the parent is
  // also visible. If the parent is filtered out, the child still renders at the
  // top level so users do not lose access.
  const childrenByParentId = useMemo(() => {
    const map = new Map<string, TerminalSessionSummary[]>();
    for (const session of allSessions) {
      const parentId = session.chatSessionId;
      if (!parentId || parentId === session.id) continue;
      if (!visibleSessionIdSet.has(parentId)) continue;
      const list = map.get(parentId) ?? [];
      list.push(session);
      map.set(parentId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    }
    return map;
  }, [allSessions, visibleSessionIdSet]);
  const excludedTopLevelIds = useMemo(() => {
    const set = new Set<string>();
    for (const list of childrenByParentId.values()) {
      for (const child of list) set.add(child.id);
    }
    return set;
  }, [childrenByParentId]);
  // Live-children badge: count, per spawner id, its still-running spawned chats.
  // Counts from the UNFILTERED session list (not `allSessions`, which is already
  // search/lane-filtered) so hiding a running child by filter does not undercount
  // its visible parent's badge. No extra fetch; clears as children go terminal.
  const liveChildrenByParentId = useMemo(() => {
    const map = new Map<string, number>();
    for (const session of allSessionsUnfiltered) {
      const parentId = session.orchestrationParentSessionId;
      if (!parentId || parentId === session.id) continue;
      if (session.status !== "running") continue;
      map.set(parentId, (map.get(parentId) ?? 0) + 1);
    }
    return map;
  }, [allSessionsUnfiltered]);
  const isChildSectionCollapsed = useCallback(
    (parentId: string) => workCollapsedSectionIds.includes(`chat:${parentId}`),
    [workCollapsedSectionIds],
  );
  const toggleChildSection = useCallback(
    (parentId: string) => toggleWorkSectionCollapsed(`chat:${parentId}`),
    [toggleWorkSectionCollapsed],
  );
  const timeBuckets = useMemo(() => bucketByTime(allSessions), [allSessions]);
  const handoffTimeBuckets = useMemo(() => bucketHandoffJobsByTime(filteredHandoffJobs), [filteredHandoffJobs]);
  const selectedCount = selectedSessionIds?.size ?? 0;
  const selectedSessions = useMemo(
    () => allSessions.filter((session) => selectedSessionIds?.has(session.id)),
    [allSessions, selectedSessionIds],
  );
  const selectedRunningCount = selectedSessions.filter(canBulkStopSession).length;
  const selectedDeletableCount = selectedSessions.filter(canBulkDeleteSession).length;
  const laneById = useMemo(() => {
    const map = new Map<string, LaneSummary>();
    for (const lane of lanes) map.set(lane.id, lane);
    return map;
  }, [lanes]);
  const handoffJobsByLaneId = useMemo(() => {
    const map = new Map<string, HandoffLaunchJob[]>();
    for (const job of filteredHandoffJobs) {
      const list = map.get(job.laneId) ?? [];
      list.push(job);
      map.set(job.laneId, list);
    }
    return map;
  }, [filteredHandoffJobs]);
  const missingLaneSessionGroups = useMemo(() => {
    if (!sessionsGroupedByLane) return [];
    const knownLaneIds = new Set(lanes.map((lane) => lane.id));
    const latestStartedAt = (sessions: TerminalSessionSummary[]): number => {
      const times = sessions
        .map((session) => new Date(session.startedAt).getTime())
        .filter(Number.isFinite);
      return times.length > 0 ? Math.max(...times) : -Infinity;
    };
    const orphanLabel = (name: string | null | undefined, fallback: string): string => {
      const trimmed = (name ?? "").trim();
      return trimmed.length > 0 ? trimmed : fallback;
    };
    return [...sessionsGroupedByLane.entries()]
      .filter(([laneId, sessions]) => !knownLaneIds.has(laneId) && sessions.length > 0)
      .sort(([leftLaneId, leftSessions], [rightLaneId, rightSessions]) => {
        const leftLatest = latestStartedAt(leftSessions);
        const rightLatest = latestStartedAt(rightSessions);
        if (leftLatest !== rightLatest) return rightLatest - leftLatest;
        const leftName = orphanLabel(leftSessions[0]?.laneName, leftLaneId);
        const rightName = orphanLabel(rightSessions[0]?.laneName, rightLaneId);
        return leftName.localeCompare(rightName);
      });
  }, [lanes, sessionsGroupedByLane]);
  const handoffOnlyMissingLaneGroups = useMemo(() => {
    const knownLaneIds = new Set(lanes.map((lane) => lane.id));
    const missingSessionLaneIds = new Set(missingLaneSessionGroups.map(([laneId]) => laneId));
    return [...handoffJobsByLaneId.entries()]
      .filter(([laneId, jobs]) => !knownLaneIds.has(laneId) && !missingSessionLaneIds.has(laneId) && jobs.length > 0)
      .sort(([leftLaneId, leftJobs], [rightLaneId, rightJobs]) => {
        const leftLatest = Math.max(...leftJobs.map((job) => job.createdAtMs));
        const rightLatest = Math.max(...rightJobs.map((job) => job.createdAtMs));
        if (leftLatest !== rightLatest) return rightLatest - leftLatest;
        const leftName = leftJobs[0]?.laneName ?? leftLaneId;
        const rightName = rightJobs[0]?.laneName ?? rightLaneId;
        return leftName.localeCompare(rightName);
      });
  }, [handoffJobsByLaneId, lanes, missingLaneSessionGroups]);
  const expandSessionWithChildren = useCallback((session: TerminalSessionSummary): string[] => {
    const children = childrenByParentId.get(session.id) ?? [];
    if (children.length === 0) return [session.id];
    if (isChildSectionCollapsed(session.id)) return [session.id];
    return [session.id, ...children.map((child) => child.id)];
  }, [childrenByParentId, isChildSectionCollapsed]);
  const collectVisibleIds = useCallback((sessions: TerminalSessionSummary[]): string[] => {
    const ids: string[] = [];
    for (const session of sessions) {
      if (excludedTopLevelIds.has(session.id)) continue;
      ids.push(...expandSessionWithChildren(session));
    }
    return ids;
  }, [excludedTopLevelIds, expandSessionWithChildren]);
  const renderedSessionIds = useMemo(() => {
    if (isByLane) {
      const ids: string[] = [];
      for (const lane of orderedLanes) {
        if (workCollapsedLaneIds.includes(lane.id)) continue;
        ids.push(...collectVisibleIds(sessionsGroupedByLane?.get(lane.id) ?? []));
      }
      for (const [laneId, list] of missingLaneSessionGroups) {
        if (workCollapsedLaneIds.includes(laneId)) continue;
        ids.push(...collectVisibleIds(list));
      }
      return ids;
    }
    if (isByTime) {
      const ids: string[] = [];
      if (!workCollapsedSectionIds.includes("time:today")) ids.push(...collectVisibleIds(timeBuckets.today));
      if (!workCollapsedSectionIds.includes("time:yesterday")) ids.push(...collectVisibleIds(timeBuckets.yesterday));
      if (!workCollapsedSectionIds.includes("time:older")) ids.push(...collectVisibleIds(timeBuckets.older));
      return ids;
    }
    const ids: string[] = [];
    if (!workCollapsedSectionIds.includes("status:running")) ids.push(...collectVisibleIds(runningFiltered));
    if (!workCollapsedSectionIds.includes("status:awaiting")) ids.push(...collectVisibleIds(awaitingInputFiltered));
    if (!workCollapsedSectionIds.includes("status:ended")) ids.push(...collectVisibleIds(endedFiltered));
    return ids;
  }, [
    awaitingInputFiltered,
    collectVisibleIds,
    endedFiltered,
    isByLane,
    isByTime,
    missingLaneSessionGroups,
    orderedLanes,
    runningFiltered,
    sessionsGroupedByLane,
    timeBuckets.older,
    timeBuckets.today,
    timeBuckets.yesterday,
    workCollapsedLaneIds,
    workCollapsedSectionIds,
  ]);

  // First-rendered card carries a stable automation anchor at a real session.
  // We track whether we've already emitted it across the whole list (not per-section).
  let sessionItemAnchorEmitted = false;
  // The "active" grid is the set containing the focused session; its members'
  // badges are highlighted, members of other grids are greyed.
  const activeGridSetId = findGridSetForSession(gridSets, activeItemId)?.id ?? null;
  const gridBadgeFor = (sessionId: string): "active" | "inactive" | null => {
    const set = findGridSetForSession(gridSets, sessionId);
    if (!set) return null;
    return set.id === activeGridSetId ? "active" : "inactive";
  };

  const renderCardCore = (session: TerminalSessionSummary, options?: { compact?: boolean }) => {
    const isFirst = !sessionItemAnchorEmitted;
    if (isFirst) sessionItemAnchorEmitted = true;
    const card = (
      <SessionCard
        key={session.id}
        session={session}
        lane={laneById.get(session.laneId) ?? null}
        liveChildrenCount={liveChildrenByParentId.get(session.id) ?? 0}
        isSelected={selectedSessionId === session.id}
        isMultiSelected={selectedSessionIds?.has(session.id) ?? false}
        onSelect={(id, event) => onSelectSession(id, event, renderedSessionIds)}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu(session, e);
        }}
        compact={options?.compact}
        gridBadge={gridBadgeFor(session.id)}
      />
    );
    if (!isFirst) return card;
    return (
      <div key={`tour-${session.id}`} data-tour="work.sessionItem">
        {card}
      </div>
    );
  };

  const renderChildSection = (parentId: string, children: TerminalSessionSummary[]) => {
    if (children.length === 0) return null;
    const collapsed = isChildSectionCollapsed(parentId);
    return (
      <div key={`children-${parentId}`} className="ml-3 mt-px border-l border-white/[0.06] pl-1.5">
        <button
          type="button"
          onClick={() => toggleChildSection(parentId)}
          className="flex w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-left text-[9px] font-medium uppercase tracking-wide text-muted-fg/40 transition-colors hover:bg-white/[0.03] hover:text-muted-fg/70"
          aria-expanded={!collapsed}
        >
          {collapsed ? (
            <CaretRight size={9} weight="bold" className="shrink-0 text-muted-fg/40" />
          ) : (
            <CaretDown size={9} weight="bold" className="shrink-0 text-muted-fg/40" />
          )}
          <Terminal size={9} weight="regular" className="shrink-0 text-muted-fg/40" />
          <span className="truncate">
            {children.length === 1 ? "1 shell" : `${children.length} shells`}
          </span>
        </button>
        {!collapsed ? (
          <div className="space-y-px">
            {children.map((child) => (
              <div key={child.id}>{renderCardCore(child, { compact: true })}</div>
            ))}
          </div>
        ) : null}
      </div>
    );
  };

  const renderCards = (list: TerminalSessionSummary[]) =>
    list
      .filter((session) => !excludedTopLevelIds.has(session.id))
      .map((session) => {
        const children = childrenByParentId.get(session.id) ?? [];
        const card = renderCardCore(session);
        if (children.length === 0) return card;
        return (
          <div key={`group-${session.id}`}>
            {card}
            {renderChildSection(session.id, children)}
          </div>
        );
      });
  const renderHandoffCards = (jobs: HandoffLaunchJob[]) => (
    <AnimatePresence initial={false}>
      {jobs.map((job) => (
        <HandoffSessionPlaceholderCard key={job.id} job={job} />
      ))}
    </AnimatePresence>
  );

  const groupedByStatusList = (
    <div className="px-1.5 pb-2">
      <StickyGroupHeader
        sectionId="status:running"
        icon={<span className="h-2 w-2 shrink-0 rounded-full" style={{ background: "var(--color-success)" }} />}
        label="Running"
        count={runningFiltered.length + filteredHandoffJobs.length}
        collapsed={workCollapsedSectionIds.includes("status:running")}
        onToggleCollapsed={() => toggleWorkSectionCollapsed("status:running")}
      >
        {renderHandoffCards(filteredHandoffJobs)}
        {renderCards(runningFiltered)}
      </StickyGroupHeader>
      <StickyGroupHeader
        sectionId="status:awaiting"
        icon={<span className="h-2 w-2 shrink-0 rounded-full" style={{ background: "var(--color-warning)" }} />}
        label="Awaiting"
        count={awaitingInputFiltered.length}
        collapsed={workCollapsedSectionIds.includes("status:awaiting")}
        onToggleCollapsed={() => toggleWorkSectionCollapsed("status:awaiting")}
      >
        {renderCards(awaitingInputFiltered)}
      </StickyGroupHeader>
      <StickyGroupHeader
        sectionId="status:ended"
        icon={<span className="h-2 w-2 shrink-0 rounded-full" style={{ background: "var(--color-error)" }} />}
        label="Ended"
        count={endedFiltered.length}
        collapsed={workCollapsedSectionIds.includes("status:ended")}
        onToggleCollapsed={() => toggleWorkSectionCollapsed("status:ended")}
      >
        {renderCards(endedFiltered)}
      </StickyGroupHeader>
    </div>
  );

  const byLaneList = (
    <div className="space-y-1 px-2 pb-3">
      {orderedLanes.map((lane) => {
        const list = sessionsGroupedByLane?.get(lane.id) ?? [];
        const laneHandoffJobs = handoffJobsByLaneId.get(lane.id) ?? [];
        const collapsed = workCollapsedLaneIds.includes(lane.id);
        const total = list.length + laneHandoffJobs.length;
        const laneAccent = lane.color ?? null;
        const laneHeaderTint = laneSurfaceTint(laneAccent, "pastel");
        const laneIcon = (
          <span
            className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center"
            style={{ color: laneHeaderTint.text ?? laneAccent ?? "var(--color-muted-fg)" }}
          >
            {lane.icon ? iconGlyph(lane.icon) : <LaneIcon size={12} weight="regular" />}
          </span>
        );
        const primaryPr = selectPrimaryLanePr(lane, prsByLaneId.get(lane.id) ?? []);
        const prBadge = primaryPr ? (
          <LanePrHeaderBadge
            pr={primaryPr}
            onOpen={() => navigate(`/prs?tab=normal&prId=${encodeURIComponent(primaryPr.id)}`)}
          />
        ) : null;
        return (
          <StickyGroupHeader
            key={lane.id}
            sectionId={lane.id}
            icon={laneIcon}
            label={lane.name}
            subLabel={branchNameFromRef(lane.branchRef)}
            variant="lane"
            count={total}
            collapsed={collapsed}
            accentColor={laneAccent}
            prBadge={prBadge}
            onToggleCollapsed={() => toggleWorkLaneCollapsed(lane.id)}
            onContextMenu={(e) => triggerLaneContextMenu(lane.id, e)}
          >
            {renderHandoffCards(laneHandoffJobs)}
            {renderCards(list)}
          </StickyGroupHeader>
        );
      })}
      {missingLaneSessionGroups.map(([laneId, list]) => {
        const laneHandoffJobs = handoffJobsByLaneId.get(laneId) ?? [];
        const collapsed = workCollapsedLaneIds.includes(laneId);
        const trimmedLaneName = (list[0]?.laneName ?? "").trim();
        const label = trimmedLaneName.length > 0 ? trimmedLaneName : laneHandoffJobs[0]?.laneName ?? laneId;
        return (
          <StickyGroupHeader
            key={laneId}
            sectionId={laneId}
            icon={<LaneIcon size={12} weight="regular" className="h-3.5 w-3.5 shrink-0 text-muted-fg/55" />}
            label={label}
            variant="lane"
            count={list.length + laneHandoffJobs.length}
            collapsed={collapsed}
            onToggleCollapsed={() => toggleWorkLaneCollapsed(laneId)}
          >
            {renderHandoffCards(laneHandoffJobs)}
            {renderCards(list)}
          </StickyGroupHeader>
        );
      })}
      {handoffOnlyMissingLaneGroups.map(([laneId, jobs]) => {
        const collapsed = workCollapsedLaneIds.includes(laneId);
        const label = jobs[0]?.laneName ?? laneId;
        return (
          <StickyGroupHeader
            key={laneId}
            sectionId={laneId}
            icon={<LaneIcon size={12} weight="regular" className="h-3.5 w-3.5 shrink-0 text-muted-fg/55" />}
            label={label}
            variant="lane"
            count={jobs.length}
            collapsed={collapsed}
            onToggleCollapsed={() => toggleWorkLaneCollapsed(laneId)}
          >
            {renderHandoffCards(jobs)}
          </StickyGroupHeader>
        );
      })}
    </div>
  );

  const byTimeList = (
    <div className="px-1.5 pb-2">
      <StickyGroupHeader
        sectionId="time:today"
        icon={null}
        label="Today"
        count={timeBuckets.today.length + handoffTimeBuckets.today.length}
        collapsed={workCollapsedSectionIds.includes("time:today")}
        onToggleCollapsed={() => toggleWorkSectionCollapsed("time:today")}
      >
        {renderHandoffCards(handoffTimeBuckets.today)}
        {renderCards(timeBuckets.today)}
      </StickyGroupHeader>
      <StickyGroupHeader
        sectionId="time:yesterday"
        icon={null}
        label="Yesterday"
        count={timeBuckets.yesterday.length + handoffTimeBuckets.yesterday.length}
        collapsed={workCollapsedSectionIds.includes("time:yesterday")}
        onToggleCollapsed={() => toggleWorkSectionCollapsed("time:yesterday")}
      >
        {renderHandoffCards(handoffTimeBuckets.yesterday)}
        {renderCards(timeBuckets.yesterday)}
      </StickyGroupHeader>
      <StickyGroupHeader
        sectionId="time:older"
        icon={null}
        label="Older"
        count={timeBuckets.older.length + handoffTimeBuckets.older.length}
        collapsed={workCollapsedSectionIds.includes("time:older")}
        onToggleCollapsed={() => toggleWorkSectionCollapsed("time:older")}
      >
        {renderHandoffCards(handoffTimeBuckets.older)}
        {renderCards(timeBuckets.older)}
      </StickyGroupHeader>
    </div>
  );

  return (
    <div
      className="flex h-full flex-col overflow-hidden"
      style={{ background: "var(--work-sidebar-bg)" }}
    >
      {/* Compact toolbar */}
      <div className="ade-session-list-toolbar shrink-0 space-y-1.5 px-2 pt-2 pb-1.5">
        <div className="ade-session-list-toolbar-row flex min-w-0 items-center gap-1.5 overflow-hidden">
          <div className="ade-session-list-toolbar-search relative min-w-0 flex-1">
            <MagnifyingGlass size={11} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-fg/40" />
            <input
              className="h-7 w-full min-w-0 rounded-lg border pl-7 pr-2 text-[11px] text-fg outline-none placeholder:text-muted-fg/30"
              style={{
                borderColor: "rgba(255,255,255,0.06)",
                background: "rgba(255,255,255,0.03)",
              }}
              placeholder="Search..."
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <SmartTooltip content={{ label: "Filters", description: "Toggle the filter panel to organize sessions by lane or time." }}>
            <button
              type="button"
              className="ade-session-list-toolbar-filter relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors"
              style={{
                border: "1px solid rgba(255,255,255,0.06)",
                background: filterOpen || laneFilterActive ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.03)",
                color: filterOpen || laneFilterActive ? "var(--color-fg)" : "var(--color-muted-fg)",
              }}
              onClick={() => setFilterOpen(!filterOpen)}
              aria-label={laneFilterActive ? "Filters, lane filter active" : "Filters"}
              data-tour="work.laneFilter"
            >
              <Funnel size={12} weight={filterOpen ? "fill" : "regular"} />
              {laneFilterActive ? (
                <span
                  data-testid="work-lane-filter-active-indicator"
                  className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] shadow-[0_0_8px_var(--color-accent)]"
                />
              ) : null}
            </button>
          </SmartTooltip>
          <SmartTooltip content={{ label: "New Chat", description: "Start a new AI chat session." }}>
            <button
              type="button"
              className="ade-session-list-toolbar-new-chat inline-flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-[10px] font-medium transition-colors"
              style={{
                border: "1px solid rgba(168,130,255,0.35)",
                background: "rgba(168,130,255,0.08)",
                color: "rgba(168,130,255,0.9)",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
              onClick={() => onShowDraftKind("chat")}
              aria-label="Start a new chat"
              data-tour="work.newSession"
            >
              <Plus size={10} weight="bold" />
              <span className="ade-session-list-toolbar-new-chat-label">New Chat</span>
            </button>
          </SmartTooltip>
        </div>

        {/* Expandable filter panel */}
        {filterOpen ? (
          <div className="ade-chat-drawer-glass space-y-1.5 p-2">
            <div className="flex items-start gap-1">
              <span className="w-10 shrink-0 pt-1.5 text-[9px] font-medium uppercase tracking-wider text-muted-fg/50">Group</span>
              <div className={FILTER_OPTION_GRID_CLASS}>
                {([
                  { key: "by-lane" as const, label: "Lane" },
                  { key: "all-lanes-by-status" as const, label: "Status" },
                  { key: "by-time" as const, label: "Time" },
                ] as const).map((opt) => (
                  <SmartTooltip
                    key={opt.key}
                    content={{
                      label: opt.label,
                      description:
                        opt.key === "by-lane"
                          ? "Group sessions by the lane they belong to."
                          : opt.key === "all-lanes-by-status"
                            ? "Group by status: running, awaiting, or ended."
                            : "Group by when sessions were started.",
                    }}
                  >
                    <button
                      type="button"
                      className={FILTER_OPTION_BUTTON_CLASS}
                      data-active={sessionListOrganization === opt.key ? "true" : undefined}
                      style={{
                        color: sessionListOrganization === opt.key ? "var(--color-fg)" : "var(--color-muted-fg)",
                      }}
                      onClick={() => setSessionListOrganization(opt.key)}
                    >
                      {opt.label}
                    </button>
                  </SmartTooltip>
                ))}
              </div>
            </div>
            <div className="flex items-start gap-1">
              <span className="w-10 shrink-0 pt-1.5 text-[9px] font-medium uppercase tracking-wider text-muted-fg/50">Lane</span>
              <div className="min-w-0 flex-1">
                <LaneCombobox
                  lanes={orderedLanes}
                  value={filterLaneId}
                  onChange={setFilterLaneId}
                  showAllOption
                  fullWidth
                />
              </div>
            </div>
          </div>
        ) : null}

        {selectedCount > 0 ? (
          <div className="ade-chat-drawer-glass flex items-center gap-1.5 p-1.5">
            <span className="min-w-0 flex-1 truncate text-[10px] font-medium text-fg/80">
              {selectedCount} selected
            </span>
            {selectedRunningCount > 0 ? (
              <SmartTooltip content={{ label: "Stop runtimes", description: "Terminate selected running CLI and shell processes." }}>
                <button
                  type="button"
                  className="inline-flex h-6 items-center gap-1 rounded-md border border-amber-500/20 bg-amber-500/10 px-2 text-[10px] font-medium text-amber-200"
                  onClick={onBulkClose}
                >
                  <Square size={10} />
                  Stop {selectedRunningCount}
                </button>
              </SmartTooltip>
            ) : null}
            {selectedDeletableCount > 0 ? (
              <SmartTooltip content={{ label: "Delete selected", description: "Permanently delete selected sessions." }}>
                <button
                  type="button"
                  className="inline-flex h-6 items-center gap-1 rounded-md border border-red-500/25 bg-red-500/10 px-2 text-[10px] font-medium text-red-200"
                  onClick={onBulkDelete}
                >
                  <Trash size={10} />
                  Delete {selectedDeletableCount}
                </button>
              </SmartTooltip>
            ) : null}
            {selectedRunningCount > 0 ? (
              <SmartTooltip content={{ label: "Stop & delete selected", description: "Stop running runtimes, then permanently delete every selected session." }}>
                <button
                  type="button"
                  className="inline-flex h-6 items-center gap-1 rounded-md border border-red-500/30 bg-red-500/15 px-2 text-[10px] font-medium text-red-200"
                  onClick={onBulkStopAndDelete}
                >
                  <Trash size={10} />
                  Stop &amp; delete {selectedCount}
                </button>
              </SmartTooltip>
            ) : null}
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-fg/60 hover:bg-white/[0.06] hover:text-fg"
              onClick={onClearSelection}
              aria-label="Clear selected sessions"
              title="Clear selection"
            >
              <X size={10} />
            </button>
          </div>
        ) : null}
      </div>

      {/* Divider */}
      <div className="shrink-0 h-px" style={{ background: "var(--work-pane-border)" }} />

      {/* Session list */}
      <div
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1 pt-2"
        data-tour="work.crossLaneSwitch"
      >
        {!hasAnySessions ? (
          <div className="flex flex-col items-center justify-center h-full px-3 py-10 text-center">
            <Terminal size={16} weight="regular" className="text-muted-fg/15 mb-2" />
            <div className="text-[11px] font-medium text-fg/70">No sessions</div>
            <div className="mt-1 text-[10px] text-muted-fg/40 leading-relaxed max-w-[180px]">
              Start a new session above.
            </div>
          </div>
        ) : isByTime ? (
          byTimeList
        ) : isByLane ? (
          byLaneList
        ) : (
          groupedByStatusList
        )}
      </div>

      {/* Add Lane button */}
      <div className="shrink-0 px-2 pb-2 pt-1" style={{ borderTop: "1px solid var(--work-pane-border)" }}>
        <SmartTooltip content={{ label: "Add Lane", description: "Create a new lane without leaving Work." }}>
          <button
            type="button"
            className="inline-flex w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-[11px] font-medium transition-colors hover:bg-white/[0.06]"
            style={{
              color: "var(--color-muted-fg)",
              border: "1px solid rgba(255,255,255,0.06)",
              background: "rgba(255,255,255,0.02)",
              cursor: "pointer",
            }}
            onClick={() => setCreateLaneOpen(true)}
          >
            <Plus size={11} weight="bold" />
            Add Lane
          </button>
        </SmartTooltip>
      </div>
      {createLaneOpen ? (
        <CreateLaneDialogHost
          open={createLaneOpen}
          onOpenChange={setCreateLaneOpen}
          behavior="close-on-create"
          onNavigateToTemplates={() => navigate("/settings?tab=lane-templates")}
          onOpenLinearSettings={() => navigate("/settings?tab=general#linear-connection")}
        />
      ) : null}
      {laneContextMenuPortal}
    </div>
  );
});
