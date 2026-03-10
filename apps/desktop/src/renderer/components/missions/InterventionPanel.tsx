import { useMemo, useCallback } from "react";
import { ChatCircle } from "@phosphor-icons/react";
import type { MissionIntervention, ClarificationQuestion } from "../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT, primaryButton } from "../lanes/laneDesignTokens";
import { useMissionsStore } from "./useMissionsStore";
import { isRecord } from "./missionHelpers";

/* ════════════════════ INTERVENTION PANEL ════════════════════ */

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

/**
 * Banner for coordinator manual input interventions. Shows when the coordinator
 * is waiting for an answer or has optional questions.
 */
export function InterventionPanel({ compact }: { compact: boolean }) {
  const selectedMission = useMissionsStore((s) => s.selectedMission);
  const setActiveInterventionId = useMissionsStore((s) => s.setActiveInterventionId);

  const openManualInputInterventions = useMemo(
    () =>
      selectedMission?.interventions.filter(
        (intervention) => intervention.interventionType === "manual_input" && intervention.status === "open",
      ) ?? [],
    [selectedMission],
  );

  const blockingManualInputInterventions = useMemo(
    () => openManualInputInterventions.filter((intervention) => isBlockingManualInputIntervention(intervention)),
    [openManualInputInterventions],
  );

  if (!selectedMission || openManualInputInterventions.length === 0) return null;

  const blockingCount = blockingManualInputInterventions.length;
  const optionalCount = openManualInputInterventions.length - blockingCount;
  const primaryIntervention = blockingManualInputInterventions[0] ?? openManualInputInterventions[0];
  if (!primaryIntervention) return null;

  const label =
    blockingCount > 0
      ? blockingCount === 1
        ? "Coordinator is waiting on 1 answer"
        : `Coordinator is waiting on ${blockingCount} answers`
      : optionalCount === 1
        ? "Coordinator has 1 optional question"
        : `Coordinator has ${optionalCount} optional questions`;

  const detail = isQuizIntervention(primaryIntervention)
    ? `${primaryIntervention.metadata.questions.length} question${primaryIntervention.metadata.questions.length === 1 ? "" : "s"} ready to answer`
    : primaryIntervention.title;

  return (
    <div
      style={{
        background: COLORS.cardBg,
        border: `1px solid ${blockingCount > 0 ? COLORS.warning : COLORS.accentBorder}`,
        margin: compact ? "8px 12px" : "12px 16px",
        padding: compact ? "8px 12px" : "12px 16px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <ChatCircle
          weight="bold"
          style={{
            color: blockingCount > 0 ? COLORS.warning : COLORS.accent,
            width: 14,
            height: 14,
            flexShrink: 0,
          }}
        />
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontFamily: MONO_FONT,
              fontSize: compact ? 10 : 11,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "1px",
              color: blockingCount > 0 ? COLORS.warning : COLORS.accent,
            }}
          >
            {label}
          </div>
          <div
            style={{
              marginTop: 4,
              fontFamily: SANS_FONT,
              fontSize: compact ? 11 : 12,
              color: COLORS.textSecondary,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {detail}
          </div>
        </div>
      </div>
      <button
        style={primaryButton({ height: 28, padding: "0 12px", fontSize: 10 })}
        onClick={() => setActiveInterventionId(primaryIntervention.id)}
      >
        {isQuizIntervention(primaryIntervention) ? "ANSWER NOW" : "OPEN REQUEST"}
      </button>
    </div>
  );
}
