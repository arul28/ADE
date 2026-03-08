import { useEffect, useState } from "react";
import type { LaneEnvInitProgress as EnvInitProgress, LaneEnvInitStep } from "../../../shared/types";

function stepIcon(status: LaneEnvInitStep["status"]): string {
  switch (status) {
    case "completed": return "\u2713";
    case "running": return "\u27F3";
    case "failed": return "\u2717";
    case "skipped": return "\u2014";
    default: return "\u25CB";
  }
}

function stepColor(status: LaneEnvInitStep["status"]): string {
  switch (status) {
    case "completed": return "text-green-400";
    case "running": return "text-blue-400 animate-spin";
    case "failed": return "text-red-400";
    case "skipped": return "text-muted-fg";
    default: return "text-muted-fg/50";
  }
}

export function LaneEnvInitProgressPanel({ progress }: { progress: EnvInitProgress | null }) {
  if (!progress || progress.steps.length === 0) return null;

  const isRunning = progress.overallStatus === "running";
  const isFailed = progress.overallStatus === "failed";

  return (
    <div className="mt-3 rounded border border-border/20 bg-card/40 p-3">
      <div className="flex items-center gap-2 text-xs font-medium">
        <span>Environment Setup</span>
        {isRunning && <span className="text-blue-400 text-[10px]">in progress...</span>}
        {isFailed && <span className="text-red-400 text-[10px]">failed</span>}
        {progress.overallStatus === "completed" && <span className="text-green-400 text-[10px]">done</span>}
      </div>
      <div className="mt-2 space-y-1.5">
        {progress.steps.map((step) => (
          <div key={step.kind} className="flex items-center gap-2 text-xs">
            <span className={`w-4 text-center ${stepColor(step.status)}`}>{stepIcon(step.status)}</span>
            <span className={step.status === "failed" ? "text-red-400" : "text-muted-fg"}>{step.label}</span>
            {step.durationMs != null && step.status === "completed" && (
              <span className="text-muted-fg/60 ml-auto">{(step.durationMs / 1000).toFixed(1)}s</span>
            )}
            {step.error && (
              <span className="text-red-400/80 ml-auto truncate max-w-[200px]" title={step.error}>{step.error}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
