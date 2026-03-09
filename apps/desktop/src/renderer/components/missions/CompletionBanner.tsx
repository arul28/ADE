import React, { useMemo, useState } from "react";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import type { MissionStateDocument, RunCompletionEvaluation, OrchestratorRunStatus } from "../../../shared/types";
import { cn } from "../ui/cn";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";

type CompletionBannerProps = {
  status: OrchestratorRunStatus;
  evaluation?: RunCompletionEvaluation | null;
  runId?: string | null;
  stateDoc?: MissionStateDocument | null;
  className?: string;
};

const BANNER_CONFIG: Partial<Record<OrchestratorRunStatus, {
  bg: string;
  border: string;
  color: string;
  label: string;
}>> = {
  succeeded: { bg: `${COLORS.success}08`, border: `${COLORS.success}30`, color: COLORS.success, label: "Completed" },
  failed: { bg: `${COLORS.danger}08`, border: `${COLORS.danger}30`, color: COLORS.danger, label: "Failed" },
  paused: { bg: `${COLORS.warning}08`, border: `${COLORS.warning}30`, color: COLORS.warning, label: "Paused" },
  canceled: { bg: "#71717A08", border: "#71717A30", color: "#71717A", label: "Canceled" },
};

function summarize(stateDoc: MissionStateDocument | null) {
  if (!stateDoc) return null;
  const outcomes = stateDoc.stepOutcomes;
  const succeeded = outcomes.filter((e) => e.status === "succeeded").length;
  const failed = outcomes.filter((e) => e.status === "failed").length;
  const tests = outcomes.reduce(
    (acc, e) => {
      if (!e.testsRun) return acc;
      acc.passed += e.testsRun.passed;
      acc.failed += e.testsRun.failed;
      return acc;
    },
    { passed: 0, failed: 0 },
  );
  return { total: outcomes.length, succeeded, failed, files: stateDoc.modifiedFiles.length, tests };
}

export function CompletionBanner({ status, evaluation, stateDoc = null, className }: CompletionBannerProps) {
  const [expanded, setExpanded] = useState(false);
  const finalization = stateDoc?.finalization ?? null;
  const coordinatorAvailability = stateDoc?.coordinatorAvailability ?? null;

  const config = useMemo(() => {
    if (status === "succeeded" && finalization?.status === "finalization_failed") {
      return { bg: `${COLORS.danger}08`, border: `${COLORS.danger}30`, color: COLORS.danger, label: "Completed — finalization failed" };
    }
    if (status === "succeeded" && finalization && !finalization.contractSatisfied) {
      return { bg: `${COLORS.warning}08`, border: `${COLORS.warning}30`, color: COLORS.warning, label: `Completed — ${finalization.status.replace(/_/g, " ")}` };
    }
    return BANNER_CONFIG[status];
  }, [finalization, status]);

  const summary = useMemo(() => summarize(stateDoc), [stateDoc]);
  if (!config) return null;

  const blockingDiagnostics = status !== "canceled" ? (evaluation?.diagnostics?.filter((d) => d.blocking) ?? []) : [];
  const riskFactors = status !== "canceled" ? (evaluation?.riskFactors ?? []) : [];
  const hasDetails = summary || blockingDiagnostics.length > 0 || riskFactors.length > 0 || finalization?.summary;

  return (
    <div
      className={cn("px-3 py-2", className)}
      style={{ background: config.bg, borderLeft: `3px solid ${config.border}` }}
    >
      <div className="flex items-center justify-between">
        <span
          className="text-[11px] font-semibold uppercase tracking-wide"
          style={{ color: config.color, fontFamily: MONO_FONT }}
        >
          {config.label}
        </span>

        {hasDetails && (
          <button
            type="button"
            onClick={() => setExpanded((p) => !p)}
            className="flex items-center gap-1 text-[9px]"
            style={{ color: COLORS.textDim, fontFamily: MONO_FONT, background: "none", border: "none", cursor: "pointer", padding: 0 }}
          >
            {expanded ? <CaretDown weight="bold" className="h-2.5 w-2.5" /> : <CaretRight weight="bold" className="h-2.5 w-2.5" />}
            Details
          </button>
        )}
      </div>

      {/* Inline summary */}
      {summary && (status === "succeeded" || status === "failed") && (
        <div className="mt-1 flex items-center gap-3 text-[10px]" style={{ fontFamily: MONO_FONT, color: COLORS.textSecondary }}>
          <span>{summary.total} steps</span>
          {summary.succeeded > 0 && <span style={{ color: COLORS.success }}>{summary.succeeded} passed</span>}
          {summary.failed > 0 && <span style={{ color: COLORS.danger }}>{summary.failed} failed</span>}
          {summary.files > 0 && <span>{summary.files} files</span>}
          {summary.tests.passed + summary.tests.failed > 0 && (
            <span>Tests: {summary.tests.passed}p / {summary.tests.failed}f</span>
          )}
        </div>
      )}

      {/* Expanded details */}
      {expanded && (
        <div className="mt-2 space-y-1">
          {finalization?.summary && (
            <div className="text-[10px]" style={{ fontFamily: MONO_FONT, color: COLORS.textSecondary }}>
              {finalization.summary}
            </div>
          )}
          {coordinatorAvailability?.summary && status === "succeeded" && (
            <div className="text-[10px]" style={{ fontFamily: MONO_FONT, color: COLORS.textDim }}>
              {coordinatorAvailability.summary}
            </div>
          )}
          {riskFactors.map((factor, i) => (
            <div key={i} className="text-[10px]" style={{ color: COLORS.warning, fontFamily: MONO_FONT }}>
              {"\u26A0"} {factor.replace(/_/g, " ")}
            </div>
          ))}
          {blockingDiagnostics.map((d, i) => (
            <div key={i} className="text-[10px]" style={{ color: COLORS.danger, fontFamily: MONO_FONT }}>
              {"\u2717"} {d.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
