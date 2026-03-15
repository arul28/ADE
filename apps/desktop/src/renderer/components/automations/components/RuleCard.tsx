import {
  ClockCounterClockwise,
  PencilSimple,
  Play,
  Trash,
} from "@phosphor-icons/react";
import type { AutomationRuleSummary } from "../../../../shared/types";
import { Chip } from "../../ui/Chip";
import { cn } from "../../ui/cn";
import { formatDate, statusToneAutomation as statusTone } from "../../../lib/format";

function summarizeTrigger(rule: AutomationRuleSummary): string {
  const trigger = rule.triggers[0] ?? rule.trigger;
  if (!trigger) return "No trigger";
  if (trigger.type === "schedule") {
    return trigger.cron?.trim().length ? `Schedule · ${trigger.cron}` : "Schedule";
  }
  if (trigger.type.startsWith("linear.")) {
    const scope = [trigger.team, trigger.project, trigger.assignee].filter(Boolean).join(" / ");
    return scope ? `Linear · ${scope}` : "Linear event";
  }
  if (trigger.type.startsWith("git.") || trigger.type === "commit") {
    return trigger.branch?.trim().length ? `GitHub · ${trigger.type} · ${trigger.branch}` : `GitHub · ${trigger.type}`;
  }
  if (trigger.type === "github-webhook" || trigger.type === "webhook") {
    return trigger.event?.trim().length ? `Webhook · ${trigger.event}` : "Webhook";
  }
  if (trigger.type === "session-end" || trigger.type.startsWith("lane.") || trigger.type === "file.change") {
    return `ADE · ${trigger.type}`;
  }
  return trigger.type;
}

function summarizeExecution(rule: AutomationRuleSummary): string {
  const execution = rule.execution;
  if (!execution) return "Mission";
  if (execution.kind === "agent-session") return "Agent session";
  if (execution.kind === "built-in") {
    const actionCount = execution.builtIn?.actions?.length ?? 0;
    return actionCount > 0 ? `Built-in · ${actionCount} task${actionCount === 1 ? "" : "s"}` : "Built-in";
  }
  return "Mission";
}

function summarizeModel(rule: AutomationRuleSummary): string | null {
  if (rule.execution?.kind === "built-in") return null;
  return rule.modelConfig?.orchestratorModel?.modelId ?? null;
}

export function RuleCard({
  rule,
  selected,
  onSelect,
  onToggle,
  onRunNow,
  onEdit,
  onHistory,
  onDelete,
}: {
  rule: AutomationRuleSummary;
  selected: boolean;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
  onRunNow: () => void;
  onEdit: () => void;
  onHistory: () => void;
  onDelete?: () => void;
}) {
  const model = summarizeModel(rule);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "group w-full rounded-2xl p-3 text-left transition-all duration-150",
        selected ? "shadow-[0_20px_40px_-28px_rgba(99,102,241,0.8)]" : "hover:-translate-y-[1px]",
      )}
      style={{
        background: selected ? "linear-gradient(180deg, rgba(33,30,56,0.96), rgba(22,19,37,0.96))" : "#171325",
        border: `1px solid ${selected ? "rgba(129,140,248,0.38)" : "rgba(45,40,64,0.92)"}`,
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="truncate text-sm font-semibold text-[#FAFAFA]">{rule.name}</div>
            <Chip className={cn("text-[9px]", statusTone(rule.running ? "running" : rule.lastRunStatus))}>
              {rule.running ? "running" : rule.lastRunStatus ?? "never"}
            </Chip>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="rounded-full px-2 py-1 font-mono text-[10px] text-[#E2E8F0]" style={{ background: "rgba(99,102,241,0.18)" }}>
              {summarizeTrigger(rule)}
            </span>
            <span className="rounded-full px-2 py-1 font-mono text-[10px] text-[#DCFCE7]" style={{ background: "rgba(34,197,94,0.18)" }}>
              {summarizeExecution(rule)}
            </span>
            <span className="rounded-full px-2 py-1 font-mono text-[10px] text-[#FDE68A]" style={{ background: "rgba(245,158,11,0.18)" }}>
              {rule.mode}
            </span>
          </div>

          {rule.description ? (
            <div className="mt-2 line-clamp-2 text-xs leading-5 text-[#B8B6C7]">{rule.description}</div>
          ) : null}

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-[#8E8AA6]">
            <span>next {formatDate(rule.nextRunAt, "On event")}</span>
            <span>last {formatDate(rule.lastRunAt, "Never")}</span>
            <span>{rule.source}</span>
            {model ? <span className="truncate">{model}</span> : null}
          </div>
        </div>

        <div className="shrink-0 space-y-2">
          <label
            className="flex items-center justify-end gap-1 text-[10px] font-mono uppercase tracking-[1px] text-[#8E8AA6]"
            onClick={(event) => event.stopPropagation()}
          >
            <input
              type="checkbox"
              checked={rule.enabled}
              onChange={(event) => onToggle(event.target.checked)}
              className="accent-[#818CF8]"
            />
            {rule.enabled ? "on" : "off"}
          </label>

          <div className="flex items-center justify-end gap-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onRunNow();
              }}
              className="rounded-lg p-1.5 text-[#8E8AA6] transition-colors hover:text-[#C7D2FE]"
              title="Run now"
            >
              <Play size={13} weight="regular" />
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onEdit();
              }}
              className="rounded-lg p-1.5 text-[#8E8AA6] transition-colors hover:text-[#C7D2FE]"
              title="Edit"
            >
              <PencilSimple size={13} weight="regular" />
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onHistory();
              }}
              className="rounded-lg p-1.5 text-[#8E8AA6] transition-colors hover:text-[#C7D2FE]"
              title="History"
            >
              <ClockCounterClockwise size={13} weight="regular" />
            </button>
            {onDelete ? (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete();
                }}
                className="rounded-lg p-1.5 text-[#8E8AA6] transition-colors hover:text-[#FCA5A5]"
                title="Delete"
              >
                <Trash size={13} weight="regular" />
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
