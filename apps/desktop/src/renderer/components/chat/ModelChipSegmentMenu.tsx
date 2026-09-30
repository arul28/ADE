// The small list that opens above a model chip's thinking or permission part.
// The composer owns the keys (the editor keeps focus the whole time); this only
// draws the options and takes clicks.

import { useMemo } from "react";

import { AnchoredMenu } from "../ui/AnchoredMenu";
import { cn } from "../ui/cn";
import { Z_LAYERS } from "../ui/zLayers";
import type { ModelChipOption, ModelChipSegment } from "./composerModelChip";

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
  if (!options.length) return null;
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
      aria-label={segment === "effort" ? "Thinking level" : "Permission mode"}
      className="ade-chat-drawer-glass w-[200px] overflow-hidden py-1"
      // Keep focus (and the caret) in the editor while picking with the mouse.
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="px-3 pb-1 pt-1.5 text-[9px] font-medium uppercase tracking-[0.08em] text-fg/32">
        {segment === "effort" ? "Thinking" : "Permissions"}
        <span className="ml-1.5 normal-case tracking-normal text-fg/24">Tab next · Esc done</span>
      </div>
      {options.map((option, index) => (
        <div
          key={option.value}
          role="option"
          aria-selected={index === activeIndex}
          data-active={index === activeIndex}
          className={cn(
            "ade-chat-drawer-row mx-1 cursor-pointer rounded-md px-2.5 py-1.5 text-[11px]",
            index === activeIndex ? "text-amber-100" : "text-fg/60",
          )}
          onClick={() => onPick(index)}
        >
          {option.label}
        </div>
      ))}
    </AnchoredMenu>
  );
}
