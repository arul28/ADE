import { memo } from "react";
import { cn } from "../../ui/cn";

export type ReasoningEffortControlProps = {
  effort: string | null;
  onChange: (effort: string | null) => void;
  tiers: readonly string[];
  disabled?: boolean;
  className?: string;
};

function tierLabel(tier: string): string {
  if (tier === "xhigh") return "Extra High";
  if (tier === "max") return "Max";
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

export const ReasoningEffortControl = memo(function ReasoningEffortControl({
  effort,
  onChange,
  tiers,
  disabled = false,
  className,
}: ReasoningEffortControlProps) {
  const hasTiers = tiers.length > 0;

  return (
    <div
      aria-hidden={!hasTiers}
      className={cn(
        "overflow-hidden transition-[opacity,max-height] duration-200 ease-out",
        hasTiers ? "max-h-16 opacity-100" : "pointer-events-none max-h-0 opacity-0",
        className,
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-t border-white/[0.06]">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-fg/55 shrink-0">
          Thinking
        </span>
        <div
          role="radiogroup"
          aria-label="Reasoning effort"
          className="ml-auto inline-flex items-center rounded-md border border-white/[0.06] bg-white/[0.03] p-0.5"
        >
          {tiers.map((tier) => {
            const isActive = effort === tier;
            return (
              <button
                key={tier}
                type="button"
                role="radio"
                aria-checked={isActive}
                disabled={disabled}
                onClick={() => onChange(isActive ? null : tier)}
                className={cn(
                  "h-6 min-w-[2.25rem] rounded-[5px] px-2 font-sans text-[10px] font-medium leading-none",
                  "transition-colors duration-150",
                  isActive
                    ? "bg-violet-500/15 text-fg shadow-[inset_0_0_0_1px_rgba(167,139,250,0.30)]"
                    : "text-muted-fg/70 hover:text-fg/85 hover:bg-white/[0.04]",
                  disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
                )}
              >
                {tierLabel(tier)}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
});
