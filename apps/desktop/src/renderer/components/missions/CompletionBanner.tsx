import React from "react";
import type { RunCompletionEvaluation, OrchestratorRunStatus } from "../../../shared/types";
import { cn } from "../ui/cn";

type CompletionBannerProps = {
  status: OrchestratorRunStatus;
  evaluation?: RunCompletionEvaluation | null;
  className?: string;
};

const BANNER_STYLES: Partial<Record<OrchestratorRunStatus, { bg: string; text: string; label: string }>> = {
  succeeded: {
    bg: "bg-emerald-500/10 border-emerald-500/30",
    text: "text-emerald-300",
    label: "Mission completed successfully"
  },
  succeeded_with_risk: {
    bg: "bg-amber-500/10 border-amber-500/30",
    text: "text-amber-300",
    label: "Mission completed with risk"
  },
  failed: {
    bg: "bg-red-500/10 border-red-500/30",
    text: "text-red-300",
    label: "Mission failed"
  },
  paused: {
    bg: "bg-amber-500/10 border-amber-500/30",
    text: "text-amber-300",
    label: "Mission paused"
  }
};

export function CompletionBanner({ status, evaluation, className }: CompletionBannerProps) {
  const style = BANNER_STYLES[status];
  if (!style) return null;

  const blockingDiagnostics = evaluation?.diagnostics?.filter((d) => d.blocking) ?? [];
  const riskFactors = evaluation?.riskFactors ?? [];

  return (
    <div className={cn("rounded-lg border px-3 py-2", style.bg, className)}>
      <div className={cn("text-xs font-medium", style.text)}>{style.label}</div>

      {riskFactors.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {riskFactors.map((factor, i) => (
            <div key={i} className="text-[10px] text-amber-300/80">
              {"\u26A0"} {factor.replace(/_/g, " ")}
            </div>
          ))}
        </div>
      )}

      {blockingDiagnostics.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {blockingDiagnostics.map((d, i) => (
            <div key={i} className="text-[10px] text-red-300/80">
              {"\u2717"} {d.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
