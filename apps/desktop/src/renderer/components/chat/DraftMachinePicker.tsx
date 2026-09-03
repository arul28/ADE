import { CaretDown, Check, CloudArrowUp, DesktopTower } from "@phosphor-icons/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "../ui/cn";
import { SmartTooltip } from "../ui/SmartTooltip";
import {
  computeLanePopoverPlacement,
  type LanePopoverPlacement,
} from "../terminals/LaneCombobox";

export type DraftMachineOption = {
  id: string;
  name: string;
  /**
   * "cloud" entries are not computers ADE is paired with — they are hosted
   * runtimes (today: Cursor Cloud) that run the chat off-machine. They live in
   * this list because "where does this run" is one question, not two.
   *
   * "plugin" entries are the same idea contributed rather than compiled: a
   * `machine-entry` socket naming a place to run that only the plugin knows
   * about. They carry their own glyph, so this picker never has to learn what
   * any particular plugin is.
   */
  kind?: "machine" | "cloud" | "plugin";
  /**
   * The row's glyph, when the caller draws it. Overrides the compiled pair.
   *
   * Passed as a node rather than an icon name so this component keeps knowing
   * nothing about the plugin icon vocabulary: resolving a `brand:` token needs
   * the declaring plugin's shipped artwork, which is a lookup the caller has
   * already done.
   */
  icon?: ReactNode;
  /** Set to render the row disabled with this sentence as its tooltip. */
  unavailableReason?: string | null;
  /**
   * An inline affordance at the row's end — a contributed row's "Advanced…".
   *
   * Its own control, not a second meaning for the row: selecting a machine and
   * configuring one are different gestures, and someone who wants to set up a
   * run before committing to it should not have to enter the mode first. So it
   * is reachable by keyboard alongside the rows and carries its own accessible
   * name; pressing it never changes the selection.
   */
  advanced?: {
    /** The accessible name. Include the machine — "Advanced" alone is ambiguous. */
    label: string;
    onSelect: () => void;
  } | null;
};

const MENU_WIDTH = 220;
const CLOUD_VIOLET = "#A78BFA";

function machineIcon(option: DraftMachineOption) {
  if (option.icon) return option.icon;
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
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusOnCloseRef = useRef(false);
  const [placement, setPlacement] = useState<LanePopoverPlacement | null>(null);
  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setPlacement(computeLanePopoverPlacement({
      trigger: { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      width: { min: MENU_WIDTH, max: MENU_WIDTH },
    }));
  }, []);

  useLayoutEffect(() => {
    if (!open && restoreFocusOnCloseRef.current) {
      restoreFocusOnCloseRef.current = false;
      triggerRef.current?.focus();
    }
    if (!open) return;
    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open, updatePosition]);

  const closeAndRestoreFocus = useCallback(() => {
    restoreFocusOnCloseRef.current = true;
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (triggerRef.current?.contains(target as Node)) return;
      if (target?.closest?.("[data-draft-machine-menu]")) return;
      setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeAndRestoreFocus();
      }
    };
    window.addEventListener("mousedown", handleDown);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleDown);
      window.removeEventListener("keydown", handleKey);
    };
  }, [closeAndRestoreFocus, open]);

  useEffect(() => {
    if (!open || !menuRef.current) return;
    const preferred = menuRef.current.querySelector<HTMLButtonElement>(
      '[role="menuitemradio"][aria-checked="true"]:not(:disabled)',
    );
    const first = menuRef.current.querySelector<HTMLButtonElement>(
      '[role="menuitemradio"]:not(:disabled)',
    );
    (preferred ?? first)?.focus();
  }, [open]);

  const handleMenuKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    // Both roles, in DOM order: the Advanced affordance sits at the end of the
    // row it belongs to, so arrowing through the menu reaches it right after
    // the machine it configures rather than skipping it entirely.
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="menuitemradio"]:not(:disabled), [role="menuitem"]:not(:disabled)',
      ),
    );
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeAndRestoreFocus();
      return;
    }
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
    if (event.key === "ArrowUp") nextIndex = currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = items.length - 1;
    if (nextIndex != null) {
      event.preventDefault();
      items[nextIndex]?.focus();
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && document.activeElement instanceof HTMLButtonElement) {
      event.preventDefault();
      document.activeElement.click();
    }
  }, [closeAndRestoreFocus]);

  const selected = machines.find((machine) => machine.id === selectedMachineId) ?? null;
  const displayed = selected ?? machines[0];
  const selectionUnavailable = selectedMachineId != null && selected == null;
  if (
    machines.length < 2
    && !selectionUnavailable
    && !selected?.unavailableReason?.trim()
  ) return null;
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
    <div className="relative inline-flex shrink-0">
      <SmartTooltip
        forceEnabled
        content={{
          label: tooltipLabel,
          description: tooltipDescription ?? defaultTriggerDescription,
        }}
      >
        <button
          ref={triggerRef}
          type="button"
          data-draft-machine-picker
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={triggerAriaLabel}
          disabled={disabled}
          // `onOpen` runs outside the state updater on purpose. React may call
          // an updater during another component's render and may call it twice,
          // so a probe fired from inside it warns about updating the parent
          // mid-render and can run twice per click.
          onClick={() => {
            const next = !open;
            setOpen(next);
            if (next) onOpen?.();
          }}
          className={cn(
            "inline-flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md border px-2",
            "font-sans text-[11px] font-medium transition-colors",
            open
              ? "border-white/[0.12] bg-white/[0.06] text-fg/85"
              : "border-white/[0.07] bg-white/[0.03] text-muted-fg/75 hover:bg-white/[0.06] hover:text-fg/85",
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
      </SmartTooltip>
      {open && triggerRef.current
        ? createPortal(
            (() => {
              return (
                <div
                  ref={menuRef}
                  data-draft-machine-menu
                  role="menu"
                  aria-label="Choose a machine"
                  onKeyDown={handleMenuKeyDown}
                  className="fixed z-[100] flex flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-[#13111A]/95 p-1 shadow-[0_18px_48px_rgba(0,0,0,0.55)] backdrop-blur-md"
                  style={{
                    width: placement?.width ?? MENU_WIDTH,
                    left: placement?.left ?? 0,
                    maxHeight: placement?.maxHeight,
                    top: placement?.top ?? 0,
                    transform: placement?.transform,
                  }}
                >
                  {machines.map((machine) => {
                    const active = machine.id === selectedMachineId;
                    const reason = machine.unavailableReason?.trim() || null;
                    const advanced = machine.advanced ?? null;
                    const row = (
                      <button
                        key={machine.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={active}
                        disabled={Boolean(reason)}
                        onClick={() => {
                          closeAndRestoreFocus();
                          if (!active) onChange(machine.id);
                        }}
                        className={cn(
                          "flex items-center gap-2 rounded-md px-2 py-1.5 text-left font-sans text-[11px] transition-colors",
                          advanced ? "min-w-0 flex-1" : "",
                          active ? "text-fg/90" : "text-fg/65 hover:bg-white/[0.06] hover:text-fg/90",
                          reason && "cursor-not-allowed opacity-40 hover:bg-transparent",
                        )}
                      >
                        {machineIcon(machine)}
                        <span className="min-w-0 truncate">{machine.name}</span>
                        {active ? <Check size={11} weight="bold" className="ml-auto shrink-0" aria-hidden /> : null}
                      </button>
                    );
                    const withTooltip = reason
                      ? (
                        <SmartTooltip
                          key={machine.id}
                          forceEnabled
                          content={{ label: machine.name, description: reason }}
                        >
                          {row}
                        </SmartTooltip>
                      )
                      : row;
                    if (!advanced) return withTooltip;
                    // A button inside a button is invalid markup and swallows
                    // the inner click, so the pair sits side by side in a row
                    // wrapper rather than nested. The radio keeps its own role;
                    // Advanced is a plain menu item beside it.
                    return (
                      <div key={machine.id} className="flex items-center gap-1">
                        {withTooltip}
                        <button
                          type="button"
                          role="menuitem"
                          aria-label={advanced.label}
                          data-draft-machine-advanced={machine.id}
                          onClick={(event) => {
                            // Never a selection. Advanced configures a run; it
                            // does not commit the composer to one.
                            event.stopPropagation();
                            closeAndRestoreFocus();
                            advanced.onSelect();
                          }}
                          className="shrink-0 rounded-md px-1.5 py-1 font-sans text-[10px] text-muted-fg/55 transition-colors hover:bg-white/[0.06] hover:text-fg/85"
                        >
                          Advanced…
                        </button>
                      </div>
                    );
                  })}
                </div>
              );
            })(),
            document.body,
          )
        : null}
    </div>
  );
}
