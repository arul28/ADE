import { Chip } from "../../ui/Chip";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";

export type AutomationTemplate = {
  id: string;
  name: string;
  description: string;
  triggerType: string;
  actionSummary: string;
  icon: React.ElementType;
};

export function TemplateCard({
  template,
  onUse,
  className,
}: {
  template: AutomationTemplate;
  onUse: () => void;
  className?: string;
}) {
  const Icon = template.icon;
  return (
    <div
      className={cn(
        "group p-4 flex flex-col gap-3 transition-all duration-150 hover:-translate-y-[1px]",
        className,
      )}
      style={{
        background: "#181423",
        border: "1px solid #2D2840",
        boxShadow: "0 1px 6px -1px rgba(0,0,0,0.6), 0 0 0 1px rgba(45,40,64,0.3)",
      }}
    >
      <div className="flex items-start gap-3">
        <div
          className="shrink-0 flex items-center justify-center w-8 h-8"
          style={{ background: "rgba(167,139,250,0.10)", border: "1px solid rgba(167,139,250,0.20)" }}
        >
          <Icon size={16} weight="regular" className="text-[#A78BFA]" />
        </div>
        <div className="min-w-0 flex-1">
          <div
            className="text-[12px] font-bold tracking-[-0.2px] text-[#FAFAFA]"
            style={{ fontFamily: "'Space Grotesk', sans-serif" }}
          >
            {template.name}
          </div>
          <div className="mt-1 font-mono text-[10px] text-[#8B8B9A] leading-relaxed">
            {template.description}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Chip className="text-[8px]">{template.triggerType}</Chip>
        <span className="font-mono text-[9px] text-[#71717A] truncate">{template.actionSummary}</span>
      </div>

      <Button
        size="sm"
        variant="outline"
        onClick={onUse}
        className="self-end opacity-0 group-hover:opacity-100 transition-opacity duration-150"
      >
        Use Template
      </Button>
    </div>
  );
}
