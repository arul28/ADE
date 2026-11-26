import React from "react";
import { CaretDown, CircleNotch } from "@phosphor-icons/react";
import { SPLIT_COLORS } from "../../usage/UsageCostSplit";
import { useChartTheme } from "../health/healthCharts";
import { Banner } from "../../ui/notice";
import { ModernSection } from "../primitives";
import "./devTools.css";

/**
 * The pieces every developer-tools list in Settings is built from (Apple
 * devices, Android devices, Storage): a titled section, the row, its size,
 * its delete, the loading and failed states. One look, one place to change it.
 */

/** Rows shown before "Show all". */
export const LIST_PREVIEW = 6;

/** One theme-aware hue per kind, from the validated chart palette Storage's own bars use. */
export function useDevToolHues(): { simulators: string; runtimes: string; buildData: string; emulators: string } {
  const theme = useChartTheme();
  return {
    simulators: SPLIT_COLORS.input[theme],
    runtimes: SPLIT_COLORS.ultrafast[theme],
    buildData: SPLIT_COLORS.output[theme],
    emulators: SPLIT_COLORS.cacheWrite[theme],
  };
}

export function DevToolsListSection({
  group,
  anchor,
  title,
  hint,
  count,
  actions,
  children,
}: {
  group: string;
  anchor: string;
  title: string;
  hint: React.ReactNode;
  count?: number | null;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <ModernSection group={group} anchor={anchor} title={count != null ? `${title} · ${count}` : title} hint={hint} actions={actions}>
      {children}
    </ModernSection>
  );
}

/** One row: a glyph, a title with its chips, a quiet line, the size, and one action. */
export function DevToolRow({
  glyph,
  title,
  chips,
  sub,
  subTitle,
  size,
  action,
}: {
  glyph: React.ReactNode;
  title: string;
  chips?: React.ReactNode;
  sub: React.ReactNode;
  subTitle?: string;
  size: React.ReactNode;
  action: React.ReactNode;
}) {
  return (
    <li className="ade-dev-row">
      <span className="ade-dev-row-glyph" aria-hidden>{glyph}</span>
      <span className="ade-dev-row-text">
        <span className="ade-dev-row-title">
          {title}
          {chips}
        </span>
        <span className="ade-dev-row-sub" title={subTitle}>{sub}</span>
      </span>
      {size}
      {action}
    </li>
  );
}

/** The quiet ghost button at the end of a row: Delete, Remove. */
export function RowAction({
  label,
  ariaLabel,
  busy,
  disabled,
  blockedWhy,
  onClick,
}: {
  label: string;
  ariaLabel: string;
  busy?: boolean;
  disabled?: boolean;
  /** Why it cannot run here; shown as the tooltip and disables it. */
  blockedWhy?: string | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="ade-modern-btn"
      data-size="sm"
      data-variant="ghost"
      disabled={disabled || blockedWhy != null}
      title={blockedWhy ?? ariaLabel}
      aria-label={ariaLabel}
      onClick={onClick}
    >
      {busy ? <CircleNotch size={12} className="animate-spin" /> : null}
      {label}
    </button>
  );
}

export function SizeCell({ value, measuring, format }: { value: number | null; measuring?: boolean; format: (bytes: number) => string }) {
  if (value != null) return <span className="ade-dev-size">{format(value)}</span>;
  return <span className="ade-dev-size" data-pending="true">{measuring ? "Measuring…" : "—"}</span>;
}

export function PartError({ id, title, error, onRetry }: { id: string; title: string; error: string; onRetry: () => void }) {
  return <Banner layout="inline" model={{ id, tone: "warning", title, detail: error, actions: [{ label: "Try again", onClick: onRetry }] }} />;
}

export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="ade-dev-list" aria-busy="true">
      {Array.from({ length: rows }, (_, index) => <div key={index} className="ade-dev-row"><span className="ade-dev-shimmer" /></div>)}
    </div>
  );
}

export function ShowAll({ total, open, onToggle }: { total: number; open: boolean; onToggle: () => void }) {
  if (total <= LIST_PREVIEW) return null;
  return (
    <button type="button" className="ade-dev-showall" aria-expanded={open} onClick={onToggle}>
      <CaretDown size={11} weight="bold" className="ade-dev-showall-caret" aria-hidden />
      {open ? "Show fewer" : `Show all ${total}`}
    </button>
  );
}
