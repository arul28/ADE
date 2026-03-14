import React, { useState } from "react";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import type { RunCompletionEvaluation, OrchestratorRunStatus } from "../../../shared/types";
import { cn } from "../ui/cn";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";

type CompletionBannerProps = {
  status: OrchestratorRunStatus;
  evaluation?: RunCompletionEvaluation | null;
  runId?: string | null;
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

export function CompletionBanner({ status, evaluation, className }: CompletionBannerProps) {
  const [expanded, setExpanded] = useState(false);

  const config = BANNER_CONFIG[status];
  if (!config) return null;

  const blockingDiagnostics = status !== "canceled" ? (evaluation?.diagnostics?.filter((d) => d.blocking) ?? []) : [];
  const riskFactors = status !== "canceled" ? (evaluation?.riskFactors ?? []) : [];
  const hasDetails = blockingDiagnostics.length > 0 || riskFactors.length > 0;

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

      {/* Expanded details */}
      {expanded && (
        <div className="mt-2 space-y-1">
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
