import React, { useCallback, useEffect } from "react";
import { X } from "@phosphor-icons/react";

import { cn } from "../ui/cn";

const DIALOG_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "summary",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function getFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR),
  ).filter((element) => {
    const closedDetails = element.closest<HTMLDetailsElement>(
      "details:not([open])",
    );
    const isClosedDetailsSummary =
      closedDetails?.querySelector(":scope > summary") === element;
    return (
      !element.closest('[hidden], [aria-hidden="true"]') &&
      (!closedDetails || isClosedDetailsSummary) &&
      !element.hasAttribute("disabled") &&
      element.tabIndex >= 0
    );
  });
}

export function useDialogFocusTrap(
  panelRef: React.RefObject<HTMLDivElement>,
  onClose: () => void,
  open: boolean,
): React.KeyboardEventHandler<HTMLDivElement> {
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      panelRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, panelRef]);

  return useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const panel = panelRef.current;
      if (!panel) return;
      const focusable = getFocusableElements(panel);
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (document.activeElement === panel) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose, panelRef],
  );
}

type HeaderSheetProps = {
  open: boolean;
  panelRef: React.RefObject<HTMLDivElement>;
  icon: React.ReactNode;
  title: string;
  subtitle: React.ReactNode;
  headerActions?: React.ReactNode;
  onClose: () => void;
  ariaLabelledBy?: string;
  width?: string;
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
  onClose,
  ariaLabelledBy,
  width,
  closeTitle = `Close ${title}`,
  children,
}: HeaderSheetProps) {
  const handleKeyDown = useDialogFocusTrap(panelRef, onClose, open);
  const panelPositionClassName = width
    ? cn(
        "absolute right-3 top-10 max-h-[calc(100vh-72px)] overflow-y-auto",
        width,
      )
    : "absolute right-3 top-10 max-h-[calc(100vh-72px)] w-[min(620px,calc(100vw-24px))] overflow-y-auto";

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[120]"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        className={cn(
          panelPositionClassName,
          "rounded-xl border border-white/10 bg-[color:var(--ade-shell-surface,#121019)] shadow-2xl shadow-black/45",
        )}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ariaLabelledBy}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/10 bg-[color:var(--ade-shell-surface,#121019)] px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            {icon}
            <div className="min-w-0">
              <div
                id={ariaLabelledBy}
                className="truncate text-[13px] font-semibold"
              >
                {title}
              </div>
              <div className="truncate text-[11px] text-white/55">
                {subtitle}
              </div>
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
        </div>
        {children}
      </div>
    </div>
  );
}
