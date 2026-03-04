import React, { useEffect, useMemo, useState } from "react";
import type { MissionStateDocument, RunCompletionEvaluation, OrchestratorRunStatus } from "../../../shared/types";
import { cn } from "../ui/cn";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";

type CompletionBannerProps = {
  status: OrchestratorRunStatus;
  evaluation?: RunCompletionEvaluation | null;
  runId?: string | null;
  className?: string;
};

const BANNER_STYLES: Partial<Record<OrchestratorRunStatus, {
  containerStyle: React.CSSProperties;
  textColor: string;
  label: string;
}>> = {
  succeeded: {
    containerStyle: { background: `${COLORS.success}18`, border: `1px solid ${COLORS.success}30` },
    textColor: COLORS.success,
    label: "MISSION COMPLETED SUCCESSFULLY"
  },
  failed: {
    containerStyle: { background: `${COLORS.danger}18`, border: `1px solid ${COLORS.danger}30` },
    textColor: COLORS.danger,
    label: "MISSION FAILED"
  },
  paused: {
    containerStyle: { background: `${COLORS.warning}18`, border: `1px solid ${COLORS.warning}30` },
    textColor: COLORS.warning,
    label: "MISSION PAUSED"
  },
  canceled: {
    containerStyle: { background: "#71717A18", border: "1px solid #71717A30" },
    textColor: "#71717A",
    label: "MISSION CANCELED"
  }
};

const STRUCTURED_SUMMARY_STATUSES = new Set<OrchestratorRunStatus>([
  "succeeded",
  "failed",
]);

function summarizeMissionState(stateDoc: MissionStateDocument | null) {
  if (!stateDoc) return null;
  const outcomes = stateDoc.stepOutcomes;
  const succeeded = outcomes.filter((entry) => entry.status === "succeeded").length;
  const failed = outcomes.filter((entry) => entry.status === "failed").length;
  const skipped = outcomes.filter((entry) => entry.status === "skipped").length;
  const inProgress = outcomes.filter((entry) => entry.status === "in_progress").length;
  const tests = outcomes.reduce(
    (acc, entry) => {
      if (!entry.testsRun) return acc;
      acc.passed += entry.testsRun.passed;
      acc.failed += entry.testsRun.failed;
      acc.skipped += entry.testsRun.skipped;
      return acc;
    },
    { passed: 0, failed: 0, skipped: 0 }
  );
  const openIssues = stateDoc.activeIssues.filter((entry) => entry.status === "open").length;
  const mitigatedIssues = stateDoc.activeIssues.filter((entry) => entry.status === "mitigated").length;
  const resolvedIssues = stateDoc.activeIssues.filter((entry) => entry.status === "resolved").length;

  return {
    totalOutcomes: outcomes.length,
    succeeded,
    failed,
    skipped,
    inProgress,
    tests,
    filesChanged: stateDoc.modifiedFiles.length,
    openIssues,
    mitigatedIssues,
    resolvedIssues,
  };
}

export function CompletionBanner({ status, evaluation, runId, className }: CompletionBannerProps) {
  const style = BANNER_STYLES[status];
  const [stateDoc, setStateDoc] = useState<MissionStateDocument | null>(null);
  const shouldShowStructuredSummary = STRUCTURED_SUMMARY_STATUSES.has(status);
  const summary = useMemo(() => summarizeMissionState(stateDoc), [stateDoc]);

  useEffect(() => {
    if (!runId || !shouldShowStructuredSummary) {
      setStateDoc(null);
      return;
    }
    let cancelled = false;
    const loadState = async () => {
      try {
        const next = await window.ade.orchestrator.getMissionStateDocument({ runId });
        if (cancelled) return;
        setStateDoc(next);
      } catch {
        // Banner still shows without the structured summary
      }
    };
    void loadState();
    return () => {
      cancelled = true;
    };
  }, [runId, shouldShowStructuredSummary]);

  if (!style) return null;

  const blockingDiagnostics = evaluation?.diagnostics?.filter((d) => d.blocking) ?? [];
  const riskFactors = evaluation?.riskFactors ?? [];

  return (
    <div
      className={cn("px-3 py-2", className)}
      style={{ ...style.containerStyle, borderRadius: 0 }}
    >
      <div
        style={{
          color: style.textColor,
          fontFamily: MONO_FONT,
          fontSize: 11,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "1px"
        }}
      >
        {style.label}
      </div>

      {summary && shouldShowStructuredSummary && (
        <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]" style={{ fontFamily: MONO_FONT, color: COLORS.textPrimary }}>
          <div>Steps: {summary.totalOutcomes} total</div>
          <div>Files changed: {summary.filesChanged}</div>
          <div>Succeeded: {summary.succeeded}</div>
          <div>Failed: {summary.failed}</div>
          <div>Skipped: {summary.skipped}</div>
          <div>In progress: {summary.inProgress}</div>
          <div>Tests: {summary.tests.passed} pass / {summary.tests.failed} fail / {summary.tests.skipped} skip</div>
          <div>Issues: {summary.openIssues} open / {summary.mitigatedIssues} mitigated / {summary.resolvedIssues} resolved</div>
        </div>
      )}

      {riskFactors.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {riskFactors.map((factor, i) => (
            <div
              key={i}
              style={{
                color: COLORS.warning,
                fontSize: 10,
                fontFamily: MONO_FONT
              }}
            >
              {"\u26A0"} {factor.replace(/_/g, " ")}
            </div>
          ))}
        </div>
      )}

      {blockingDiagnostics.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {blockingDiagnostics.map((d, i) => (
            <div
              key={i}
              style={{
                color: COLORS.danger,
                fontSize: 10,
                fontFamily: MONO_FONT
              }}
            >
              {"\u2717"} {d.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
