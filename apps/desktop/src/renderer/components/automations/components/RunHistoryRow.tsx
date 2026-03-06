import type { AutomationRun } from "../../../../shared/types";
import { Chip } from "../../ui/Chip";
import { cn } from "../../ui/cn";
import { statusToneAutomation as statusTone, formatDurationMs } from "../../../lib/format";

function formatWhen(ts: string | null): string {
  if (!ts) return "--";
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return ts;
  return new Date(parsed).toLocaleString();
}

export function RunHistoryRow({
  run,
  ruleName,
  selected,
  onSelect,
}: {
  run: AutomationRun;
  ruleName?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const durationMs =
    run.startedAt && run.endedAt
      ? Date.parse(run.endedAt) - Date.parse(run.startedAt)
      : null;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full px-3 py-2 text-left transition-all duration-100",
        selected ? "bg-[#1E1A2C]" : "hover:bg-[#14111D]",
      )}
      style={{ borderBottom: "1px solid #2D284040" }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {ruleName && (
              <span className="truncate text-[11px] font-semibold text-[#FAFAFA]">{ruleName}</span>
            )}
            <span className="font-mono text-[9px] text-[#71717A]">{run.triggerType}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-3 font-mono text-[9px] text-[#71717A]">
            <span>{formatWhen(run.startedAt)}</span>
            <span>{formatDurationMs(durationMs)}</span>
            <span>{run.actionsCompleted}/{run.actionsTotal} actions</span>
          </div>
          {run.errorMessage && (
            <div className="mt-0.5 font-mono text-[9px] text-red-300 truncate">{run.errorMessage}</div>
          )}
        </div>
        <Chip className={cn("text-[9px] shrink-0", statusTone(run.status))}>{run.status}</Chip>
      </div>
    </button>
  );
}
