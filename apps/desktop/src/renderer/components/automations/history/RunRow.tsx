import type { AutomationRun } from "../../../../shared/types";
import { cn } from "../../ui/cn";
import { relativeWhen } from "../../../lib/format";
import { eventLabel } from "../triggerCatalog";
import { readTestRunInfo, testRunLabel } from "./testRunInfo";
import { STATE_TEXT, StatusGlyph, durationLabel, messageTone, runState, statusWord } from "./runPresentation";

function summarizeExecution(run: AutomationRun): string {
  if (run.executionKind === "agent-session") return "Agent chat";
  const n = Math.max(1, run.actionsTotal);
  return `${n} step${n === 1 ? "" : "s"}`;
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
  const test = readTestRunInfo(run);
  const state = runState(run.status);
  const took = durationLabel(run.startedAt, run.endedAt, true);
  const message = run.errorMessage ?? run.summary;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex w-full gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
        selected ? "border-accent/40 bg-fg/[0.05]" : "border-fg/[0.06] hover:bg-fg/[0.04]",
      )}
    >
      <span className="mt-0.5"><StatusGlyph status={run.status} size={16} /></span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[12px] font-medium text-fg">{eventLabel(run.triggerType)}</span>
          <span className="shrink-0 text-[10.5px] text-[color:var(--kit-text-3)]" title={new Date(run.startedAt).toLocaleString()}>
            {relativeWhen(run.startedAt)}
          </span>
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10.5px] text-[color:var(--kit-text-3)]">
          <span className={cn("font-medium", STATE_TEXT[state])}>{statusWord(run.status)}</span>
          <span aria-hidden>·</span>
          <span>{summarizeExecution(run)}</span>
          {took ? <><span aria-hidden>·</span><span className="kit-num">{took}</span></> : null}
          {test ? (
            <span className="kit-tag ml-1" data-tone="warn" data-testid="automation-run-test-badge">{testRunLabel(test)}</span>
          ) : null}
        </span>
        {message ? (
          <span className={cn("mt-1 line-clamp-2 block text-[11px] leading-snug", messageTone(state))}>
            {message}
          </span>
        ) : null}
      </span>
    </button>
  );
}
