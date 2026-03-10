import { useMemo, useState, useCallback } from "react";
import { ChatCircle, Clock, WarningCircle, Check, X } from "@phosphor-icons/react";
import type { MissionIntervention, ClarificationQuestion } from "../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT, primaryButton, outlineButton, dangerButton } from "../lanes/laneDesignTokens";
import { useMissionsStore } from "./useMissionsStore";
import { isRecord } from "./missionHelpers";
import { relativeWhen } from "../../lib/format";

/* ════════════════════ INTERVENTION HELPERS ════════════════════ */

function isQuizIntervention(
  intervention: MissionIntervention | null | undefined,
): intervention is MissionIntervention & {
  metadata: Record<string, unknown> & { quizMode: true; questions: ClarificationQuestion[] };
} {
  return Boolean(
    intervention &&
      intervention.interventionType === "manual_input" &&
      intervention.status === "open" &&
      intervention.metadata?.quizMode === true &&
      Array.isArray(intervention.metadata?.questions),
  );
}

function isBlockingManualInputIntervention(intervention: MissionIntervention): boolean {
  if (intervention.interventionType !== "manual_input" || intervention.status !== "open") return false;
  return intervention.metadata?.canProceedWithoutAnswer !== true;
}

export { isQuizIntervention, isBlockingManualInputIntervention };

/* ════════════════════ INTERVENTION PANEL (VAL-UX-005) ════════════════════ */

/**
 * Dedicated intervention panel in the detail view.
 * Shows title, type badge, timestamp, response input, and resolve/dismiss buttons.
 * Replaces modal auto-open for a better inline UX. (VAL-UX-005)
 */
export function InterventionPanel({ compact }: { compact: boolean }) {
  const selectedMission = useMissionsStore((s) => s.selectedMission);
  const steerBusy = useMissionsStore((s) => s.steerBusy);

  const openInterventions = useMemo(
    () => selectedMission?.interventions.filter((i) => i.status === "open") ?? [],
    [selectedMission],
  );

  const [responseText, setResponseText] = useState("");

  const handleResolve = useCallback(
    async (interventionId: string) => {
      const s = useMissionsStore.getState();
      if (!s.selectedMission) return;
      s.setSteerBusy(true);
      try {
        await window.ade.orchestrator.steerMission({
          missionId: s.selectedMission.id,
          interventionId,
          directive: responseText.trim() || "Acknowledged.",
          priority: "instruction",
        });
        setResponseText("");
        await s.refreshMissionList({ preserveSelection: true, silent: true });
        await s.loadMissionDetail(s.selectedMission.id);
        await s.loadOrchestratorGraph(s.selectedMission.id);
      } catch (err) {
        s.setError(err instanceof Error ? err.message : String(err));
      } finally {
        s.setSteerBusy(false);
      }
    },
    [responseText],
  );

  const handleDismiss = useCallback(
    async (interventionId: string) => {
      const s = useMissionsStore.getState();
      if (!s.selectedMission) return;
      s.setSteerBusy(true);
      try {
        await window.ade.orchestrator.steerMission({
          missionId: s.selectedMission.id,
          interventionId,
          directive: "Dismissed by user — proceed without action.",
          priority: "instruction",
        });
        await s.refreshMissionList({ preserveSelection: true, silent: true });
        await s.loadMissionDetail(s.selectedMission.id);
      } catch (err) {
        s.setError(err instanceof Error ? err.message : String(err));
      } finally {
        s.setSteerBusy(false);
      }
    },
    [],
  );

  if (!selectedMission || openInterventions.length === 0) return null;

  return (
    <div style={{ margin: compact ? "8px 12px" : "12px 16px" }}>
      {openInterventions.map((intervention) => (
        <InterventionCard
          key={intervention.id}
          intervention={intervention}
          compact={compact}
          responseText={responseText}
          onResponseChange={setResponseText}
          onResolve={handleResolve}
          onDismiss={handleDismiss}
          busy={steerBusy}
        />
      ))}
    </div>
  );
}

/* ────────── Individual Intervention Card ────────── */

function InterventionCard({
  intervention,
  compact,
  responseText,
  onResponseChange,
  onResolve,
  onDismiss,
  busy,
}: {
  intervention: MissionIntervention;
  compact: boolean;
  responseText: string;
  onResponseChange: (v: string) => void;
  onResolve: (id: string) => Promise<void>;
  onDismiss: (id: string) => Promise<void>;
  busy: boolean;
}) {
  const isBlocking = isBlockingManualInputIntervention(intervention);
  const borderColor = isBlocking ? COLORS.warning : COLORS.accentBorder;
  const iconColor = isBlocking ? COLORS.warning : COLORS.accent;

  const typeLabel = intervention.interventionType.replace(/_/g, " ");

  return (
    <div
      style={{
        background: COLORS.cardBg,
        border: `1px solid ${borderColor}`,
        padding: compact ? "8px 12px" : "12px 16px",
        marginBottom: 8,
        wordBreak: "break-word",
      }}
    >
      {/* Header: title + type badge + timestamp */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 8 }}>
        <WarningCircle
          weight="bold"
          style={{ color: iconColor, width: 16, height: 16, flexShrink: 0, marginTop: 1 }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span
              style={{
                fontFamily: SANS_FONT,
                fontSize: 12,
                fontWeight: 600,
                color: COLORS.textPrimary,
              }}
            >
              {intervention.title}
            </span>
            <span
              style={{
                fontFamily: MONO_FONT,
                fontSize: 10,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "1px",
                color: iconColor,
                background: `${iconColor}18`,
                border: `1px solid ${iconColor}30`,
                padding: "1px 6px",
              }}
            >
              {typeLabel}
            </span>
          </div>
          <div
            style={{
              fontFamily: MONO_FONT,
              fontSize: 10,
              color: COLORS.textDim,
              marginTop: 4,
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <Clock size={10} />
            {relativeWhen(intervention.createdAt)}
          </div>
        </div>
      </div>

      {/* Response input — only for manual_input type */}
      {intervention.interventionType === "manual_input" && (
        <div style={{ marginTop: 8 }}>
          <textarea
            value={responseText}
            onChange={(e) => onResponseChange(e.target.value)}
            placeholder="Type your response..."
            rows={2}
            style={{
              width: "100%",
              background: COLORS.recessedBg,
              border: `1px solid ${COLORS.outlineBorder}`,
              color: COLORS.textPrimary,
              fontFamily: MONO_FONT,
              fontSize: 11,
              padding: "8px 12px",
              resize: "vertical",
              outline: "none",
            }}
          />
        </div>
      )}

      {/* Action buttons */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <button
          style={primaryButton({ height: 28, padding: "0 12px", fontSize: 10 })}
          onClick={() => void onResolve(intervention.id)}
          disabled={busy}
        >
          <Check size={12} />
          RESOLVE
        </button>
        {!isBlocking && (
          <button
            style={outlineButton({ height: 28, padding: "0 12px", fontSize: 10 })}
            onClick={() => void onDismiss(intervention.id)}
            disabled={busy}
          >
            <X size={12} />
            DISMISS
          </button>
        )}
      </div>
    </div>
  );
}
