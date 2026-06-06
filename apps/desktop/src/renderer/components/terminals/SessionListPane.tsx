import React, { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CaretDown, CaretRight, Funnel, MagnifyingGlass, Plus, Square, Terminal, Trash, X } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { BranchIcon, LaneIcon } from "../ui/vcsIcons";
import type { LaneSummary, TerminalSessionSummary } from "../../../shared/types";
import { SessionCard } from "./SessionCard";
import { LaneCombobox } from "./LaneCombobox";
import { sortLanesForTabs } from "../lanes/laneUtils";
import type { WorkDraftKind, WorkGridSet, WorkSessionListOrganization } from "../../state/appStore";
import { findGridSetForSession } from "../../lib/workGrid";
import { iconGlyph } from "../graph/graphHelpers";
import { SmartTooltip } from "../ui/SmartTooltip";
import { cn } from "../ui/cn";
import { branchNameFromRef } from "../prs/shared/laneBranchTargets";
import { laneSurfaceTint } from "../lanes/laneDesignTokens";
import { canBulkDeleteSession, canBulkStopSession } from "../../lib/sessions";
import { useWorkLaneContextMenu } from "./useWorkLaneContextMenu";


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
      <button
        type="button"
        className={cn(
          "ade-lane-group-header sticky top-0 z-10 flex w-full items-center text-left transition-colors backdrop-blur-xl cursor-pointer select-none",
          isLane ? "gap-1.5 rounded-lg px-3 py-2" : "gap-1.5 rounded-md px-2 py-1.5",
          laneTint.text ? "hover:brightness-[1.03]" : "hover:bg-white/[0.04]",
        )}
        style={{
          background: laneTint.background,
          border: isLane
            ? laneTint.border ?? "1px solid rgba(255, 255, 255, 0.08)"
            : undefined,
          borderBottom: isLane ? undefined : "1px solid rgba(255, 255, 255, 0.04)",
          boxShadow: isLane
            ? "0 1px 6px -2px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.04)"
            : undefined,
        }}
        onClick={onToggleCollapsed}
        onContextMenu={onContextMenu}
        data-section-id={sectionId}
      >
        {isLane ? (
          <div className="flex w-full min-w-0 items-center gap-1.5">
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
            <span className="ml-auto shrink-0 rounded-full bg-white/[0.08] px-1.5 py-px text-[10px] font-semibold tabular-nums text-muted-fg/60">
              {count}
            </span>
          </div>
        ) : (
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

export const SessionListPane = React.memo(function SessionListPane({
  lanes,
  runningFiltered,
  awaitingInputFiltered,
  endedFiltered,
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
}: {
  lanes: LaneSummary[];
  runningFiltered: TerminalSessionSummary[];
  awaitingInputFiltered: TerminalSessionSummary[];
  endedFiltered: TerminalSessionSummary[];
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
  onContextMenu: (session: TerminalSessionSummary, e: React.MouseEvent) => void;
  sessionListOrganization: WorkSessionListOrganization;
  setSessionListOrganization: (v: WorkSessionListOrganization) => void;
  workCollapsedLaneIds: string[];
  toggleWorkLaneCollapsed: (laneId: string) => void;
  workCollapsedSectionIds: string[];
  toggleWorkSectionCollapsed: (sectionId: string) => void;
  sessionsGroupedByLane: Map<string, TerminalSessionSummary[]> | null;
}) {
  const navigate = useNavigate();
  const orderedLanes = useMemo(() => sortLanesForTabs(lanes), [lanes]);
  const { trigger: triggerLaneContextMenu, menu: laneContextMenuPortal } = useWorkLaneContextMenu();

  const hasAnySessions =
    runningFiltered.length + awaitingInputFiltered.length + endedFiltered.length > 0;

  const isByLane = sessionListOrganization === "by-lane";
  const isByTime = sessionListOrganization === "by-time";
  const normalizedFilterLaneId = filterLaneId.trim();
  const laneFilterActive = normalizedFilterLaneId.length > 0 && normalizedFilterLaneId !== "all";
  const [filterOpen, setFilterOpen] = useState(false);

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
  const isChildSectionCollapsed = useCallback(
    (parentId: string) => workCollapsedSectionIds.includes(`chat:${parentId}`),
    [workCollapsedSectionIds],
  );
  const toggleChildSection = useCallback(
    (parentId: string) => toggleWorkSectionCollapsed(`chat:${parentId}`),
    [toggleWorkSectionCollapsed],
  );
  const timeBuckets = useMemo(() => bucketByTime(allSessions), [allSessions]);
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

  // First-rendered card carries `data-tour="work.sessionItem"` so the Work
  // tab tour can anchor at a real session. We track whether we've already
  // emitted the anchor across the whole list (not per-section).
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

  const groupedByStatusList = (
    <div className="px-1.5 pb-2">
      <StickyGroupHeader
        sectionId="status:running"
        icon={<span className="h-2 w-2 shrink-0 rounded-full" style={{ background: "var(--color-success)" }} />}
        label="Running"
        count={runningFiltered.length}
        collapsed={workCollapsedSectionIds.includes("status:running")}
        onToggleCollapsed={() => toggleWorkSectionCollapsed("status:running")}
      >
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
        const collapsed = workCollapsedLaneIds.includes(lane.id);
        const total = list.length;
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
            onToggleCollapsed={() => toggleWorkLaneCollapsed(lane.id)}
            onContextMenu={(e) => triggerLaneContextMenu(lane.id, e)}
          >
            {renderCards(list)}
          </StickyGroupHeader>
        );
      })}
      {missingLaneSessionGroups.map(([laneId, list]) => {
        const collapsed = workCollapsedLaneIds.includes(laneId);
        const trimmedLaneName = (list[0]?.laneName ?? "").trim();
        const label = trimmedLaneName.length > 0 ? trimmedLaneName : laneId;
        return (
          <StickyGroupHeader
            key={laneId}
            sectionId={laneId}
            icon={<LaneIcon size={12} weight="regular" className="h-3.5 w-3.5 shrink-0 text-muted-fg/55" />}
            label={label}
            variant="lane"
            count={list.length}
            collapsed={collapsed}
            onToggleCollapsed={() => toggleWorkLaneCollapsed(laneId)}
          >
            {renderCards(list)}
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
        count={timeBuckets.today.length}
        collapsed={workCollapsedSectionIds.includes("time:today")}
        onToggleCollapsed={() => toggleWorkSectionCollapsed("time:today")}
      >
        {renderCards(timeBuckets.today)}
      </StickyGroupHeader>
      <StickyGroupHeader
        sectionId="time:yesterday"
        icon={null}
        label="Yesterday"
        count={timeBuckets.yesterday.length}
        collapsed={workCollapsedSectionIds.includes("time:yesterday")}
        onToggleCollapsed={() => toggleWorkSectionCollapsed("time:yesterday")}
      >
        {renderCards(timeBuckets.yesterday)}
      </StickyGroupHeader>
      <StickyGroupHeader
        sectionId="time:older"
        icon={null}
        label="Older"
        count={timeBuckets.older.length}
        collapsed={workCollapsedSectionIds.includes("time:older")}
        onToggleCollapsed={() => toggleWorkSectionCollapsed("time:older")}
      >
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
        <SmartTooltip content={{ label: "Add Lane", description: "Navigate to the Lanes tab to create a new lane." }}>
          <button
            type="button"
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg py-1.5 text-[11px] font-medium transition-colors hover:bg-white/[0.06]"
            style={{
              color: "var(--color-muted-fg)",
              border: "1px solid rgba(255,255,255,0.06)",
              background: "rgba(255,255,255,0.02)",
              cursor: "pointer",
            }}
            onClick={() => navigate("/lanes?action=create")}
          >
            <Plus size={11} weight="bold" />
            Add Lane
          </button>
        </SmartTooltip>
      </div>
      {laneContextMenuPortal}
    </div>
  );
});
