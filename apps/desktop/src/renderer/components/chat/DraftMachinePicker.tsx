import { CaretDown, Check, DesktopTower } from "@phosphor-icons/react";
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
};

const MENU_WIDTH = 220;

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
}: {
  machines: readonly DraftMachineOption[];
  selectedMachineId: string | null;
  onChange: (machineId: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
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
    if (!open) return;
    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open, updatePosition]);

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
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("mousedown", handleDown);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleDown);
      window.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  if (machines.length < 2) return null;

  const selected = machines.find((machine) => machine.id === selectedMachineId) ?? machines[0];
  if (!selected) return null;

  return (
    <div className="relative inline-flex shrink-0">
      <SmartTooltip
        forceEnabled
        content={{
          label: "Machine",
          description: "Which computer this chat runs on. The lane list beside it follows your choice.",
        }}
      >
        <button
          ref={triggerRef}
          type="button"
          data-draft-machine-picker
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Choose machine, currently ${selected.name}`}
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
          className={cn(
            "inline-flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md border px-2",
            "font-sans text-[11px] font-medium transition-colors",
            open
              ? "border-white/[0.12] bg-white/[0.06] text-fg/85"
              : "border-white/[0.07] bg-white/[0.03] text-muted-fg/75 hover:bg-white/[0.06] hover:text-fg/85",
            disabled && "cursor-not-allowed opacity-45",
          )}
        >
          <DesktopTower size={12} weight="duotone" className="shrink-0 text-amber-400/85" aria-hidden />
          <span className="min-w-0 truncate">{selected.name}</span>
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
                  data-draft-machine-menu
                  role="menu"
                  aria-label="Choose a machine"
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
                    const active = machine.id === selected.id;
                    return (
                      <button
                        key={machine.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={active}
                        onClick={() => {
                          setOpen(false);
                          if (!active) onChange(machine.id);
                          triggerRef.current?.focus();
                        }}
                        className={cn(
                          "flex items-center gap-2 rounded-md px-2 py-1.5 text-left font-sans text-[11px] transition-colors",
                          active ? "text-fg/90" : "text-fg/65 hover:bg-white/[0.06] hover:text-fg/90",
                        )}
                      >
                        <DesktopTower size={12} weight="duotone" className="shrink-0 text-amber-400/85" aria-hidden />
                        <span className="min-w-0 truncate">{machine.name}</span>
                        {active ? <Check size={11} weight="bold" className="ml-auto shrink-0" aria-hidden /> : null}
                      </button>
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
