import type { AutomationRun } from "../../../../shared/types";
import { Chip } from "../../ui/Chip";
import { cn } from "../../ui/cn";
import { formatDate, formatDurationMs, statusToneAutomation as statusTone } from "../../../lib/format";

function summarizeExecution(run: AutomationRun): string {
  if (run.executionKind === "agent-session") return "Agent session";
  if (run.executionKind === "mission") return "Mission";
  return `${Math.max(1, run.actionsTotal)} built-in task${run.actionsTotal === 1 ? "" : "s"}`;
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
        "w-full rounded-2xl px-4 py-3 text-left transition-all duration-100",
        selected ? "bg-[#1B1730]" : "hover:bg-[#151123]",
      )}
      style={{ border: `1px solid ${selected ? "rgba(129,140,248,0.28)" : "rgba(45,40,64,0.55)"}` }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {ruleName ? <span className="truncate text-[12px] font-semibold text-[#FAFAFA]">{ruleName}</span> : null}
            <span className="font-mono text-[10px] text-[#8E8AA6]">{run.triggerType}</span>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-[#8E8AA6]">
            <span>{formatDate(run.startedAt)}</span>
            <span>{formatDurationMs(durationMs)}</span>
            <span>{summarizeExecution(run)}</span>
            {run.chatSessionId ? <span>{run.chatSessionId.slice(0, 8)}</span> : null}
            {!run.chatSessionId && run.missionId ? <span>{run.missionId.slice(0, 8)}</span> : null}
          </div>

          {run.summary ? (
            <div className="mt-2 line-clamp-2 text-xs leading-5 text-[#B6B2C9]">{run.summary}</div>
          ) : null}

          {run.errorMessage ? (
            <div className="mt-2 truncate font-mono text-[10px] text-red-300">{run.errorMessage}</div>
          ) : null}
        </div>

        <Chip className={cn("shrink-0 text-[9px]", statusTone(run.status))}>{run.status}</Chip>
      </div>
    </button>
  );
}
