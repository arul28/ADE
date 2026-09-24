import { ArrowLeft } from "@phosphor-icons/react";
import type { AutomationRuleDraft } from "../../../../shared/types";
import { TemplateCard } from "./TemplateCard";
import { TEMPLATE_GROUPS } from "./templateData";

export function TemplateGallery({
  onUseTemplate,
  onBack,
}: {
  onUseTemplate: (draft: Omit<AutomationRuleDraft, "id">) => void;
  /** A quiet link above the title, back to where you were in Automations. */
  onBack?: () => void;
}) {
  return (
    <div className="h-full overflow-y-auto bg-bg px-6 py-6 text-fg">
      <div className="mx-auto max-w-6xl">
        {onBack ? (
          <button
            type="button"
            className="-ml-1 mb-3 inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[12px] font-medium text-muted-fg/70 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
            onClick={onBack}
          >
            <ArrowLeft size={12} />
            Back to automations
          </button>
        ) : null}
        <div className="max-w-2xl">
          <div className="text-[15px] font-semibold text-fg">Start from a template</div>
          <div className="mt-1 text-[13px] leading-relaxed text-muted-fg/75">
            Each template seeds a working rule you can tune. Pick one, then edit the trigger, prompt, and lane once it's in your list.
          </div>
        </div>

        {TEMPLATE_GROUPS.map((group) => (
          <div key={group.title}>
            <div className="mb-3 mt-7 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-fg/60">
              {group.title}
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {group.templates.map((template) => (
                <TemplateCard key={template.id} template={template} onUse={() => onUseTemplate(template.draft)} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
