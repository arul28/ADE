import React, { useRef, useState } from "react";
import { CalendarBlank, CaretLeft, CaretRight } from "@phosphor-icons/react";
import { AnchoredMenu } from "../ui/AnchoredMenu";
import { MENU_SURFACE_CLASS } from "../ui/paneMenuTokens";
import { Z_LAYERS } from "../ui/zLayers";
import { cn } from "../ui/cn";

const DUE_DATE_FORMAT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

function isoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateFromIso(value: string | null): Date | null {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

export function IssueDueDatePicker({
  value,
  disabled = false,
  ariaLabel = "Due date",
  onPick,
}: {
  value: string | null;
  disabled?: boolean;
  ariaLabel?: string;
  onPick: (value: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => {
    const selected = dateFromIso(value) ?? new Date();
    return new Date(selected.getFullYear(), selected.getMonth(), 1);
  });
  const anchorRef = useRef<HTMLButtonElement>(null);
  const selected = dateFromIso(value);
  const weekdayOffset = (month.getDay() + 6) % 7;
  const dayCount = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cellCount = Math.ceil((weekdayOffset + dayCount) / 7) * 7;
  const cells = Array.from({ length: cellCount }, (_, index) => {
    const day = index - weekdayOffset + 1;
    return day > 0 && day <= dayCount ? new Date(month.getFullYear(), month.getMonth(), day) : null;
  });
  const monthLabel = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(month);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          const date = dateFromIso(value) ?? new Date();
          setMonth(new Date(date.getFullYear(), date.getMonth(), 1));
          setOpen(true);
        }}
        className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-fg/[0.08] bg-fg/[0.02] px-2 text-[11.5px] text-fg/85 transition-colors hover:border-fg/[0.16] hover:bg-fg/[0.05] disabled:cursor-default disabled:opacity-70"
      >
        <CalendarBlank size={12} className="shrink-0 text-[color:var(--kit-text-3)]" />
        <span className="truncate">{selected ? DUE_DATE_FORMAT.format(selected) : "None"}</span>
      </button>
      <AnchoredMenu
        open={open}
        anchorRef={anchorRef}
        onClose={() => setOpen(false)}
        zIndex={Z_LAYERS.dialogPopover}
        className={`${MENU_SURFACE_CLASS} w-[248px] p-2`}
      >
        <div className="mb-2 flex items-center justify-between">
          <button
            type="button"
            aria-label="Previous month"
            className="kit-icon-btn h-6 w-6"
            onClick={() => setMonth((current) => new Date(current.getFullYear(), current.getMonth() - 1, 1))}
          >
            <CaretLeft size={12} />
          </button>
          <span className="text-[11.5px] font-medium text-fg/85">{monthLabel}</span>
          <button
            type="button"
            aria-label="Next month"
            className="kit-icon-btn h-6 w-6"
            onClick={() => setMonth((current) => new Date(current.getFullYear(), current.getMonth() + 1, 1))}
          >
            <CaretRight size={12} />
          </button>
        </div>
        <div className="grid grid-cols-7 gap-0.5 text-center text-[9.5px] text-muted-fg/55" aria-hidden="true">
          {["M", "T", "W", "T", "F", "S", "S"].map((day, index) => <span key={`${day}-${index}`} className="py-1">{day}</span>)}
        </div>
        <div className="grid grid-cols-7 gap-0.5" role="grid" aria-label={monthLabel}>
          {cells.map((date, index) => {
            if (!date) return <span key={`empty-${index}`} aria-hidden="true" />;
            const dayValue = isoDate(date);
            const isSelected = value === dayValue;
            const isToday = dayValue === isoDate(new Date());
            return (
              <button
                key={dayValue}
                type="button"
                role="gridcell"
                aria-label={date.toLocaleDateString()}
                aria-selected={isSelected}
                onClick={() => { onPick(dayValue); setOpen(false); }}
                className={cn(
                  "grid h-7 place-items-center rounded-md text-[11px] transition-colors hover:bg-fg/[0.08]",
                  isSelected && "bg-[color:var(--color-accent)] text-accent-fg hover:bg-[color:var(--color-accent)]",
                  isToday && !isSelected && "border border-fg/[0.18]",
                )}
              >
                {date.getDate()}
              </button>
            );
          })}
        </div>
        <div className="mt-2 flex items-center justify-between border-t border-fg/[0.06] pt-2">
          <button type="button" className="kit-btn kit-btn-ghost h-6 px-2 text-[10.5px]" onClick={() => { onPick(isoDate(new Date())); setOpen(false); }}>
            Today
          </button>
          <button type="button" className="kit-btn kit-btn-ghost h-6 px-2 text-[10.5px]" disabled={!value} onClick={() => { onPick(null); setOpen(false); }}>
            Clear
          </button>
        </div>
      </AnchoredMenu>
    </>
  );
}
