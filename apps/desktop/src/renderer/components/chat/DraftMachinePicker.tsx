import { CaretDown, Check, CloudArrowUp, DesktopTower } from "@phosphor-icons/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
   */
  kind?: "machine" | "cloud";
  /** Set to render the row disabled with this sentence as its tooltip. */
  unavailableReason?: string | null;
};

const MENU_WIDTH = 220;
const CLOUD_VIOLET = "#A78BFA";

function machineIcon(option: DraftMachineOption) {
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
 * Renders nothing with fewer than two machines: there is no choice to make, and
 * the shelf should not spend a control saying so.
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
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="menuitemradio"]:not(:disabled)',
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

  if (machines.length < 2) return null;

  const selected = machines.find((machine) => machine.id === selectedMachineId) ?? null;
  const displayed = selected ?? machines[0];
  if (!displayed) return null;
  const triggerAriaLabel = selected
    ? `${triggerLabel}, currently ${selected.name}`
    : `${triggerLabel}, current machine unavailable; fallback ${displayed.name}`;
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
          onClick={() => setOpen((current) => {
            const next = !current;
            if (next) onOpen?.();
            return next;
          })}
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
                    ...(placement?.bottom !== undefined
                      ? { bottom: placement.bottom }
                      : { top: placement?.top ?? 0 }),
                  }}
                >
                  {machines.map((machine) => {
                    const active = machine.id === selectedMachineId;
                    const reason = machine.unavailableReason?.trim() || null;
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
                          active ? "text-fg/90" : "text-fg/65 hover:bg-white/[0.06] hover:text-fg/90",
                          reason && "cursor-not-allowed opacity-40 hover:bg-transparent",
                        )}
                      >
                        {machineIcon(machine)}
                        <span className="min-w-0 truncate">{machine.name}</span>
                        {active ? <Check size={11} weight="bold" className="ml-auto shrink-0" aria-hidden /> : null}
                      </button>
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
                </div>
              );
            })(),
            document.body,
          )
        : null}
    </div>
  );
}
