import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Archive, ArrowCounterClockwise, CaretDown, CaretRight, DownloadSimple, Funnel, GitBranch, MagnifyingGlass, Plus, Square, Terminal, Trash, X } from "@phosphor-icons/react";
import type { LaneSummary, TerminalSessionSummary } from "../../../shared/types";
import { SessionCard } from "./SessionCard";
import { LaneCombobox } from "./LaneCombobox";
import { sortLanesForTabs } from "../lanes/laneUtils";
import type { WorkDraftKind, WorkSessionListOrganization, WorkStatusFilter } from "../../state/appStore";
import { iconGlyph } from "../graph/graphHelpers";
import { SmartTooltip } from "../ui/SmartTooltip";
import { cn } from "../ui/cn";
import { branchNameFromRef } from "../prs/shared/laneBranchTargets";
import { laneSurfaceTint } from "../lanes/laneDesignTokens";

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
  const laneTint = laneSurfaceTint(accentColor, isLane ? "default" : "soft");
  return (
    <div className="mt-0.5 first:mt-0">
      <button
        type="button"
        className={cn(
          "sticky top-0 z-10 flex w-full items-center gap-1.5 rounded-md text-left transition-colors backdrop-blur-xl cursor-pointer select-none",
          laneTint.text ? "hover:brightness-[1.03]" : "hover:bg-white/[0.04]",
          isLane ? "px-2.5 py-2" : "px-2 py-1.5",
        )}
        style={{
          background: laneTint.background,
          borderBottom: isLane ? undefined : "1px solid rgba(255, 255, 255, 0.04)",
        }}
        onClick={onToggleCollapsed}
        data-section-id={sectionId}
      >
        {isLane ? (
          <div className="flex w-full min-w-0 items-center gap-1.5">
            {collapsed ? (
              <CaretRight size={12} className="shrink-0 text-muted-fg/30" />
            ) : (
              <CaretDown size={12} className="shrink-0 text-muted-fg/30" />
            )}
            {icon}
            <span
              className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-tight text-fg/90"
              style={accentColor ? { color: accentColor } : undefined}
            >
              {label}
            </span>
            {showBranchCluster ? (
              <div
                className="flex min-w-0 max-w-[min(50%,12rem)] shrink items-center gap-1"
                style={{ color: "var(--color-muted-fg)" }}
              >
                <GitBranch size={10} weight="regular" className="shrink-0 opacity-60" aria-hidden />
                <span className="truncate text-[10px] font-medium leading-tight text-muted-fg/75" title={branchText}>
                  {branchText}
                </span>
              </div>
            ) : null}
            <span className="shrink-0 rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[9px] font-medium text-muted-fg/50">
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
      {!collapsed && count > 0 ? (
        <div
          className={cn(
            "space-y-px pb-0.5",
            isLane && "pl-2",
          )}
        >
          {children}
        </div>
      ) : null}
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
  filterStatus: _filterStatus,
  setFilterStatus: _setFilterStatus,
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
  onBulkArchive,
  onBulkRestore,
  onBulkExport,
  archivableCount = 0,
  restorableCount = 0,
  onResume,
  resumingSessionId,
  onInfoClick,
  onContextMenu,
  sessionListOrganization,
  setSessionListOrganization,
  workCollapsedLaneIds,
  toggleWorkLaneCollapsed,
  workCollapsedSectionIds,
  toggleWorkSectionCollapsed,
  sessionsGroupedByLane,
}: {
  lanes: LaneSummary[];
  runningFiltered: TerminalSessionSummary[];
  awaitingInputFiltered: TerminalSessionSummary[];
  endedFiltered: TerminalSessionSummary[];
  loading: boolean;
  filterLaneId: string;
  setFilterLaneId: (v: string) => void;
  filterStatus: WorkStatusFilter;
  setFilterStatus: (v: WorkStatusFilter) => void;
  q: string;
  setQ: (v: string) => void;
  selectedSessionId: string | null;
  selectedSessionIds?: Set<string>;
  draftKind: WorkDraftKind;
  showingDraft: boolean;
  onShowDraftKind: (kind: WorkDraftKind) => void;
  onSelectSession: (id: string, event: React.MouseEvent, visibleSessionIds: string[]) => void;
  onClearSelection?: () => void;
  onBulkClose?: () => void;
  onBulkDelete?: () => void;
  onBulkArchive?: () => void;
  onBulkRestore?: () => void;
  onBulkExport?: () => void;
  archivableCount?: number;
  restorableCount?: number;
  onResume: (session: TerminalSessionSummary) => void;
  resumingSessionId: string | null;
  onInfoClick: (session: TerminalSessionSummary, e: React.MouseEvent) => void;
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

  const hasAnySessions =
    runningFiltered.length + awaitingInputFiltered.length + endedFiltered.length > 0;

  const isByLane = sessionListOrganization === "by-lane";
  const isByTime = sessionListOrganization === "by-time";
  const [filterOpen, setFilterOpen] = useState(false);

  const allSessions = useMemo(
    () => [...runningFiltered, ...awaitingInputFiltered, ...endedFiltered],
    [runningFiltered, awaitingInputFiltered, endedFiltered],
  );
  const timeBuckets = useMemo(() => bucketByTime(allSessions), [allSessions]);
  const selectedCount = selectedSessionIds?.size ?? 0;
  const selectedSessions = useMemo(
    () => allSessions.filter((session) => selectedSessionIds?.has(session.id)),
    [allSessions, selectedSessionIds],
  );
  const selectedRunningCount = selectedSessions.filter((session) => session.status === "running").length;
  const selectedEndedCount = selectedSessions.length - selectedRunningCount;
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
  const renderedSessionIds = useMemo(() => {
    if (isByLane) {
      const ids: string[] = [];
      for (const lane of orderedLanes) {
        if (workCollapsedLaneIds.includes(lane.id)) continue;
        ids.push(...(sessionsGroupedByLane?.get(lane.id) ?? []).map((session) => session.id));
      }
      for (const [laneId, list] of missingLaneSessionGroups) {
        if (workCollapsedLaneIds.includes(laneId)) continue;
        ids.push(...list.map((session) => session.id));
      }
      return ids;
    }
    if (isByTime) {
      const ids: string[] = [];
      if (!workCollapsedSectionIds.includes("time:today")) ids.push(...timeBuckets.today.map((session) => session.id));
      if (!workCollapsedSectionIds.includes("time:yesterday")) ids.push(...timeBuckets.yesterday.map((session) => session.id));
      if (!workCollapsedSectionIds.includes("time:older")) ids.push(...timeBuckets.older.map((session) => session.id));
      return ids;
    }
    const ids: string[] = [];
    if (!workCollapsedSectionIds.includes("status:running")) ids.push(...runningFiltered.map((session) => session.id));
    if (!workCollapsedSectionIds.includes("status:awaiting")) ids.push(...awaitingInputFiltered.map((session) => session.id));
    if (!workCollapsedSectionIds.includes("status:ended")) ids.push(...endedFiltered.map((session) => session.id));
    return ids;
  }, [
    awaitingInputFiltered,
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
  const renderCards = (list: TerminalSessionSummary[]) =>
    list.map((session) => {
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
          onResume={() => onResume(session)}
          onInfoClick={(e) => onInfoClick(session, e)}
          onContextMenu={(e) => {
            e.preventDefault();
            onContextMenu(session, e);
          }}
          resumingSessionId={resumingSessionId}
        />
      );
      if (!isFirst) return card;
      // tour anchor: wraps the first rendered SessionCard.
      return (
        <div key={session.id} data-tour="work.sessionItem">
          {card}
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
    <div className="px-1.5 pb-2">
      {orderedLanes.map((lane) => {
        const list = sessionsGroupedByLane?.get(lane.id) ?? [];
        const collapsed = workCollapsedLaneIds.includes(lane.id);
        const total = list.length;
        const laneAccent = lane.color ?? null;
        const laneIcon = (
          <span
            className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center"
            style={{ color: laneAccent ?? "var(--color-muted-fg)" }}
          >
            {lane.icon ? iconGlyph(lane.icon) : <Terminal size={12} weight="regular" />}
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
            icon={<GitBranch size={12} weight="regular" className="h-3.5 w-3.5 shrink-0 text-muted-fg/55" />}
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
      <div className="shrink-0 px-2 pt-2 pb-1.5 space-y-1.5">
        {/* Search + filter row */}
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1 min-w-0">
            <MagnifyingGlass size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-fg/40" />
            <input
              className="h-7 w-full rounded-lg border pl-7 pr-2 text-[11px] text-fg outline-none placeholder:text-muted-fg/30"
              style={{
                borderColor: "rgba(255,255,255,0.06)",
                background: "rgba(255,255,255,0.03)",
              }}
              placeholder="Search..."
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <SmartTooltip content={{ label: "New Chat", description: "Start a new AI chat session." }}>
            <button
              type="button"
              className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-[10px] font-medium transition-colors"
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
              New Chat
            </button>
          </SmartTooltip>
          <SmartTooltip content={{ label: "Filters", description: "Toggle the filter panel to organize sessions by lane, status, or time." }}>
            <button
              type="button"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors"
              style={{
                border: "1px solid rgba(255,255,255,0.06)",
                background: filterOpen ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.03)",
                color: filterOpen ? "var(--color-fg)" : "var(--color-muted-fg)",
              }}
              onClick={() => setFilterOpen(!filterOpen)}
              aria-label="Filters"
              data-tour="work.laneFilter"
            >
              <Funnel size={12} weight={filterOpen ? "fill" : "regular"} />
            </button>
          </SmartTooltip>
        </div>

        {/* Expandable filter panel */}
        {filterOpen ? (
          <div className="ade-chat-drawer-glass space-y-1.5 p-2">
            <div className="flex items-center gap-1">
              <span className="text-[9px] font-medium text-muted-fg/50 uppercase tracking-wider shrink-0 w-10">Group</span>
              <div className="flex items-center gap-0.5 flex-1">
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
                      className="ade-chat-drawer-row flex-1 rounded-md px-2 py-1 text-[10px] font-medium"
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
            <div className="flex items-center gap-1">
              <span className="text-[9px] font-medium text-muted-fg/50 uppercase tracking-wider shrink-0 w-10">Lane</span>
              <div className="flex-1">
                <LaneCombobox
                  lanes={orderedLanes}
                  value={filterLaneId}
                  onChange={setFilterLaneId}
                  showAllOption
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
              <SmartTooltip content={{ label: "Close selected", description: "Terminate selected running sessions." }}>
                <button
                  type="button"
                  className="inline-flex h-6 items-center gap-1 rounded-md border border-amber-500/20 bg-amber-500/10 px-2 text-[10px] font-medium text-amber-200"
                  onClick={onBulkClose}
                >
                  <Square size={10} />
                  Close {selectedRunningCount}
                </button>
              </SmartTooltip>
            ) : null}
            {archivableCount > 0 ? (
              <SmartTooltip content={{ label: "Archive selected", description: "Hide selected chats from the default view. Terminal sessions are skipped." }}>
                <button
                  type="button"
                  className="inline-flex h-6 items-center gap-1 rounded-md border border-white/10 bg-white/[0.05] px-2 text-[10px] font-medium text-fg/80"
                  onClick={onBulkArchive}
                >
                  <Archive size={10} />
                  Archive {archivableCount}
                </button>
              </SmartTooltip>
            ) : null}
            {restorableCount > 0 ? (
              <SmartTooltip content={{ label: "Restore selected", description: "Return selected archived chats to the active list." }}>
                <button
                  type="button"
                  className="inline-flex h-6 items-center gap-1 rounded-md border border-white/10 bg-white/[0.05] px-2 text-[10px] font-medium text-fg/80"
                  onClick={onBulkRestore}
                >
                  <ArrowCounterClockwise size={10} />
                  Restore {restorableCount}
                </button>
              </SmartTooltip>
            ) : null}
            {selectedCount > 0 ? (
              <SmartTooltip content={{ label: "Export bundle", description: "Download a markdown file with metadata for the selected sessions." }}>
                <button
                  type="button"
                  className="inline-flex h-6 items-center gap-1 rounded-md border border-white/10 bg-white/[0.05] px-2 text-[10px] font-medium text-fg/80"
                  onClick={onBulkExport}
                >
                  <DownloadSimple size={10} />
                  Export
                </button>
              </SmartTooltip>
            ) : null}
            {selectedEndedCount > 0 ? (
              <SmartTooltip content={{ label: "Delete selected", description: "Permanently delete selected ended sessions." }}>
                <button
                  type="button"
                  className="inline-flex h-6 items-center gap-1 rounded-md border border-red-500/25 bg-red-500/10 px-2 text-[10px] font-medium text-red-200"
                  onClick={onBulkDelete}
                >
                  <Trash size={10} />
                  Delete {selectedEndedCount}
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
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pt-1"
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
    </div>
  );
});
