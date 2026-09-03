import React from "react";
import type { AutomationRuleDraft } from "../../../../shared/types";
import { usePluginAutomationTemplates } from "../../plugins/sockets/PluginAutomationTemplates";
import { PluginTemplateCard } from "./PluginTemplateCard";
import { TemplateCard } from "./TemplateCard";
import { TEMPLATE_GROUPS } from "./templateData";
import { useOfferedTemplateFilter } from "./useOfferedTemplates";

export function TemplateGallery({
  onUseTemplate,
}: {
  onUseTemplate: (draft: Omit<AutomationRuleDraft, "id">) => void;
}) {
  const offered = useOfferedTemplateFilter();
  /**
   * Plugin templates, in one group AFTER every group ADE ships.
   *
   * One group rather than a group per plugin: most plugins ship one or two
   * playbooks, and a column of single-card headings would turn the gallery into
   * a table of contents. Attribution is on the card instead, where the reader is
   * already looking. The group is absent when nothing survives normalization —
   * see `normalizePluginTemplateDraft`, which drops a body ADE cannot make a
   * rule out of rather than offering a card that seeds an empty one.
   */
  const pluginTemplates = usePluginAutomationTemplates();
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

        {pluginTemplates.length > 0 ? (
          <div>
            <div className="mb-3 mt-7 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-fg/60">
              From plugins
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {pluginTemplates.map((card) => (
                <PluginTemplateCard key={card.id} card={card} onUse={() => onUseTemplate(card.draft)} />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
