import React, { useEffect, type ReactNode } from "react";
import { CircleNotch, X } from "@phosphor-icons/react";

import type { CtoLinearQuickView } from "../../../shared/types";
import {
  ADE_BROWSER_VIEW_OCCLUSION_END_EVENT,
  ADE_BROWSER_VIEW_OCCLUSION_START_EVENT,
} from "../../lib/workSidebarBrowserResize";
import { LinearMark, LINEAR_BRAND } from "../lanes/linearBrand";
import { Dialog } from "../ui/dialog";

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
  onClose: () => void;
  children: React.ReactNode;
}) {
  const title = headerTitle
    ?? quickView?.organization?.name
    ?? "Linear";
  const subtitle = headerSubtitle
    ?? [
      quickView?.viewer?.displayName ?? quickView?.connection.viewerName ?? "Connected",
      quickView?.organization?.urlKey,
    ].filter(Boolean).join(" · ");

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
      width={1760}
      height="min(940px, calc(100dvh - 28px))"
      maxHeight="calc(100dvh - 28px)"
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
    </Dialog>
  );
}
