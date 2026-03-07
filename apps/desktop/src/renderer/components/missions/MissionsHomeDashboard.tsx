import React from "react";
import { Plus } from "@phosphor-icons/react";
import type { MissionDashboardSnapshot } from "../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT, primaryButton, outlineButton } from "../lanes/laneDesignTokens";
import { formatDurationMs } from "../../lib/format";

export const MissionsHomeDashboard = React.memo(function MissionsHomeDashboard({
  snapshot,
  onNewMission,
  onViewMission
}: {
  snapshot: MissionDashboardSnapshot | null;
  onNewMission: () => void;
  onViewMission: (missionId: string) => void;
}) {
  if (!snapshot) {
    return (
      <div className="flex h-full items-center justify-center text-xs" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
        Loading mission dashboard...
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col p-4 gap-3 overflow-auto">
      <div className="flex items-center justify-between">
        <div className="text-sm font-bold" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>MISSIONS</div>
        <button style={primaryButton()} onClick={onNewMission}>
          <Plus size={14} />
          NEW MISSION
        </button>
      </div>

      <div className="p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
        <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>Active Missions</div>
        <div className="mt-2 space-y-2">
          {snapshot.active.length === 0 ? (
            <div className="text-xs" style={{ color: COLORS.textDim }}>No active missions.</div>
          ) : snapshot.active.map((entry) => (
            <button
              key={entry.mission.id}
              className="w-full text-left p-2"
              style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}
              onClick={() => onViewMission(entry.mission.id)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-medium" style={{ color: COLORS.textPrimary }}>{entry.mission.title}</span>
                <span className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>{entry.phaseProgress.pct}%</span>
              </div>
              <div className="mt-1 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                {entry.phaseName ?? "Phase"} · {entry.activeWorkers} workers · {formatDurationMs(entry.elapsedMs)}
              </div>
              <div className="mt-1 h-1.5 w-full" style={{ background: COLORS.pageBg }}>
                <div className="h-full" style={{ width: `${entry.phaseProgress.pct}%`, background: COLORS.accent }} />
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
        <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>Recent Missions</div>
        <div className="mt-2 space-y-1.5">
          {snapshot.recent.length === 0 ? (
            <div className="text-xs" style={{ color: COLORS.textDim }}>No recent missions.</div>
          ) : snapshot.recent.map((entry) => (
            <div key={entry.mission.id} className="flex items-center gap-2 px-2 py-1.5" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
              <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: COLORS.textPrimary }}>{entry.mission.title}</span>
              <span className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>{formatDurationMs(entry.durationMs)}</span>
              <button style={outlineButton()} onClick={() => onViewMission(entry.mission.id)}>
                {entry.action.toUpperCase()}
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
        <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>Stats (7d)</div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className="p-2" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
            <div className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>Missions</div>
            <div className="text-sm font-semibold" style={{ color: COLORS.textPrimary }}>{snapshot.weekly.missions}</div>
          </div>
          <div className="p-2" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
            <div className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>Success</div>
            <div className="text-sm font-semibold" style={{ color: COLORS.textPrimary }}>{Math.round((snapshot.weekly.successRate ?? 0) * 100)}%</div>
          </div>
          <div className="p-2" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
            <div className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>Avg Duration</div>
            <div className="text-sm font-semibold" style={{ color: COLORS.textPrimary }}>{formatDurationMs(snapshot.weekly.avgDurationMs)}</div>
          </div>
          <div className="p-2" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
            <div className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>Est. Cost</div>
            <div className="text-sm font-semibold" style={{ color: COLORS.textPrimary }}>${(snapshot.weekly.totalCostUsd ?? 0).toFixed(2)}</div>
          </div>
        </div>
      </div>
    </div>
  );
});
