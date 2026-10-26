import { forwardRef, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { CaretDown, Check } from "@phosphor-icons/react";
import { usesCodexNamedEffortLabels, type ModelDescriptor } from "../../../../shared/modelRegistry";
import { cn } from "../../ui/cn";
import { toneText } from "../../lanes/laneDesignTokens";
import { usePortalContainer } from "../../ui/portalContainer";
import { Z_LAYERS } from "../../ui/zLayers";
import { resolveModelDescriptorWithRuntimeCatalog } from "./modelCatalog";
import { capitalizeWord } from "./modelFacts";
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
  /**
   * Binding key of the machine whose runtime catalog describes `modelId`.
   * Thinking levels come from that catalog's `reasoningEfforts`, so a composer
   * targeting another machine must read the tiers that machine reported, not
   * the bound machine's. Omitted means the bound machine.
   */
  catalogScopeKey?: string;
  /**
   * Bumped by the owner when that catalog arrives. The picker is memoized and
   * resolves its model once, so without this a model the catalog alone
   * describes (a Copilot SDK model) kept the static row's empty levels.
   */
  catalogRevision?: number;
  /**
   * Claude's per-message "ultrathink" switch, shown under the levels. It is
   * separate from the level because Claude Code reads it as a one-turn nudge
   * that stacks on any level. Omitted for providers that do not read it.
   */
  ultrathink?: { active: boolean; onChange: (active: boolean) => void } | null;
  /**
   * Codex Daybreak (broader access for authorized cybersecurity work), shown
   * under the levels only for a model the signed-in account may use it on.
   * It is a chat setting, not a level, so it stacks on any effort.
   */
  daybreak?: { active: boolean; onChange: (active: boolean) => void } | null;
  copilotAutoTier?: "efficiency" | "balance" | "intelligence" | null;
  onCopilotAutoTierChange?: (tier: "efficiency" | "balance" | "intelligence") => void;
  copilotAutoTierPending?: boolean;
  /**
   * Space is tight (a hint chip sits beside the picker): below a wide
   * composer the trigger shows only its bars and caret, no level name.
   */
  squeezed?: boolean;
};

export function reasoningChipLabel(
  effort: string | null | undefined,
  useCodex56Labels = false,
): string | null {
  if (!effort) return null;
  const lower = effort.trim().toLowerCase();
  if (!lower) return null;
  if (lower === "minimal") return "MIN";
  if (lower === "low") return useCodex56Labels ? "LIGHT" : "LOW";
  if (lower === "medium") return "MED";
  if (lower === "high") return "HI";
  if (lower === "xhigh") return "XH";
  if (lower === "max") return "MAX";
  if (lower === "ultra") return "ULTRA";
  if (lower === "ultracode") return "ULTRA";
  return lower.slice(0, 3).toUpperCase();
}

function tierLabel(tier: string, useCodex56Labels = false): string {
  if (useCodex56Labels && tier === "low") return "Light";
  if (tier === "xhigh") return "Extra High";
  if (tier === "max") return "Max";
  if (tier === "ultra") return "Ultra";
  if (tier === "ultracode") return "Ultracode";
  return capitalizeWord(tier);
}

/** The footer's effort label for a tier, so a chip can show the same word. */
export function reasoningEffortTierLabel(tier: string, useCodex56Labels = false): string {
  return tierLabel(tier, useCodex56Labels);
}

/** The footer's colour for an effort on a model's tiers, so a chip can match it. */
export function reasoningEffortToneColor(effort: string | null, tiers: readonly string[]): string {
  const index = effort ? tiers.indexOf(effort) : -1;
  return REASONING_TONE_STYLES[reasoningToneKeyForTier(effort, index, tiers.length)].color;
}

/** The same tone as space-separated RGB, for tinted fills (`rgba(var / a)`). */
export function reasoningEffortToneRgb(effort: string | null, tiers: readonly string[]): string {
  const index = effort ? tiers.indexOf(effort) : -1;
  return REASONING_TONE_STYLES[reasoningToneKeyForTier(effort, index, tiers.length)].rgb;
}

type ReasoningToneKey = "auto" | "low" | "steady" | "smart" | "deep" | "max" | "ultra";

const REASONING_TONE_STYLES: Record<
  ReasoningToneKey,
  {
    color: string;
    rgb: string;
  }
> = {
  auto: {
    color: "#A1A1AA",
    rgb: "161 161 170",
  },
  low: {
    color: "#6EE7B7",
    rgb: "52 211 153",
  },
  steady: {
    color: "#67E8F9",
    rgb: "34 211 238",
  },
  smart: {
    color: "#93C5FD",
    rgb: "96 165 250",
  },
  deep: {
    color: "#C4B5FD",
    rgb: "167 139 250",
  },
  max: {
    color: "#D8B4FE",
    rgb: "192 132 252",
  },
  ultra: {
    color: "#F5D0FE",
    rgb: "232 121 249",
  },
};

function reasoningToneKeyForIndex(index: number, total: number): ReasoningToneKey {
  if (index < 0) return "auto";
  if (total <= 1) return "max";
  const ratio = index / (total - 1);
  if (ratio <= 0.12) return "low";
  if (ratio <= 0.38) return "steady";
  if (ratio <= 0.52) return "smart";
  if (ratio < 1) return "deep";
  return "max";
}

/** Where the sliding indicator starts, as a fraction of the track, for a tier. */
function segmentFraction(index: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(index, total - 1)) / total;
}

function pointerPercent(clientX: number, rect: DOMRect): number {
  const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
  return Math.max(0, Math.min(100, ratio * 100));
}

/** The segment under the pointer. */
function segmentIndexAt(percent: number, total: number): number {
  if (total <= 1) return 0;
  return Math.max(0, Math.min(total - 1, Math.floor((percent / 100) * total)));
}

/** While dragging, the indicator is centred on the pointer, clamped to the track. */
function dragFraction(percent: number, total: number): number {
  if (total <= 0) return 0;
  const half = 0.5 / total;
  return Math.max(0, Math.min((total - 1) / total, percent / 100 - half));
}

/**
 * The indicator is one segment wide and sits at the track's left inset; it
 * moves by `translateX(offset * 100%)`, where `offset` is in segments. A
 * transform keeps the slide on the compositor — animating `left` would lay the
 * popover out on every frame of the move and of a drag.
 */
function segmentOffset(fraction: number, total: number): string {
  return (fraction * Math.max(1, total)).toFixed(4);
}

function setIndicatorPosition(track: HTMLDivElement, fraction: number, total: number): void {
  track.style.setProperty("--reasoning-slider-thumb-position", segmentOffset(fraction, total));
}

/**
 * Short words for a crowded track (more than four levels); the accessible
 * name and the header keep the full one. Shared with the model chip's list.
 */
export function reasoningEffortTrackLabel(tier: string, total: number, fullLabel: string): string {
  if (total <= 4) return fullLabel;
  if (tier === "minimal") return "Min";
  if (tier === "medium") return "Med";
  if (tier === "xhigh") return "XHigh";
  if (tier === "ultracode") return "Ultra";
  return fullLabel;
}

function reasoningToneKeyForTier(tier: string | null | undefined, index: number, total: number): ReasoningToneKey {
  if (tier === "ultra" || tier === "ultracode") return "ultra";
  if (tier === "max") return "max";
  return reasoningToneKeyForIndex(index, total);
}

const POINTER_DRAG_THRESHOLD_PX = 3;

type ActivePointerGesture = {
  pointerId: number;
  startClientX: number;
  startedOnRidge: boolean;
  moved: boolean;
  captured: boolean;
};

export const ReasoningEffortPicker = memo(function ReasoningEffortPicker({
  modelId,
  reasoningEffort,
  onChange,
  useFamilyDefaults = true,
  compact = false,
  disabled = false,
  className,
  triggerClassName,
  catalogScopeKey,
  catalogRevision = 0,
  ultrathink,
  daybreak,
  copilotAutoTier,
  onCopilotAutoTierChange,
  copilotAutoTierPending = false,
  squeezed = false,
}: ReasoningEffortPickerProps) {
  const portalContainer = usePortalContainer();
  const [open, setOpen] = useState(false);
  const activePointerGestureRef = useRef<ActivePointerGesture | null>(null);
  const suppressTierClickRef = useRef(false);
  const suppressTierClickTimerRef = useRef<number | null>(null);
  const copilotOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const { rememberReasoning, getReasoningForFamily } = useReasoningByFamily();
  useEffect(() => {
    if (open) return;
    activePointerGestureRef.current = null;
    suppressTierClickRef.current = false;
    if (suppressTierClickTimerRef.current != null) {
      window.clearTimeout(suppressTierClickTimerRef.current);
      suppressTierClickTimerRef.current = null;
    }
  }, [open]);
  useEffect(() => () => {
    if (suppressTierClickTimerRef.current != null) {
      window.clearTimeout(suppressTierClickTimerRef.current);
    }
  }, []);

  const descriptor = useMemo<ModelDescriptor | undefined>(
    () => resolveModelDescriptorWithRuntimeCatalog(modelId, catalogScopeKey),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the revision is the catalog's arrival
    [catalogScopeKey, catalogRevision, modelId],
  );

  const tiers = useMemo(
    () => descriptor?.reasoningTiers ?? [],
    [descriptor?.reasoningTiers],
  );
  const family = descriptor?.family;
  const useCodex56Labels = usesCodexNamedEffortLabels(descriptor?.providerModelId);

  const displayedEffort = useMemo<string | null>(() => resolveDisplayedReasoningEffort({
    tiers,
    explicitEffort: reasoningEffort,
    rememberedForFamily: useFamilyDefaults && family ? getReasoningForFamily(family) ?? null : null,
    modelDefault: descriptor?.defaultReasoningEffort ?? null,
  }), [descriptor?.defaultReasoningEffort, family, getReasoningForFamily, reasoningEffort, tiers, useFamilyDefaults]);

  const activeIndex = displayedEffort ? tiers.findIndex((tier) => tier === displayedEffort) : -1;
  const previousActiveIndexRef = useRef(activeIndex);
  const effortTransitionDirection = activeIndex > previousActiveIndexRef.current
    ? "up"
    : activeIndex < previousActiveIndexRef.current
      ? "down"
      : "idle";
  useEffect(() => {
    previousActiveIndexRef.current = activeIndex;
  }, [activeIndex]);
  const activeTone = REASONING_TONE_STYLES[
    reasoningToneKeyForTier(displayedEffort, activeIndex, tiers.length)
  ];
  const activeLabel = activeIndex >= 0 ? tierLabel(tiers[activeIndex]!, useCodex56Labels) : "Auto";
  const isUltraActive = displayedEffort === "ultra" || displayedEffort === "ultracode";
  const thumbLeft = segmentOffset(segmentFraction(Math.max(0, activeIndex), tiers.length), tiers.length);

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
    },
    [commitEffort, displayedEffort],
  );

  const restoreTrackPosition = useCallback(
    (track: HTMLDivElement) => {
      track.removeAttribute("data-dragging");
      track.style.setProperty("--reasoning-slider-thumb-position", thumbLeft);
    },
    [thumbLeft],
  );

  const releasePointerCapture = useCallback((track: HTMLDivElement, pointerId: number) => {
    if (typeof track.releasePointerCapture !== "function") return;
    if (typeof track.hasPointerCapture === "function" && !track.hasPointerCapture(pointerId)) return;
    track.releasePointerCapture(pointerId);
  }, []);

  const suppressTrailingTierClick = useCallback(() => {
    suppressTierClickRef.current = true;
    if (suppressTierClickTimerRef.current != null) {
      window.clearTimeout(suppressTierClickTimerRef.current);
    }
    suppressTierClickTimerRef.current = window.setTimeout(() => {
      suppressTierClickRef.current = false;
      suppressTierClickTimerRef.current = null;
    }, 0);
  }, []);

  const handleTrackClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!suppressTierClickRef.current) return;
    suppressTierClickRef.current = false;
    if (suppressTierClickTimerRef.current != null) {
      window.clearTimeout(suppressTierClickTimerRef.current);
      suppressTierClickTimerRef.current = null;
    }
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handleTrackPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (disabled || tiers.length === 0) return;
      const target = event.target as Element | null;
      const startedOnRidge = Boolean(target?.closest?.("[data-reasoning-slider-segment]"));
      if (event.button !== 0 || activePointerGestureRef.current != null) return;
      const gesture: ActivePointerGesture = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startedOnRidge,
        moved: false,
        captured: false,
      };
      activePointerGestureRef.current = gesture;
      if (startedOnRidge) return;
      event.preventDefault();
      event.currentTarget.dataset.dragging = "true";
      if (typeof event.currentTarget.setPointerCapture === "function") {
        event.currentTarget.setPointerCapture(event.pointerId);
        gesture.captured = true;
      }
      setIndicatorPosition(
        event.currentTarget,
        dragFraction(pointerPercent(event.clientX, event.currentTarget.getBoundingClientRect()), tiers.length),
        tiers.length,
      );
    },
    [disabled, tiers.length],
  );

  const handleTrackPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = activePointerGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (!gesture.moved) {
      if (Math.abs(event.clientX - gesture.startClientX) < POINTER_DRAG_THRESHOLD_PX) return;
      gesture.moved = true;
    }
    event.preventDefault();
    event.currentTarget.dataset.dragging = "true";
    if (!gesture.captured && typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
      gesture.captured = true;
    }
    setIndicatorPosition(
      event.currentTarget,
      dragFraction(pointerPercent(event.clientX, event.currentTarget.getBoundingClientRect()), tiers.length),
      tiers.length,
    );
  }, [tiers.length]);

  const handleTrackPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const gesture = activePointerGestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const moved = gesture.moved
        || Math.abs(event.clientX - gesture.startClientX) >= POINTER_DRAG_THRESHOLD_PX;
      activePointerGestureRef.current = null;
      if (gesture.startedOnRidge && !moved) {
        restoreTrackPosition(event.currentTarget);
        return;
      }
      event.preventDefault();
      const percent = pointerPercent(event.clientX, event.currentTarget.getBoundingClientRect());
      const nextIndex = segmentIndexAt(percent, tiers.length);
      event.currentTarget.removeAttribute("data-dragging");
      setIndicatorPosition(event.currentTarget, segmentFraction(nextIndex, tiers.length), tiers.length);
      if (gesture.captured) releasePointerCapture(event.currentTarget, event.pointerId);
      if (gesture.startedOnRidge) suppressTrailingTierClick();
      commitEffort(tiers[nextIndex] ?? null);
    },
    [commitEffort, releasePointerCapture, restoreTrackPosition, suppressTrailingTierClick, tiers],
  );

  const handleTrackPointerCancel = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const gesture = activePointerGestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      activePointerGestureRef.current = null;
      restoreTrackPosition(event.currentTarget);
      if (gesture.captured) releasePointerCapture(event.currentTarget, event.pointerId);
    },
    [releasePointerCapture, restoreTrackPosition],
  );

  const handleTrackLostPointerCapture = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const gesture = activePointerGestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      activePointerGestureRef.current = null;
      restoreTrackPosition(event.currentTarget);
    },
    [restoreTrackPosition],
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

  const copilotAuto = descriptor?.family === "github-copilot" && descriptor.providerModelId === "auto";
  if (copilotAuto && onCopilotAutoTierChange) {
    const options = [["efficiency", "Efficiency"], ["balance", "Balance"], ["intelligence", "Intelligence"]] as const;
    const selected = copilotAutoTier ?? "balance";
    const selectedLabel = options.find(([value]) => value === selected)?.[1] ?? "Balance";
    const handleOptionKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      let nextIndex: number | null = null;
      if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        nextIndex = (index + 1) % options.length;
      } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        nextIndex = (index - 1 + options.length) % options.length;
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = options.length - 1;
      }
      if (nextIndex == null) return;
      event.preventDefault();
      copilotOptionRefs.current[nextIndex]?.focus();
      const next = options[nextIndex];
      if (next) onCopilotAutoTierChange(next[0]);
    };
    return (
      <Popover.Root open={open} onOpenChange={(next) => setOpen(disabled ? false : next)}>
        <Popover.Trigger asChild>
          <button
            type="button"
            disabled={disabled}
            data-state={open ? "open" : "closed"}
            className={cn(
              "inline-flex min-w-0 items-center rounded-md border font-sans transition-colors duration-150",
              compact ? "h-6 gap-1.5 px-1.5 text-[9px]" : "h-8 gap-2 px-2.5 text-[11px] sm:text-[12px]",
              "border-fg/[0.06] bg-fg/[0.03] text-fg/80 hover:border-fg/[0.12] hover:bg-fg/[0.06]",
              open && "border-fg/[0.12] bg-fg/[0.06]",
              disabled && "cursor-not-allowed opacity-60 hover:border-fg/[0.06] hover:bg-fg/[0.03]",
              triggerClassName,
              className,
            )}
            aria-label="Copilot Auto profile"
            aria-haspopup="dialog"
            aria-expanded={open}
          >
            <span className="shrink-0 font-medium leading-none text-fg/80">{selectedLabel}</span>
            <CaretDown
              size={compact ? 9 : 10}
              weight="bold"
              className={cn(
                "shrink-0 text-muted-fg/60 transition-transform duration-150",
                open && "rotate-180 text-fg/80",
              )}
            />
          </button>
        </Popover.Trigger>
        <Popover.Portal container={portalContainer ?? undefined}>
          <Popover.Content
            side="top"
            align="start"
            sideOffset={6}
            collisionPadding={8}
            avoidCollisions
            className="outline-none"
            style={{ zIndex: Z_LAYERS.popover }}
          >
            <div
              className="relative isolate flex w-[288px] flex-col overflow-hidden rounded-2xl border border-fg/[0.08] bg-(color:--work-popover-bg) p-2.5 shadow-[0_18px_48px_rgba(0,0,0,0.58)] backdrop-blur-md"
              role="radiogroup"
              aria-label="Copilot Auto profile"
            >
              <div className="flex items-center justify-between gap-3 px-1 pb-2.5 pt-0.5">
                <span className="font-sans text-[12px] leading-none text-muted-fg/72">Copilot Auto</span>
                <span className="shrink-0 font-sans text-[10px] leading-none text-muted-fg/50">Profile</span>
              </div>
              <div className="flex flex-col gap-0.5">
                {options.map(([value, label], index) => {
                  const isActive = selected === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={isActive}
                      ref={(el) => { copilotOptionRefs.current[index] = el; }}
                      tabIndex={isActive ? 0 : -1}
                      onKeyDown={(event) => handleOptionKeyDown(event, index)}
                      onClick={() => { onCopilotAutoTierChange(value); setOpen(false); }}
                      className={cn(
                        "flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left font-sans text-[12px] leading-none outline-none transition-colors duration-150",
                        "focus-visible:ring-1 focus-visible:ring-fg/25",
                        isActive ? "bg-fg/[0.06] text-fg" : "text-muted-fg/75 hover:bg-fg/[0.05] hover:text-fg/90",
                      )}
                    >
                      <span className="truncate">{label}</span>
                      {isActive ? <Check size={12} weight="bold" className="shrink-0 text-fg/70" /> : null}
                    </button>
                  );
                })}
              </div>
              {copilotAutoTierPending ? (
                <p role="status" className="mt-2 px-1 font-sans text-[10px] leading-4 text-muted-fg/60">
                  Applies from the next message
                </p>
              ) : null}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    );
  }
  if (tiers.length === 0) return null;

  const shortLabel = reasoningChipLabel(displayedEffort, useCodex56Labels) ?? "AUTO";

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
          label={activeLabel}
          shortLabel={shortLabel}
          tone={activeTone}
          tiers={tiers}
          activeIndex={activeIndex}
          compact={compact}
          disabled={disabled}
          open={open}
          ultra={isUltraActive}
          squeezed={squeezed}
          className={cn(triggerClassName, className)}
        />
      </Popover.Trigger>
      {/* Inside a dialog, portal into it: a modal dialog blocks pointer
          events and focus everywhere outside its content. */}
      <Popover.Portal container={portalContainer ?? undefined}>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          avoidCollisions
          className="outline-none"
          style={{ zIndex: Z_LAYERS.popover }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
          }}
        >
          <div
            data-reasoning-effort-picker-content="true"
            className={cn(
              "ade-reasoning-effort-content relative isolate flex flex-col overflow-hidden rounded-2xl border border-fg/[0.08]",
              tiers.length > 4 ? "w-[328px]" : "w-[288px]",
              "bg-(color:--work-popover-bg) p-2.5 shadow-[0_18px_48px_rgba(0,0,0,0.58)] backdrop-blur-md",
              isUltraActive && "ade-reasoning-effort-content-ultra",
            )}
            data-reasoning-ultra={isUltraActive ? "true" : undefined}
            role="radiogroup"
            aria-label="Reasoning effort"
            style={{
              "--reasoning-fill-rgb": activeTone.rgb,
            } as React.CSSProperties}
          >
            <div className="flex items-center justify-between gap-3 px-1 pb-2.5 pt-0.5">
              <div className="flex min-w-0 items-center gap-2 font-sans text-[12px] leading-none text-muted-fg/72">
                <EffortMeter tiers={tiers} activeIndex={activeIndex} color={activeTone.color} />
                <span>Effort</span>
                <span
                  key={displayedEffort ?? "auto"}
                  className="ade-reasoning-effort-word font-semibold"
                  data-direction={effortTransitionDirection}
                  style={{ color: toneText(activeTone.color) }}
                >
                  {activeLabel}
                </span>
              </div>
              <span className="shrink-0 font-sans text-[10px] leading-none text-muted-fg/50">
                Faster → Smarter
              </span>
            </div>
            <div
              data-reasoning-slider-track
              className="ade-reasoning-slider-track relative flex h-9 touch-none select-none items-stretch rounded-full bg-black/25 p-[3px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]"
              onPointerDown={handleTrackPointerDown}
              onPointerMove={handleTrackPointerMove}
              onPointerUp={handleTrackPointerUp}
              onPointerCancel={handleTrackPointerCancel}
              onLostPointerCapture={handleTrackLostPointerCapture}
              onClickCapture={handleTrackClickCapture}
              role="presentation"
              style={{
                "--reasoning-slider-thumb-position": thumbLeft,
              } as React.CSSProperties}
            >
              <div
                data-reasoning-slider-thumb
                className={cn(
                  "ade-reasoning-slider-thumb pointer-events-none absolute inset-y-[3px] rounded-full",
                  activeIndex < 0 && "opacity-0",
                )}
                style={{
                  left: 3,
                  transform: "translateX(calc(var(--reasoning-slider-thumb-position) * 100%))",
                  width: `calc((100% - 6px) / ${tiers.length})`,
                }}
                aria-hidden
              />
              {tiers.map((tier, index) => {
                const isActive = displayedEffort === tier;
                return (
                  <button
                    key={tier}
                    type="button"
                    role="radio"
                    aria-checked={isActive}
                    aria-label={tierLabel(tier, useCodex56Labels)}
                    tabIndex={isActive || (activeIndex < 0 && index === 0) ? 0 : -1}
                    data-reasoning-slider-segment
                    onClick={(event) => {
                      event.stopPropagation();
                      handleSelect(tier);
                    }}
                    onKeyDown={handleSliderKeyDown}
                    className={cn(
                      "relative z-[1] min-w-0 flex-1 cursor-pointer rounded-full px-1 text-center font-sans text-[11px] font-medium leading-none outline-none transition-colors duration-200",
                      "focus-visible:ring-1 focus-visible:ring-fg/25",
                      isActive ? "text-fg" : "text-muted-fg/65 hover:text-fg/90",
                    )}
                    style={isActive ? { color: toneText(activeTone.color) } : undefined}
                  >
                    <span className="block truncate">{reasoningEffortTrackLabel(tier, tiers.length, tierLabel(tier, useCodex56Labels))}</span>
                  </button>
                );
              })}
            </div>
            {isUltraActive ? (
              <p
                className="ade-reasoning-ultra-warning mt-2.5 px-1 font-sans text-[10px] leading-4 text-fuchsia-100/75"
                data-reasoning-ultra-warning="true"
              >
                Automatically delegates work across multiple agents and can consume task limits faster.
              </p>
            ) : null}
            {ultrathink ? (
              <PickerSwitchRow
                tone="ultrathink"
                label="Ultrathink"
                labelClassName="ade-ultrathink-text"
                description="Asks Claude to reason extra hard on this message only."
                control={ultrathink}
                disabled={disabled}
              />
            ) : null}
            {daybreak ? (
              <PickerSwitchRow
                tone="daybreak"
                label="Daybreak"
                labelClassName="text-fg/85"
                description="Broader access for authorized cybersecurity work in this chat."
                control={daybreak}
                disabled={disabled}
              />
            ) : null}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
});

/**
 * An on/off row under the effort levels (Claude's Ultrathink, Codex's
 * Daybreak): a setting that stacks on any level rather than being one.
 * `data-reasoning-<tone>-switch` lets tests and tooling find each row.
 */
function PickerSwitchRow({
  tone,
  label,
  labelClassName,
  description,
  control,
  disabled,
}: {
  tone: "ultrathink" | "daybreak";
  label: string;
  labelClassName: string;
  description: string;
  control: { active: boolean; onChange: (active: boolean) => void };
  disabled: boolean;
}) {
  return (
    <>
      <div className="mx-0.5 mt-2.5 h-px bg-fg/[0.06]" />
      <button
        type="button"
        role="switch"
        aria-checked={control.active}
        disabled={disabled}
        {...{ [`data-reasoning-${tone}-switch`]: "true" }}
        onClick={() => control.onChange(!control.active)}
        className="mt-1.5 flex w-full items-center justify-between gap-3 rounded-lg px-1 py-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-fg/25"
      >
        <span className="flex min-w-0 flex-col gap-1">
          <span className={`${labelClassName} self-start font-sans text-[12px] font-semibold leading-none`}>{label}</span>
          <span className="font-sans text-[10px] leading-4 text-muted-fg/60">{description}</span>
        </span>
        <span aria-hidden className="ade-picker-switch" data-tone={tone} data-on={control.active ? "true" : "false"} />
      </button>
    </>
  );
}

type TriggerProps = {
  label: string;
  shortLabel: string;
  tone: (typeof REASONING_TONE_STYLES)[ReasoningToneKey];
  tiers: readonly string[];
  activeIndex: number;
  compact: boolean;
  disabled: boolean;
  open: boolean;
  ultra: boolean;
  squeezed: boolean;
  className?: string;
};

const ReasoningEffortTrigger = memo(
  forwardRef<HTMLButtonElement, TriggerProps & React.ButtonHTMLAttributes<HTMLButtonElement>>(
    function ReasoningEffortTrigger(
      { label, shortLabel, tone, tiers, activeIndex, compact, disabled, open, ultra, squeezed, className, ...rest },
      ref,
    ) {
      return (
        <button
          {...rest}
          ref={ref}
          type="button"
          data-state={open ? "open" : "closed"}
          data-reasoning-effort-picker-trigger="true"
          data-reasoning-ultra={ultra ? "true" : undefined}
          disabled={disabled}
          aria-label="Reasoning effort"
          title={squeezed ? `Reasoning effort: ${label}` : "Reasoning effort"}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={cn(
            "inline-flex min-w-0 items-center rounded-md border font-sans transition-colors duration-150",
            compact
              ? "h-6 gap-1.5 px-1.5 text-[9px]"
              : "h-8 gap-2 px-2.5 text-[11px] sm:text-[12px]",
            "border-fg/[0.06] bg-fg/[0.03] text-fg/80 hover:border-fg/[0.12] hover:bg-fg/[0.06]",
            ultra && "ade-reasoning-effort-trigger-ultra",
            open && "border-fg/[0.12] bg-fg/[0.06]",
            disabled && "cursor-not-allowed opacity-60 hover:border-fg/[0.06] hover:bg-fg/[0.03]",
            className,
          )}
        >
          <EffortMeter tiers={tiers} activeIndex={activeIndex} color={tone.color} compact={compact} />
          <span
            data-reasoning-chip="true"
            className={cn(
              "shrink-0 font-medium leading-none",
              compact ? "text-[9px]" : "text-[11px] sm:text-[12px]",
            )}
            style={{ color: toneText(tone.color) }}
          >
            {squeezed ? (
              <span className="hidden @3xl:inline">{label}</span>
            ) : (
              <>
                <span className="hidden @sm:inline">{label}</span>
                <span className="@sm:hidden">{shortLabel}</span>
              </>
            )}
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

/**
 * Rising bars, one per tier, lit up to the current effort in its tone. It says
 * "how hard will it think" at a glance, before the label is read.
 */
export const EffortMeter = memo(function EffortMeter({
  tiers,
  activeIndex,
  color,
  compact = false,
}: {
  tiers: readonly string[];
  activeIndex: number;
  color: string;
  compact?: boolean;
}) {
  const total = Math.max(1, tiers.length);
  const minHeight = compact ? 3 : 4;
  const maxHeight = compact ? 10 : 12;
  return (
    <span aria-hidden data-reasoning-meter="true" className="inline-flex shrink-0 items-end gap-[2px]">
      {tiers.map((tier, index) => {
        const height = total <= 1
          ? maxHeight
          : minHeight + ((maxHeight - minHeight) * index) / (total - 1);
        const lit = activeIndex >= 0 && index <= activeIndex;
        return (
          <span
            key={tier}
            className={cn(
              "w-[3px] rounded-full transition-colors duration-200",
              !lit && "bg-fg/[0.16]",
            )}
            style={{ height, ...(lit ? { backgroundColor: toneText(color) } : {}) }}
          />
        );
      })}
    </span>
  );
});

/**
 * The effort this control WOULD display for a model when no explicit value is
 * set: the remembered effort for that model's family, validated against the
 * model's own tiers.
 *
 * Exported so the owner of the value can resolve it BEFORE sending. The picker
 * used to display this fallback while the send path read the unset value, so
 * the trigger said "High" and the request went out on the model default. The
 * fix belongs here, not in an effect that writes its parent's state on mount —
 * this control renders at a dozen call sites, several of which persist every
 * onChange straight to the backend.
 */
export function resolveDisplayedReasoningEffort(args: {
  tiers: readonly string[];
  explicitEffort: string | null;
  rememberedForFamily: string | null;
  modelDefault: string | null;
}): string | null {
  const validModelDefault = args.modelDefault && args.tiers.includes(args.modelDefault)
    ? args.modelDefault
    : null;
  if (args.explicitEffort) {
    return args.tiers.includes(args.explicitEffort) ? args.explicitEffort : validModelDefault;
  }
  if (args.rememberedForFamily) {
    return args.tiers.includes(args.rememberedForFamily) ? args.rememberedForFamily : validModelDefault;
  }
  return null;
}
