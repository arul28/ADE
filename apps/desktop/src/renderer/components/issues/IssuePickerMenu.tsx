import React, { useEffect, useMemo, useRef, useState } from "react";
import { Check } from "@phosphor-icons/react";
import { LinearAssigneeAvatar } from "../app/LinearIssueBrowserRows";
import { AnchoredMenu } from "../ui/AnchoredMenu";
import { cn } from "../ui/cn";
import { MENU_ITEM_CLASS, MENU_SURFACE_CLASS } from "../ui/paneMenuTokens";
import { Z_LAYERS } from "../ui/zLayers";

export type PickerOption = {
  id: string;
  label: string;
  icon?: React.ReactNode;
  keywords?: string;
};

const MAX_VISIBLE_OPTIONS = 120;

/**
 * A filterable option list in an `AnchoredMenu`. Escape closes the menu only:
 * a window capture listener stops the key before the host dialog's own
 * Escape handler (Radix listens on the document in capture) can close the pane.
 */
export function PickerMenu({
  open,
  anchorRef,
  onClose,
  options,
  selectedIds,
  multi = false,
  placeholder,
  onPick,
}: {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  options: PickerOption[];
  selectedIds: Set<string>;
  multi?: boolean;
  placeholder: string;
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? options.filter((option) => `${option.label} ${option.keywords ?? ""}`.toLowerCase().includes(needle))
      : options;
    return matches.slice(0, MAX_VISIBLE_OPTIONS);
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHighlight(0);
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  useEffect(() => {
    setHighlight((current) => Math.min(current, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  return (
    <AnchoredMenu
      open={open}
      anchorRef={anchorRef}
      onClose={onClose}
      zIndex={Z_LAYERS.dialogPopover}
      remeasureKey={filtered.length}
      className={cn(MENU_SURFACE_CLASS, "w-[240px]")}
    >
      <input
        ref={inputRef}
        value={query}
        placeholder={placeholder}
        onChange={(event) => {
          setQuery(event.target.value);
          setHighlight(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setHighlight((current) => Math.min(filtered.length - 1, current + 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setHighlight((current) => Math.max(0, current - 1));
          } else if (event.key === "Enter") {
            event.preventDefault();
            const option = filtered[highlight];
            if (option) onPick(option.id);
          }
        }}
        className="mb-1 h-7 w-full rounded-[var(--radius-sm)] border border-fg/[0.07] bg-black/20 px-2 text-[11.5px] text-fg outline-none placeholder:text-muted-fg/40 focus:border-fg/18"
      />
      <div className="max-h-[260px] overflow-y-auto overscroll-contain" role="listbox" aria-multiselectable={multi || undefined}>
        {filtered.length === 0 ? (
          <div className="px-2 py-2 text-[11px] text-muted-fg/50">No matches</div>
        ) : filtered.map((option, index) => {
          const selected = selectedIds.has(option.id);
          return (
            <button
              key={option.id || "__none__"}
              type="button"
              role="option"
              aria-selected={selected}
              data-highlighted={index === highlight ? "" : undefined}
              className={cn(MENU_ITEM_CLASS, "w-full text-left")}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => onPick(option.id)}
            >
              {option.icon ? <span className="grid w-4 shrink-0 place-items-center">{option.icon}</span> : null}
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {selected ? <Check size={11} weight="bold" className="shrink-0 text-fg/70" /> : null}
            </button>
          );
        })}
      </div>
    </AnchoredMenu>
  );
}

/** A GitHub label as a picker option, with its color dot. */
export function githubLabelOptions(labels: Array<{ name: string; color: string | null }>): PickerOption[] {
  return labels.map((label) => ({
    id: label.name,
    label: label.name,
    icon: <span className="block h-2 w-2 rounded-full" style={{ backgroundColor: label.color ?? "var(--kit-fill)" }} />,
  }));
}

/** A GitHub person as a picker option, with their avatar. */
export function githubPersonOptions(people: Array<{ login: string; avatarUrl: string | null }>): PickerOption[] {
  return people.map((person) => ({
    id: person.login,
    label: person.login,
    icon: <LinearAssigneeAvatar name={person.login} avatarUrl={person.avatarUrl} size={14} />,
  }));
}
