import { CaretDown, Check, CloudArrowUp, DesktopTower, Scales } from "@phosphor-icons/react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { DevinLogo } from "../shared/ProviderLogos";
import { CloudMark } from "../remoteTargets/cloudBrand";
import { cn } from "../ui/cn";
import { MENU_ITEM_CLASS, MENU_SCROLL_CLASS, POPOVER_SURFACE_CLASS } from "../ui/paneMenuTokens";
import { usePortalContainer } from "../ui/portalContainer";
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
  cloudProvider?: "cursor" | "devin" | "cloud";
  /** Set to render the row disabled with this sentence as its tooltip. */
  unavailableReason?: string | null;
  /** A second line under the name: what picking it does first ("Clone the project here"). */
  detail?: string | null;
  /**
   * The row's facts are not known yet (ADE Cloud before the first account
   * read): the second line keeps its space, empty, so the
   * answer fills them in place without a claim before it.
   */
  detailPending?: boolean;
  /** Draw a divider above this row (ADE Cloud sits apart from the computers). */
  separatorBefore?: boolean;
};

const CLOUD_VIOLET = "#A78BFA";

/** Every row's icon sits in the same 14px box, so names line up whatever the icon. */
function machineIcon(option: DraftMachineOption) {
  let icon;
  if (option.kind === "cloud" && option.cloudProvider === "devin") {
    icon = <DevinLogo size={12} className="shrink-0 rounded-[2px]" />;
  } else if (option.kind === "cloud" && option.cloudProvider === "cloud") {
    icon = <CloudMark size={13} brand bold />;
  } else if (option.kind === "cloud") {
    icon = <CloudArrowUp size={12} weight="fill" className="shrink-0" style={{ color: CLOUD_VIOLET }} aria-hidden />;
  } else {
    icon = <DesktopTower size={12} weight="duotone" className="shrink-0 text-amber-400/85" aria-hidden />;
  }
  return <span className="inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center" aria-hidden>{icon}</span>;
}

/** The line under a row's name when its caller gave none, so every row has the same two lines. */
function fallbackLine(option: DraftMachineOption): string {
  if (option.kind === "cloud") return option.cloudProvider === "cloud" ? "A computer for each lane" : "Runs in the cloud";
  return "Connected";
}

/**
 * Arrow keys, Home and End over every row that can be picked: "Least loaded"
 * and the machines, in menu order, wrapping at the ends.
 */
function moveAmongRows(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
  event.preventDefault();
  event.stopPropagation();
  const items = Array.from(
    event.currentTarget.closest('[role="menu"]')?.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not([aria-disabled="true"]):not([data-disabled]), [role="menuitemradio"]:not(:disabled):not([aria-disabled="true"])',
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
  side = "top",
  autoPick = null,
  autoPickUnavailableReason = null,
  menuLabel = null,
  onPointerClose,
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
  /**
   * Preferred side of the trigger. `"top"` suits the draft shelf at the bottom
   * of the window; a top-bar host passes `"bottom"` so the menu does not cover
   * the dialog header. Radix still flips when the preferred side has no room.
   */
  side?: "top" | "bottom";
  /**
   * "Least loaded": the machine new work would go to by its load and its
   * placement preference (`autoLaneMachine`), offered above the machines.
   * Picking it picks that machine; nothing moves later by itself.
   */
  autoPick?: { machineId: string; summary: string } | null;
  /**
   * Shows "Least loaded" off with this sentence, so the menu keeps the same
   * rows in the same places when the pick makes it not apply.
   */
  autoPickUnavailableReason?: string | null;
  /** A small heading at the top of the menu ("Run on"). */
  menuLabel?: string | null;
  /**
   * The menu closed after a pointer press in it. The caller puts focus where
   * the person works (the prompt box); without it focus stays where it is.
   */
  onPointerClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // The last input in the open menu was the pointer: closing then keeps focus where it is.
  const closedByPointerRef = useRef(false);
  // The menu is about to give focus back to the trigger after a keyboard pick
  // or Escape: that focus must not open the trigger's tooltip over the prompt.
  const returningFocusRef = useRef(false);
  // Inside a modal dialog, a body portal sits under the dialog's scrim (and the
  // dialog blocks clicks outside its content). Portal into the panel instead,
  // the same way the lane combobox and composer chips do.
  const portalContainer = usePortalContainer();
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
  const adeCloudSelected = selected?.kind === "cloud" && selected.cloudProvider === "cloud";
  const cloudNames = [
    ...(machines.some((machine) => machine.kind === "cloud" && machine.cloudProvider === "cloud") ? ["ADE Cloud"] : []),
    ...(machines.some((machine) => machine.kind === "cloud" && machine.cloudProvider === "cursor") ? ["Cursor Cloud"] : []),
    ...(machines.some((machine) => machine.kind === "cloud" && machine.cloudProvider === "devin") ? ["Devin Cloud"] : []),
  ];
  const defaultTriggerDescription = hasCloudOption && cloudNames.length
    ? `Pick this computer, another paired computer, or ${cloudNames.join(", ")}. The lane list beside it follows your choice.`
    : "Pick this computer or another paired computer. The lane list beside it follows your choice.";
  // The pick itself comes first, so the tooltip says where this draft runs now.
  const selectedLine = adeCloudSelected
    ? "Runs on ADE Cloud: a new lane gets its own computer, and a lane you pick runs on the computer it has."
    : selected && !selected.unavailableReason
      ? `Runs on ${selected.name}.`
      : null;

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
          description: tooltipDescription ?? (selectedLine ? `${selectedLine} ${defaultTriggerDescription}` : defaultTriggerDescription),
        }}
      >
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            data-draft-machine-picker
            aria-label={triggerAriaLabel}
            disabled={disabled}
            onPointerDown={(event) => event.preventDefault()}
            onFocus={(event) => {
              if (!returningFocusRef.current) return;
              returningFocusRef.current = false;
              // Keep the tooltip (SmartTooltip listens on its wrapper) for a
              // hover or a real keyboard move onto the trigger.
              event.stopPropagation();
            }}
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
      <DropdownMenu.Portal container={portalContainer ?? undefined}>
        <DropdownMenu.Content
          aria-label="Choose a machine"
          onFocusCapture={(event) => {
            if (event.target !== event.currentTarget) return;
            const content = event.currentTarget;
            const focusSelected = () => {
              const selected = content.querySelector<HTMLElement>(
                '[role="menuitemradio"][aria-checked="true"]:not([aria-disabled="true"])',
              );
              const firstAvailable = content.querySelector<HTMLElement>(
                '[role="menuitemradio"]:not([aria-disabled="true"])',
              );
              (selected ?? firstAvailable)?.focus();
            };
            focusSelected();
            // A keyboard open: the menu's own entry focus runs after this
            // handler and moves to the first row. Put focus back on the
            // selected row once that event is done (a microtask, no timer).
            queueMicrotask(focusSelected);
          }}
          onPointerDownCapture={() => { closedByPointerRef.current = true; }}
          onKeyDownCapture={() => { closedByPointerRef.current = false; }}
          onCloseAutoFocus={(event) => {
            // A pick with the mouse puts focus back in the prompt box (or
            // leaves it where it is), so the trigger's tooltip does not open
            // over the prompt. A keyboard pick or Escape returns focus to the
            // trigger as usual, with no tooltip.
            if (closedByPointerRef.current) {
              event.preventDefault();
              closedByPointerRef.current = false;
              onPointerClose?.();
              return;
            }
            returningFocusRef.current = true;
            // The menu focuses the trigger in this same event. If it does not,
            // the next real focus still shows the tooltip.
            queueMicrotask(() => { returningFocusRef.current = false; });
          }}
          className={cn(POPOVER_SURFACE_CLASS, MENU_SCROLL_CLASS, "w-[320px] p-1 font-sans text-[11px] text-fg/82")}
          style={{ zIndex: portalContainer ? Z_LAYERS.dialogPopover : Z_LAYERS.popover }}
          side={side}
          align="start"
          sideOffset={4}
          collisionPadding={8}
        >
          {menuLabel ? <div className="adec-menu-label" aria-hidden>{menuLabel}</div> : null}
          {autoPick ? (
            <>
              <SmartTooltip
                forceEnabled={Boolean(autoPickUnavailableReason)}
                wrapperStyle={{ display: "flex", width: "100%" }}
                content={{ label: "Least loaded", description: autoPickUnavailableReason ?? "" }}
              >
                <DropdownMenu.Item
                  disabled={Boolean(autoPickUnavailableReason)}
                  className={cn(MENU_ITEM_CLASS, "min-h-[30px] w-full items-center gap-2 text-left text-[11px] text-fg/75")}
                  onSelect={() => {
                    if (autoPick.machineId !== selectedMachineId) onChange(autoPick.machineId);
                  }}
                  onKeyDown={moveAmongRows}
                >
                  <span className="inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center" aria-hidden>
                    <Scales size={12} weight="duotone" className="text-muted-fg/80" />
                  </span>
                  <span className="shrink-0 truncate">Least loaded</span>
                  <span className="min-w-0 flex-1 truncate text-right text-[10px] tabular-nums text-muted-fg/60" title={autoPick.summary}>{autoPick.summary}</span>
                  <span className="w-[11px] shrink-0" aria-hidden />
                </DropdownMenu.Item>
              </SmartTooltip>
              <DropdownMenu.Separator className="my-1 h-px bg-fg/[0.06]" />
            </>
          ) : null}
          <DropdownMenu.RadioGroup
            value={selectedMachineId ?? ""}
            onValueChange={(machineId) => {
              if (machineId !== selectedMachineId) onChange(machineId);
            }}
          >
            {machines.map((machine) => {
              const active = machine.id === selectedMachineId;
              const reason = machine.unavailableReason?.trim() || null;
              // A row that can't be picked says why on its right, not only on hover.
              const secondLine = reason ?? (machine.detail?.trim() || null);
              const row = (
                <DropdownMenu.RadioItem
                  asChild
                  value={machine.id}
                  disabled={Boolean(reason)}
                  className={cn(
                    MENU_ITEM_CLASS,
                    // One line per row: the name, then its status on the right (B14-14).
                    "min-h-[30px] w-full items-center gap-2 text-left text-[11px]",
                    active ? "text-fg/90" : "text-fg/70",
                  )}
                >
                  <button
                    type="button"
                    disabled={Boolean(reason)}
                    onKeyDown={moveAmongRows}
                  >
                    <span className="flex shrink-0">{machineIcon(machine)}</span>
                    <span className="min-w-0 max-w-[48%] shrink-0 truncate font-medium">{machine.name}</span>
                    <span
                      className={cn("min-w-0 flex-1 truncate text-right text-[10px] tabular-nums", reason ? "text-[var(--kit-warn)]" : "text-muted-fg/60")}
                      title={secondLine ?? undefined}
                    >
                      {machine.detailPending && !secondLine ? "\u00a0" : secondLine ?? fallbackLine(machine)}
                    </span>
                    {/* The check keeps its place when not shown, so names never shift. */}
                    <span className="flex w-[11px] shrink-0 justify-end">
                      <DropdownMenu.ItemIndicator>
                        <Check size={11} weight="bold" className="shrink-0" aria-hidden />
                      </DropdownMenu.ItemIndicator>
                    </span>
                  </button>
                </DropdownMenu.RadioItem>
              );
              // Every row keeps the same wrapper whether or not it has a
              // reason: swapping the element type remounted the row (and
              // dropped keyboard focus) each time a reason came or went.
              return (
                <div key={machine.id} className="contents">
                  {machine.separatorBefore ? <DropdownMenu.Separator className="my-1 h-px bg-fg/[0.06]" /> : null}
                  <SmartTooltip
                    forceEnabled={Boolean(reason)}
                    wrapperStyle={{ display: "flex", width: "100%" }}
                    content={{ label: machine.name, description: reason ?? "" }}
                  >
                    {row}
                  </SmartTooltip>
                </div>
              );
            })}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
