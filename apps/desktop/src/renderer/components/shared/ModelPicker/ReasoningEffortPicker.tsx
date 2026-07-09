import { forwardRef, memo, useCallback, useEffect, useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { CaretDown, Question } from "@phosphor-icons/react";
import type { ModelDescriptor } from "../../../../shared/modelRegistry";
import { cn } from "../../ui/cn";
import { resolveModelDescriptorWithRuntimeCatalog } from "./modelCatalog";
import { useReasoningByFamily } from "./useReasoningByFamily";

export type ReasoningEffortPickerProps = {
  modelId: string;
  reasoningEffort: string | null;
  onChange: (effort: string | null) => void;
  /** When false, each picker uses only its explicit value (no shared per-family defaults). */
  useFamilyDefaults?: boolean;
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
  if (lower === "ultracode") return "ULTRA";
  return lower.slice(0, 3).toUpperCase();
}

function tierLabel(tier: string): string {
  if (tier === "xhigh") return "Extra High";
  if (tier === "max") return "Max";
  if (tier === "ultracode") return "Ultracode";
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

const reasoningSliderStyleId = "ade-reasoning-slider-effects";

function ensureReasoningSliderStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(reasoningSliderStyleId)) return;
  const sheet = document.createElement("style");
  sheet.id = reasoningSliderStyleId;
  sheet.textContent = `
    @keyframes ade-reasoning-effort-word-pop {
      0% { opacity: 0; transform: translateY(3px); filter: blur(3px); }
      100% { opacity: 1; transform: translateY(0); filter: blur(0); }
    }
    @keyframes ade-reasoning-fill-sheen {
      0% { transform: translateX(-80%); opacity: 0; }
      35% { opacity: 0.55; }
      100% { transform: translateX(80%); opacity: 0; }
    }
    @keyframes ade-reasoning-grid-drift {
      0% { background-position: 0 0, 0 0; }
      100% { background-position: -18px 0, 0 0; }
    }
    .ade-reasoning-effort-word {
      animation: ade-reasoning-effort-word-pop 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    .ade-reasoning-slider-fill {
      background: linear-gradient(90deg, rgba(var(--reasoning-fill-rgb), 0.38), rgba(var(--reasoning-fill-rgb), 0.82));
      box-shadow: 0 0 18px rgba(var(--reasoning-fill-rgb), 0.24);
      transition: width 220ms cubic-bezier(0.2, 0.8, 0.2, 1), background 220ms ease, box-shadow 220ms ease;
    }
    .ade-reasoning-slider-fill::after {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: linear-gradient(100deg, transparent 20%, rgba(255,255,255,0.22) 50%, transparent 78%);
      animation: ade-reasoning-fill-sheen 1.8s ease-in-out infinite;
    }
    .ade-reasoning-slider-fill-max {
      background:
        radial-gradient(circle at center, rgba(255,255,255,0.20) 0 0.8px, transparent 1px),
        linear-gradient(90deg, rgba(124,58,237,0.34), rgba(216,180,254,0.86));
      background-size: 4px 4px, 100% 100%;
      animation: ade-reasoning-grid-drift 1.15s linear infinite;
      box-shadow: 0 0 24px rgba(167,139,250,0.34);
    }
    @media (prefers-reduced-motion: reduce) {
      .ade-reasoning-effort-word,
      .ade-reasoning-slider-fill::after,
      .ade-reasoning-slider-fill-max {
        animation: none;
      }
      .ade-reasoning-slider-fill {
        transition: none;
      }
    }
  `;
  document.head.appendChild(sheet);
}

type ReasoningToneKey = "auto" | "low" | "steady" | "smart" | "deep" | "max";

const REASONING_TONE_STYLES: Record<
  ReasoningToneKey,
  {
    color: string;
    rgb: string;
    trigger: string;
    chip: string;
    thumb: string;
    ridge: string;
  }
> = {
  auto: {
    color: "#A1A1AA",
    rgb: "161 161 170",
    trigger: "border-white/[0.06] bg-white/[0.03] text-fg/80 hover:border-white/[0.10] hover:bg-white/[0.055]",
    chip: "border-white/[0.08] bg-white/[0.055] text-muted-fg/78",
    thumb: "border-zinc-200/70 bg-zinc-200 text-zinc-950",
    ridge: "bg-white/20",
  },
  low: {
    color: "#6EE7B7",
    rgb: "52 211 153",
    trigger: "border-emerald-300/22 bg-emerald-500/[0.075] text-emerald-100 hover:border-emerald-300/32 hover:bg-emerald-500/[0.11]",
    chip: "border-emerald-300/26 bg-emerald-500/[0.14] text-emerald-100",
    thumb: "border-emerald-50 bg-emerald-200 text-emerald-950",
    ridge: "bg-emerald-200",
  },
  steady: {
    color: "#67E8F9",
    rgb: "34 211 238",
    trigger: "border-cyan-300/22 bg-cyan-500/[0.075] text-cyan-100 hover:border-cyan-300/32 hover:bg-cyan-500/[0.11]",
    chip: "border-cyan-300/26 bg-cyan-500/[0.14] text-cyan-100",
    thumb: "border-cyan-50 bg-cyan-200 text-cyan-950",
    ridge: "bg-cyan-200",
  },
  smart: {
    color: "#93C5FD",
    rgb: "96 165 250",
    trigger: "border-sky-300/22 bg-sky-500/[0.075] text-sky-100 hover:border-sky-300/32 hover:bg-sky-500/[0.11]",
    chip: "border-sky-300/26 bg-sky-500/[0.14] text-sky-100",
    thumb: "border-sky-50 bg-sky-200 text-sky-950",
    ridge: "bg-sky-200",
  },
  deep: {
    color: "#C4B5FD",
    rgb: "167 139 250",
    trigger: "border-violet-300/24 bg-violet-500/[0.08] text-violet-100 hover:border-violet-300/34 hover:bg-violet-500/[0.12]",
    chip: "border-violet-300/28 bg-violet-500/[0.15] text-violet-100",
    thumb: "border-violet-50 bg-violet-200 text-violet-950",
    ridge: "bg-violet-200",
  },
  max: {
    color: "#D8B4FE",
    rgb: "192 132 252",
    trigger: "border-fuchsia-300/28 bg-fuchsia-500/[0.09] text-fuchsia-100 hover:border-fuchsia-300/38 hover:bg-fuchsia-500/[0.13]",
    chip: "border-fuchsia-300/30 bg-fuchsia-500/[0.17] text-fuchsia-100",
    thumb: "border-fuchsia-50 bg-fuchsia-100 text-fuchsia-950",
    ridge: "bg-fuchsia-100",
  },
};

function reasoningToneKeyForIndex(index: number, total: number): ReasoningToneKey {
  if (index < 0) return "auto";
  if (total <= 1) return "max";
  const ratio = index / (total - 1);
  if (ratio <= 0.12) return "low";
  if (ratio <= 0.38) return "steady";
  if (ratio <= 0.62) return "smart";
  if (ratio < 1) return "deep";
  return "max";
}

function tierPercent(index: number, total: number): number {
  if (total <= 1) return 50;
  return (index / (total - 1)) * 100;
}

export const ReasoningEffortPicker = memo(function ReasoningEffortPicker({
  modelId,
  reasoningEffort,
  onChange,
  useFamilyDefaults = true,
  compact = false,
  disabled = false,
  className,
  triggerClassName,
}: ReasoningEffortPickerProps) {
  const [open, setOpen] = useState(false);
  const { rememberReasoning, getReasoningForFamily } = useReasoningByFamily();
  useEffect(() => {
    ensureReasoningSliderStyles();
  }, []);

  const descriptor = useMemo<ModelDescriptor | undefined>(
    () => resolveModelDescriptorWithRuntimeCatalog(modelId),
    [modelId],
  );

  const tiers = descriptor?.reasoningTiers ?? [];
  const family = descriptor?.family;

  const displayedEffort = useMemo<string | null>(() => {
    if (reasoningEffort) return reasoningEffort;
    if (useFamilyDefaults && family) return getReasoningForFamily(family);
    return null;
  }, [reasoningEffort, family, getReasoningForFamily, useFamilyDefaults]);

  const activeIndex = displayedEffort ? tiers.findIndex((tier) => tier === displayedEffort) : -1;
  const activeTone = REASONING_TONE_STYLES[reasoningToneKeyForIndex(activeIndex, tiers.length)];
  const activeLabel = activeIndex >= 0 ? tierLabel(tiers[activeIndex]!) : "Auto";
  const fillPercent = activeIndex < 0 ? 0 : tiers.length <= 1 ? 100 : tierPercent(activeIndex, tiers.length);
  const thumbPercent = activeIndex < 0 ? 0 : tierPercent(activeIndex, tiers.length);
  const thumbLeft = activeIndex < 0 || tiers.length <= 1
    ? activeIndex < 0 ? "8px" : "50%"
    : `calc(${thumbPercent}% + ${8 - (thumbPercent / 100) * 16}px)`;

  const commitEffort = useCallback(
    (tier: string | null) => {
      const next = tier;
      if (useFamilyDefaults && family) rememberReasoning(family, next);
      onChange(next);
    },
    [family, onChange, rememberReasoning, useFamilyDefaults],
  );

  const handleSelect = useCallback(
    (tier: string) => {
      commitEffort(displayedEffort === tier ? null : tier);
      setOpen(false);
    },
    [commitEffort, displayedEffort],
  );

  const handleTrackPointer = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (disabled || tiers.length === 0) return;
      const target = event.target as Element | null;
      if (target?.closest?.("[data-reasoning-slider-ridge-button]")) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
      const clamped = Math.max(0, Math.min(1, ratio));
      const nextIndex = tiers.length <= 1 ? 0 : Math.round(clamped * (tiers.length - 1));
      commitEffort(tiers[nextIndex] ?? null);
    },
    [commitEffort, disabled, tiers],
  );

  const handleSliderKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (disabled || tiers.length === 0) return;
      let nextIndex: number | null = null;
      if (event.key === "ArrowRight" || event.key === "ArrowUp") {
        nextIndex = Math.min(tiers.length - 1, activeIndex < 0 ? 0 : activeIndex + 1);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
        nextIndex = Math.max(0, activeIndex < 0 ? 0 : activeIndex - 1);
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = tiers.length - 1;
      }
      if (nextIndex == null) return;
      event.preventDefault();
      commitEffort(tiers[nextIndex] ?? null);
    },
    [activeIndex, commitEffort, disabled, tiers],
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
          tone={activeTone}
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
              "flex w-[232px] flex-col overflow-hidden rounded-xl border border-white/[0.08]",
              "bg-[#17151A]/96 p-3 shadow-[0_18px_48px_rgba(0,0,0,0.58)] backdrop-blur-md",
            )}
            role="radiogroup"
            aria-label="Reasoning effort"
            style={{
              "--reasoning-fill-rgb": activeTone.rgb,
            } as React.CSSProperties}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 font-sans text-[12px] leading-none text-muted-fg/72">
                <span>Effort </span>
                <span
                  key={displayedEffort ?? "auto"}
                  className="ade-reasoning-effort-word font-semibold"
                  style={{ color: activeTone.color }}
                >
                  {activeLabel}
                </span>
              </div>
              <Question size={13} weight="bold" className="shrink-0 text-muted-fg/45" aria-hidden />
            </div>
            <div className="mt-4 flex items-center justify-between font-sans text-[11px] leading-none text-muted-fg/62">
              <span>Faster</span>
              <span>Smarter</span>
            </div>
            <div
              className="relative mt-3 h-[18px] cursor-pointer rounded-md bg-[#242327] p-[3px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.045),inset_0_1px_3px_rgba(0,0,0,0.45)]"
              onPointerDown={handleTrackPointer}
              role="presentation"
            >
              <div className="relative h-full overflow-hidden rounded-[5px] bg-black/18">
                <div
                  className={cn(
                    "ade-reasoning-slider-fill absolute inset-y-0 left-0 overflow-hidden rounded-[5px]",
                    activeIndex === tiers.length - 1 && activeIndex >= 0 && "ade-reasoning-slider-fill-max",
                  )}
                  style={{ width: `${fillPercent}%` }}
                  aria-hidden
                />
                {tiers.map((tier, index) => {
                  const percent = tierPercent(index, tiers.length);
                  const isActive = displayedEffort === tier;
                  const tone = REASONING_TONE_STYLES[reasoningToneKeyForIndex(index, tiers.length)];
                  return (
                    <button
                      key={tier}
                      type="button"
                      role="radio"
                      aria-checked={isActive}
                      aria-label={tierLabel(tier)}
                      data-reasoning-slider-ridge-button
                      onClick={(event) => {
                        event.stopPropagation();
                        handleSelect(tier);
                      }}
                      onKeyDown={handleSliderKeyDown}
                      className="absolute top-1/2 flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                      style={{ left: `${percent}%` }}
                    >
                      <span className="sr-only">{tierLabel(tier)}</span>
                      <span
                        className={cn(
                          "h-1 w-1 rounded-full transition-all duration-200",
                          isActive ? cn("h-1.5 w-1.5", tone.ridge, "shadow-[0_0_10px_currentColor]") : "bg-white/20",
                        )}
                        aria-hidden
                      />
                    </button>
                  );
                })}
                <div
                  className={cn(
                    "pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-md border shadow-[0_3px_10px_rgba(0,0,0,0.32)] transition-[left,background-color,border-color,box-shadow] duration-200",
                    activeTone.thumb,
                    activeIndex < 0 && "opacity-60",
                  )}
                  style={{ left: thumbLeft }}
                  aria-hidden
                />
              </div>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
});

type TriggerProps = {
  label: string;
  tone: (typeof REASONING_TONE_STYLES)[ReasoningToneKey];
  compact: boolean;
  disabled: boolean;
  open: boolean;
  className?: string;
};

const ReasoningEffortTrigger = memo(
  forwardRef<HTMLButtonElement, TriggerProps & React.ButtonHTMLAttributes<HTMLButtonElement>>(
    function ReasoningEffortTrigger(
      { label, tone, compact, disabled, open, className, ...rest },
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
              ? "h-6 px-1 text-[9px]"
              : "h-8 px-2 text-[11px] sm:text-[12px]",
            tone.trigger,
            open && "ring-1 ring-white/[0.06]",
            disabled && "cursor-not-allowed opacity-60 hover:border-white/[0.06] hover:bg-white/[0.03]",
            className,
          )}
        >
          <span
            data-reasoning-chip="true"
            className={cn(
              "shrink-0 rounded border px-1 font-semibold uppercase leading-none tracking-wide",
              tone.chip,
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
