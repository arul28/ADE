import {
  Play,
  PencilSimple,
  ClockCounterClockwise,
} from "@phosphor-icons/react";
import type { AutomationRuleSummary } from "../../../../shared/types";
import { Chip } from "../../ui/Chip";
import { cn } from "../../ui/cn";
import { formatDate, statusToneAutomation as statusTone } from "../../../lib/format";

function summarizeRule(rule: AutomationRuleSummary): string {
  const trigger = rule.triggers[0];
  const triggerLabel = trigger
    ? trigger.type === "schedule" && trigger.cron
      ? `${trigger.type} ${trigger.cron}`
      : trigger.type
    : "manual";
  return `${rule.mode} · ${rule.reviewProfile} · ${triggerLabel}`;
}

function summarizeExecutor(rule: AutomationRuleSummary): string {
  if (rule.executor.mode === "employee") {
    return rule.executor.targetId ? `employee:${rule.executor.targetId}` : "employee";
  }
  if (rule.executor.mode === "cto-route") {
    const capabilities = rule.executor.routingHints?.requiredCapabilities?.length
      ? ` (${rule.executor.routingHints.requiredCapabilities.join(", ")})`
      : "";
    return `cto-route${capabilities}`;
  }
  return rule.executor.mode;
}

export function RuleCard({
  rule,
  selected,
  onSelect,
  onToggle,
  onRunNow,
  onEdit,
  onHistory,
}: {
  rule: AutomationRuleSummary;
  selected: boolean;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
  onRunNow: () => void;
  onEdit: () => void;
  onHistory: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full p-3 text-left transition-all duration-150 group",
        selected
          ? "shadow-[0_0_16px_-4px_rgba(167,139,250,0.12)]"
          : "hover:-translate-y-[0.5px]",
      )}
      style={{
        background: selected ? "#1E1A2C" : "#181423",
        border: `1px solid ${selected ? "rgba(167,139,250,0.25)" : "#2D2840"}`,
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="truncate text-xs font-semibold text-[#FAFAFA]">{rule.name}</div>
            <Chip className={cn("text-[9px]", statusTone(rule.running ? "running" : rule.lastRunStatus))}>
              {rule.running ? "running" : rule.lastRunStatus ?? "never"}
            </Chip>
          </div>

          <div className="mt-2 flex items-center gap-0 text-[11px]">
            <div className="px-1.5 py-0.5 font-mono leading-none" style={{ background: "rgba(249,115,22,0.10)", color: "#F97316" }}>
              {rule.mode}
            </div>
            <Arrow />
            <div className="px-1.5 py-0.5 font-mono leading-none" style={{ background: "rgba(59,130,246,0.10)", color: "#60A5FA" }}>
              {rule.reviewProfile}
            </div>
            <Arrow />
            <div className="px-1.5 py-0.5 font-mono leading-none" style={{ background: "rgba(99,102,241,0.10)", color: "#A5B4FC" }}>
              {summarizeExecutor(rule)}
            </div>
            <Arrow />
            <div className="truncate px-1.5 py-0.5 font-mono leading-none" style={{ background: "rgba(34,197,94,0.10)", color: "#22C55E" }}>
              {summarizeRule(rule)}
            </div>
          </div>

          <div className="mt-1.5 text-xs text-[#71717A] truncate font-mono">
            last run: {formatDate(rule.lastRunAt, "Never")} · queue {rule.queueCount}
          </div>
          <div className="mt-1 text-[10px] text-[#8B8B9A] font-mono truncate">
            {rule.outputs.disposition} · {rule.verification.verifyBeforePublish ? `${rule.verification.mode ?? "intervention"} gate` : "publish ungated"}
            {rule.modelConfig?.orchestratorModel.modelId ? ` · ${rule.modelConfig.orchestratorModel.modelId}` : ""}
          </div>
          {rule.confidence ? (
            <div className="mt-1 text-[10px] text-[#8B8B9A] font-mono">
              confidence: {rule.confidence.label} ({Math.round(rule.confidence.value * 100)}%)
            </div>
          ) : null}
        </div>

        <div className="shrink-0 flex flex-col items-end gap-1.5">
          <label
            className="flex items-center gap-1 text-[9px] font-mono uppercase tracking-[1px] text-[#71717A] cursor-pointer"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              type="checkbox"
              checked={rule.enabled}
              onChange={(e) => onToggle(e.target.checked)}
              className="accent-[#A78BFA]"
            />
            {rule.enabled ? "on" : "off"}
          </label>

          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onRunNow(); }}
              className="p-1 text-[#71717A] hover:text-[#A78BFA] transition-colors"
              title="Run now"
            >
              <Play size={12} weight="regular" />
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onEdit(); }}
              className="p-1 text-[#71717A] hover:text-[#A78BFA] transition-colors"
              title="Edit"
            >
              <PencilSimple size={12} weight="regular" />
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onHistory(); }}
              className="p-1 text-[#71717A] hover:text-[#A78BFA] transition-colors"
              title="History"
            >
              <ClockCounterClockwise size={12} weight="regular" />
            </button>
          </div>
        </div>
      </div>
    </button>
  );
}

function Arrow() {
  return (
    <svg width="16" height="8" viewBox="0 0 16 8" className="shrink-0" style={{ color: "#2D284080" }}>
      <path d="M0 4 L12 4 L9 1 M12 4 L9 7" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
