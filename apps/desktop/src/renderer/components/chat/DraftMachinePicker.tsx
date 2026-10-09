import { CaretDown, Check, CloudArrowUp, DesktopTower } from "@phosphor-icons/react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useState } from "react";

import { DevinLogo } from "../shared/ProviderLogos";
import { cn } from "../ui/cn";
import { MENU_ITEM_CLASS, MENU_SCROLL_CLASS, POPOVER_SURFACE_CLASS } from "../ui/paneMenuTokens";
import { SmartTooltip } from "../ui/SmartTooltip";
import { Z_LAYERS } from "../ui/zLayers";

export type DraftMachineOption = {
  id: string;
  name: string;
  /**
   * "cloud" entries are not computers ADE is paired with — they are hosted
   * runtimes (today: Cursor Cloud) that run the chat off-machine. They live in
   * this list because "where does this run" is one question, not two.
   */
  kind?: "machine" | "cloud";
  /** Which provider's mark a cloud entry wears; generic cloud icon when unset. */
  cloudProvider?: "cursor" | "devin";
  /** Set to render the row disabled with this sentence as its tooltip. */
  unavailableReason?: string | null;
};

const CLOUD_VIOLET = "#A78BFA";

function machineIcon(option: DraftMachineOption) {
  if (option.kind === "cloud" && option.cloudProvider === "devin") {
    return <DevinLogo size={12} className="shrink-0 rounded-[2px]" />;
  }
  return option.kind === "cloud" ? (
    <CloudArrowUp size={12} weight="fill" className="shrink-0" style={{ color: CLOUD_VIOLET }} aria-hidden />
  ) : (
    <DesktopTower size={12} weight="duotone" className="shrink-0 text-amber-400/85" aria-hidden />
  );
}

/**
 * Machine half of the launch shelf's "where does this run" pair.
 *
 * Machine and lane are two orthogonal choices, and folding them into one list
 * made that list carry both — every lane row had to name its machine, and the
 * list grew by machine count rather than staying the length of one machine's
 * lanes. Choosing the machine first means the lane list beside it is always
 * flat, short, and unambiguous.
 *
 * Renders nothing with fewer than two machines unless the current selection is
 * unavailable. That exception keeps the recovery control visible when a
 * persisted remote selection outlives its connection.
 */
export function DraftMachinePicker({
  machines,
  selectedMachineId,
  onChange,
  disabled = false,
  onOpen,
  tooltipLabel = "Where it runs",
  tooltipDescription,
  triggerLabel = "Choose machine",
  showWhenSingle = false,
}: {
  machines: readonly DraftMachineOption[];
  selectedMachineId: string | null;
  onChange: (machineId: string) => void;
  disabled?: boolean;
  /** Fires when the menu opens so callers can retry a failed catalog probe. */
  onOpen?: () => void;
  tooltipLabel?: string;
  tooltipDescription?: string;
  triggerLabel?: string;
  /**
   * With one machine, still name it (a plain pill, no menu) instead of
   * rendering nothing: a surface where the choice would otherwise look missing.
   */
  showWhenSingle?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = machines.find((machine) => machine.id === selectedMachineId) ?? null;
  const displayed = selected ?? machines[0];
  const selectionUnavailable = selectedMachineId != null && selected == null;
  if (
    machines.length < 2
    && !selectionUnavailable
    && !selected?.unavailableReason?.trim()
  ) {
    if (!showWhenSingle || !displayed) return null;
    return (
      <SmartTooltip
        forceEnabled
        content={{
          label: tooltipLabel,
          description: tooltipDescription ?? "Runs on this computer. Pair another computer in Connections to run chats there.",
        }}
      >
        <span
          data-draft-machine-picker
          className="inline-flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md border border-fg/[0.07] bg-fg/[0.03] px-2 font-sans text-[11px] font-medium text-muted-fg/75"
          aria-label={`Runs on ${displayed.name}`}
        >
          {machineIcon(displayed)}
          <span className="min-w-0 truncate">{displayed.name}</span>
        </span>
      </SmartTooltip>
    );
  }
  if (!displayed) return null;
  const availableFallback = machines.find((machine) => !machine.unavailableReason?.trim()) ?? displayed;
  let triggerAriaLabel: string;
  if (selected?.unavailableReason || selectionUnavailable) {
    triggerAriaLabel = `${triggerLabel}, current machine unavailable; fallback ${availableFallback.name}`;
  } else if (selected) {
    triggerAriaLabel = `${triggerLabel}, currently ${selected.name}`;
  } else {
    triggerAriaLabel = `${triggerLabel}, current machine unavailable; fallback ${displayed.name}`;
  }
  const hasCloudOption = machines.some((machine) => machine.kind === "cloud");
  const defaultTriggerDescription = hasCloudOption
    ? "Pick this computer, another paired computer, or Cursor Cloud. The lane list beside it follows your choice."
    : "Pick this computer or another paired computer. The lane list beside it follows your choice.";

  return (
    <DropdownMenu.Root
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) onOpen?.();
      }}
      modal={false}
    >
      <SmartTooltip
        forceEnabled
        content={{
          label: tooltipLabel,
          description: tooltipDescription ?? defaultTriggerDescription,
        }}
      >
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            data-draft-machine-picker
            aria-label={triggerAriaLabel}
            disabled={disabled}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              const nextOpen = !open;
              setOpen(nextOpen);
              if (nextOpen) onOpen?.();
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " " && event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
              event.preventDefault();
              const nextOpen = event.key === "ArrowDown" || event.key === "ArrowUp" ? true : !open;
              setOpen(nextOpen);
              if (nextOpen) onOpen?.();
            }}
            className={cn(
              "inline-flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md border px-2",
              "font-sans text-[11px] font-medium transition-colors",
              open
                ? "border-fg/[0.12] bg-fg/[0.06] text-fg/85"
                : "border-fg/[0.07] bg-fg/[0.03] text-muted-fg/75 hover:bg-fg/[0.06] hover:text-fg/85",
              disabled && "cursor-not-allowed opacity-45",
            )}
          >
            {machineIcon(displayed)}
            <span className="min-w-0 truncate">{displayed.name}</span>
            <CaretDown
              size={9}
              weight="bold"
              className={cn("shrink-0 transition-transform duration-150", open && "rotate-180")}
              aria-hidden
            />
          </button>
        </DropdownMenu.Trigger>
      </SmartTooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          aria-label="Choose a machine"
          className={cn(POPOVER_SURFACE_CLASS, MENU_SCROLL_CLASS, "w-[220px] p-1 font-sans text-[11px] text-fg/82")}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            const selected = event.currentTarget.querySelector<HTMLElement>(
              '[role="menuitemradio"][aria-checked="true"]:not([aria-disabled="true"])',
            );
            const firstAvailable = event.currentTarget.querySelector<HTMLElement>(
              '[role="menuitemradio"]:not([aria-disabled="true"])',
            );
            (selected ?? firstAvailable)?.focus();
          }}
          style={{ zIndex: Z_LAYERS.popover }}
          side="top"
          align="start"
          sideOffset={4}
          collisionPadding={8}
        >
          <DropdownMenu.RadioGroup
            value={selectedMachineId ?? ""}
            onValueChange={(machineId) => {
              if (machineId !== selectedMachineId) onChange(machineId);
            }}
          >
            {machines.map((machine) => {
              const active = machine.id === selectedMachineId;
              const reason = machine.unavailableReason?.trim() || null;
              const row = (
                <DropdownMenu.RadioItem
                  asChild
                  key={machine.id}
                  value={machine.id}
                  disabled={Boolean(reason)}
                  className={cn(MENU_ITEM_CLASS, "text-[11px]", active ? "text-fg/90" : "text-fg/65")}
                >
                  <button
                    type="button"
                    disabled={Boolean(reason)}
                    onKeyDown={(event) => {
                      if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
                      event.preventDefault();
                      event.stopPropagation();
                      const items = Array.from(
                        event.currentTarget.closest('[role="menu"]')?.querySelectorAll<HTMLButtonElement>(
                          '[role="menuitemradio"]:not(:disabled):not([aria-disabled="true"])',
                        ) ?? [],
                      );
                      if (items.length === 0) return;
                      const currentIndex = items.indexOf(event.currentTarget);
                      const nextIndex = event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? items.length - 1
                          : event.key === "ArrowDown"
                            ? (currentIndex + 1) % items.length
                            : (currentIndex - 1 + items.length) % items.length;
                      items[nextIndex]?.focus();
                    }}
                  >
                    {machineIcon(machine)}
                    <span className="min-w-0 flex-1 truncate">{machine.name}</span>
                    <DropdownMenu.ItemIndicator>
                      <Check size={11} weight="bold" className="shrink-0" aria-hidden />
                    </DropdownMenu.ItemIndicator>
                  </button>
                </DropdownMenu.RadioItem>
              );
              if (!reason) return row;
              return (
                <SmartTooltip
                  key={machine.id}
                  forceEnabled
                  content={{ label: machine.name, description: reason }}
                >
                  {row}
                </SmartTooltip>
              );
            })}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
