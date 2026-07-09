import type { AutomationRun } from "../../../../shared/types";
import { Chip } from "../../ui/Chip";
import { cn } from "../../ui/cn";
import { formatDate, formatDurationMs, statusToneAutomation as statusTone } from "../../../lib/format";
import { eventLabel } from "../triggerCatalog";

function summarizeExecution(run: AutomationRun): string {
  if (run.executionKind === "agent-session") return "Agent session";
  const n = Math.max(1, run.actionsTotal);
  return `${n} built-in step${n === 1 ? "" : "s"}`;
}

export function RunRow({
  run,
  selected,
  onSelect,
}: {
  run: AutomationRun;
  selected: boolean;
  onSelect: () => void;
}) {
  const durationMs = run.startedAt && run.endedAt ? Date.parse(run.endedAt) - Date.parse(run.startedAt) : null;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full rounded-lg px-3 py-2.5 text-left transition-colors",
        selected ? "border-l-2 border-accent bg-white/[0.04]" : "border border-white/[0.06] hover:bg-white/[0.05]",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[12px] font-medium text-fg">{eventLabel(run.triggerType)}</span>
            <span className="shrink-0 text-[10.5px] text-muted-fg/55">{formatDate(run.startedAt)}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10.5px] text-muted-fg/60">
            <span>{formatDurationMs(durationMs)}</span>
            <span>{summarizeExecution(run)}</span>
          </div>
          {run.summary ? (
            <div className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-muted-fg/75">{run.summary}</div>
          ) : null}
          {run.errorMessage ? (
            <div className="mt-1 truncate text-[10px] text-red-400">{run.errorMessage}</div>
          ) : null}
        </div>
        <Chip className={cn("shrink-0 text-[9px]", statusTone(run.status))}>{run.status}</Chip>
      </div>
    </button>
  );
}
