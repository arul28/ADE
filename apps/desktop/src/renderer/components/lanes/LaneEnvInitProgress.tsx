import type { LaneEnvInitProgress as EnvInitProgress, LaneEnvInitStep } from "../../../shared/types";

function StepIcon({ status }: { status: LaneEnvInitStep["status"] }) {
  switch (status) {
    case "completed":
      return <span className="text-green-400">&#x2713;</span>;
    case "running":
      return <span className="inline-block h-3 w-3 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />;
    case "failed":
      return <span className="text-red-400">&#x2717;</span>;
    case "skipped":
      return <span className="text-muted-fg">&mdash;</span>;
    default:
      return <span className="text-muted-fg/50">&#x25CB;</span>;
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
            <span className="w-4 text-center flex items-center justify-center"><StepIcon status={step.status} /></span>
            <span className={step.status === "failed" ? "text-red-400" : "text-muted-fg"}>{step.label}</span>
            {step.durationMs != null && step.status === "completed" && (
              <span className="text-muted-fg/60 ml-auto">{(step.durationMs / 1000).toFixed(1)}s</span>
            )}
            {step.error && (
              <span className="text-red-400/80 ml-auto max-w-[400px] break-words" title={step.error}>{step.error}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
