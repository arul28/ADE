import React from "react";
import type { AutomationRuleDraft } from "../../../../shared/types";
import { TemplateCard } from "./TemplateCard";
import { TEMPLATE_GROUPS } from "./templateData";
import { useOfferedTemplateFilter } from "./useOfferedTemplates";

export function TemplateGallery({
  onUseTemplate,
}: {
  onUseTemplate: (draft: Omit<AutomationRuleDraft, "id">) => void;
}) {
  const offered = useOfferedTemplateFilter();
  // A group whose every template was withheld drops out too, the same way
  // `templateData` already drops a group nothing is filed under. An empty
  // heading over an empty grid would read as a load failure.
  const groups = React.useMemo(
    () => TEMPLATE_GROUPS
      .map((group) => ({ ...group, templates: group.templates.filter(offered) }))
      .filter((group) => group.templates.length > 0),
    [offered],
  );

  return (
    <div className="h-full overflow-y-auto bg-bg px-6 py-6 text-fg">
      <div className="mx-auto max-w-6xl">
        <div className="max-w-2xl">
          <div className="text-[15px] font-semibold text-fg">Start from a template</div>
          <div className="mt-1 text-[13px] leading-relaxed text-muted-fg/75">
            Each template seeds a working rule you can tune. Pick one, then edit the trigger, prompt, and lane once it's in your list.
          </div>
        </div>

        {groups.map((group) => (
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
