import React, { useEffect, type ReactNode } from "react";

import type { CtoLinearQuickView } from "../../../shared/types";
import {
  ADE_BROWSER_VIEW_OCCLUSION_END_EVENT,
  ADE_BROWSER_VIEW_OCCLUSION_START_EVENT,
} from "../../lib/workSidebarBrowserResize";
import { Dialog } from "../ui/dialog";
import {
  LinearPaneHeader,
  LINEAR_PANE_BRAND,
  type IssuePaneBrand,
} from "./LinearPaneHeader";

export type { IssuePaneBrand } from "./LinearPaneHeader";

/**
 * Shared popover chrome for Linear and GitHub issue panes: a centered, portal'd
 * dialog with a blurred backdrop, a branded header, and a flex column body.
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
  onRefresh,
  onNew,
  newTitle,
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
  onRefresh: () => void;
  onNew?: () => void;
  newTitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open || typeof window === "undefined") return undefined;
    window.dispatchEvent(new Event(ADE_BROWSER_VIEW_OCCLUSION_START_EVENT));
    return () => {
      window.dispatchEvent(new Event(ADE_BROWSER_VIEW_OCCLUSION_END_EVENT));
    };
  }, [open]);

  if (!open) return null;

  // Esc and outside clicks are the Dialog's (Radix): a confirm raised from
  // inside the pane stacks above it and answers Esc alone.
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={ariaLabel}
      hideHeader
      // Keeps clear of the window edges and the macOS window buttons.
      width="min(1680px, calc(100vw - 112px))"
      height="min(900px, calc(100dvh - 104px))"
      maxHeight="calc(100dvh - 104px)"
      bodyPadding={false}
      scrollBody={false}
      bodyStyle={{ display: "flex", flexDirection: "column" }}
      // Nothing in the pane grabs focus on open; the panel holds it.
      preventAutoFocus
      panelStyle={{
        background: "var(--ade-shell-surface, #121019)",
        borderRadius: 12,
        borderColor: brand.border,
        boxShadow: `0 24px 70px rgba(0, 0, 0, 0.58), 0 0 0 1px ${brand.border}`,
      }}
    >
      <LinearPaneHeader
        quickView={quickView}
        title={headerTitle}
        subtitle={headerSubtitle}
        loading={loading}
        brand={brand}
        mark={mark}
        refreshTitle={refreshTitle}
        closeTitle={closeTitle}
        onRefresh={onRefresh}
        onNew={onNew}
        newTitle={newTitle}
        onClose={onClose}
      />

      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </Dialog>
  );
}
