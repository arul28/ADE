import { Funnel } from "@phosphor-icons/react";
import type { AutomationRuleDraft } from "../../../../shared/types";
import { cn } from "../../ui/cn";
import { cardCls } from "../designTokens";
import { FLAGSHIP_TEMPLATES } from "../templates/templateData";
import { templateIconFor } from "../templates/templateIcons";
import { SourceIconBadge, TemplateSourceChip } from "../templates/TemplateSourceChip";
import { sourceForTriggerType } from "../triggerCatalog";

export function AutomationsEmptyState({
  onUseTemplate,
  onBrowseTemplates,
}: {
  onUseTemplate: (draft: Omit<AutomationRuleDraft, "id">) => void;
  onBrowseTemplates: () => void;
}) {
  const flagships = FLAGSHIP_TEMPLATES.slice(0, 3);
  return (
    <div className="px-1 py-2">
      <div className="text-[13px] font-semibold text-fg">No automations yet</div>
      <div className="mt-1 text-[11.5px] leading-relaxed text-muted-fg/70">
        Start from a flagship playbook, or build your own from scratch.
      </div>

      <div className="mt-3 space-y-2">
        {flagships.map((template) => {
          const Icon = templateIconFor(template.id);
          const source = sourceForTriggerType(template.triggerType);
          return (
            <button
              key={template.id}
              type="button"
              onClick={() => onUseTemplate(template.draft)}
              className={cn(cardCls, "flex w-full items-start gap-2.5 p-3 text-left transition-colors hover:border-accent/30 hover:bg-white/[0.05]")}
            >
              <SourceIconBadge source={source} size={28} icon={Icon} />
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] font-semibold text-fg">{template.name}</span>
                <span className="mt-0.5 block text-[10.5px] leading-snug text-muted-fg/70">{template.description}</span>
                <TemplateSourceChip
                  triggerType={template.triggerType}
                  className="mt-1 inline-flex max-w-full items-center gap-1 text-[10.5px]"
                />
              </span>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onBrowseTemplates}
        className="mt-2 text-[11px] font-medium text-accent hover:underline"
      >
        Browse all templates →
      </button>
    </div>
  );
}

/**
 * What the list shows when a provenance chip is on and matches nothing. It
 * names the filter that is hiding things — an empty list with no explanation
 * reads as "my automations are gone" — and offers the way back.
 */
export function AutomationsFilterEmptyState({
  filterLabel,
  onShowAll,
}: {
  filterLabel: string;
  onShowAll: () => void;
}) {
  return (
    <div
      data-testid="automations-filter-empty"
      className="flex flex-col items-center justify-center px-3 py-10 text-center"
    >
      <Funnel size={16} weight="regular" className="mb-2 text-muted-fg/25" />
      <div className="text-[11px] font-medium text-fg/70">No automations match</div>
      <div className="mt-1 max-w-[190px] text-[10px] leading-relaxed text-muted-fg/45">
        The {filterLabel} filter is hiding the rest.
      </div>
      <button
        type="button"
        className="mt-2.5 rounded-md px-2 py-1 text-[10px] font-medium text-muted-fg/70 transition-colors hover:bg-white/[0.06] hover:text-fg"
        onClick={onShowAll}
      >
        Show all
      </button>
    </div>
  );
}
