import React, { useState, useMemo } from "react";
import {
  SpinnerGap,
  Warning,
  CaretDown,
  Eye,
} from "@phosphor-icons/react";
import type {
  OrchestratorAttempt,
  OrchestratorChatTarget,
  OrchestratorClaim,
  OrchestratorStep,
} from "../../../shared/types";
import { cn } from "../ui/cn";
import { COLORS, MONO_FONT, inlineBadge } from "../lanes/laneDesignTokens";
import { relativeWhen } from "../../lib/format";
import {
  isRecord,
  compactText,
  stepIntentSummary,
  resolveStepHeartbeatAt,
  heartbeatAgeMinutes,
  isDisplayOnlyTaskStep,
  STEP_STATUS_HEX,
  EXECUTOR_BADGE_HEX,
  STALE_HEARTBEAT_THRESHOLD_MINUTES,
} from "./missionHelpers";

export const StepDetailPanel = React.memo(function StepDetailPanel({
  step,
  attempts,
  allSteps,
  claims,
  onOpenWorkerThread,
  onViewWorkSession,
  onInspectPrompt,
}: {
  step: OrchestratorStep | null;
  attempts: OrchestratorAttempt[];
  allSteps: OrchestratorStep[];
  claims: OrchestratorClaim[];
  onOpenWorkerThread: (target: OrchestratorChatTarget) => void;
  onViewWorkSession?: (sessionId: string) => void;
  onInspectPrompt?: (stepId: string) => void;
}) {
  const [showFullOutput, setShowFullOutput] = useState(false);

  if (!step) {
    return (
      <aside className="p-3 lg:w-[380px] lg:max-w-[40%] lg:shrink-0" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
        <div className="text-[11px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>STEP DETAILS</div>
        <p className="mt-2 text-[11px]" style={{ color: COLORS.textMuted }}>Select a card in Board or a node in DAG to inspect worker progress.</p>
      </aside>
    );
  }

  const latestAttempt = attempts[0] ?? null;
  const meta = isRecord(step.metadata) ? step.metadata : {};
  const isPlanNode = isDisplayOnlyTaskStep(step);
  const stepType = typeof meta.stepType === "string" ? meta.stepType : "unknown";
  const expectedSignals = Array.isArray(meta.expectedSignals)
    ? meta.expectedSignals
        .map((entry) => String(entry ?? "").trim())
        .filter(Boolean)
    : [];
  const doneCriteria = typeof meta.doneCriteria === "string" ? meta.doneCriteria.trim() : "";
  const dependencyLabels = useMemo(
    () => step.dependencyStepIds
      .map((depId) => allSteps.find((candidate) => candidate.id === depId))
      .filter((dep): dep is OrchestratorStep => Boolean(dep))
      .map((dep) => dep.title.trim() || dep.stepKey),
    [step.dependencyStepIds, allSteps]
  );
  const latestHeartbeatAt = resolveStepHeartbeatAt({ step, attempts, claims });
  const resultEnvelope = latestAttempt && isRecord(latestAttempt.metadata)
    ? latestAttempt.metadata.resultEnvelope
    : undefined;
  const resultText = typeof resultEnvelope === "string"
    ? resultEnvelope
    : isRecord(resultEnvelope) ? JSON.stringify(resultEnvelope, null, 2) : null;

  // Validation contract
  const validationContract = isRecord(meta.validationContract) ? meta.validationContract : null;
  const vcTier = validationContract && typeof validationContract.tier === "string" ? validationContract.tier : null;
  const vcRequired = validationContract ? validationContract.required !== false : false;
  const vcCriteria = validationContract && typeof validationContract.criteria === "string" ? validationContract.criteria : null;
  const lastValidationReport = isRecord(meta.lastValidationReport) ? meta.lastValidationReport : null;
  const vcVerdict = lastValidationReport && typeof lastValidationReport.verdict === "string"
    ? lastValidationReport.verdict as "pass" | "fail"
    : null;
  const vcFindings = lastValidationReport && Array.isArray(lastValidationReport.findings)
    ? (lastValidationReport.findings as unknown[])
        .map((f) => String(f ?? "").trim())
        .filter(Boolean)
    : [];

  const stepHex = STEP_STATUS_HEX[step.status] ?? COLORS.textMuted;
  const detailCellStyle: React.CSSProperties = { background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, padding: "4px 8px" };

  const hbAge = heartbeatAgeMinutes(latestHeartbeatAt);
  const isHeartbeatStale = hbAge !== null && hbAge >= STALE_HEARTBEAT_THRESHOLD_MINUTES;

  const isRunning = step.status === "running";
  const isWaitingForWorker = isRunning && (!latestAttempt || latestAttempt.status !== "running");
  const isWorkerInitializing = isRunning && latestAttempt?.status === "running" && !latestAttempt.executorSessionId;

  return (
    <aside className="p-3 lg:w-[380px] lg:max-w-[40%] lg:shrink-0 overflow-y-auto max-h-full" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>STEP DETAILS</div>
        <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[1px]" style={inlineBadge(stepHex)}>
          {step.status}
        </span>
      </div>

      {isWaitingForWorker && (
        <div
          className="mt-2 flex items-center gap-2 px-2 py-1.5 text-[10px]"
          style={{ background: `${COLORS.warning}12`, border: `1px solid ${COLORS.warning}30`, color: COLORS.warning }}
        >
          <SpinnerGap size={14} weight="regular" className="animate-spin shrink-0" />
          <span>Waiting for worker allocation...</span>
        </div>
      )}
      {isWorkerInitializing && (
        <div
          className="mt-2 flex items-center gap-2 px-2 py-1.5 text-[10px]"
          style={{ background: `${COLORS.accent}12`, border: `1px solid ${COLORS.accent}30`, color: COLORS.accent }}
        >
          <SpinnerGap size={14} weight="regular" className="animate-spin shrink-0" />
          <span>Initializing execution environment...</span>
        </div>
      )}

      {isRunning && isHeartbeatStale && (
        <div
          className="mt-2 flex items-center gap-2 px-2 py-1.5 text-[10px]"
          style={{ background: `${COLORS.warning}18`, border: `1px solid ${COLORS.warning}40`, color: COLORS.warning }}
        >
          <Warning size={14} weight="fill" className="shrink-0" />
          <span>Heartbeat stale ({Math.round(hbAge!)}m) — worker may be stuck</span>
        </div>
      )}

      <div className="mt-2">
        <div className="text-xs font-medium" style={{ color: COLORS.textPrimary }}>{step.title}</div>
        <div className="mt-1 min-h-[28px] text-[10px] leading-snug" style={{ color: COLORS.textMuted }}>{stepIntentSummary(step)}</div>
        {isPlanNode && (
          <div
            className="mt-2 px-2 py-1.5 text-[10px]"
            style={{ background: `${COLORS.warning}14`, border: `1px solid ${COLORS.warning}28`, color: COLORS.warning }}
          >
            This is a plan node. It shapes the visible work breakdown, but it does not run as a worker session.
          </div>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-[10px]">
        <div style={detailCellStyle}>
          <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px", fontSize: 9 }}>KEY</div>
          <div className="font-medium" style={{ color: COLORS.textPrimary }}>{step.stepKey}</div>
        </div>
        <div style={detailCellStyle}>
          <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px", fontSize: 9 }}>TYPE</div>
          <div className="font-medium" style={{ color: COLORS.textPrimary }}>{isPlanNode ? "plan" : stepType}</div>
        </div>
        <div style={detailCellStyle}>
          <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px", fontSize: 9 }}>ATTEMPTS</div>
          <div className="font-medium" style={{ color: COLORS.textPrimary }}>{attempts.length}</div>
        </div>
        <div style={detailCellStyle}>
          <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px", fontSize: 9 }}>DEPENDENCIES</div>
          <div className="font-medium" style={{ color: COLORS.textPrimary }}>{step.dependencyStepIds.length}</div>
        </div>
        <div className="col-span-2" style={detailCellStyle}>
          <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px", fontSize: 9 }}>LANE</div>
          <div className="font-medium" style={{ color: COLORS.textPrimary }}>{step.laneId ?? "none"}</div>
        </div>
      </div>

      {(dependencyLabels.length > 0 || doneCriteria || expectedSignals.length > 0) && (
        <div className="mt-3 px-2 py-2 text-[10px] space-y-1.5" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
          {dependencyLabels.length > 0 && (
            <div>
              <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px", fontSize: 9 }}>DEPENDS ON</div>
              <div className="mt-0.5 leading-snug" style={{ color: COLORS.textPrimary }}>{dependencyLabels.join(", ")}</div>
            </div>
          )}
          {doneCriteria && (
            <div>
              <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px", fontSize: 9 }}>COMPLETION CRITERIA</div>
              <div className="mt-0.5 leading-snug" style={{ color: COLORS.textPrimary }}>{compactText(doneCriteria, 220)}</div>
            </div>
          )}
          {expectedSignals.length > 0 && (
            <div>
              <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px", fontSize: 9 }}>EXPECTED SIGNALS</div>
              <div className="mt-0.5 leading-snug" style={{ color: COLORS.textPrimary }}>{expectedSignals.slice(0, 4).join(", ")}</div>
            </div>
          )}
        </div>
      )}

      {validationContract && (
        <div className="mt-3 px-2 py-2 text-[10px] space-y-1.5" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
          <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px", fontSize: 9 }}>VALIDATION</div>
          <div className="flex items-center gap-2">
            {vcTier && (
              <span className="px-1 py-0.5 text-[9px] font-bold uppercase tracking-[1px]" style={inlineBadge(COLORS.accent)}>
                {vcTier}
              </span>
            )}
            <span className="text-[9px]" style={{ color: vcRequired ? COLORS.warning : COLORS.textMuted, fontFamily: MONO_FONT }}>
              {vcRequired ? "REQUIRED" : "OPTIONAL"}
            </span>
            {vcVerdict && (
              <span
                className="px-1 py-0.5 text-[9px] font-bold uppercase tracking-[1px]"
                style={inlineBadge(vcVerdict === "pass" ? COLORS.success : COLORS.danger)}
              >
                {vcVerdict}
              </span>
            )}
          </div>
          {vcCriteria && (
            <div className="leading-snug" style={{ color: COLORS.textSecondary }}>{compactText(vcCriteria, 220)}</div>
          )}
          {vcFindings.length > 0 && (
            <div className="space-y-0.5">
              <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px", fontSize: 9 }}>FINDINGS</div>
              {vcFindings.slice(0, 5).map((finding, idx) => (
                <div key={idx} className="leading-snug" style={{ color: COLORS.textSecondary }}>
                  {"\u2022"} {finding}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!isPlanNode && (
        <div className="mt-3 px-2 py-2 text-[10px]" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
          <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px", fontSize: 9 }}>LATEST WORKER ATTEMPT</div>
          {latestAttempt ? (
            <div className="mt-1 space-y-1">
              <div className="flex items-center justify-between">
                <span style={{ color: COLORS.textMuted }}>Executor</span>
                <span className="px-1 py-0.5 text-[9px] font-bold uppercase tracking-[1px]" style={inlineBadge(EXECUTOR_BADGE_HEX[latestAttempt.executorKind] ?? COLORS.textMuted)}>
                  {latestAttempt.executorKind}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span style={{ color: COLORS.textMuted }}>Status</span>
                <span style={{ color: COLORS.textPrimary }}>{latestAttempt.status}</span>
              </div>
              <div className="flex items-center justify-between">
                <span style={{ color: COLORS.textMuted }}>Started</span>
                <span style={{ color: COLORS.textPrimary }}>{latestAttempt.startedAt ? relativeWhen(latestAttempt.startedAt) : "--"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span style={{ color: COLORS.textMuted }}>Heartbeat age</span>
                <span
                  className="flex items-center gap-1"
                  style={{ color: isHeartbeatStale ? COLORS.warning : COLORS.textPrimary }}
                >
                  {isHeartbeatStale && <Warning size={11} weight="fill" />}
                  {latestHeartbeatAt ? relativeWhen(latestHeartbeatAt) : "--"}
                </span>
              </div>
              {latestAttempt.errorMessage && (
                <div className="px-1.5 py-1" style={{ border: `1px solid ${COLORS.danger}30`, background: `${COLORS.danger}18`, color: COLORS.danger }}>
                  {compactText(latestAttempt.errorMessage, 160)}
                </div>
              )}
            </div>
          ) : (
            <div className="mt-1 flex items-center gap-2" style={{ color: COLORS.textMuted }}>
              {isRunning ? (
                <>
                  <SpinnerGap size={12} weight="regular" className="animate-spin" />
                  <span>Waiting for worker allocation...</span>
                </>
              ) : (
                <span>No attempt has started yet.</span>
              )}
            </div>
          )}
        </div>
      )}

      {resultText && (
        <div className="mt-3 px-2 py-2 text-[10px]" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
          <button
            onClick={() => setShowFullOutput(!showFullOutput)}
            className="flex items-center gap-1 transition-colors w-full"
            style={{ color: COLORS.textMuted }}
          >
            <CaretDown className={cn("h-3 w-3 transition-transform", showFullOutput && "rotate-180")} />
            <span className="font-bold uppercase tracking-[1px]" style={{ fontFamily: MONO_FONT }}>VIEW FULL OUTPUT</span>
          </button>
          {showFullOutput && (
            <pre className="mt-2 max-h-[300px] overflow-auto p-2 text-[10px] whitespace-pre-wrap break-all" style={{ background: COLORS.recessedBg, color: COLORS.textSecondary, fontFamily: MONO_FONT }}>
              {resultText}
            </pre>
          )}
        </div>
      )}

      <div className="mt-3 space-y-1.5">
        {!isPlanNode && onInspectPrompt && (
          <button
            type="button"
            onClick={() => onInspectPrompt(step.id)}
            className="w-full px-2 py-1.5 text-[10px] font-bold uppercase tracking-[1px] transition-colors"
            style={{ background: `${COLORS.warning}12`, border: `1px solid ${COLORS.warning}28`, color: COLORS.warning, fontFamily: MONO_FONT }}
          >
            INSPECT EFFECTIVE PROMPT
          </button>
        )}
        {!isPlanNode && latestAttempt && (
          <button
            onClick={() => onOpenWorkerThread({
              kind: "worker",
              runId: step.runId,
              stepId: step.id,
              stepKey: step.stepKey,
              attemptId: latestAttempt.id,
              sessionId: latestAttempt.executorSessionId ?? null,
              laneId: step.laneId ?? null
            })}
            className="w-full px-2 py-1.5 text-[10px] font-bold uppercase tracking-[1px] transition-colors"
            style={{ background: `${COLORS.accent}18`, border: `1px solid ${COLORS.accent}30`, color: COLORS.accent, fontFamily: MONO_FONT }}
          >
            JUMP TO WORKER CHANNEL
          </button>
        )}
        {!isPlanNode && latestAttempt?.executorSessionId && onViewWorkSession && (
          <button
            onClick={() => onViewWorkSession(latestAttempt.executorSessionId!)}
            className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-[10px] font-bold uppercase tracking-[1px] transition-colors"
            style={{ background: `${COLORS.textMuted}10`, border: `1px solid ${COLORS.border}`, color: COLORS.textMuted, fontFamily: MONO_FONT }}
          >
            <Eye size={12} weight="regular" />
            VIEW IN WORK TAB
          </button>
        )}
      </div>
    </aside>
  );
});
