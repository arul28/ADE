import { useMemo, useRef, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
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
import { useShallow } from "zustand/react/shallow";
import type { MissionRunView, MissionRunViewDisplayStatus, MissionSummary } from "../../../shared/types";
import { cn } from "../ui/cn";
import { COLORS, MONO_FONT, SANS_FONT, primaryButton } from "../lanes/laneDesignTokens";
import { relativeWhen } from "../../lib/format";
import {
  MISSION_BOARD_COLUMNS,
  getMissionStatusBadgeConfig,
  isMissionVisiblyActive,
  type MissionListViewMode,
} from "./missionHelpers";
import { buildMissionStateNarrative } from "./missionFeedPresentation";
import { useMissionsStore } from "./useMissionsStore";
import { openMissionCreateDialog } from "./missionCreateDialogStore";

const selectSidebarState = (s: ReturnType<typeof useMissionsStore.getState>) => ({
  missions: s.missions,
  selectedMissionId: s.selectedMissionId,
  selectedMission: s.selectedMission,
  searchFilter: s.searchFilter,
  missionListView: s.missionListView,
  refreshing: s.refreshing,
  missionSettingsSnapshot: s.missionSettingsSnapshot,
});

/* ════════════════════ MISSION SIDEBAR ════════════════════ */

export function MissionSidebar({ runView }: { runView: MissionRunView | null }) {
  const {
    missions,
    selectedMissionId,
    selectedMission,
    searchFilter,
    missionListView,
    refreshing,
    missionSettingsSnapshot,
  } = useMissionsStore(useShallow(selectSidebarState));

  const setSelectedMissionId = useMissionsStore((s) => s.setSelectedMissionId);
  const setSearchFilter = useMissionsStore((s) => s.setSearchFilter);
  const setMissionListView = useMissionsStore((s) => s.setMissionListView);
  const setMissionContextMenu = useMissionsStore((s) => s.setMissionContextMenu);
  const setMissionSettingsOpen = useMissionsStore((s) => s.setMissionSettingsOpen);
  const setMissionSettingsNotice = useMissionsStore((s) => s.setMissionSettingsNotice);
  const setMissionSettingsError = useMissionsStore((s) => s.setMissionSettingsError);
  const refreshMissionList = useMissionsStore((s) => s.refreshMissionList);
  const loadMissionSettings = useMissionsStore((s) => s.loadMissionSettings);

  const selectedDisplayStatus = runView?.lifecycle.displayStatus ?? null;
  const selectedMissionNarrative = useMemo(() => buildMissionStateNarrative(runView), [runView]);

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
              background: "color-mix(in srgb, var(--color-accent) 18%, transparent)",
              border: "1px solid color-mix(in srgb, var(--color-accent) 30%, transparent)",
              color: COLORS.accent,
              fontFamily: MONO_FONT,
            }}
          >
            {missions.length} TOTAL
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void refreshMissionList({ preserveSelection: true, refreshDashboard: true })}
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
                  ? { background: "color-mix(in srgb, var(--color-accent) 18%, transparent)", color: COLORS.textPrimary }
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
                  ? { background: "color-mix(in srgb, var(--color-accent) 18%, transparent)", color: COLORS.textPrimary }
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
                <Rocket size={28} weight="regular" style={{ color: "color-mix(in srgb, var(--color-accent) 40%, transparent)" }} />
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
            selectedDisplayStatus={selectedDisplayStatus}
            onSelect={setSelectedMissionId}
            onContextMenu={handleMissionContextMenu}
          />
        ) : (
          <MissionListView
            missions={filteredMissions}
            selectedMissionId={selectedMissionId}
            selectedDisplayStatus={selectedDisplayStatus}
            onSelect={setSelectedMissionId}
            onContextMenu={handleMissionContextMenu}
          />
        )}
      </div>

      <MissionSidebarStatusBlock
        missionTitle={selectedMission?.title ?? null}
        missionPrompt={selectedMission?.prompt ?? null}
        openInterventions={selectedMission?.openInterventions ?? 0}
        artifactCount={selectedMission?.artifactCount ?? 0}
        status={selectedDisplayStatus}
        summary={selectedMissionNarrative?.detail ?? null}
        headline={selectedMissionNarrative?.title ?? null}
        phaseName={runView?.active.phaseName ?? null}
        stepTitle={runView?.active.stepTitle ?? null}
        updatedAt={selectedMissionNarrative?.at ?? runView?.lastMeaningfulProgress?.at ?? selectedMission?.updatedAt ?? null}
      />
    </div>
  );
}

const SIDEBAR_STATUS_TONES: Record<MissionRunViewDisplayStatus, { style: CSSProperties; label: string }> = {
  not_started: { style: { background: "#6B728018", color: "#6B7280", border: "1px solid #6B728030" }, label: "Not started" },
  starting: { style: { background: "#A78BFA18", color: "#A78BFA", border: "1px solid #A78BFA30" }, label: "Starting" },
  running: { style: { background: "#22C55E18", color: "#22C55E", border: "1px solid #22C55E30" }, label: "Running" },
  paused: { style: { background: "#F59E0B18", color: "#F59E0B", border: "1px solid #F59E0B30" }, label: "Paused" },
  blocked: { style: { background: "#F59E0B18", color: "#F59E0B", border: "1px solid #F59E0B30" }, label: "Blocked" },
  completed: { style: { background: "#22C55E18", color: "#22C55E", border: "1px solid #22C55E30" }, label: "Completed" },
  failed: { style: { background: "#EF444418", color: "#EF4444", border: "1px solid #EF444430" }, label: "Failed" },
  canceled: { style: { background: "#6B728018", color: "#6B7280", border: "1px solid #6B728030" }, label: "Canceled" },
};

function MissionSidebarStatusBlock(props: {
  missionTitle: string | null;
  missionPrompt: string | null;
  openInterventions: number;
  artifactCount: number;
  status: MissionRunViewDisplayStatus | null;
  headline: string | null;
  summary: string | null;
  phaseName: string | null;
  stepTitle: string | null;
  updatedAt: string | null;
}) {
  const {
    missionTitle,
    missionPrompt,
    openInterventions,
    artifactCount,
    status,
    headline,
    summary,
    phaseName,
    stepTitle,
    updatedAt,
  } = props;

  return (
    <div className="shrink-0 px-2.5 pb-2.5 pt-2" style={{ borderTop: `1px solid ${COLORS.border}` }}>
      <div className="space-y-2" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, padding: "10px" }}>
        <div className="flex items-center justify-between gap-2">
          <span
            className="text-[10px] font-bold uppercase tracking-[1px]"
            style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}
          >
            Selected mission
          </span>
          {updatedAt ? (
            <span className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
              {relativeWhen(updatedAt)}
            </span>
          ) : null}
        </div>

        {missionTitle ? (
          <>
            <div className="space-y-1">
              <div className="text-[12px] font-semibold leading-[1.35]" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>
                {missionTitle}
              </div>
              {status ? (
                <span
                  className="inline-flex items-center px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.9px]"
                  style={SIDEBAR_STATUS_TONES[status].style}
                >
                  {SIDEBAR_STATUS_TONES[status].label}
                </span>
              ) : null}
            </div>

            {headline ? (
              <div className="text-[11px] font-semibold leading-[1.45]" style={{ color: COLORS.textSecondary }}>
                {headline}
              </div>
            ) : null}

            <div className="space-y-1 text-[11px] leading-[1.45]" style={{ color: COLORS.textMuted }}>
              <div>{summary || missionPrompt || "Open this mission to see its latest runtime state."}</div>
              {(phaseName || stepTitle) && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {phaseName ? (
                    <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.6px]" style={{ background: "color-mix(in srgb, var(--color-accent) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--color-accent) 28%, transparent)", color: COLORS.accent, fontFamily: MONO_FONT }}>
                      {phaseName}
                    </span>
                  ) : null}
                  {stepTitle ? (
                    <span className="truncate" style={{ color: COLORS.textSecondary }}>
                      {stepTitle}
                    </span>
                  ) : null}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 text-[10px]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
              <span>{openInterventions} open</span>
              <span>{artifactCount} artifacts</span>
            </div>
          </>
        ) : (
          <div className="text-[11px] leading-[1.45]" style={{ color: COLORS.textMuted }}>
            Pick a mission to keep its current run state visible while you browse the queue.
          </div>
        )}
      </div>
    </div>
  );
}

/* ────────── Board View ────────── */

function MissionBoardView(props: {
  missions: MissionSummary[];
  selectedMissionId: string | null;
  selectedDisplayStatus: MissionRunViewDisplayStatus | null;
  onSelect: (id: string) => void;
  onContextMenu: (m: MissionSummary, e: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const { missions, selectedMissionId, selectedDisplayStatus, onSelect, onContextMenu } = props;
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
                  displayStatus={m.id === selectedMissionId ? selectedDisplayStatus : null}
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
  displayStatus: MissionRunViewDisplayStatus | null;
  onSelect: (id: string) => void;
  onContextMenu: (m: MissionSummary, e: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const { mission: m, isSelected, displayStatus, onSelect, onContextMenu } = props;
  return (
    <button
      onClick={() => onSelect(m.id)}
      onContextMenu={(event) => onContextMenu(m, event)}
      className="w-full text-left p-2.5 transition-colors"
      style={
        isSelected
          ? {
              background: "#A78BFA12",
              borderTop: "1px solid color-mix(in srgb, var(--color-accent) 30%, transparent)",
              borderRight: "1px solid color-mix(in srgb, var(--color-accent) 30%, transparent)",
              borderBottom: "1px solid color-mix(in srgb, var(--color-accent) 30%, transparent)",
              borderLeft: `3px solid ${COLORS.accent}`,
            }
          : { background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }
      }
    >
      <div className="flex items-center gap-1.5">
        <MissionStatusDot mission={m} displayStatus={displayStatus} />
        <div className="text-xs font-medium truncate flex-1" style={{ color: COLORS.textPrimary }}>
          {m.title}
        </div>
        <MissionInterventionBadge count={m.openInterventions} missionStatus={m.status} />
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
  selectedDisplayStatus: MissionRunViewDisplayStatus | null;
  onSelect: (id: string) => void;
  onContextMenu: (m: MissionSummary, e: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const { missions, selectedMissionId, selectedDisplayStatus, onSelect, onContextMenu } = props;
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
                displayStatus={m.id === selectedMissionId ? selectedDisplayStatus : null}
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
  displayStatus: MissionRunViewDisplayStatus | null;
  onSelect: (id: string) => void;
  onContextMenu: (m: MissionSummary, e: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const { mission: m, isSelected, displayStatus, onSelect, onContextMenu } = props;
  const progress = m.totalSteps > 0 ? Math.round((m.completedSteps / m.totalSteps) * 100) : 0;
  const isActive = isMissionVisiblyActive(m.status, displayStatus);
  const badgeStyle = getMissionStatusBadgeConfig(m.status, displayStatus);
  return (
    <button
      onClick={() => onSelect(m.id)}
      onContextMenu={(event) => onContextMenu(m, event)}
      className="w-full text-left px-2.5 py-2 transition-colors"
      style={isSelected
        ? { background: "#A78BFA12", borderTop: "1px solid color-mix(in srgb, var(--color-accent) 30%, transparent)", borderRight: "1px solid color-mix(in srgb, var(--color-accent) 30%, transparent)", borderBottom: "1px solid color-mix(in srgb, var(--color-accent) 30%, transparent)", borderLeft: `3px solid ${COLORS.accent}` }
        : isActive
          ? { background: "color-mix(in srgb, var(--color-info) 6%, transparent)", border: "1px solid color-mix(in srgb, var(--color-info) 16%, transparent)" }
          : { border: "1px solid transparent" }}
    >
      <div className="flex items-start gap-2">
        <MissionListStatusDot mission={m} displayStatus={displayStatus} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium" style={{ color: COLORS.textPrimary }}>{m.title}</div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <span className="px-1 py-0.5 text-[10px] font-bold uppercase tracking-[1px]" style={{ background: badgeStyle.background, color: badgeStyle.color, border: badgeStyle.border, fontFamily: MONO_FONT }}>{badgeStyle.label}</span>
            <MissionInterventionBadge count={m.openInterventions} missionStatus={m.status} />
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

function MissionListStatusDot({ mission: m, displayStatus }: { mission: MissionSummary; displayStatus: MissionRunViewDisplayStatus | null }) {
  const baseStatus = getMissionStatusBadgeConfig(m.status, displayStatus);
  const isBlocked = displayStatus === "blocked" || m.status === "intervention_required";
  const isFailed = displayStatus === "failed" || m.status === "failed";
  const hasOpenInterventions = m.status === "in_progress" && m.openInterventions > 0;
  const needsAttention = isBlocked || isFailed || hasOpenInterventions;
  let dotColor: string;
  if (isBlocked) dotColor = "#F59E0B";
  else if (hasOpenInterventions) dotColor = "#3B82F6";
  else if (isFailed) dotColor = "#EF4444";
  else dotColor = baseStatus.color;
  return (
    <span
      className="mt-1 h-2 w-2 shrink-0"
      style={{ background: dotColor, borderRadius: needsAttention ? "50%" : 0, boxShadow: needsAttention ? `0 0 6px ${dotColor}60` : "none" }}
    />
  );
}

/* ────────── Shared small components ────────── */

function MissionStatusDot({ mission: m, displayStatus }: { mission: MissionSummary; displayStatus: MissionRunViewDisplayStatus | null }) {
  const isBlocked = displayStatus === "blocked" || m.status === "intervention_required";
  const isFailed = displayStatus === "failed" || m.status === "failed";
  const hasOpenInterventions = m.status === "in_progress" && m.openInterventions > 0;
  if (!(isBlocked || isFailed || hasOpenInterventions)) return null;
  let color: string;
  let title: string;
  if (isBlocked) {
    color = "#F59E0B";
    title = "Needs attention";
  } else if (isFailed) {
    color = "#EF4444";
    title = "Failed";
  } else {
    color = "#3B82F6";
    title = `${m.openInterventions} open intervention${m.openInterventions === 1 ? "" : "s"}`;
  }
  return (
    <span
      className="shrink-0"
      style={{
        width: 6,
        height: 6,
        borderRadius: "50%",
        background: color,
        boxShadow: `0 0 6px ${color}60`,
      }}
      title={title}
    />
  );
}

function MissionInterventionBadge({ count, missionStatus }: { count: number; missionStatus: MissionSummary["status"] }) {
  if (count <= 0) return null;
  if (missionStatus === "completed" || missionStatus === "canceled") return null;
  return (
    <span
      className="shrink-0 px-1 py-0.5 text-[10px] font-bold"
      style={{
        color: COLORS.warning,
        background: "color-mix(in srgb, var(--color-warning) 18%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-warning) 30%, transparent)",
        fontFamily: MONO_FONT,
      }}
      title={`${count} pending intervention${count === 1 ? "" : "s"}`}
    >
      {count > 1 ? `${count}!` : "!"}
    </span>
  );
}
