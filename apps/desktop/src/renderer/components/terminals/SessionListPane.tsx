import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CaretDown, CaretRight, Funnel, GitBranch, MagnifyingGlass, Plus, Terminal } from "@phosphor-icons/react";
import type { LaneSummary, TerminalSessionSummary } from "../../../shared/types";
import { SessionCard } from "./SessionCard";
import { LaneCombobox } from "./LaneCombobox";
import { sortLanesForTabs } from "../lanes/laneUtils";
import type { WorkDraftKind, WorkSessionListOrganization, WorkStatusFilter } from "../../state/appStore";
import { iconGlyph } from "../graph/graphHelpers";
import { SmartTooltip } from "../ui/SmartTooltip";

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
  children,
}: {
  sectionId: string;
  icon: React.ReactNode;
  label: string;
  count: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div className="mt-0.5 first:mt-0">
      <button
        type="button"
        className="sticky top-0 z-10 flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors backdrop-blur-xl cursor-pointer select-none hover:bg-white/[0.04]"
        style={{
          background: "rgba(255, 255, 255, 0.02)",
          borderBottom: "1px solid rgba(255, 255, 255, 0.04)",
        }}
        onClick={onToggleCollapsed}
        data-section-id={sectionId}
      >
        {collapsed ? (
          <CaretRight size={10} className="shrink-0 text-muted-fg/30" />
        ) : (
          <CaretDown size={10} className="shrink-0 text-muted-fg/30" />
        )}
        {icon}
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-fg/90">{label}</span>
        <span className="shrink-0 rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[9px] font-medium text-muted-fg/50">
          {count}
        </span>
      </button>
      {!collapsed && count > 0 ? (
        <div className="space-y-px pb-0.5">{children}</div>
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
  draftKind: _draftKind,
  showingDraft: _showingDraft,
  onShowDraftKind,
  onSelectSession,
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
  projectActiveTargetId,
}: {
  lanes: LaneSummary[];
  projectActiveTargetId?: string | null;
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
  draftKind: WorkDraftKind;
  showingDraft: boolean;
  onShowDraftKind: (kind: WorkDraftKind) => void;
  onSelectSession: (id: string) => void;
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
  const laneById = useMemo(() => {
    const map = new Map<string, LaneSummary>();
    for (const lane of lanes) map.set(lane.id, lane);
    return map;
  }, [lanes]);

  const renderCards = (list: TerminalSessionSummary[]) =>
    list.map((session) => (
      <SessionCard
        key={session.id}
        session={session}
        lane={laneById.get(session.laneId) ?? null}
        projectActiveTargetId={projectActiveTargetId}
        isSelected={selectedSessionId === session.id}
        onSelect={onSelectSession}
        onResume={() => onResume(session)}
        onInfoClick={(e) => onInfoClick(session, e)}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu(session, e);
        }}
        resumingSessionId={resumingSessionId}
      />
    ));

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
        const laneIcon = (
          <span className="inline-flex shrink-0 items-center justify-center text-muted-fg/55">
            {lane.icon ? iconGlyph(lane.icon) : <GitBranch size={11} weight="regular" />}
          </span>
        );
        return (
          <StickyGroupHeader
            key={lane.id}
            sectionId={lane.id}
            icon={laneIcon}
            label={lane.name}
            count={total}
            collapsed={collapsed}
            onToggleCollapsed={() => toggleWorkLaneCollapsed(lane.id)}
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
    <div className="flex h-full flex-col overflow-hidden" style={{ background: "var(--work-sidebar-bg)" }}>
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
            >
              <Funnel size={12} weight={filterOpen ? "fill" : "regular"} />
            </button>
          </SmartTooltip>
        </div>

        {/* Expandable filter panel */}
        {filterOpen ? (
          <div className="space-y-1.5 rounded-lg p-2" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.04)" }}>
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
                      className="flex-1 rounded-md px-2 py-1 text-[10px] font-medium transition-colors"
                      style={{
                        background: sessionListOrganization === opt.key ? "rgba(255,255,255,0.08)" : "transparent",
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
      </div>

      {/* Divider */}
      <div className="shrink-0 h-px" style={{ background: "var(--work-pane-border)" }} />

      {/* Session list */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pt-1">
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
