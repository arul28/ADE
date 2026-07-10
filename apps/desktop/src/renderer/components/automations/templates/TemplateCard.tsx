import { ArrowRight } from "@phosphor-icons/react";
import { cn } from "../../ui/cn";
import { cardCls } from "../designTokens";
import { accentTint, eventLabel, sourceAccent, sourceDef, sourceForTriggerType } from "../triggerCatalog";
import type { AutomationTemplate } from "./templateData";
import { templateIconFor } from "./templateIcons";

export function TemplateCard({
  template,
  onUse,
  className,
}: {
  template: AutomationTemplate;
  onUse: () => void;
  className?: string;
}) {
  const Icon = templateIconFor(template.id);
  const source = sourceForTriggerType(template.triggerType);
  const sourceDefinition = sourceDef(source);
  const SourceIcon = sourceDefinition.icon;
  return (
    <button
      type="button"
      onClick={onUse}
      className={cn(
        cardCls,
        "group flex flex-col gap-3 text-left transition-colors hover:border-accent/30 hover:bg-white/[0.05]",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border"
          style={{
            borderColor: accentTint(source, 0.25),
            background: accentTint(source, 0.12),
            color: sourceAccent(source),
          }}
        >
          <Icon size={16} weight="regular" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-fg">{template.name}</span>
            {template.isFlagship ? (
              <span className="shrink-0 text-[10px] font-medium" style={{ color: "#E8B45A" }}>Flagship</span>
            ) : null}
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-muted-fg/75">{template.description}</p>
        </div>
      </div>

      <div className="text-[10.5px] text-muted-fg/60">
        You'll configure: {template.whatYouConfigure.join(" · ")}
      </div>

      <div className="mt-auto flex items-center justify-between">
        <span
          className="inline-flex min-w-0 items-center gap-1 truncate text-[10.5px]"
          style={{ color: accentTint(source, 0.85) }}
          title={template.triggerType}
        >
          <SourceIcon size={11} weight="fill" className="shrink-0" />
          <span className="truncate">{sourceDefinition.label} · {eventLabel(template.triggerType)}</span>
        </span>
        {/* Decorative affordance: the whole card is the button; a nested
            <button> would be invalid HTML. */}
        <span className="inline-flex items-center gap-1 rounded-md border border-white/[0.12] px-2 py-1 text-[10.5px] font-medium text-fg/85 transition-colors group-hover:border-accent/40 group-hover:text-accent">
          Use template
          <ArrowRight size={11} weight="bold" />
        </span>
      </div>
    </button>
  );
}
