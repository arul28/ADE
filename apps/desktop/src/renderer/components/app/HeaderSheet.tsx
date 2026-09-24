import React from "react";
import { createPortal } from "react-dom";
import { X } from "@phosphor-icons/react";

import { cn } from "../ui/cn";
import { useDialogFocusTrap } from "../ui/dialogFocus";
import { Z_LAYERS } from "../ui/zLayers";

/**
 * The one top-bar dropdown shell (Connections, usage, activity): a click-away
 * layer on `Z_LAYERS.sheet` with a panel pinned under the header's right edge,
 * the shared focus trap, and Escape to close. Pass `bare` when the content draws
 * its own header; `title` then only names the sheet for assistive tech.
 */
type HeaderSheetProps = {
  open: boolean;
  panelRef: React.RefObject<HTMLDivElement>;
  icon?: React.ReactNode;
  title: string;
  subtitle?: React.ReactNode;
  /** Render only `children` in the panel (no sticky header, no panel scroll). */
  bare?: boolean;
  /** Replaces the default panel surface (background, border, shadow) classes. */
  surfaceClassName?: string;
  /** Replaces the default sticky header surface classes. */
  headerClassName?: string;
  /** Replaces the default title text classes. */
  titleClassName?: string;
  headerActions?: React.ReactNode;
  onClose: () => void;
  ariaLabelledBy?: string;
  width?: string;
  panelStyle?: React.CSSProperties;
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
  closeTitle?: string;
  children: React.ReactNode;
};

export function HeaderSheet({
  open,
  panelRef,
  icon,
  title,
  subtitle,
  headerActions,
  bare = false,
  surfaceClassName = "rounded-xl border border-white/10 bg-[color:var(--ade-shell-surface,#121019)] shadow-2xl shadow-black/45",
  headerClassName = "border-white/10 bg-[color:var(--ade-shell-surface,#121019)]",
  titleClassName = "text-[13px] font-semibold",
  onClose,
  ariaLabelledBy,
  width,
  panelStyle,
  onKeyDown,
  closeTitle = `Close ${title}`,
  children,
}: HeaderSheetProps) {
  const handleKeyDown = useDialogFocusTrap(panelRef, onClose, open);
  const handlePanelKeyDown: React.KeyboardEventHandler<HTMLDivElement> = (event) => {
    onKeyDown?.(event);
    if (!event.defaultPrevented && !event.isPropagationStopped()) {
      handleKeyDown(event);
    }
  };
  const panelPositionClassName = cn(
    "absolute right-3 top-10 max-h-[calc(100vh-72px)]",
    !bare && "overflow-y-auto",
    width ?? "w-[min(620px,calc(100vw-24px))]",
  );

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0"
      style={{ zIndex: Z_LAYERS.sheet, WebkitAppRegion: "no-drag" } as React.CSSProperties}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        className={cn(panelPositionClassName, surfaceClassName)}
        style={panelStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby={bare ? undefined : ariaLabelledBy}
        aria-label={bare ? title : undefined}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handlePanelKeyDown}
      >
        {bare ? null : <div className={cn("sticky top-0 z-10 flex items-center justify-between border-b px-4 py-3", headerClassName)}>
          <div className="flex min-w-0 items-center gap-2">
            {icon}
            <div className="min-w-0">
              <div
                id={ariaLabelledBy}
                className={cn("truncate", titleClassName)}
              >
                {title}
              </div>
              {subtitle != null ? (
                <div className="truncate text-[11px] text-white/55">
                  {subtitle}
                </div>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {headerActions}
            <button
              type="button"
              className="ade-shell-control inline-flex h-7 w-7 items-center justify-center rounded-md"
              data-variant="ghost"
              onClick={onClose}
              title={closeTitle}
            >
              <X size={13} weight="regular" />
            </button>
          </div>
        </div>}
        {children}
      </div>
    </div>,
    document.body,
  );
}
