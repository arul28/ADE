import { forwardRef, memo, useCallback, useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { CaretDown } from "@phosphor-icons/react";
import { resolveModelDescriptor, type ModelDescriptor } from "../../../../shared/modelRegistry";
import { cn } from "../../ui/cn";
import { useReasoningByFamily } from "./useReasoningByFamily";

export type ReasoningEffortPickerProps = {
  modelId: string;
  reasoningEffort: string | null;
  onChange: (effort: string | null) => void;
  compact?: boolean;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
};

export function reasoningChipLabel(effort: string | null | undefined): string | null {
  if (!effort) return null;
  const lower = effort.trim().toLowerCase();
  if (!lower) return null;
  if (lower === "minimal") return "MIN";
  if (lower === "low") return "LOW";
  if (lower === "medium") return "MED";
  if (lower === "high") return "HI";
  if (lower === "xhigh") return "XH";
  if (lower === "max") return "MAX";
  return lower.slice(0, 3).toUpperCase();
}

function tierLabel(tier: string): string {
  if (tier === "xhigh") return "Extra High";
  if (tier === "max") return "Max";
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

export const ReasoningEffortPicker = memo(function ReasoningEffortPicker({
  modelId,
  reasoningEffort,
  onChange,
  compact = false,
  disabled = false,
  className,
  triggerClassName,
}: ReasoningEffortPickerProps) {
  const [open, setOpen] = useState(false);
  const { rememberReasoning, getReasoningForFamily } = useReasoningByFamily();

  const descriptor = useMemo<ModelDescriptor | undefined>(
    () => (modelId ? resolveModelDescriptor(modelId) : undefined),
    [modelId],
  );

  const tiers = descriptor?.reasoningTiers ?? [];
  const family = descriptor?.family;

  const displayedEffort = useMemo<string | null>(() => {
    if (reasoningEffort) return reasoningEffort;
    if (family) return getReasoningForFamily(family);
    return null;
  }, [reasoningEffort, family, getReasoningForFamily]);

  const handleSelect = useCallback(
    (tier: string) => {
      const next = displayedEffort === tier ? null : tier;
      if (family) rememberReasoning(family, next);
      onChange(next);
      setOpen(false);
    },
    [displayedEffort, family, onChange, rememberReasoning],
  );

  if (tiers.length === 0) return null;

  const label = reasoningChipLabel(displayedEffort) ?? "AUTO";

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (disabled) {
          setOpen(false);
          return;
        }
        setOpen(next);
      }}
    >
      <Popover.Trigger asChild>
        <ReasoningEffortTrigger
          label={label}
          compact={compact}
          disabled={disabled}
          open={open}
          className={cn(triggerClassName, className)}
        />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          avoidCollisions
          className="z-[100] outline-none"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
          }}
        >
          <div
            data-reasoning-effort-picker-content="true"
            className={cn(
              "flex min-w-[140px] flex-col overflow-hidden rounded-lg border border-white/[0.08]",
              "bg-[#13111A]/95 p-1 shadow-[0_18px_48px_rgba(0,0,0,0.55)] backdrop-blur-md",
            )}
            role="radiogroup"
            aria-label="Reasoning effort"
          >
            <div className="px-2 py-1 text-[9px] font-semibold uppercase tracking-wide text-muted-fg/55">
              Thinking
            </div>
            {tiers.map((tier) => {
              const isActive = displayedEffort === tier;
              return (
                <button
                  key={tier}
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  onClick={() => handleSelect(tier)}
                  className={cn(
                    "flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left font-sans text-[11px] font-medium leading-none",
                    "transition-colors duration-150",
                    isActive
                      ? "bg-violet-500/15 text-fg shadow-[inset_0_0_0_1px_rgba(167,139,250,0.30)]"
                      : "text-muted-fg/75 hover:bg-white/[0.04] hover:text-fg/90",
                  )}
                >
                  <span>{tierLabel(tier)}</span>
                  <span
                    className={cn(
                      "rounded border px-1 py-[1px] text-[8px] font-semibold uppercase tracking-wide leading-none",
                      isActive
                        ? "border-violet-400/40 bg-violet-500/[0.18] text-violet-100"
                        : "border-white/[0.08] bg-white/[0.03] text-muted-fg/60",
                    )}
                  >
                    {reasoningChipLabel(tier)}
                  </span>
                </button>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
});

type TriggerProps = {
  label: string;
  compact: boolean;
  disabled: boolean;
  open: boolean;
  className?: string;
};

const ReasoningEffortTrigger = memo(
  forwardRef<HTMLButtonElement, TriggerProps & React.ButtonHTMLAttributes<HTMLButtonElement>>(
    function ReasoningEffortTrigger(
      { label, compact, disabled, open, className, ...rest },
      ref,
    ) {
      return (
        <button
          {...rest}
          ref={ref}
          type="button"
          data-state={open ? "open" : "closed"}
          data-reasoning-effort-picker-trigger="true"
          disabled={disabled}
          aria-label="Reasoning effort"
          title="Reasoning effort"
          aria-haspopup="dialog"
          aria-expanded={open}
          className={cn(
            "inline-flex min-w-0 items-center gap-1 rounded-md border font-sans transition-colors duration-150",
            compact
              ? "h-7 px-1.5 text-[10px]"
              : "h-8 px-2 text-[11px] sm:text-[12px]",
            "border-white/[0.06] bg-white/[0.03] text-fg/80",
            "hover:border-violet-400/20 hover:bg-violet-500/[0.06] hover:text-fg",
            open && "border-violet-400/30 bg-violet-500/[0.08] text-fg",
            disabled && "cursor-not-allowed opacity-60 hover:border-white/[0.06] hover:bg-white/[0.03]",
            className,
          )}
        >
          <span
            data-reasoning-chip="true"
            className={cn(
              "shrink-0 rounded border border-violet-400/25 bg-violet-500/[0.12] px-1 font-semibold uppercase leading-none tracking-wide text-violet-100/90",
              compact ? "py-[1px] text-[8px]" : "py-[2px] text-[9px]",
            )}
          >
            {label}
          </span>
          <CaretDown
            size={compact ? 9 : 10}
            weight="bold"
            className={cn(
              "shrink-0 text-muted-fg/60 transition-transform duration-150",
              open && "rotate-180 text-fg/80",
            )}
          />
        </button>
      );
    },
  ),
);
