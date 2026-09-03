import { ArrowRight } from "@phosphor-icons/react";

import { pluginIcon } from "../../plugins/pluginIcons";
import { usePluginBrandIcons } from "../../plugins/sockets/usePluginBrandIcons";
import type { PluginAutomationTemplateCard } from "../../plugins/sockets/PluginAutomationTemplates";
import { cn } from "../../ui/cn";
import { cardCls } from "../designTokens";
import { accentTint, sourceAccent } from "../triggerCatalog";
import { SourceIconBadge } from "./TemplateSourceChip";

/**
 * One plugin-declared template, drawn as the gallery's own card.
 *
 * Same shell as {@link TemplateCard} on purpose — a plugin playbook is a
 * playbook, and a differently shaped card would read as a lesser offer. What
 * differs is the two things that must differ: the mark is the PLUGIN'S (a
 * `brand:*` token it shipped resolves only from its own artwork, which is why
 * the glyph rows are looked up here rather than left to the compiled catalogue),
 * and the chip names the plugin instead of a compiled source, because
 * `TemplateSourceChip` would print "Plugins · Plugin event" for every one of
 * them and tell the reader nothing.
 *
 * There is no "what you'll configure" line. That list is authored per template
 * in `templateData`, and inventing one from a plugin's opaque body would be ADE
 * putting words in the plugin's mouth.
 */
export function PluginTemplateCard({
  card,
  onUse,
}: {
  card: PluginAutomationTemplateCard;
  onUse: () => void;
}) {
  const brandIcons = usePluginBrandIcons();
  const Icon = pluginIcon(card.icon, brandIcons(card.pluginId));
  const trigger = card.draft.trigger.pluginTrigger ?? "";
  // The plugin's own accent when it declared one, otherwise the catalog's
  // Plugins accent — the same colour the generic tile in the trigger grid wears,
  // so a template and the trigger it seeds look like the same feature.
  const accent = card.accent ?? sourceAccent("plugin");

  return (
    <button
      type="button"
      onClick={onUse}
      className={cn(
        cardCls,
        "group flex flex-col gap-3 text-left transition-colors hover:border-accent/30 hover:bg-white/[0.05]",
      )}
    >
      <div className="flex items-start gap-3">
        <SourceIconBadge source="plugin" size={32} icon={Icon} />
        <div className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-fg">{card.name}</span>
          {card.description ? (
            <p className="mt-1 text-[11.5px] leading-relaxed text-muted-fg/75">{card.description}</p>
          ) : null}
        </div>
      </div>

      <div className="mt-auto flex items-center justify-between gap-2">
        <span
          className="inline-flex min-w-0 items-center gap-1 truncate text-[10.5px]"
          style={{ color: accent }}
          title={`${card.pluginId} · ${trigger}`}
        >
          <Icon size={11} weight="regular" className="shrink-0" />
          <span className="truncate">{trigger ? `${card.pluginName} · ${trigger}` : card.pluginName}</span>
        </span>
        {/* Decorative affordance: the whole card is the button; a nested
            <button> would be invalid HTML. */}
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[10.5px] font-medium text-fg/85 transition-colors group-hover:border-accent/40 group-hover:text-accent"
          style={{ borderColor: accentTint("plugin", 0.25) }}
        >
          Use template
          <ArrowRight size={11} weight="bold" />
        </span>
      </div>
    </button>
  );
}
