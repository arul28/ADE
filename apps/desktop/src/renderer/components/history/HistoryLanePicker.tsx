import React, { useRef } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { CaretDown, Check } from "@phosphor-icons/react";
import type { LaneSummary } from "../../../shared/types";
import { cn } from "../ui/cn";
import { LaneIcon } from "../ui/vcsIcons";
import { Z_LAYERS } from "../ui/zLayers";
import { PaneTooltip } from "../ui/PaneTooltip";
import { WORK_TOOL_CHROME_FOCUS } from "../terminals/workToolChrome";
import { getLaneAccent } from "../lanes/laneColorPalette";
import { normalizeBranchName } from "./commitRowModel";

export type HistoryLanePickerGroup = {
  key: string;
  /** Empty for a single-machine project: no heading. */
  machineName: string;
  disabledReason: string | null;
  options: Array<{ value: string; lane: LaneSummary }>;
};

/**
 * The lane the Commits view is on: lane glyph in the lane's colour and its
 * name. The branch is in the tooltip and the menu, not the button.
 */
export function HistoryLanePicker({
  value,
  groups,
  onChange,
}: {
  value: string;
  groups: HistoryLanePickerGroup[];
  onChange: (value: string) => void;
}) {
  // Same fallback index as the graph: the lane's place among live lanes.
  const colorFor = (group: HistoryLanePickerGroup, lane: LaneSummary) =>
    getLaneAccent(lane, Math.max(0, group.options.filter((option) => !option.lane.archivedAt).findIndex((option) => option.lane.id === lane.id)));
  let current: { lane: LaneSummary; color: string; machineName: string } | null = null;
  for (const group of groups) {
    const hit = group.options.find((option) => option.value === value);
    if (hit) current = { lane: hit.lane, color: colorFor(group, hit.lane), machineName: group.machineName };
  }
  // A mouse pick does not hand focus back to the trigger: that would leave a
  // focus ring and the tooltip up. A keyboard pick or Escape does, however
  // the menu was opened, so the keyboard keeps its place. This is the input
  // that last acted on the picker.
  const lastInput = useRef<"pointer" | "keyboard">("keyboard");
  const branch = current ? normalizeBranchName(current.lane.branchRef) : "";
  const tip = current
    ? [current.lane.name, branch, current.machineName].filter(Boolean).join(" · ")
    : "Choose a lane";
  return (
    <DropdownMenu.Root modal={false}>
      <PaneTooltip label={tip}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label={current ? `Lane ${current.lane.name}` : "Choose a lane"}
            onPointerDown={() => {
              lastInput.current = "pointer";
            }}
            onKeyDown={() => {
              lastInput.current = "keyboard";
            }}
            className={cn(
              "inline-flex h-7 min-w-0 max-w-[260px] shrink items-center gap-1.5 rounded-[7px] px-2 text-[12.5px] font-medium text-fg/90",
              "transition-colors duration-100 hover:bg-white/[0.06] data-[state=open]:bg-white/[0.08]",
              WORK_TOOL_CHROME_FOCUS,
            )}
            data-testid="history-lane-picker"
          >
            {current ? <LaneIcon size={14} style={{ color: current.color }} /> : null}
            <span className="min-w-0 truncate">{current ? current.lane.name : "Choose a lane"}</span>
            <CaretDown size={11} className="shrink-0 text-muted-fg" aria-hidden />
          </button>
        </DropdownMenu.Trigger>
      </PaneTooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          // Capture: an item acts on its own keydown/pointerup, before the
          // event would bubble here.
          onPointerDownCapture={() => {
            lastInput.current = "pointer";
          }}
          onKeyDownCapture={() => {
            lastInput.current = "keyboard";
          }}
          onCloseAutoFocus={(event) => {
            if (lastInput.current === "pointer") event.preventDefault();
          }}
          className="max-h-[min(70vh,520px)] min-w-[260px] max-w-[380px] overflow-y-auto rounded-[9px] border border-white/[0.08] bg-[var(--color-card)] p-1 shadow-xl"
          style={{ zIndex: Z_LAYERS.popover }}
        >
          {groups.map((group, index) => (
            <React.Fragment key={group.key}>
              {index > 0 ? <DropdownMenu.Separator className="my-1 h-px bg-white/[0.06]" /> : null}
              {group.machineName ? (
                <DropdownMenu.Label className="px-2 pb-0.5 pt-1 text-[11px] text-muted-fg" title={group.disabledReason ?? undefined}>
                  {group.machineName}
                  {group.disabledReason ? " · unavailable" : ""}
                </DropdownMenu.Label>
              ) : null}
              {/* Primary leads, as in the lane list; colours keep the group's own order. */}
              {[
                ...group.options.filter((option) => option.lane.laneType === "primary"),
                ...group.options.filter((option) => option.lane.laneType !== "primary"),
              ].map((option) => {
                const optionBranch = normalizeBranchName(option.lane.branchRef);
                const selected = option.value === value;
                return (
                  <DropdownMenu.Item
                    key={option.value}
                    disabled={group.disabledReason != null}
                    onSelect={() => onChange(option.value)}
                    className={cn(
                      "flex cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 outline-none",
                      "data-[highlighted]:bg-white/[0.07] data-[disabled]:cursor-default data-[disabled]:opacity-40",
                    )}
                  >
                    <LaneIcon size={13} style={{ color: colorFor(group, option.lane) }} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[12.5px] text-fg">{option.lane.name}</span>
                      {optionBranch && optionBranch !== option.lane.name ? (
                        <span className="truncate text-[11px] text-muted-fg/70">{optionBranch}</span>
                      ) : null}
                    </span>
                    {selected ? <Check size={12} className="shrink-0 text-fg/80" aria-hidden /> : null}
                  </DropdownMenu.Item>
                );
              })}
            </React.Fragment>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
