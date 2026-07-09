import { ArrowRight } from "@phosphor-icons/react";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { cardCls } from "../designTokens";
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
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-accent/20 bg-accent/10 text-accent">
          <Icon size={16} weight="regular" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-fg">{template.name}</span>
            {template.isFlagship ? (
              <span className="shrink-0 text-[10px] font-medium text-accent">Flagship</span>
            ) : null}
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-muted-fg/75">{template.description}</p>
        </div>
      </div>

      <div className="text-[10.5px] text-muted-fg/60">
        You'll configure: {template.whatYouConfigure.join(" · ")}
      </div>

      <div className="mt-auto flex items-center justify-between">
        <span className="truncate font-mono text-[9.5px] text-muted-fg/50">{template.triggerType}</span>
        <Button size="sm" variant="outline" onClick={onUse} className="pointer-events-none">
          Use template
          <ArrowRight size={11} weight="bold" />
        </Button>
      </div>
    </button>
  );
}
