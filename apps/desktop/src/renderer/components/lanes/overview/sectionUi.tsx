import React from "react";
import { CaretDown } from "@phosphor-icons/react";
import { cn } from "../../ui/cn";

/*
  The few pieces every section of the lane overview shares: a plain
  sentence-case title with a muted count, flat rows that only fill on hover,
  and quiet buttons. One rhythm everywhere: 12px titles, 8px to the rows,
  32px rows with 8px of side padding. Colour lives in state glyphs and state
  words, never in boxes or section titles.
*/

/** GitHub's merged purple, per theme (see index.css). */
export const MERGED_COLOR = "var(--ade-lane-merged, #A371F7)";
/** The softer violet the status line uses for "ahead". */
export const VIOLET_COLOR = "var(--ade-lane-violet, #B9A6F5)";
/** Renamed and copied files. */
export const RENAMED_COLOR = "var(--ade-lane-sky, #38BDF8)";

/**
 * A flat 32px row. The hover fill runs past the text by 8px on each side, so
 * every row's text lines up with the section title above it.
 */
export const OVERVIEW_ROW = cn(
  "-mx-2 flex w-[calc(100%+16px)] min-w-0 items-center gap-2.5 rounded-md px-2 text-left",
  "transition-colors duration-100 ease-out",
);

/** Hover fill for rows you can click. Tinted from the text colour so it works in both themes. */
export const OVERVIEW_ROW_HOVER = "cursor-pointer hover:bg-fg/[0.045] focus-visible:bg-fg/[0.045] focus-visible:outline-none";

/** The right-hand time column, the same width in every section so times line up. */
export const OVERVIEW_TIME = "w-14 shrink-0 text-right text-[11.5px] tabular-nums text-muted-fg/60";

/** Which overview sections are folded, and how to fold one. Provided by the dashboard. */
export type OverviewCollapse = {
  isCollapsed: (key: string) => boolean;
  toggle: (key: string) => void;
};

export const OverviewCollapseContext = React.createContext<OverviewCollapse | null>(null);

/**
 * One overview section. With a `collapseKey` (and a dashboard around it) the
 * title row folds the body away, and a hairline above separates it from the
 * section before. The line plus 12px on each side keeps the 24px rhythm.
 */
export function OverviewSection({
  title,
  count,
  action,
  children,
  testId,
  collapseKey,
}: {
  title: string;
  count?: number | null;
  action?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
  collapseKey?: string;
}) {
  const collapse = React.useContext(OverviewCollapseContext);
  const collapsible = collapse != null && collapseKey != null;
  const collapsed = collapsible && collapse.isCollapsed(collapseKey);
  const bodyId = React.useId();
  const titleContent = (
    <>
      <h2 className="m-0 truncate text-[12px] font-medium text-muted-fg">{title}</h2>
      {count != null && count > 0 ? (
        <span className="text-[12px] tabular-nums text-muted-fg/50">{count}</span>
      ) : null}
    </>
  );
  return (
    <section
      aria-label={title}
      data-testid={testId}
      data-collapsed={collapsible ? String(collapsed) : undefined}
      className={cn("flex min-w-0 flex-col", collapsible && "border-t border-border/60 pt-3")}
    >
      <header className="flex h-6 min-w-0 items-center gap-1.5">
        {collapsible ? (
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            title={collapsed ? `Show ${title.toLowerCase()}` : `Hide ${title.toLowerCase()}`}
            data-testid={testId ? `${testId}-toggle` : undefined}
            onClick={() => collapse.toggle(collapseKey)}
            className={cn(
              "group/section -ml-1 flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-md pl-1 pr-1.5 text-left",
              "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
            )}
          >
            {titleContent}
            <CaretDown
              size={10}
              weight="bold"
              aria-hidden
              className={cn(
                "shrink-0 text-muted-fg/50 transition-transform duration-100 group-hover/section:text-fg",
                collapsed && "-rotate-90",
              )}
            />
          </button>
        ) : titleContent}
        {action ? <div className="ml-auto flex shrink-0 items-center gap-1">{action}</div> : null}
      </header>
      {collapsed ? null : <div id={bodyId} className="mt-2 flex min-w-0 flex-col">{children}</div>}
    </section>
  );
}

/** A small bordered button for a section's one real action ("Open in PRs"). */
export function SmallButton({
  children,
  onClick,
  testId,
  title,
  tone = "default",
}: {
  children: React.ReactNode;
  onClick: () => void;
  testId?: string;
  title?: string;
  /** "success" for a ready-to-merge PR; otherwise neutral. */
  tone?: "default" | "success";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      data-testid={testId}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[12px] font-medium",
        "transition-colors duration-100",
        "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
        tone === "success"
          ? "bg-success/[0.12] text-success shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-success)_30%,transparent)] hover:bg-success/[0.18]"
          : "bg-fg/[0.04] text-fg/85 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-border)_85%,transparent)] hover:bg-fg/[0.08] hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

/** Quiet text control: "Show all", "Open in PRs". */
export function TextButton({
  children,
  onClick,
  testId,
  title,
  className,
}: {
  children: React.ReactNode;
  onClick: () => void;
  testId?: string;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      data-testid={testId}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] text-muted-fg/80",
        "transition-colors duration-100 hover:bg-fg/[0.05] hover:text-fg",
        "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** "Show all 14" under a capped list, lined up with the rows' text. */
export function ShowAllButton({ hidden, onClick, testId, label }: { hidden: number; onClick: () => void; testId?: string; label?: string }) {
  if (hidden <= 0) return null;
  return (
    <div className="-ml-1.5 pt-1">
      <TextButton onClick={onClick} testId={testId}>{label ?? `Show ${hidden} more`}</TextButton>
    </div>
  );
}
