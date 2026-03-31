import React, { useMemo } from "react";
import { CaretDown, CaretRight, ChatCircleText, Command, Terminal } from "@phosphor-icons/react";
import type { LaneSummary, TerminalSessionSummary } from "../../../shared/types";
import { SessionCard } from "./SessionCard";
import { LaneCombobox } from "./LaneCombobox";
import { sortLanesForTabs } from "../lanes/laneUtils";
import type { WorkDraftKind, WorkSessionListOrganization, WorkStatusFilter } from "../../state/appStore";
import { sessionStatusBucket } from "../../lib/terminalAttention";

const ENTRY_OPTIONS: Array<{
  kind: WorkDraftKind;
  label: string;
  icon: typeof ChatCircleText;
}> = [
  { kind: "chat", label: "Chat", icon: ChatCircleText },
  { kind: "cli", label: "CLI", icon: Command },
  { kind: "shell", label: "Shell", icon: Terminal },
];

function bucketSessions(sessions: TerminalSessionSummary[]) {
  const running: TerminalSessionSummary[] = [];
  const awaiting: TerminalSessionSummary[] = [];
  const ended: TerminalSessionSummary[] = [];
  for (const s of sessions) {
    const b = sessionStatusBucket({
      status: s.status,
      lastOutputPreview: s.lastOutputPreview,
      runtimeState: s.runtimeState,
    });
    if (b === "running") running.push(s);
    else if (b === "awaiting-input") awaiting.push(s);
    else ended.push(s);
  }
  return { running, awaiting, ended };
}

function SessionSection({
  title,
  color,
  count,
  children,
}: {
  title: string;
  color: string;
  count: number;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div className="mt-1 first:mt-0">
      <div className="flex items-center gap-1.5 px-2 py-1">
        <span className="h-1 w-1 rounded-full" style={{ background: color }} />
        <span className="text-[10px] font-medium" style={{ color, letterSpacing: "-0.01em" }}>
          {title}
        </span>
        <span className="text-[10px] text-muted-fg/40">{count}</span>
      </div>
      <div className="space-y-px">{children}</div>
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
  draftKind,
  showingDraft,
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
  sessionsGroupedByLane: Map<string, TerminalSessionSummary[]> | null;
}) {
  const orderedLanes = useMemo(() => sortLanesForTabs(lanes), [lanes]);

  const hasAnySessions =
    runningFiltered.length + awaitingInputFiltered.length + endedFiltered.length > 0;

  const isByLane = sessionListOrganization === "by-lane";

  const renderCards = (list: TerminalSessionSummary[]) =>
    list.map((session) => (
      <SessionCard
        key={session.id}
        session={session}
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
      <SessionSection title="Running" color="var(--color-success)" count={runningFiltered.length}>
        {renderCards(runningFiltered)}
      </SessionSection>
      <SessionSection title="Awaiting" color="var(--color-warning)" count={awaitingInputFiltered.length}>
        {renderCards(awaitingInputFiltered)}
      </SessionSection>
      <SessionSection title="Ended" color="var(--color-error)" count={endedFiltered.length}>
        {renderCards(endedFiltered)}
      </SessionSection>
    </div>
  );

  const byLaneList = (
    <div className="px-1.5 pb-2">
      {orderedLanes.map((lane) => {
        const list = sessionsGroupedByLane?.get(lane.id) ?? [];
        const collapsed = workCollapsedLaneIds.includes(lane.id);
        const { running, awaiting, ended } = bucketSessions(list);
        const total = list.length;
        return (
          <div key={lane.id} className="mt-0.5 first:mt-0">
            <button
              type="button"
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04]"
              onClick={() => toggleWorkLaneCollapsed(lane.id)}
            >
              {collapsed ? (
                <CaretRight size={10} className="shrink-0 text-muted-fg/30" />
              ) : (
                <CaretDown size={10} className="shrink-0 text-muted-fg/30" />
              )}
              <span
                className="h-[5px] w-[5px] shrink-0 rounded-full"
                style={{ background: lane.color ?? "var(--color-muted-fg)" }}
              />
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-fg/90">{lane.name}</span>
              <span className="shrink-0 text-[10px] text-muted-fg/30">{total}</span>
            </button>
            {!collapsed && total > 0 ? (
              <div className="ml-4 border-l border-white/[0.04] pl-2 pb-0.5">
                <SessionSection title="Running" color="var(--color-success)" count={running.length}>
                  {renderCards(running)}
                </SessionSection>
                <SessionSection title="Awaiting" color="var(--color-warning)" count={awaiting.length}>
                  {renderCards(awaiting)}
                </SessionSection>
                <SessionSection title="Ended" color="var(--color-error)" count={ended.length}>
                  {renderCards(ended)}
                </SessionSection>
              </div>
            ) : null}
            {!collapsed && total === 0 ? (
              <div className="ml-7 py-1 text-[10px] text-muted-fg/30">
                No sessions
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="flex h-full flex-col overflow-hidden" style={{ background: "var(--work-sidebar-bg)" }}>
      {/* Toolbar */}
      <div className="shrink-0 px-2 pt-2 pb-1.5 space-y-1.5">
        {/* Entry buttons */}
        <div className="flex items-center gap-1">
          {ENTRY_OPTIONS.map((entry) => {
            const Icon = entry.icon;
            const active = showingDraft && draftKind === entry.kind;
            return (
              <button
                key={entry.kind}
                type="button"
                onClick={() => onShowDraftKind(entry.kind)}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md transition-colors"
                style={{
                  height: 28,
                  border: "none",
                  background: active ? "var(--color-accent-muted)" : "rgba(255,255,255,0.03)",
                  color: active ? "var(--color-accent)" : "var(--color-muted-fg)",
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: active ? 500 : 400,
                }}
              >
                <Icon size={12} weight="regular" />
                {entry.label}
              </button>
            );
          })}
        </div>

        {/* View toggle: By status / By lane */}
        <div className="ade-work-segmented">
          <button
            type="button"
            className="ade-work-segmented-item"
            data-active={!isByLane ? "true" : undefined}
            onClick={() => setSessionListOrganization("all-lanes-by-status")}
            style={{ flex: 1 }}
          >
            By status
          </button>
          <button
            type="button"
            className="ade-work-segmented-item"
            data-active={isByLane ? "true" : undefined}
            onClick={() => setSessionListOrganization("by-lane")}
            style={{ flex: 1 }}
          >
            By lane
          </button>
        </div>

        {/* Lane filter */}
        <LaneCombobox
          lanes={orderedLanes}
          value={filterLaneId}
          onChange={setFilterLaneId}
          showAllOption
        />

        {/* Search */}
        <input
          className="h-7 w-full rounded-md border px-2.5 text-[11px] text-fg outline-none"
          style={{
            borderColor: "rgba(255,255,255,0.06)",
            background: "rgba(255,255,255,0.03)",
          }}
          placeholder="Search sessions..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {/* Divider */}
      <div className="shrink-0 h-px" style={{ background: "var(--work-pane-border)" }} />

      {/* Session list */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pt-1">
        {!hasAnySessions && !isByLane ? (
          <div className="flex flex-col items-center justify-center h-full px-3 py-10 text-center">
            <Terminal size={16} weight="regular" className="text-muted-fg/15 mb-2" />
            <div className="text-[11px] font-medium text-fg/70">No sessions</div>
            <div className="mt-1 text-[10px] text-muted-fg/40 leading-relaxed max-w-[180px]">
              Start a new session above.
            </div>
          </div>
        ) : isByLane ? (
          byLaneList
        ) : (
          groupedByStatusList
        )}
      </div>
    </div>
  );
});
