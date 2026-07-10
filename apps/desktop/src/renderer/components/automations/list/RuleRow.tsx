import { useMemo } from "react";
import { ClockCounterClockwise, Play, Trash, Warning } from "@phosphor-icons/react";
import type { AutomationIngressDelivery, AutomationRuleSummary, AutomationTriggerDeliveryStatus } from "../../../../shared/types";
import { triggerDeliveryKeyForType } from "../../../../shared/types";
import { cn } from "../../ui/cn";
import { SettingsToggle } from "../../settings/settingsSectionUi";
import { formatDate } from "../../../lib/format";
import { buildRuleSentence } from "../automationCopy";
import { sourceAccent, sourceDef, sourceForTriggerType } from "../triggerCatalog";
import { RuleSentence } from "./RuleSentence";

function statusDotColor(status: string | null, running: boolean): string {
  if (running) return "bg-amber-400";
  if (status === "succeeded") return "bg-emerald-400";
  if (status === "failed") return "bg-red-400";
  if (status === "cancelled" || status === "skipped") return "bg-muted-fg/50";
  return "bg-muted-fg/30";
}

function scheduleHint(rule: AutomationRuleSummary): string {
  const trigger = rule.triggers[0] ?? rule.trigger;
  if (trigger?.type === "schedule") return `Next ${formatDate(rule.nextRunAt, "—")}`;
  return "Runs on event";
}

function blockedDelivery(
  rule: AutomationRuleSummary,
  delivery: AutomationIngressDelivery,
): AutomationTriggerDeliveryStatus | null {
  const triggers = rule.triggers.length ? rule.triggers : rule.trigger ? [rule.trigger] : [];
  for (const trigger of triggers) {
    const deliveryKey = triggerDeliveryKeyForType(trigger.type);
    if (deliveryKey && !delivery[deliveryKey].ready) return delivery[deliveryKey];
  }
  return null;
}

export function RuleRow({
  rule,
  delivery,
  selected,
  onSelect,
  onToggle,
  onRunNow,
  onOpenHistory,
  onDelete,
}: {
  rule: AutomationRuleSummary;
  delivery: AutomationIngressDelivery | null;
  selected: boolean;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
  onRunNow: () => void;
  onOpenHistory: () => void;
  onDelete: () => void;
}) {
  const sentence = useMemo(() => buildRuleSentence(rule), [rule]);
  const deliveryBlocked = rule.enabled && delivery ? blockedDelivery(rule, delivery) : null;
  const deliveryBlockedTitle = deliveryBlocked?.setupError ?? "Events for this trigger can't be delivered yet.";
  const lastRun = rule.lastRunStatus;
  const primaryTrigger = rule.triggers[0] ?? rule.trigger;
  const primarySource = sourceForTriggerType(primaryTrigger?.type ?? "manual");
  const SourceIcon = sourceDef(primarySource).icon;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "group cursor-pointer rounded-lg border px-3 py-2.5 text-left transition-colors focus:outline-none",
        selected
          ? "border-accent/40 bg-accent/[0.06]"
          : "border-white/[0.06] bg-white/[0.02] hover:border-white/[0.12] hover:bg-white/[0.04]",
      )}
    >
      <div className="flex items-start gap-2.5">
        <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", statusDotColor(lastRun, rule.running))} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cn("truncate text-[13px] font-semibold", rule.enabled ? "text-fg" : "text-muted-fg/70")}>
              {rule.name || "Untitled automation"}
            </span>
            {deliveryBlocked ? (
              <span title={deliveryBlockedTitle} className="shrink-0 text-amber-300">
                <Warning size={12} weight="fill" />
              </span>
            ) : null}
          </div>

          <RuleSentence sentence={sentence} className="mt-1 line-clamp-2 text-[11px]" />

          <div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-muted-fg/55">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <span className="shrink-0" style={{ color: sourceAccent(primarySource), opacity: 0.7 }}>
                <SourceIcon size={11} weight="fill" />
              </span>
              <span>{scheduleHint(rule)}</span>
            </span>
            <span aria-hidden>·</span>
            <span>Last {formatDate(rule.lastRunAt, "never")}</span>
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5" onClick={(e) => e.stopPropagation()}>
          <SettingsToggle id={`rule-toggle-${rule.id}`} checked={rule.enabled} onChange={onToggle} />
          <div className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            <button
              type="button"
              onClick={onOpenHistory}
              title="History"
              className="rounded p-1 text-muted-fg/60 hover:text-fg"
            >
              <ClockCounterClockwise size={13} weight="regular" />
            </button>
            <button
              type="button"
              onClick={onRunNow}
              title="Run now"
              className="rounded p-1 text-muted-fg/60 hover:text-fg"
            >
              <Play size={13} weight="regular" />
            </button>
            <button
              type="button"
              onClick={onDelete}
              title="Delete"
              className="rounded p-1 text-muted-fg/60 hover:text-red-300"
            >
              <Trash size={13} weight="regular" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
