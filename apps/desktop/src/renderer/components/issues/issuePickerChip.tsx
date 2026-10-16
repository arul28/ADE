import React, { useRef, useState } from "react";
import { cn } from "../ui/cn";
import { PickerMenu, type PickerOption } from "./IssuePickerMenu";

function Chip({
  label,
  children,
  anchorRef,
  onClick,
  muted,
  disabled,
}: {
  label: string;
  children: React.ReactNode;
  anchorRef?: React.RefObject<HTMLButtonElement>;
  onClick: () => void;
  muted?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      ref={anchorRef}
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 min-w-0 max-w-[220px] items-center gap-1.5 rounded-md border border-fg/[0.08] bg-fg/[0.02] px-2 text-[11.5px] transition-colors hover:border-fg/[0.16] hover:bg-fg/[0.05]",
        muted ? "text-[color:var(--kit-text-3)]" : "text-fg/85",
        disabled && "cursor-not-allowed opacity-50 hover:border-fg/[0.08] hover:bg-fg/[0.02]",
      )}
    >
      {children}
    </button>
  );
}

/** A chip that opens the shared filterable picker. */
export function ChipPicker({
  label,
  display,
  options,
  selected,
  multi,
  placeholder,
  onOpen,
  onPick,
  muted,
  disabled,
}: {
  label: string;
  display: React.ReactNode;
  options: PickerOption[];
  selected: string[];
  multi?: boolean;
  placeholder: string;
  onOpen?: () => void;
  onPick: (id: string) => void;
  muted?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Chip label={label} anchorRef={ref} muted={muted} disabled={disabled} onClick={() => { if (disabled) return; onOpen?.(); setOpen(true); }}>{display}</Chip>
      <PickerMenu
        open={open && !disabled}
        anchorRef={ref}
        onClose={() => setOpen(false)}
        options={options}
        selectedIds={new Set(selected)}
        multi={multi}
        placeholder={placeholder}
        onPick={(id) => {
          if (!multi) setOpen(false);
          onPick(id);
        }}
      />
    </>
  );
}
