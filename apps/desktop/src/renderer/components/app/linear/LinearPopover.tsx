import React, { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { CaretDown, Check } from "@phosphor-icons/react";
import { AnchoredMenu } from "../../ui/AnchoredMenu";
import { cn } from "../../ui/cn";
import { useEscapeLayer } from "../../ui/useEscapeLayer";
import { Z_LAYERS } from "../../ui/zLayers";

/**
 * Small popover kit for the issue list's toolbar (Display, Filter). Escape
 * closes the innermost layer (a dropdown, then the popover) through
 * `useEscapeLayer`, never the Linear pane's dialog behind it.
 */

export function LinearPopover({
  open,
  anchorRef,
  onClose,
  label,
  width = 320,
  children,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  label: string;
  width?: number;
  children: React.ReactNode;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEscapeLayer(open, onClose);

  // Focus moves into the popover on open and back to its button on close.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const anchor = anchorRef.current;
    let body: HTMLDivElement | null = null;
    const frame = window.requestAnimationFrame(() => {
      body = bodyRef.current;
      body?.querySelector<HTMLElement>("button, [tabindex='0'], input, select")?.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      const active = document.activeElement;
      // Focus inside the popover (or lost with it) goes back to the button.
      if (anchor && (!active || active === document.body || (body && body.contains(active)))) anchor.focus({ preventScroll: true });
    };
  }, [anchorRef, open]);

  return (
    <AnchoredMenu open={open} anchorRef={anchorRef} onClose={onClose} placement="bottom-end" offset={6} zIndex={Z_LAYERS.dialogPopover}>
      <div
        ref={bodyRef}
        role="dialog"
        aria-label={label}
        data-linear-popover="true"
        className="rounded-[10px] border border-fg/[0.09] bg-[color:var(--color-popup-bg,var(--ade-shell-surface,#151325))] text-fg shadow-[0_16px_48px_-12px_rgba(0,0,0,0.55),0_0_0_0.5px_rgba(0,0,0,0.2)]"
        style={{ width }}
      >
        {children}
      </div>
    </AnchoredMenu>
  );
}

export type LinearMenuOption<T extends string> = { value: T; label: string; icon?: React.ReactNode };

/** A select-style dropdown that lives inside a popover (no portal, no native list). */
export function LinearMenuSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<LinearMenuOption<T>>;
  onChange: (value: T) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const current = options.find((option) => option.value === value) ?? options[0];
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus({ preventScroll: true });
  };
  useEscapeLayer(open, () => close());

  useEffect(() => {
    if (!open) return undefined;
    setHighlight(Math.max(0, options.findIndex((option) => option.value === value)));
    listRef.current?.focus({ preventScroll: true });
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && (listRef.current?.contains(target) || buttonRef.current?.contains(target))) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
    // Opening reads the value once; later changes close the list anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    close();
  };

  return (
    <div className={cn("relative", className)}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        className="flex h-7 w-full items-center gap-1.5 rounded-md border border-fg/[0.09] bg-fg/[0.03] px-2 text-left text-[12.5px] text-fg/90 outline-none transition-colors hover:bg-fg/[0.06] focus-visible:border-fg/25"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {current?.icon ? <span className="grid shrink-0 place-items-center text-muted-fg">{current.icon}</span> : null}
        <span className="min-w-0 flex-1 truncate">{current?.label}</span>
        <CaretDown size={10} className="shrink-0 text-muted-fg/70" />
      </button>
      {open ? (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={`${listId}-${highlight}`}
          className="absolute right-0 top-[calc(100%+4px)] z-10 max-h-[280px] min-w-full overflow-y-auto rounded-lg border border-fg/[0.09] bg-[color:var(--color-popup-bg,var(--ade-shell-surface,#151325))] p-1 shadow-[0_12px_32px_-10px_rgba(0,0,0,0.55)] outline-none"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setHighlight((index) => Math.min(options.length - 1, index + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setHighlight((index) => Math.max(0, index - 1));
            } else if (event.key === "Home") {
              event.preventDefault();
              setHighlight(0);
            } else if (event.key === "End") {
              event.preventDefault();
              setHighlight(options.length - 1);
            } else if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.stopPropagation();
              choose(highlight);
            } else if (event.key === "Tab") {
              close(false);
            }
          }}
        >
          {options.map((option, index) => {
            const selected = option.value === value;
            return (
              <div
                key={option.value}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={selected}
                className={cn(
                  "flex h-7 cursor-pointer items-center gap-2 whitespace-nowrap rounded-md px-2 text-[12.5px]",
                  index === highlight ? "bg-fg/[0.07] text-fg" : "text-fg/80",
                )}
                onMouseEnter={() => setHighlight(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(index)}
              >
                {option.icon ? <span className="grid w-4 shrink-0 place-items-center text-muted-fg">{option.icon}</span> : null}
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {selected ? <Check size={12} className="shrink-0 text-fg/70" /> : <span className="w-3 shrink-0" />}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function LinearSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className="group/switch flex h-8 w-full items-center justify-between gap-3 rounded-md px-2 text-left text-[12.5px] text-fg/85 outline-none transition-colors hover:bg-fg/[0.04] focus-visible:bg-fg/[0.06]"
      onClick={() => onChange(!checked)}
    >
      <span>{label}</span>
      <span
        aria-hidden="true"
        className={cn(
          "relative h-4 w-[26px] shrink-0 rounded-full transition-colors",
          checked ? "bg-[#5E6AD2]" : "bg-fg/[0.16]",
        )}
      >
        <span
          className={cn(
            "absolute top-[2px] h-3 w-3 rounded-full bg-white shadow-sm transition-transform",
            checked ? "translate-x-[12px]" : "translate-x-[2px]",
          )}
        />
      </span>
    </button>
  );
}
