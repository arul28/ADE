import { useMemo, useState } from "react";
import { ArrowClockwise, BookOpen, MagnifyingGlass, Plus } from "@phosphor-icons/react";
import type {
  AutomationAction,
  AutomationIngressDelivery,
  AutomationIngressStatus,
  AutomationRule,
  AutomationRuleDraft,
  AutomationRuleSummary,
} from "../../../../shared/types";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { inputCls } from "../designTokens";
import { IngressStatusStrip } from "../settings/IngressStatusStrip";
import { AutomationsEmptyState, AutomationsFilterEmptyState } from "./AutomationsEmptyState";
import { RuleRow, ruleOrigin } from "./RuleRow";

/** Provenance axis for the list: everything, the CTO's rules, or handoffs. */
export type RuleOriginFilter = "all" | "cto" | "handoff";

export const RULE_ORIGIN_FILTERS: ReadonlyArray<{
  key: RuleOriginFilter;
  label: string;
  hint: string;
}> = [
  { key: "all", label: "All", hint: "Every automation in this project." },
  { key: "cto", label: "By CTO", hint: "Automations the CTO wrote for you." },
  { key: "handoff", label: "Handoffs", hint: "Automations that hand a chat to another model." },
];

function ruleActions(rule: Pick<AutomationRule, "execution" | "actions" | "legacy">): AutomationAction[] {
  return [
    ...(rule.execution?.builtIn?.actions ?? []),
    ...(rule.actions ?? []),
    ...(rule.legacy?.actions ?? []),
  ];
}

/**
 * A handoff rule is one whose ACTIONS hand the chat over. Rule names are free
 * text — a rule called "Handoff on limit" that only runs tests is not a
 * handoff, and one called "Keep going" that hands off is.
 */
export function ruleHasHandoffAction(rule: Pick<AutomationRule, "execution" | "actions" | "legacy">): boolean {
  return ruleActions(rule).some((action) => action.type === "handoff");
}

export function matchesRuleOriginFilter(
  rule: AutomationRuleSummary,
  filter: RuleOriginFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "cto") return ruleOrigin(rule) === "cto";
  return ruleHasHandoffAction(rule);
}

export function ruleOriginFilterCounts(
  rules: readonly AutomationRuleSummary[],
): Record<RuleOriginFilter, number> {
  const counts: Record<RuleOriginFilter, number> = { all: rules.length, cto: 0, handoff: 0 };
  for (const rule of rules) {
    if (matchesRuleOriginFilter(rule, "cto")) counts.cto += 1;
    if (matchesRuleOriginFilter(rule, "handoff")) counts.handoff += 1;
  }
  return counts;
}

/**
 * The Work tab's filter-chip idiom (`FILTER_OPTION_*` in SessionListPane), kept
 * character-for-character so the two filter surfaces read as one control.
 */
const FILTER_CHIP_GRID_CLASS = "grid min-w-0 flex-1 gap-0.5 [grid-template-columns:repeat(auto-fit,minmax(2.4rem,1fr))]";
const FILTER_CHIP_CLASS = "ade-chat-drawer-row min-w-0 truncate rounded-md px-1.5 py-1 text-center text-[10px] font-medium";

export function RuleList({
  rules,
  selectedRuleId,
  search,
  loading,
  error,
  configTrustRequired,
  ingressStatus,
  delivery,
  onSearch,
  onSelect,
  onToggle,
  onRunNow,
  onOpenHistory,
  onDelete,
  onNew,
  onOpenTemplates,
  onUseTemplate,
  onRefresh,
  onConfirmTrust,
}: {
  rules: AutomationRuleSummary[];
  selectedRuleId: string | null;
  search: string;
  loading: boolean;
  error: string | null;
  configTrustRequired: boolean;
  ingressStatus: AutomationIngressStatus | null;
  delivery: AutomationIngressDelivery | null;
  onSearch: (value: string) => void;
  onSelect: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onRunNow: (rule: AutomationRuleSummary) => void;
  onOpenHistory: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
  onOpenTemplates: () => void;
  onUseTemplate: (draft: Omit<AutomationRuleDraft, "id">) => void;
  onRefresh: () => void;
  onConfirmTrust: () => void;
}) {
  const [originFilter, setOriginFilter] = useState<RuleOriginFilter>("all");
  // Counts come from the rules the list was handed, so they track the search
  // box live rather than advertising matches the user cannot see.
  const counts = useMemo(() => ruleOriginFilterCounts(rules), [rules]);
  const visibleRules = useMemo(
    () => (originFilter === "all" ? rules : rules.filter((rule) => matchesRuleOriginFilter(rule, originFilter))),
    [originFilter, rules],
  );
  const activeFilterLabel = RULE_ORIGIN_FILTERS.find((f) => f.key === originFilter)?.label ?? "All";

  return (
    <div className="flex min-h-0 w-[340px] shrink-0 flex-col border-r border-white/[0.06] bg-white/[0.01]">
      <div className="shrink-0 border-b border-white/[0.06] px-4 py-3.5">
        <div className="flex items-center justify-between gap-3">
          <div className="text-[15px] font-semibold text-fg">Automations</div>
          <Button size="sm" variant="ghost" disabled={loading} onClick={onRefresh} title="Refresh">
            <ArrowClockwise size={12} weight="regular" className={cn(loading && "animate-spin")} />
          </Button>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" variant="primary" data-tour="automations.createTrigger" onClick={onNew}>
            <Plus size={12} weight="bold" />
            New
          </Button>
          <Button size="sm" variant="outline" onClick={onOpenTemplates}>
            <BookOpen size={12} weight="regular" />
            Templates
          </Button>
        </div>
        <div className="relative mt-3">
          <MagnifyingGlass size={12} weight="bold" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-fg/50" />
          <input
            className={cn(inputCls, "pl-7")}
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search automations"
          />
        </div>
        {/* Provenance chips. A chip with nothing behind it goes inert instead
            of handing back a blank list with no explanation. Hidden entirely
            when there is nothing to filter, so a first-run project sees the
            templates and not three zeroes. */}
        {rules.length > 0 ? (
          <div className="mt-2 flex items-start gap-1" role="group" aria-label="Filter automations">
            <div className={FILTER_CHIP_GRID_CLASS}>
              {RULE_ORIGIN_FILTERS.map(({ key, label, hint }) => {
                const count = counts[key];
                const active = originFilter === key;
                const inert = count === 0 && !active;
                return (
                  <button
                    key={key}
                    type="button"
                    data-testid={`automations-filter-${key}`}
                    aria-pressed={active}
                    aria-label={`${label}, ${count}`}
                    title={inert ? `${hint} None right now.` : hint}
                    disabled={inert}
                    data-active={active ? "true" : undefined}
                    className={cn(FILTER_CHIP_CLASS, inert && "cursor-default opacity-40")}
                    style={{ color: active ? "var(--color-fg)" : "var(--color-muted-fg)" }}
                    onClick={() => setOriginFilter(key)}
                  >
                    {label}
                    <span className="ml-1 tabular-nums text-muted-fg/50">{count}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>

      <IngressStatusStrip ingressStatus={ingressStatus} />

      {/* The parent computes this from the UNFILTERED rules so search can't hide the recovery CTA. */}
      {configTrustRequired ? (
        <div className="shrink-0 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2.5 text-[11px] text-amber-100">
          <div className="font-semibold">Shared automations are paused</div>
          <div className="mt-0.5 leading-relaxed text-amber-100/80">
            <span className="font-mono">.ade/ade.yaml</span> changed outside this app. Review it, then trust it to let shared automations run.
          </div>
          <Button size="sm" variant="outline" className="mt-2 text-amber-100" onClick={onConfirmTrust}>
            Trust config
          </Button>
        </div>
      ) : null}
      {error ? (
        <div className="shrink-0 border-b border-red-500/20 bg-red-500/10 px-4 py-2.5 text-[11px] text-red-200">{error}</div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {rules.length === 0 ? (
          <AutomationsEmptyState onUseTemplate={onUseTemplate} onBrowseTemplates={onOpenTemplates} />
        ) : visibleRules.length === 0 ? (
          <AutomationsFilterEmptyState
            filterLabel={activeFilterLabel}
            onShowAll={() => setOriginFilter("all")}
          />
        ) : (
          <div className="space-y-2">
            {visibleRules.map((rule) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                delivery={delivery}
                selected={rule.id === selectedRuleId}
                onSelect={() => onSelect(rule.id)}
                onToggle={(enabled) => onToggle(rule.id, enabled)}
                onRunNow={() => onRunNow(rule)}
                onOpenHistory={() => onOpenHistory(rule.id)}
                onDelete={() => onDelete(rule.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
