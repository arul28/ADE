/**
 * One chrome vocabulary for every Work tool panel.
 *
 * The browser pane settled its own toolbar first — a single short row of ghost
 * icon buttons over a hairline, no filled chips, no sentences. Terminal, Git,
 * Files and the iOS simulator each had their own answer to the same row:
 * uppercase mono buttons in one, tinted `<select>`s in another, three stacked
 * rows in a third. Four toolbars is three too many, so the geometry lives here
 * and each panel spends it rather than inventing it.
 *
 * The rules, so a new panel does not have to reverse-engineer them:
 * - Exactly ONE chrome row per tool, 40px, under the pane header's own 36px.
 * - Controls are ghost: transparent until hover, and hover/press change fill
 *   only — never size, never colour temperature. 120ms, the app's house rate.
 * - Icons are 16px in buttons, 12px inside a chip next to text.
 * - Nothing in the row is a sentence. What a control does is a tooltip's job.
 * - Content that is its own surface (a terminal, a diff) sits inset 8px with a
 *   10px radius and a 1px inset ring, so the pane frames it instead of letting
 *   it bleed into the chrome.
 */
import type { ReactNode } from "react";
import { cn } from "../ui/cn";
import { PaneTooltip } from "../ui/PaneTooltip";

/**
 * The row itself: 40px, hairline below at 60% of the border token.
 *
 * `ade-pane-chrome` is what makes the whole row `select-none` — dragging the
 * pane divider used to leave half the labels highlighted in accent blue.
 * `ade-tool-pane-rule` is the same hairline the pane header draws, so the two
 * rows read as one piece of furniture rather than two boxes.
 */
export const WORK_TOOL_CHROME_ROW = cn(
  "ade-pane-chrome ade-tool-pane-rule flex h-10 min-w-0 shrink-0 items-center gap-1 px-2",
);

/*
  Deliberately NOT built on `.ade-shell-control`.

  That class carries a real `1px solid` border and its ghost variant only
  clears it via `[data-variant="ghost"]`, which a plain `border-0` utility does
  not reliably beat — a chip rendered without the attribute picks up a hairline
  box, and the row goes back to looking like a strip of outlined controls. The
  ghost skin is short enough to state outright, so it is stated outright.
*/

/** 28px ghost square. Hover and press are a fill change and nothing else. */
export const WORK_TOOL_CHROME_BUTTON = cn(
  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] border-0 bg-transparent",
  "text-muted-fg transition-colors duration-[120ms] ease-out",
  "hover:bg-white/[0.06] hover:text-fg active:bg-white/[0.09]",
  "data-[state=open]:bg-white/[0.09] data-[state=open]:text-fg",
  "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
  "disabled:pointer-events-none disabled:opacity-35",
);

/** Same skin, but sized by its contents — a chip with an icon and a label. */
export const WORK_TOOL_CHROME_CHIP = cn(
  "inline-flex h-7 min-w-0 shrink items-center gap-1.5 rounded-[7px] border-0 bg-transparent px-2",
  "text-[12px] font-medium text-fg/80 transition-colors duration-[120ms] ease-out",
  "hover:bg-white/[0.06] hover:text-fg active:bg-white/[0.09]",
  "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
  "disabled:pointer-events-none disabled:opacity-35",
);

/**
 * For a chip wrapped in a `PaneTooltip`.
 *
 * The tooltip's wrapper is the real layout box — an `inline-flex` span that
 * defaults to `flex-shrink: 1` but `min-width: auto`, so a chip inside it
 * refuses to go below its content width and pushes the row's buttons off the
 * end. Passed as the tooltip's `className`, never the chip's.
 */
export const WORK_TOOL_CHROME_CHIP_WRAP = "min-w-0 shrink";

/** The muted half of the row: counts, states, whatever is read and not clicked. */
export const WORK_TOOL_CHROME_META = "shrink-0 text-[12px] tabular-nums text-muted-fg";

/** 12px muted section label. Sentence case — the pane is not shouting. */
export const WORK_TOOL_SECTION_LABEL = "px-1 text-[12px] font-medium text-muted-fg";

/**
 * A 28px ghost icon button with the pane's own tooltip.
 *
 * `label` is both the tooltip and the accessible name, so a control can never
 * end up described in one and anonymous in the other.
 */
export function WorkToolChromeButton({
  label,
  shortcut,
  onClick,
  disabled = false,
  active = false,
  className,
  testId,
  children,
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
  /** A state you left on (recording, split). Renders as fill, not as colour. */
  active?: boolean;
  className?: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <PaneTooltip label={label} shortcut={shortcut} side="bottom">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-pressed={active || undefined}
        data-testid={testId}
        data-variant="ghost"
        data-state={active ? "open" : undefined}
        className={cn(WORK_TOOL_CHROME_BUTTON, className)}
      >
        {children}
      </button>
    </PaneTooltip>
  );
}

/**
 * The pane's empty state: one line and one action.
 *
 * Every tool used to draw a duotone glyph, a headline, a wrapped paragraph
 * explaining the tool, and sometimes a second button and a code hint — five
 * things in a 280px column, none of which is the one you came to press. A
 * short line says where you are; the button is the whole point.
 */
export function WorkToolEmptyLine({
  title,
  action,
  testId,
}: {
  title: string;
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-5 text-center"
    >
      <p className="font-sans text-[14px] font-medium text-fg/85">{title}</p>
      {action}
    </div>
  );
}

/** The one filled control a panel is allowed: the action its empty state exists for. */
export const WORK_TOOL_PRIMARY_BUTTON = cn(
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[8px] px-3",
  "border border-[color-mix(in_srgb,var(--color-accent)_30%,transparent)]",
  "bg-[color-mix(in_srgb,var(--color-accent)_13%,transparent)]",
  "font-sans text-[12px] font-medium text-fg/90 transition-colors duration-[120ms] ease-out",
  "hover:bg-[color-mix(in_srgb,var(--color-accent)_20%,transparent)] hover:text-fg",
  "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
  "disabled:pointer-events-none disabled:opacity-40",
);

/**
 * The inset frame for content that is its own surface.
 *
 * 8px of pane around it, a 10px radius, and a 1px INSET ring rather than a
 * border — a border would add a pixel to the box and make the terminal reflow
 * by a column at some widths. `overflow-hidden` is what makes the radius real
 * for a canvas child.
 */
export const WORK_TOOL_SURFACE = cn(
  "relative min-h-0 flex-1 overflow-hidden rounded-[10px]",
  "shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-border)_70%,transparent)]",
);

export function WorkToolSurface({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn(WORK_TOOL_SURFACE, className)}>{children}</div>;
}
