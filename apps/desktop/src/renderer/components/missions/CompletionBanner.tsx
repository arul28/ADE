import React from "react";
import type { RunCompletionEvaluation, OrchestratorRunStatus } from "../../../shared/types";
import { cn } from "../ui/cn";

type CompletionBannerProps = {
  status: OrchestratorRunStatus;
  evaluation?: RunCompletionEvaluation | null;
  className?: string;
};

const BANNER_STYLES: Partial<Record<OrchestratorRunStatus, {
  containerStyle: React.CSSProperties;
  textColor: string;
  label: string;
}>> = {
  succeeded: {
    containerStyle: { background: "#22C55E18", border: "1px solid #22C55E30" },
    textColor: "#22C55E",
    label: "MISSION COMPLETED SUCCESSFULLY"
  },
  succeeded_with_risk: {
    containerStyle: { background: "#F59E0B18", border: "1px solid #F59E0B30" },
    textColor: "#F59E0B",
    label: "MISSION COMPLETED WITH RISK"
  },
  failed: {
    containerStyle: { background: "#EF444418", border: "1px solid #EF444430" },
    textColor: "#EF4444",
    label: "MISSION FAILED"
  },
  paused: {
    containerStyle: { background: "#F59E0B18", border: "1px solid #F59E0B30" },
    textColor: "#F59E0B",
    label: "MISSION PAUSED"
  }
};

export function CompletionBanner({ status, evaluation, className }: CompletionBannerProps) {
  const style = BANNER_STYLES[status];
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
          fontFamily: "JetBrains Mono, monospace",
          fontSize: 11,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "1px"
        }}
      >
        {style.label}
      </div>

      {riskFactors.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {riskFactors.map((factor, i) => (
            <div
              key={i}
              style={{
                color: "#F59E0B",
                fontSize: 10,
                fontFamily: "JetBrains Mono, monospace"
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
                color: "#EF4444",
                fontSize: 10,
                fontFamily: "JetBrains Mono, monospace"
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
