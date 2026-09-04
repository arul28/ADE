import React, { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CircleNotch, X } from "@phosphor-icons/react";
import { LinearMark, LINEAR_BRAND } from "@ade-dev/ui";

import type { CtoLinearQuickView } from "../types";

export type IssuePaneBrand = {
  surface: string;
  surfaceHover: string;
  accent: string;
  border: string;
};

const LINEAR_PANE_BRAND: IssuePaneBrand = {
  surface: LINEAR_BRAND.surface,
  surfaceHover: LINEAR_BRAND.surfaceHover,
  accent: LINEAR_BRAND.primaryBright,
  border: LINEAR_BRAND.border,
};

/**
 * Shared popover chrome for Linear and GitHub issue panes: a centered, portal'd
 * dialog with a blurred backdrop, a branded header, and a flex column body.
 *
 * `createPortal` still works inside a guest, so the compiled portal is kept —
 * `document.body` here is the page's own document. The one thing dropped is the
 * `ade:browser-view-occlusion-*` window events the compiled modal dispatched
 * while open: those told ADE's native BrowserView to get out of the way of an
 * Electron-renderer overlay. A guest cannot occlude the host's native views and
 * has no listener for those events, so raising them would be shouting into an
 * empty document.
 */
export function LinearPaneModal({
  open,
  ariaLabel,
  quickView,
  loading = false,
  brand = LINEAR_PANE_BRAND,
  mark,
  headerTitle,
  headerSubtitle,
  refreshTitle = "Refresh Linear",
  closeTitle = "Close Linear",
  chrome = true,
  onRefresh,
  onClose,
  children,
}: {
  open: boolean;
  ariaLabel: string;
  quickView?: CtoLinearQuickView | null;
  loading?: boolean;
  brand?: IssuePaneBrand;
  mark?: ReactNode;
  headerTitle?: string;
  headerSubtitle?: string;
  refreshTitle?: string;
  closeTitle?: string;
  /**
   * Whether this pane draws its own chrome.
   *
   * False in a placement the HOST has already framed and already titled — a
   * composer picker, an anchored popover. There the portal, the `bg-black/55`
   * backdrop and the branded header are all a second copy of something already
   * on screen: two headers over one list, and a black sheet painted across the
   * reader's window. The centred dialog is worse than redundant, because
   * `min(1760px, 100vw - 28px)` by `min(940px, 100dvh - 28px)` is measured
   * against the GUEST viewport, so a 360×420 popover asked for a pane five
   * times its width.
   *
   * True everywhere the pane IS the frame: an overlay placement, and the
   * transcript card, where nothing else draws a dialog around it.
   */
  chrome?: boolean;
  onRefresh: () => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const title = headerTitle
    ?? quickView?.organization?.name
    ?? "Linear";
  const subtitle = headerSubtitle
    ?? [
      quickView?.viewer?.displayName ?? quickView?.connection.viewerName ?? "Connected",
      quickView?.organization?.urlKey,
    ].filter(Boolean).join(" · ");

  useEffect(() => {
    if (!open) return;
    // A click outside dismisses only a pane that IS the dialog. Chromeless, the
    // pane fills a frame the host owns and every click in the app is outside
    // it — dismissing on one would close the picker the moment the reader
    // reached for anything around it. The host dismisses its own placement.
    const onDown = (event: MouseEvent) => {
      if (!chrome) return;
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
  }, [chrome, onClose, open]);

  if (!open) return null;

  if (!chrome) {
    // No portal either, and that is part of the same decision: a `fixed` portal
    // contributes zero height to the document, so a host that measures the
    // guest to size its placement would read nothing. In the frame's own flow
    // the list fills the height the host gave it.
    return (
      <div
        ref={popoverRef}
        role="group"
        aria-label={ariaLabel}
        className="flex min-h-0 flex-col overflow-hidden text-fg"
        style={{ height: "100dvh" }}
      >
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    );
  }

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
        className="fixed left-1/2 top-1/2 z-[9999] flex h-[min(940px,calc(100dvh-28px))] w-[min(1760px,calc(100vw-28px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border bg-[color:var(--shell-surface)] text-fg shadow-2xl shadow-black/50"
        style={{
          borderColor: brand.border,
          boxShadow: `0 24px 70px rgba(0, 0, 0, 0.58), 0 0 0 1px ${brand.border}`,
        }}
      >
        <div
          className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-3 py-2"
          style={{ background: brand.surface }}
        >
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="grid h-6 w-6 shrink-0 place-items-center rounded-md"
              style={{ background: brand.surfaceHover, color: brand.accent }}
            >
              {mark ?? <LinearMark size={14} />}
            </span>
            <div className="min-w-0 truncate text-[12px] text-fg/90">
              <span className="font-medium">{title}</span>
              {subtitle ? (
                <>
                  <span className="text-muted-fg/45"> · </span>
                  <span className="text-muted-fg/65">{subtitle}</span>
                </>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className="ade-shell-control inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px]"
              data-variant="ghost"
              onClick={onRefresh}
              disabled={loading}
              title={refreshTitle}
            >
              {loading ? <CircleNotch size={11} className="animate-spin" /> : null}
              Refresh
            </button>
            <button
              type="button"
              className="ade-shell-control inline-flex h-6 w-6 items-center justify-center rounded-md"
              data-variant="ghost"
              onClick={onClose}
              title={closeTitle}
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
