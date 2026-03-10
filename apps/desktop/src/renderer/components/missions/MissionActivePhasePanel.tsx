import React, { useState } from "react";
import {
  CaretDown,
  CaretRight,
  WarningCircle,
  CheckCircle,
  Eye,
} from "@phosphor-icons/react";
import type { ActivePhaseViewModel } from "./missionControlViewModel";
import type { OrchestratorPromptInspector, PhaseCard } from "../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT } from "../lanes/laneDesignTokens";
import { PromptInspectorCard } from "./PromptInspectorCard";

/* ─── Phase Stepper ─── */

function PhaseStepper({
  phases,
  activePhaseKey,
  compact = false,
}: {
  phases: PhaseCard[];
  activePhaseKey: string | null;
  compact?: boolean;
}) {
  const sorted = phases.slice().sort((a, b) => a.position - b.position);
  const activeIdx = sorted.findIndex((p) => p.phaseKey === activePhaseKey);
  const dotSize = compact ? 14 : 16;
  const gapClass = compact ? "gap-1" : "gap-1.5";
  const labelClass = compact ? "whitespace-nowrap text-[10px]" : "whitespace-nowrap text-[11px]";
  const lineClass = compact ? "mx-1.5 flex-1" : "mx-2 flex-1";

  return (
    <div className="flex items-center gap-0" style={{ minHeight: compact ? 24 : 28 }}>
      {sorted.map((phase, i) => {
        const isCurrent = i === activeIdx;
        const isDone = activeIdx >= 0 && i < activeIdx;
        const isLast = i === sorted.length - 1;

        const dotColor = isCurrent ? COLORS.accent : isDone ? COLORS.success : COLORS.textDim;
        const labelColor = isCurrent ? COLORS.textPrimary : isDone ? COLORS.textSecondary : COLORS.textDim;

        return (
          <React.Fragment key={phase.id}>
            <div className={`flex items-center ${gapClass}`}>
              {isDone ? (
                <CheckCircle weight="fill" style={{ color: COLORS.success, width: dotSize, height: dotSize, flexShrink: 0 }} />
              ) : (
                <div
                  style={{
                    width: dotSize,
                    height: dotSize,
                    borderRadius: "50%",
                    border: `2px solid ${dotColor}`,
                    background: isCurrent ? COLORS.accent : "transparent",
                    flexShrink: 0,
                  }}
                />
              )}
              <span
                className={labelClass}
                style={{
                  color: labelColor,
                  fontFamily: SANS_FONT,
                  fontWeight: isCurrent ? 600 : 400,
                }}
              >
                {phase.name}
              </span>
            </div>
            {!isLast && (
              <div
                className={lineClass}
                style={{
                  height: 1,
                  minWidth: 16,
                  background: isDone ? `${COLORS.success}50` : COLORS.border,
                }}
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

/* ─── Main Panel ─── */

export function MissionActivePhasePanel({
  activePhase,
  allPhases,
  promptInspector,
  promptLoading,
  promptError,
  onInspectPrompt,
  coordinatorAvailability,
  compact = false,
}: {
  activePhase: ActivePhaseViewModel | null;
  allPhases?: PhaseCard[] | null;
  promptInspector: OrchestratorPromptInspector | null;
  promptLoading?: boolean;
  promptError?: string | null;
  onInspectPrompt?: () => void;
  coordinatorAvailability?: { available: boolean; mode: string; summary: string | null } | null;
  compact?: boolean;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);

  if (!activePhase) return null;

  const phases = allPhases ?? [];
  const actionItems = [
    ...activePhase.exitRequirements,
    ...activePhase.capabilityWarnings,
  ];
  const hasActions = actionItems.length > 0;
  const toneTextSize = compact ? "text-[10px]" : "text-[11px]";

  return (
    <div className={compact ? "mx-3 mt-2 space-y-1.5" : "mx-4 mt-3 space-y-2"}>
      {/* Phase stepper */}
      {phases.length > 1 && (
        <PhaseStepper phases={phases} activePhaseKey={activePhase.phase?.phaseKey ?? null} compact={compact} />
      )}

      {/* Action items — only if something needs attention */}
      {hasActions && (
        <div
          className={compact ? "flex items-start gap-2 px-2.5 py-1.5" : "flex items-start gap-2 px-3 py-2"}
          style={{
            background: `${COLORS.warning}08`,
            borderLeft: `3px solid ${COLORS.warning}`,
          }}
        >
          <WarningCircle weight="bold" style={{ color: COLORS.warning, width: 14, height: 14, marginTop: 1, flexShrink: 0 }} />
          <div className="min-w-0 space-y-0.5">
            {actionItems.map((item, i) => (
              <div key={i} className={toneTextSize} style={{ color: COLORS.textSecondary }}>
                {item}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Expandable details toggle */}
      <div className={compact ? "flex items-center gap-2" : "flex items-center gap-3"}>
        <button
          type="button"
          onClick={() => setShowDetails((prev) => !prev)}
          className="flex items-center gap-1 text-[10px]"
          style={{ color: COLORS.textDim, fontFamily: MONO_FONT, background: "none", border: "none", cursor: "pointer", padding: 0 }}
        >
          {showDetails ? <CaretDown weight="bold" className="h-2.5 w-2.5" /> : <CaretRight weight="bold" className="h-2.5 w-2.5" />}
          Phase details
        </button>

        <button
          type="button"
          className="flex items-center gap-1 text-[10px]"
          style={{ color: COLORS.textDim, fontFamily: MONO_FONT, background: "none", border: "none", cursor: "pointer", padding: 0 }}
          onClick={() => {
            setShowPrompt((prev) => !prev);
            if (!showPrompt) onInspectPrompt?.();
          }}
        >
          <Eye weight="bold" className="h-2.5 w-2.5" />
          {showPrompt ? "Hide prompt" : compact ? "Prompt" : "View effective prompt"}
        </button>
      </div>

      {/* Expanded details */}
      {showDetails && (
        <div
          className={compact ? "space-y-2 px-2.5 py-2" : "space-y-2 px-3 py-2"}
          style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}
        >
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[10px]" style={{ color: COLORS.textSecondary, fontFamily: MONO_FONT }}>
            {activePhase.phase?.model?.modelId && (
              <>
                <span style={{ color: COLORS.textDim }}>Model</span>
                <span>{activePhase.phase.model.modelId}</span>
              </>
            )}
            <span style={{ color: COLORS.textDim }}>Mode</span>
            <span>{activePhase.modeLabel}</span>
            <span style={{ color: COLORS.textDim }}>Ask Questions</span>
            <span>{activePhase.clarificationLabel}</span>
          </div>

          {activePhase.blockedLaterWork.length > 0 && (
            <div className="mt-1">
              <div className="text-[10px]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>Blocked downstream</div>
              {activePhase.blockedLaterWork.map((entry, i) => (
                <div key={i} className="text-[10px] mt-0.5" style={{ color: COLORS.textSecondary }}>{entry}</div>
              ))}
            </div>
          )}

          {coordinatorAvailability && (
            <div className="text-[10px]" style={{ color: COLORS.textSecondary, fontFamily: MONO_FONT }}>
              Coordinator: {coordinatorAvailability.available ? "available" : "offline"} · {coordinatorAvailability.mode.replace(/_/g, " ")}
              {coordinatorAvailability.summary ? ` — ${coordinatorAvailability.summary}` : ""}
            </div>
          )}

          {activePhase.phase?.instructions?.trim() && (
            <details className="mt-1">
              <summary className="text-[10px] cursor-pointer" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
                Custom instructions
              </summary>
              <pre
                className="mt-1 whitespace-pre-wrap break-words text-[10px]"
                style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}
              >
                {activePhase.phase.instructions}
              </pre>
            </details>
          )}
        </div>
      )}

      {/* Prompt inspector */}
      {showPrompt && (
        <PromptInspectorCard
          inspector={promptInspector}
          loading={promptLoading}
          error={promptError}
          title="Effective planning / coordinator prompt"
        />
      )}
    </div>
  );
}
