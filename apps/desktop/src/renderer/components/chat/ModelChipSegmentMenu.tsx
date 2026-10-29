// The small list that opens above a model chip's thinking or permission part.
// The composer owns the keys (the editor keeps focus the whole time); this only
// draws the options and takes clicks.
//
// A compact take on the footer pickers: thinking is the effort picker's
// segmented track and permissions the permission menu's list, each with one
// highlight that slides to the active option in its tone. It stays small
// because it opens over the text being typed.

import { useMemo } from "react";

import { AnchoredMenu } from "../ui/AnchoredMenu";
import { cn } from "../ui/cn";
import { Z_LAYERS } from "../ui/zLayers";
import { POPOVER_SURFACE_CLASS } from "../ui/paneMenuTokens";
import { PermissionModeGlyph, permissionModeToneRgb } from "../shared/PermissionModePicker";
import {
  EffortMeter,
  reasoningEffortToneRgb,
  reasoningEffortTrackLabel,
} from "../shared/ModelPicker/ReasoningEffortPicker";
import { toneText } from "../lanes/laneDesignTokens";
import { permissionToneTextClass } from "../shared/permissionModePickerOptions";
import type { ModelChipOption, ModelChipSegment } from "./composerModelChip";

const PERMISSION_ROW_HEIGHT = 26;

export function ModelChipSegmentMenu({
  anchor,
  segment,
  options,
  activeIndex,
  onPick,
  onClose,
}: {
  /** The segment element inside the chip. */
  anchor: HTMLElement;
  segment: ModelChipSegment;
  options: ModelChipOption[];
  activeIndex: number;
  onPick: (index: number) => void;
  onClose: () => void;
}) {
  const anchorRef = useMemo(() => ({ current: anchor }), [anchor]);
  const tiers = useMemo(() => options.map((option) => option.value), [options]);
  if (!options.length) return null;
  const isPerm = segment === "perm";
  const index = Math.min(Math.max(0, activeIndex), options.length - 1);
  const active = options[index]!;
  const rgb = isPerm
    ? permissionModeToneRgb(active.tone ?? "green")
    : reasoningEffortToneRgb(active.value, tiers);
  return (
    <AnchoredMenu
      open
      anchorRef={anchorRef}
      onClose={onClose}
      // The composer sits at the bottom of the window, so the list opens upward.
      placement="top-start"
      offset={6}
      zIndex={Z_LAYERS.popover}
      remeasureKey={`${segment}:${options.length}`}
      role="listbox"
      aria-label={isPerm ? "Permission mode" : "Thinking level"}
      className={cn(
        "overflow-hidden rounded-xl p-1.5",
        POPOVER_SURFACE_CLASS,
        isPerm ? "w-[188px]" : options.length > 4 ? "w-[300px]" : "w-[248px]",
      )}
      // Keep focus (and the caret) in the editor while picking with the mouse.
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="flex items-center gap-1.5 px-1 pb-1.5 pt-0.5 font-sans text-[10px] leading-none text-muted-fg/60">
        {isPerm ? null : <EffortMeter tiers={tiers} activeIndex={index} color={`rgb(${rgb})`} compact />}
        <span>{isPerm ? "Permissions" : "Thinking"}</span>
        <span className="truncate font-semibold" style={{ color: toneText(`rgb(${rgb})`) }}>{active.label}</span>
        <span className="ml-auto shrink-0 text-muted-fg/40">Tab · Esc</span>
      </div>
      {isPerm ? (
        <div className="relative rounded-lg bg-black/25 p-[2px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
          <div
            aria-hidden
            className="ade-permission-mode-highlight pointer-events-none absolute inset-x-[2px] top-[2px] rounded-md"
            style={{
              height: PERMISSION_ROW_HEIGHT,
              transform: `translateY(${index * PERMISSION_ROW_HEIGHT}px)`,
              "--permission-mode-rgb": rgb,
            } as React.CSSProperties}
          />
          {options.map((option, optionIndex) => {
            const lit = optionIndex === index;
            return (
              <div
                key={option.value}
                role="option"
                aria-selected={lit}
                data-active={lit}
                className={cn(
                  "relative z-[1] flex cursor-pointer items-center gap-2 rounded-md px-2 font-sans text-[11px] transition-colors duration-150",
                  lit ? "text-fg" : "text-fg/60 hover:text-fg/85",
                )}
                style={{ height: PERMISSION_ROW_HEIGHT }}
                onClick={() => onPick(optionIndex)}
              >
                {option.icon ? (
                  <PermissionModeGlyph
                    icon={option.icon}
                    size={11}
                    className={cn("shrink-0", permissionToneTextClass(option.tone ?? "green"))}
                  />
                ) : null}
                <span className="truncate">{option.label}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div
          className="relative flex h-7 items-stretch rounded-full bg-black/25 p-[2px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]"
          style={{ "--reasoning-fill-rgb": rgb } as React.CSSProperties}
        >
          <div
            aria-hidden
            className="ade-reasoning-slider-thumb pointer-events-none absolute inset-y-[2px] left-[2px] rounded-full"
            style={{
              width: `calc((100% - 4px) / ${options.length})`,
              transform: `translateX(${index * 100}%)`,
            }}
          />
          {options.map((option, optionIndex) => {
            const lit = optionIndex === index;
            return (
              <div
                key={option.value}
                role="option"
                aria-selected={lit}
                data-active={lit}
                className={cn(
                  "relative z-[1] flex min-w-0 flex-1 cursor-pointer items-center justify-center rounded-full px-1 font-sans text-[10px] font-medium leading-none transition-colors duration-150",
                  lit ? "" : "text-muted-fg/60 hover:text-fg/85",
                )}
                style={lit ? { color: toneText(`rgb(${rgb})`) } : undefined}
                onClick={() => onPick(optionIndex)}
              >
                <span className="truncate">{reasoningEffortTrackLabel(option.value, options.length, option.label)}</span>
              </div>
            );
          })}
        </div>
      )}
    </AnchoredMenu>
  );
}
