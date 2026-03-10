import { useMemo, useRef, type MouseEvent as ReactMouseEvent } from "react";
import {
  Rocket,
  SpinnerGap,
  ArrowsClockwise,
  MagnifyingGlass,
  Plus,
  GearSix,
  List,
  Kanban,
} from "@phosphor-icons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { MissionSummary } from "../../../shared/types";
import { cn } from "../ui/cn";
import { COLORS, MONO_FONT, SANS_FONT, primaryButton } from "../lanes/laneDesignTokens";
import { relativeWhen } from "../../lib/format";
import {
  STATUS_BADGE_STYLES,
  STATUS_DOT_HEX,
  STATUS_LABELS,
  MISSION_BOARD_COLUMNS,
  type MissionListViewMode,
} from "./missionHelpers";
import { useMissionsStore } from "./useMissionsStore";
import { openMissionCreateDialog } from "./missionCreateDialogStore";

/* ════════════════════ MISSION SIDEBAR ════════════════════ */

export function MissionSidebar() {
  const missions = useMissionsStore((s) => s.missions);
  const selectedMissionId = useMissionsStore((s) => s.selectedMissionId);
  const searchFilter = useMissionsStore((s) => s.searchFilter);
  const missionListView = useMissionsStore((s) => s.missionListView);
  const refreshing = useMissionsStore((s) => s.refreshing);
  const missionSettingsSnapshot = useMissionsStore((s) => s.missionSettingsSnapshot);

  const setSelectedMissionId = useMissionsStore((s) => s.setSelectedMissionId);
  const setSearchFilter = useMissionsStore((s) => s.setSearchFilter);
  const setMissionListView = useMissionsStore((s) => s.setMissionListView);
  const setMissionContextMenu = useMissionsStore((s) => s.setMissionContextMenu);
  const setMissionSettingsOpen = useMissionsStore((s) => s.setMissionSettingsOpen);
  const setMissionSettingsNotice = useMissionsStore((s) => s.setMissionSettingsNotice);
  const setMissionSettingsError = useMissionsStore((s) => s.setMissionSettingsError);
  const refreshMissionList = useMissionsStore((s) => s.refreshMissionList);
  const loadMissionSettings = useMissionsStore((s) => s.loadMissionSettings);

  const filteredMissions = useMemo(() => {
    if (!searchFilter.trim()) return missions;
    const q = searchFilter.toLowerCase();
    return missions.filter(
      (m) => m.title.toLowerCase().includes(q) || m.status.includes(q),
    );
  }, [missions, searchFilter]);

  const handleMissionContextMenu = (mission: MissionSummary, event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setSelectedMissionId(mission.id);
    setMissionContextMenu({
      mission,
      x: event.clientX,
      y: event.clientY,
    });
  };

  return (
    <div
      className="flex h-full w-full flex-col"
      style={{ background: COLORS.cardBg, borderRight: `1px solid ${COLORS.border}` }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between shrink-0 h-12 px-3"
        style={{ borderBottom: `1px solid ${COLORS.border}` }}
      >
        <div className="flex items-center gap-2">
          <Rocket size={16} weight="bold" style={{ color: COLORS.accent }} />
          <span
            className="text-[14px] font-bold tracking-[-0.2px]"
            style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}
          >
            MISSIONS
          </span>
          <span
            className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-[1px]"
            style={{
              background: `${COLORS.accent}18`,
              border: `1px solid ${COLORS.accent}30`,
              color: COLORS.accent,
              fontFamily: MONO_FONT,
            }}
          >
            {missions.length} TOTAL
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void refreshMissionList({ preserveSelection: true })}
            className="p-1 transition-colors"
            style={{ color: COLORS.textMuted }}
            title="Refresh"
          >
            {refreshing ? (
              <SpinnerGap className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ArrowsClockwise className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            onClick={() => {
              setMissionSettingsOpen(true);
              setMissionSettingsNotice(null);
              setMissionSettingsError(null);
              if (!missionSettingsSnapshot) {
                void loadMissionSettings();
              }
            }}
            className="p-1 transition-colors"
            style={{ color: COLORS.textMuted }}
            title="Mission Settings"
          >
            <GearSix className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => openMissionCreateDialog()}
            className="p-1 transition-colors"
            style={{ color: COLORS.accent }}
            title="New Mission"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* View mode toggle + Search */}
      <div className="px-2.5 py-2 space-y-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <MagnifyingGlass
              className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2"
              style={{ color: COLORS.textDim }}
            />
            <input
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              placeholder="Search missions..."
              className="h-7 w-full pl-7 pr-2 text-xs outline-none"
              style={{
                background: COLORS.recessedBg,
                border: `1px solid ${COLORS.outlineBorder}`,
                color: COLORS.textPrimary,
                fontFamily: MONO_FONT,
              }}
            />
          </div>
          <div
            className="flex gap-0.5 p-0.5"
            style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}
          >
            <button
              className="px-1.5 py-1 text-xs"
              style={
                missionListView === "list"
                  ? { background: `${COLORS.accent}18`, color: COLORS.textPrimary }
                  : { color: COLORS.textMuted }
              }
              onClick={() => setMissionListView("list")}
              title="List view"
            >
              <List size={14} weight="regular" />
            </button>
            <button
              className="px-1.5 py-1 text-xs"
              style={
                missionListView === "board"
                  ? { background: `${COLORS.accent}18`, color: COLORS.textPrimary }
                  : { color: COLORS.textMuted }
              }
              onClick={() => setMissionListView("board")}
              title="Board view"
            >
              <Kanban size={14} weight="regular" />
            </button>
          </div>
        </div>
      </div>

      {/* Mission list / board */}
      <div className={cn("flex-1 min-h-0 px-2 pb-2", missionListView === "list" && filteredMissions.length > 0 ? "overflow-hidden" : "overflow-y-auto")}>
        {filteredMissions.length === 0 ? (
          <div className="px-2 py-8 text-center text-xs" style={{ color: COLORS.textDim }}>
            {missions.length === 0 ? (
              <div className="flex flex-col items-center gap-2">
                <Rocket size={28} weight="regular" style={{ color: `${COLORS.accent}40` }} />
                <p>No missions yet. Missions coordinate your AI agents to accomplish complex tasks.</p>
                <button onClick={() => openMissionCreateDialog()} style={primaryButton()}>
                  START MISSION
                </button>
              </div>
            ) : (
              "No matches"
            )}
          </div>
        ) : missionListView === "board" ? (
          <MissionBoardView
            missions={filteredMissions}
            selectedMissionId={selectedMissionId}
            onSelect={setSelectedMissionId}
            onContextMenu={handleMissionContextMenu}
          />
        ) : (
          <MissionListView
            missions={filteredMissions}
            selectedMissionId={selectedMissionId}
            onSelect={setSelectedMissionId}
            onContextMenu={handleMissionContextMenu}
          />
        )}
      </div>
    </div>
  );
}

/* ────────── Board View ────────── */

function MissionBoardView(props: {
  missions: MissionSummary[];
  selectedMissionId: string | null;
  onSelect: (id: string) => void;
  onContextMenu: (m: MissionSummary, e: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const { missions, selectedMissionId, onSelect, onContextMenu } = props;
  return (
    <div className="space-y-3 pt-1">
      {MISSION_BOARD_COLUMNS.map((col) => {
        const colMissions = missions.filter((m) => m.status === col.key);
        if (colMissions.length === 0) return null;
        return (
          <div key={col.key}>
            <div className="flex items-center gap-2 mb-1.5 px-1">
              <span
                className="text-[10px] font-bold uppercase tracking-[1px]"
                style={{ color: col.hex, fontFamily: MONO_FONT }}
              >
                {col.label}
              </span>
              <span className="text-[10px]" style={{ color: COLORS.textDim }}>
                {colMissions.length}
              </span>
            </div>
            <div className="space-y-1">
              {colMissions.map((m) => (
                <MissionBoardCard
                  key={m.id}
                  mission={m}
                  isSelected={m.id === selectedMissionId}
                  onSelect={onSelect}
                  onContextMenu={onContextMenu}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MissionBoardCard(props: {
  mission: MissionSummary;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onContextMenu: (m: MissionSummary, e: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const { mission: m, isSelected, onSelect, onContextMenu } = props;
  return (
    <button
      onClick={() => onSelect(m.id)}
      onContextMenu={(event) => onContextMenu(m, event)}
      className="w-full text-left p-2.5 transition-colors"
      style={
        isSelected
          ? {
              background: "#A78BFA12",
              borderTop: `1px solid ${COLORS.accent}30`,
              borderRight: `1px solid ${COLORS.accent}30`,
              borderBottom: `1px solid ${COLORS.accent}30`,
              borderLeft: `3px solid ${COLORS.accent}`,
            }
          : { background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }
      }
    >
      <div className="flex items-center gap-1.5">
        <MissionStatusDot mission={m} />
        <div className="text-xs font-medium truncate flex-1" style={{ color: COLORS.textPrimary }}>
          {m.title}
        </div>
        <MissionInterventionBadge count={m.openInterventions} />
      </div>
      <div className="mt-1 text-[11px] truncate" style={{ color: COLORS.textMuted }}>
        {m.prompt}
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <span className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
          {relativeWhen(m.createdAt)}
        </span>
        {m.totalSteps > 0 && (
          <span className="text-[10px] ml-auto" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
            {m.completedSteps}/{m.totalSteps}
          </span>
        )}
      </div>
    </button>
  );
}

/* ────────── List View ────────── */

function MissionListView(props: {
  missions: MissionSummary[];
  selectedMissionId: string | null;
  onSelect: (id: string) => void;
  onContextMenu: (m: MissionSummary, e: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const { missions, selectedMissionId, onSelect, onContextMenu } = props;
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: missions.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 64,
    overscan: 5,
  });
  return (
    <div ref={parentRef} className="h-full overflow-y-auto" data-testid="mission-list-virtual">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const m = missions[virtualRow.index]!;
          return (
            <div
              key={m.id}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualRow.start}px)` }}
            >
              <MissionListItem
                mission={m}
                isSelected={m.id === selectedMissionId}
                onSelect={onSelect}
                onContextMenu={onContextMenu}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MissionListItem(props: {
  mission: MissionSummary;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onContextMenu: (m: MissionSummary, e: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const { mission: m, isSelected, onSelect, onContextMenu } = props;
  const progress = m.totalSteps > 0 ? Math.round((m.completedSteps / m.totalSteps) * 100) : 0;
  const isActive = m.status === "in_progress" || m.status === "planning";
  const badgeStyle = STATUS_BADGE_STYLES[m.status];
  return (
    <button
      onClick={() => onSelect(m.id)}
      onContextMenu={(event) => onContextMenu(m, event)}
      className={cn("w-full text-left px-2.5 py-2 transition-colors", isActive && !isSelected && "ade-glow-pulse-blue")}
      style={isSelected
        ? { background: "#A78BFA12", borderTop: `1px solid ${COLORS.accent}30`, borderRight: `1px solid ${COLORS.accent}30`, borderBottom: `1px solid ${COLORS.accent}30`, borderLeft: `3px solid ${COLORS.accent}` }
        : { border: "1px solid transparent" }}
    >
      <div className="flex items-start gap-2">
        <MissionListStatusDot mission={m} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium" style={{ color: COLORS.textPrimary }}>{m.title}</div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <span className="px-1 py-0.5 text-[10px] font-bold uppercase tracking-[1px]" style={{ background: badgeStyle.background, color: badgeStyle.color, border: badgeStyle.border, fontFamily: MONO_FONT }}>{STATUS_LABELS[m.status]}</span>
            <MissionInterventionBadge count={m.openInterventions} />
          </div>
          {m.totalSteps > 0 && (
            <div className="mt-1.5 flex items-center gap-2">
              <div className="h-1 flex-1" style={{ background: COLORS.recessedBg }}>
                <div className="h-1 transition-all" style={{ width: `${progress}%`, background: COLORS.accent }} />
              </div>
              <span className="shrink-0 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>{m.completedSteps}/{m.totalSteps}</span>
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

function MissionListStatusDot({ mission: m }: { mission: MissionSummary }) {
  const needsAttention = m.status === "intervention_required" || m.status === "failed" || (m.status === "in_progress" && m.openInterventions > 0);
  const dotColor = m.status === "intervention_required" ? "#F59E0B" : m.status === "in_progress" && m.openInterventions > 0 ? "#3B82F6" : m.status === "failed" ? "#EF4444" : STATUS_DOT_HEX[m.status];
  return (
    <span
      className={cn("mt-1 h-2 w-2 shrink-0", needsAttention && m.status !== "failed" && "ade-glow-pulse-amber", m.status === "failed" && "ade-glow-pulse-red")}
      style={{ background: dotColor, borderRadius: needsAttention ? "50%" : 0, boxShadow: needsAttention ? `0 0 6px ${dotColor}60` : "none" }}
    />
  );
}

/* ────────── Shared small components ────────── */

function MissionStatusDot({ mission: m }: { mission: MissionSummary }) {
  if (
    !(
      m.status === "intervention_required" ||
      m.status === "failed" ||
      (m.status === "in_progress" && m.openInterventions > 0)
    )
  )
    return null;
  return (
    <span
      className="shrink-0"
      style={{
        width: 6,
        height: 6,
        borderRadius: "50%",
        background:
          m.status === "intervention_required"
            ? "#F59E0B"
            : m.status === "failed"
              ? "#EF4444"
              : "#3B82F6",
        boxShadow:
          m.status === "intervention_required"
            ? "0 0 6px #F59E0B60"
            : m.status === "failed"
              ? "0 0 6px #EF444460"
              : "0 0 6px #3B82F660",
      }}
      title={
        m.status === "intervention_required"
          ? "Needs attention"
          : m.status === "failed"
            ? "Failed"
            : `${m.openInterventions} open intervention${m.openInterventions === 1 ? "" : "s"}`
      }
    />
  );
}

function MissionInterventionBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      className="shrink-0 px-1 py-0.5 text-[10px] font-bold"
      style={{
        color: COLORS.warning,
        background: `${COLORS.warning}18`,
        border: `1px solid ${COLORS.warning}30`,
        fontFamily: MONO_FONT,
      }}
      title={`${count} pending intervention${count === 1 ? "" : "s"}`}
    >
      {count > 1 ? `${count}!` : "!"}
    </span>
  );
}
