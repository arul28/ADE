import { ArrowClockwise, BookOpen, MagnifyingGlass, Plus } from "@phosphor-icons/react";
import type { AutomationIngressStatus, AutomationRuleDraft, AutomationRuleSummary } from "../../../../shared/types";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { inputCls } from "../designTokens";
import { IngressStatusStrip } from "../settings/IngressStatusStrip";
import { AutomationsEmptyState } from "./AutomationsEmptyState";
import { RuleRow } from "./RuleRow";

export function RuleList({
  rules,
  selectedRuleId,
  search,
  loading,
  error,
  configTrustRequired,
  ingressStatus,
  webhookGatewayReady,
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
}: {
  rules: AutomationRuleSummary[];
  selectedRuleId: string | null;
  search: string;
  loading: boolean;
  error: string | null;
  configTrustRequired: boolean;
  ingressStatus: AutomationIngressStatus | null;
  webhookGatewayReady: boolean;
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
}) {
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
      </div>

      <IngressStatusStrip ingressStatus={ingressStatus} />

      {configTrustRequired ? (
        <div className="shrink-0 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2.5 text-[11px] text-amber-100">
          Shared project config is untrusted. Confirm trust before ADE runs shared automations.
        </div>
      ) : null}
      {error ? (
        <div className="shrink-0 border-b border-red-500/20 bg-red-500/10 px-4 py-2.5 text-[11px] text-red-200">{error}</div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {rules.length === 0 ? (
          <AutomationsEmptyState onUseTemplate={onUseTemplate} onBrowseTemplates={onOpenTemplates} />
        ) : (
          <div className="space-y-2">
            {rules.map((rule) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                webhookGatewayReady={webhookGatewayReady}
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
