import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { CircleNotch, X } from "@phosphor-icons/react";

import type { CtoLinearQuickView } from "../../../shared/types";
import { LinearMark, LINEAR_BRAND } from "../lanes/linearBrand";

/**
 * The shared popover chrome for the Linear pane: a centered, portal'd dialog
 * with a blurred backdrop, a Linear-brand header (org / viewer / refresh /
 * close), and a flex column body. It mirrors the top-right Linear quick view
 * so every Linear surface — quick view, attach-to-chat, etc. — feels the same.
 *
 * The body (`children`) is expected to be a `<LinearIssueBrowser>`; the browser
 * owns its own per-issue sticky action dock, so callers vary only the browser
 * config, not this shell.
 */
export function LinearPaneModal({
  open,
  ariaLabel,
  quickView,
  loading = false,
  onRefresh,
  onClose,
  children,
}: {
  open: boolean;
  ariaLabel: string;
  quickView?: CtoLinearQuickView | null;
  loading?: boolean;
  onRefresh: () => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, open]);

  if (!open) return null;

  return createPortal(
    <>
      <button
        type="button"
        aria-label={`Close ${ariaLabel} backdrop`}
        data-linear-pane-backdrop="true"
        className="fixed inset-0 z-[9998] cursor-default bg-black/55 backdrop-blur-md"
        onClick={onClose}
        tabIndex={-1}
      />
      <div
        ref={popoverRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        className="fixed left-1/2 top-1/2 z-[9999] flex h-[min(900px,calc(100dvh-28px))] w-[min(1380px,calc(100vw-28px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border bg-[color:var(--ade-shell-surface,#121019)] text-fg shadow-2xl shadow-black/50"
        style={{
          borderColor: "rgba(123, 138, 240, 0.55)",
          boxShadow: "0 24px 70px rgba(0, 0, 0, 0.58), 0 0 0 1px rgba(123, 138, 240, 0.18)",
        }}
      >
        <div
          className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-3 py-2"
          style={{ background: LINEAR_BRAND.surface }}
        >
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="grid h-6 w-6 shrink-0 place-items-center rounded-md"
              style={{ background: LINEAR_BRAND.surfaceHover, color: LINEAR_BRAND.primaryBright }}
            >
              <LinearMark size={14} />
            </span>
            <div className="min-w-0 truncate text-[12px] text-fg/90">
              <span className="font-medium">{quickView?.organization?.name ?? "Linear"}</span>
              <span className="text-muted-fg/45"> · </span>
              <span className="text-muted-fg/65">
                {quickView?.viewer?.displayName ?? quickView?.connection.viewerName ?? "Connected"}
                {quickView?.organization?.urlKey ? ` · ${quickView.organization.urlKey}` : ""}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className="ade-shell-control inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px]"
              data-variant="ghost"
              onClick={onRefresh}
              disabled={loading}
              title="Refresh Linear"
            >
              {loading ? <CircleNotch size={11} className="animate-spin" /> : null}
              Refresh
            </button>
            <button
              type="button"
              className="ade-shell-control inline-flex h-6 w-6 items-center justify-center rounded-md"
              data-variant="ghost"
              onClick={onClose}
              title="Close Linear"
            >
              <X size={12} />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </>,
    document.body,
  );
}
