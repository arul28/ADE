import React, { useState, type ReactNode } from "react";
import { CircleNotch, Plus, X } from "@phosphor-icons/react";

import type { CtoLinearQuickView } from "../../../shared/types";
import { LinearMark, LINEAR_BRAND } from "../lanes/linearBrand";

export type IssuePaneBrand = {
  surface: string;
  surfaceHover: string;
  accent: string;
  border: string;
};

export const LINEAR_PANE_BRAND: IssuePaneBrand = {
  surface: LINEAR_BRAND.surface,
  surfaceHover: LINEAR_BRAND.surfaceHover,
  accent: LINEAR_BRAND.primaryBright,
  border: LINEAR_BRAND.border,
};

/**
 * The workspace logo in the pane header: Linear's `organization.logoUrl` when it
 * loads, else the workspace monogram, else the caller's mark (GitHub) or the
 * Linear wordmark.
 */
function PaneHeaderMark({
  name,
  logoUrl,
  brand,
  fallback,
}: {
  name?: string | null;
  logoUrl?: string | null;
  brand: IssuePaneBrand;
  fallback?: ReactNode;
}) {
  const normalizedLogoUrl = logoUrl?.trim() || null;
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null);
  const showLogo = normalizedLogoUrl != null && failedLogoUrl !== normalizedLogoUrl;
  const monogram = name?.trim().charAt(0).toUpperCase() || null;

  return (
    <span
      className="grid h-6 w-6 shrink-0 place-items-center overflow-hidden rounded-md"
      style={{ background: brand.surfaceHover, color: brand.accent }}
    >
      {showLogo ? (
        <img
          src={normalizedLogoUrl}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setFailedLogoUrl(normalizedLogoUrl)}
        />
      ) : (
        fallback ?? (monogram ? <span className="text-[11px] font-semibold">{monogram}</span> : <LinearMark size={14} />)
      )}
    </span>
  );
}

/**
 * Shared header for the Linear and GitHub issue panes. One component so the
 * quick-view popover and any `LinearPaneModal` host (Linear select, GitHub
 * select) render identical chrome: brand mark, title, subtitle, Refresh with a
 * spinner while loading, and close.
 */
export function LinearPaneHeader({
  quickView,
  title,
  subtitle,
  loading = false,
  brand = LINEAR_PANE_BRAND,
  mark,
  refreshTitle = "Refresh Linear",
  closeTitle = "Close Linear",
  onRefresh,
  onNew,
  newTitle = "New issue",
  onClose,
}: {
  quickView?: CtoLinearQuickView | null;
  /** Overrides the workspace name (e.g. "GitHub"). */
  title?: string;
  /** Overrides the workspace/viewer subtitle (e.g. "owner/repo"). */
  subtitle?: string;
  loading?: boolean;
  brand?: IssuePaneBrand;
  /** Fallback glyph when there is no workspace logo/name (e.g. GitHub). */
  mark?: ReactNode;
  refreshTitle?: string;
  closeTitle?: string;
  onRefresh: () => void;
  /** Shows "New" when given: opens the create composer for this tracker. */
  onNew?: () => void;
  newTitle?: string;
  onClose: () => void;
}) {
  const resolvedTitle = title ?? quickView?.organization?.name ?? "Linear";
  const viewer = quickView?.viewer?.displayName ?? quickView?.connection.viewerName ?? "Connected";
  const resolvedSubtitle = subtitle
    ?? [viewer, quickView?.organization?.urlKey].filter(Boolean).join(" · ");

  return (
    <div
      className="flex shrink-0 items-center justify-between gap-3 border-b border-fg/10 px-3 py-2"
      style={{ background: brand.surface }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <PaneHeaderMark
          name={quickView?.organization?.name}
          logoUrl={quickView?.organization?.logoUrl}
          brand={brand}
          fallback={mark}
        />
        <div className="min-w-0 truncate text-[12px] text-fg/90">
          <span className="font-medium">{resolvedTitle}</span>
          {resolvedSubtitle ? (
            <>
              <span className="text-muted-fg/45"> · </span>
              <span className="text-muted-fg/65">{resolvedSubtitle}</span>
            </>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {onNew ? (
          <button
            type="button"
            className="ade-shell-control inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px]"
            data-variant="ghost"
            onClick={onNew}
            title={newTitle}
          >
            <Plus size={11} weight="bold" />
            New
          </button>
        ) : null}
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
  );
}
