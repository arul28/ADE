import { useCallback, useEffect } from "react";
import { X, Stop, Trash, SpinnerGap } from "@phosphor-icons/react";
import { motion, AnimatePresence } from "motion/react";
import type { MissionSummary } from "../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton, dangerButton } from "../lanes/laneDesignTokens";
import { STATUS_BADGE_STYLES, STATUS_LABELS, TERMINAL_MISSION_STATUSES } from "./missionHelpers";
import { useMissionsStore } from "./useMissionsStore";

/* ════════════════════ MANAGE MISSION DIALOG ════════════════════ */

export function ManageMissionDialog() {
  const manageMission = useMissionsStore((s) => s.manageMission);
  const manageMissionOpen = useMissionsStore((s) => s.manageMissionOpen);
  const manageMissionBusy = useMissionsStore((s) => s.manageMissionBusy);
  const manageMissionError = useMissionsStore((s) => s.manageMissionError);
  const manageMissionCleanupLanes = useMissionsStore((s) => s.manageMissionCleanupLanes);

  const setManageMissionOpen = useMissionsStore((s) => s.setManageMissionOpen);
  const setManageMissionError = useMissionsStore((s) => s.setManageMissionError);
  const setManageMissionCleanupLanes = useMissionsStore((s) => s.setManageMissionCleanupLanes);
  const setManageMission = useMissionsStore((s) => s.setManageMission);
  const setManageMissionBusy = useMissionsStore((s) => s.setManageMissionBusy);
  const refreshMissionList = useMissionsStore((s) => s.refreshMissionList);
  const loadDashboard = useMissionsStore((s) => s.loadDashboard);
  const setError = useMissionsStore((s) => s.setError);

  const closeDialog = useCallback(
    (force = false) => {
      if (manageMissionBusy && !force) return;
      setManageMissionOpen(false);
      setManageMissionError(null);
      setManageMissionCleanupLanes(false);
      setManageMission(null);
    },
    [manageMissionBusy, setManageMission, setManageMissionCleanupLanes, setManageMissionError, setManageMissionOpen],
  );

  const handleArchive = useCallback(async () => {
    if (!manageMission) return;
    if (!TERMINAL_MISSION_STATUSES.has(manageMission.status)) {
      setManageMissionError("Only completed, failed, or canceled missions can be archived.");
      return;
    }
    setManageMissionBusy(true);
    setManageMissionError(null);
    try {
      let cleanupWarning: string | null = null;
      if (manageMissionCleanupLanes) {
        const result = await window.ade.orchestrator.cleanupTeamResources({
          missionId: manageMission.id, cleanupLanes: true,
        });
        if (result.laneErrors.length > 0) {
          cleanupWarning = `Mission archived, but lane cleanup archived ${result.lanesArchived.length}/${result.laneIds.length} lane(s). ${result.laneErrors.length} lane(s) failed to archive.`;
        }
      }
      await window.ade.missions.archive({ missionId: manageMission.id });
      closeDialog(true);
      await Promise.all([refreshMissionList({ preserveSelection: true, silent: true }), loadDashboard()]);
      setError(cleanupWarning);
    } catch (err) {
      setManageMissionError(err instanceof Error ? err.message : String(err));
    } finally {
      setManageMissionBusy(false);
    }
  }, [closeDialog, loadDashboard, manageMission, manageMissionCleanupLanes, refreshMissionList, setError, setManageMissionBusy, setManageMissionError]);

  const handleCancel = useCallback(async () => {
    if (!manageMission || TERMINAL_MISSION_STATUSES.has(manageMission.status)) return;
    setManageMissionBusy(true);
    setManageMissionError(null);
    try {
      const runs = await window.ade.orchestrator.listRuns({ missionId: manageMission.id, limit: 5 });
      const activeRun = runs.find((r) => r.status === "active" || r.status === "paused" || r.status === "bootstrapping" || r.status === "queued");
      if (activeRun) await window.ade.orchestrator.cancelRun({ runId: activeRun.id, reason: "Canceled from Manage Mission dialog." });
      closeDialog(true);
      await Promise.all([refreshMissionList({ preserveSelection: true, silent: true }), loadDashboard()]);
    } catch (err) {
      setManageMissionError(err instanceof Error ? err.message : String(err));
    } finally {
      setManageMissionBusy(false);
    }
  }, [closeDialog, loadDashboard, manageMission, refreshMissionList, setManageMissionBusy, setManageMissionError]);

  return (
    <AnimatePresence>
      {manageMissionOpen && manageMission ? (
        <>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50" style={{ background: "rgba(2, 6, 23, 0.45)", backdropFilter: "blur(6px)" }} onClick={() => closeDialog(false)} />
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }} className="fixed left-1/2 top-[16%] z-[60] w-[min(520px,calc(100vw-24px))] -translate-x-1/2 p-4" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, boxShadow: "0 16px 48px rgba(15, 23, 42, 0.32)" }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>Manage Mission</div>
                <div className="mt-1 text-sm font-semibold" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>{manageMission.title}</div>
              </div>
              <button type="button" className="p-1 transition-colors" style={{ color: COLORS.textMuted }} onClick={() => closeDialog(false)} disabled={manageMissionBusy} aria-label="Close manage mission dialog"><X className="h-4 w-4" /></button>
            </div>
            <div className="mt-3 flex items-center gap-2 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
              <span className="px-1.5 py-0.5 font-bold uppercase tracking-[1px]" style={{ background: STATUS_BADGE_STYLES[manageMission.status].background, color: STATUS_BADGE_STYLES[manageMission.status].color, border: STATUS_BADGE_STYLES[manageMission.status].border }}>{STATUS_LABELS[manageMission.status]}</span>
              {manageMission.laneName ? <span>BASE {manageMission.laneName}</span> : null}
            </div>
            <div className="mt-4 space-y-3">
              {TERMINAL_MISSION_STATUSES.has(manageMission.status) ? (
                <>
                  <div className="p-3 text-[12px]" style={{ background: COLORS.pageBg, border: `1px solid ${COLORS.border}`, color: COLORS.textSecondary }}>Archiving removes this mission from the Missions UI.</div>
                  <label className="flex items-start gap-3 p-3 text-[12px]" style={{ background: COLORS.pageBg, border: `1px solid ${COLORS.border}`, color: COLORS.textPrimary }}>
                    <input type="checkbox" checked={manageMissionCleanupLanes} onChange={(e) => setManageMissionCleanupLanes(e.target.checked)} disabled={manageMissionBusy} />
                    <div><div className="font-medium">Also archive lanes created by this mission</div><div className="mt-1 text-[11px]" style={{ color: COLORS.textMuted }}>ADE will archive every managed lane it can find across this mission&apos;s runs.</div></div>
                  </label>
                </>
              ) : (
                <div className="p-3 text-[12px]" style={{ background: COLORS.pageBg, border: `1px solid ${COLORS.border}`, color: COLORS.textSecondary }}>
                  {manageMission.status === "intervention_required" ? "This mission is waiting for intervention. You can cancel it to stop all active work." : "This mission is currently active. You can cancel it to stop all active work."}
                </div>
              )}
              {manageMissionError ? <div className="p-3 text-[11px]" style={{ background: `${COLORS.danger}10`, border: `1px solid ${COLORS.danger}35`, color: COLORS.danger }}>{manageMissionError}</div> : null}
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button type="button" style={outlineButton()} onClick={() => closeDialog(false)} disabled={manageMissionBusy}>CLOSE</button>
              {TERMINAL_MISSION_STATUSES.has(manageMission.status) ? (
                <button type="button" style={dangerButton()} onClick={() => void handleArchive()} disabled={manageMissionBusy}>{manageMissionBusy ? <SpinnerGap className="h-3 w-3 animate-spin" /> : <Trash className="h-3 w-3" />}ARCHIVE MISSION</button>
              ) : (
                <button type="button" style={dangerButton()} onClick={() => void handleCancel()} disabled={manageMissionBusy}>{manageMissionBusy ? <SpinnerGap className="h-3 w-3 animate-spin" /> : <Stop className="h-3 w-3" />}CANCEL MISSION</button>
              )}
            </div>
          </motion.div>
        </>
      ) : null}
    </AnimatePresence>
  );
}

/* ════════════════════ CONTEXT MENU ════════════════════ */

export function MissionContextMenu() {
  const missionContextMenu = useMissionsStore((s) => s.missionContextMenu);
  const setMissionContextMenu = useMissionsStore((s) => s.setMissionContextMenu);
  const setSelectedMissionId = useMissionsStore((s) => s.setSelectedMissionId);
  const setManageMission = useMissionsStore((s) => s.setManageMission);
  const setManageMissionCleanupLanes = useMissionsStore((s) => s.setManageMissionCleanupLanes);
  const setManageMissionError = useMissionsStore((s) => s.setManageMissionError);
  const setManageMissionOpen = useMissionsStore((s) => s.setManageMissionOpen);

  useEffect(() => {
    if (!missionContextMenu) return;
    const handleClose = () => setMissionContextMenu(null);
    document.addEventListener("mousedown", handleClose);
    return () => document.removeEventListener("mousedown", handleClose);
  }, [missionContextMenu, setMissionContextMenu]);

  const openManageMissionDialog = (mission: MissionSummary) => {
    setMissionContextMenu(null);
    setManageMission(mission);
    setManageMissionCleanupLanes(false);
    setManageMissionError(null);
    setManageMissionOpen(true);
  };

  if (!missionContextMenu) return null;
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={() => setMissionContextMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMissionContextMenu(null); }} />
      <div className="fixed z-50 min-w-[180px] py-1" style={{ left: missionContextMenu.x, top: missionContextMenu.y, background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, boxShadow: "0 12px 40px rgba(15, 23, 42, 0.28)" }} onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
        <button className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] transition-colors" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }} onClick={() => { setSelectedMissionId(missionContextMenu.mission.id); setMissionContextMenu(null); }}>Open Mission</button>
        <button className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] transition-colors" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }} onClick={() => openManageMissionDialog(missionContextMenu.mission)}>Manage Mission</button>
      </div>
    </>
  );
}
