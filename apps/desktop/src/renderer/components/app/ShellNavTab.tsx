import type { CSSProperties, ReactNode } from "react";
import { X } from "@phosphor-icons/react";

import { cn } from "../ui/cn";

type ShellNavTabProps = {
  active: boolean;
  label?: string;
  onActivate?: () => void;
  onClose?: () => void;
  closeTitle?: string;
  closeDisabled?: boolean;
  children: ReactNode;
  className?: string;
};

export function ShellNavTab({
  active,
  label,
  onActivate,
  onClose,
  closeTitle,
  closeDisabled = false,
  children,
  className,
}: ShellNavTabProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      className={cn(
        "ade-shell-project-tab group inline-flex w-[clamp(128px,16vw,220px)] max-w-[220px] min-w-0 items-center gap-1.5 px-2.5",
        "cursor-pointer font-semibold transition-[background-color,color,border-color,box-shadow] duration-150",
        className,
      )}
      data-state={active ? "active" : undefined}
      style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
      onClick={onActivate}
      onKeyDown={(event) => {
        if (
          onActivate &&
          (event.key === "Enter" || event.key === " ")
        ) {
          event.preventDefault();
          onActivate();
        }
      }}
    >
      {children}
      {onClose ? <button
        type="button"
        className={cn(
          "ade-shell-control ml-auto inline-flex h-4 w-4 shrink-0 items-center justify-center text-current",
          "opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100",
        )}
        data-variant="ghost"
        disabled={closeDisabled}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        onKeyDown={(event) => {
          // Enter/Space on the focused close button must not bubble into the
          // wrapper's activate handler.
          event.stopPropagation();
        }}
        title={closeTitle}
      >
        <X size={12} weight="regular" />
      </button> : null}
    </div>
  );
}
