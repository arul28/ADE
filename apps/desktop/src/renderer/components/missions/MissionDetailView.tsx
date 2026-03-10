import { useMemo, useEffect, useRef, useCallback } from "react";
import { X, WarningCircle } from "@phosphor-icons/react";
import { motion, AnimatePresence } from "motion/react";
import type { ClarificationQuiz } from "../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT } from "../lanes/laneDesignTokens";
import { useMissionsStore, type MissionAttentionToast } from "./useMissionsStore";
import { MissionHeader } from "./MissionHeader";
import { InterventionPanel, isQuizIntervention, isBlockingManualInputIntervention } from "./InterventionPanel";
import { MissionTabNavigation, MissionTabContent } from "./MissionTabContainer";
import { MissionsHomeDashboard } from "./MissionsHomeDashboard";
import { ClarificationQuizModal } from "./ClarificationQuizModal";
import { ManualInputResponseModal } from "./ManualInputResponseModal";
import { openMissionCreateDialog } from "./missionCreateDialogStore";

/* Re-export for backward compat */
export { ManageMissionDialog, MissionContextMenu } from "./ManageMissionDialog";

/* ════════════════════ MISSION DETAIL VIEW ════════════════════ */

export function MissionDetailView() {
  const selectedMissionId = useMissionsStore((s) => s.selectedMissionId);
  const selectedMission = useMissionsStore((s) => s.selectedMission);
  const dashboard = useMissionsStore((s) => s.dashboard);
  const error = useMissionsStore((s) => s.error);
  const activeTab = useMissionsStore((s) => s.activeTab);
  const activeInterventionId = useMissionsStore((s) => s.activeInterventionId);

  const setSelectedMissionId = useMissionsStore((s) => s.setSelectedMissionId);
  const setError = useMissionsStore((s) => s.setError);
  const setActiveInterventionId = useMissionsStore((s) => s.setActiveInterventionId);
  const setSteerBusy = useMissionsStore((s) => s.setSteerBusy);
  const refreshMissionList = useMissionsStore((s) => s.refreshMissionList);
  const loadMissionDetail = useMissionsStore((s) => s.loadMissionDetail);
  const loadOrchestratorGraph = useMissionsStore((s) => s.loadOrchestratorGraph);

  const chatFocused = activeTab === "chat";
  const compactPhaseChrome = chatFocused;

  const handleInterventionResponse = useCallback(
    async (interventionId: string, directiveText: string) => {
      if (!selectedMission) return;
      setSteerBusy(true);
      try {
        await window.ade.orchestrator.steerMission({
          missionId: selectedMission.id, interventionId, directive: directiveText, priority: "instruction",
        });
        setActiveInterventionId(null);
        await refreshMissionList({ preserveSelection: true, silent: true });
        await loadMissionDetail(selectedMission.id);
        await loadOrchestratorGraph(selectedMission.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSteerBusy(false);
      }
    },
    [loadMissionDetail, loadOrchestratorGraph, refreshMissionList, selectedMission, setActiveInterventionId, setError, setSteerBusy],
  );

  if (!selectedMissionId) {
    return (
      <MissionsHomeDashboard
        snapshot={dashboard}
        onNewMission={() => openMissionCreateDialog()}
        onViewMission={(id) => setSelectedMissionId(id)}
      />
    );
  }

  return (
    <>
      <MissionHeader />
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            className="px-4 py-2 text-[11px] flex items-center justify-between"
            style={{ borderBottom: `1px solid ${COLORS.danger}30`, background: `${COLORS.danger}18`, color: COLORS.danger }}
          >
            <span>{error}</span>
            <button onClick={() => setError(null)} style={{ color: COLORS.danger }}><X className="h-3 w-3" /></button>
          </motion.div>
        )}
      </AnimatePresence>
      <InterventionPanel compact={compactPhaseChrome} />
      <MissionTabNavigation />
      <MissionTabContent />
      <InterventionModals onInterventionResponse={handleInterventionResponse} />
      <AttentionToasts />
    </>
  );
}

/* ════════════════════ INTERVENTION MODALS ════════════════════ */

function InterventionModals({ onInterventionResponse }: { onInterventionResponse: (id: string, directive: string) => Promise<void> }) {
  const activeInterventionId = useMissionsStore((s) => s.activeInterventionId);
  const selectedMission = useMissionsStore((s) => s.selectedMission);
  const setActiveInterventionId = useMissionsStore((s) => s.setActiveInterventionId);
  const autoOpenedRef = useRef<Set<string>>(new Set());

  const openManualInputInterventions = useMemo(
    () => selectedMission?.interventions.filter((i) => i.interventionType === "manual_input" && i.status === "open") ?? [],
    [selectedMission],
  );
  const blockingInterventions = useMemo(
    () => openManualInputInterventions.filter((i) => isBlockingManualInputIntervention(i)),
    [openManualInputInterventions],
  );

  useEffect(() => {
    if (!selectedMission || activeInterventionId) return;
    const next = blockingInterventions.find((i) => !autoOpenedRef.current.has(i.id));
    if (!next) return;
    autoOpenedRef.current.add(next.id);
    setActiveInterventionId(next.id);
  }, [activeInterventionId, blockingInterventions, selectedMission, setActiveInterventionId]);

  useEffect(() => {
    if (!activeInterventionId) return;
    if (!(selectedMission?.interventions.some((i) => i.id === activeInterventionId) ?? false)) setActiveInterventionId(null);
  }, [activeInterventionId, selectedMission, setActiveInterventionId]);

  if (!activeInterventionId || !selectedMission) return null;
  const iv = selectedMission.interventions.find((i) => i.id === activeInterventionId);
  if (!iv || iv.status !== "open" || iv.interventionType !== "manual_input") return null;

  if (isQuizIntervention(iv)) {
    const phase = typeof iv.metadata.phase === "string" ? iv.metadata.phase : null;
    return (
      <ClarificationQuizModal
        interventionId={iv.id} missionId={selectedMission.id} questions={iv.metadata.questions} phase={phase}
        onClose={() => setActiveInterventionId(null)}
        onSubmit={async (quiz: ClarificationQuiz) => {
          const lines = quiz.answers.map((a, i) => {
            const q = quiz.questions[i]?.question?.trim() || `Question ${i + 1}`;
            return `- ${q}: ${a.answer} (${a.source === "default_assumption" ? "default assumption" : "user answer"})`;
          });
          await onInterventionResponse(iv.id, ["Coordinator question answers:", ...lines, "Proceed using these answers."].join("\n"));
        }}
      />
    );
  }
  return (
    <ManualInputResponseModal
      intervention={iv} onClose={() => setActiveInterventionId(null)}
      onSubmit={async (answer) => { await onInterventionResponse(iv.id, answer); }}
    />
  );
}

/* ════════════════════ ATTENTION TOASTS ════════════════════ */

function AttentionToasts() {
  const attentionToasts = useMissionsStore((s) => s.attentionToasts);
  const setAttentionToasts = useMissionsStore((s) => s.setAttentionToasts);
  const dismiss = useCallback((id: string) => { setAttentionToasts(attentionToasts.filter((t) => t.id !== id)); }, [attentionToasts, setAttentionToasts]);

  if (attentionToasts.length === 0) return null;
  return (
    <div style={{ position: "absolute", bottom: 12, right: 12, zIndex: 95, display: "flex", flexDirection: "column", gap: 6, width: "min(340px, calc(100vw - 20px))", pointerEvents: "none" }}>
      {attentionToasts.map((toast) => {
        const color = toast.severity === "error" ? COLORS.danger : COLORS.warning;
        return (
          <div key={toast.id} style={{ pointerEvents: "auto", background: COLORS.cardBg, border: `1px solid ${color}40`, borderLeft: `3px solid ${color}`, padding: "8px 12px", fontFamily: MONO_FONT, fontSize: 11, boxShadow: "0 4px 12px rgba(0,0,0,0.3)" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                <WarningCircle weight="bold" style={{ color, width: 14, height: 14, flexShrink: 0 }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, color, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.8px" }}>{toast.message}</div>
                  <div style={{ color: COLORS.textSecondary, fontSize: 11, fontFamily: SANS_FONT, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{toast.missionTitle}</div>
                </div>
              </div>
              <button type="button" onClick={() => dismiss(toast.id)} style={{ flexShrink: 0, background: "transparent", border: "none", color: COLORS.textMuted, cursor: "pointer", padding: 0, fontSize: 14, lineHeight: 1 }} title="Dismiss">{"\u00D7"}</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
