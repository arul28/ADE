import React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { CaretUpDown, Check } from "@phosphor-icons/react";
import { cn } from "../../ui/cn";
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS, MENU_SEPARATOR_CLASS } from "../../ui/paneMenuTokens";
import type { LaneMachineFilterEntry } from "../../../state/laneMachineRouting";
import { LANES_MACHINE_FILTER_ALL } from "../../../state/laneMachineFilterIds";

/**
 * The Lanes sidebar's filter panel, opened by the funnel in the search row.
 *
 * The shape is Work's filter panel on purpose (`WorkFilterPanel`): a kicker, a
 * label on the left and a menu button on the right, so the two sidebars read as
 * one product. It holds every lane filter this release has — the Computer — and
 * a Reset. The State/List grouping stays in the search row, where it is a view
 * switch rather than a filter.
 *
 * The ADE Cloud lanes whose computer is gone hang under ADE Cloud: they are the
 * only lanes no computer holds, and this is the one place to reach them.
 */

/** The panel element's id, so the funnel can name what it controls. */
export const LANE_FILTER_PANEL_ID = "lanes-filter-panel";

const SECTION_LABEL_CLASS = "text-[9.5px] font-semibold uppercase tracking-[0.08em] text-muted-fg/50";
const ROW_LABEL_CLASS = "w-[58px] shrink-0 text-[10.5px] text-muted-fg/75";
const TRIGGER_CLASS = cn(
  "group inline-flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-md border px-2 text-left text-[11px]",
  "border-[color-mix(in_srgb,var(--color-fg)_12%,transparent)] bg-[color-mix(in_srgb,var(--color-fg)_3%,transparent)] text-fg/85",
  "transition-colors duration-100 hover:bg-[color-mix(in_srgb,var(--color-fg)_6%,transparent)]",
  "data-[state=open]:bg-[color-mix(in_srgb,var(--color-fg)_7%,transparent)]",
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color-mix(in_srgb,var(--color-fg)_35%,transparent)]",
);
const CHECK_CLASS = "flex w-3 shrink-0 justify-center text-[var(--color-accent)]";

export type LaneFilterPanelProps = {
  /** `All`, each computer, `ADE Cloud`, then the lanes without a computer. */
  entries: readonly LaneMachineFilterEntry[];
  /** `"all"`, a computer id, ADE Cloud, or the without-a-computer value. */
  value: string;
  onChange: (next: string) => void;
  className?: string;
};

export function LaneFilterPanel({ entries, value, onChange, className }: LaneFilterPanelProps) {
  // The stored value is already reduced to a listed entry where the list is
  // built; this only keeps the trigger readable if it ever arrives stale.
  const current = entries.find((entry) => entry.id === value) ?? entries[0] ?? null;
  const filtered = value !== LANES_MACHINE_FILTER_ALL;
  return (
    <div
      id={LANE_FILTER_PANEL_ID}
      data-testid="lane-filter-panel"
      className={cn("ade-chat-drawer-glass ade-lanes-filter-panel mx-2 mb-1.5 mt-1.5 flex flex-col gap-2.5 p-2.5", className)}
    >
      <div className="flex items-center justify-between">
        <span className={SECTION_LABEL_CLASS}>Filters</span>
        {filtered ? (
          <button
            type="button"
            className="rounded px-1 text-[10px] text-muted-fg transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color-mix(in_srgb,var(--color-fg)_35%,transparent)]"
            onClick={() => onChange(LANES_MACHINE_FILTER_ALL)}
          >
            Reset
          </button>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <span className={ROW_LABEL_CLASS}>Computer</span>
        <div className="flex min-w-0 flex-1">
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className={TRIGGER_CLASS}
                aria-label={`Computer: ${current?.name ?? "All"}`}
                data-testid="lane-filter-computer"
              >
                <span className="min-w-0 flex-1 truncate">{current?.name ?? "All"}</span>
                <CaretUpDown size={10} className="shrink-0 text-muted-fg/60" aria-hidden />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className={cn(MENU_CONTENT_CLASS, "min-w-[190px]")} side="bottom" align="start" sideOffset={4}>
                <DropdownMenu.RadioGroup value={value} onValueChange={onChange}>
                  {entries.map((entry) => (
                    <DropdownMenu.RadioItem
                      key={entry.id}
                      value={entry.id}
                      className={MENU_ITEM_CLASS}
                      data-testid={`lane-filter-entry-${entry.id}`}
                    >
                      <span className={CHECK_CLASS}>
                        <DropdownMenu.ItemIndicator><Check size={10} weight="bold" /></DropdownMenu.ItemIndicator>
                      </span>
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                    </DropdownMenu.RadioItem>
                  ))}
                </DropdownMenu.RadioGroup>
                {filtered ? (
                  <>
                    <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
                    <DropdownMenu.Item
                      className={cn(MENU_ITEM_CLASS, "pl-7 text-muted-fg")}
                      onSelect={() => onChange(LANES_MACHINE_FILTER_ALL)}
                    >
                      Show all computers
                    </DropdownMenu.Item>
                  </>
                ) : null}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </div>
    </div>
  );
}
