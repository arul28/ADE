import { memo, type CSSProperties, type ReactNode, type Ref } from "react";
import type { Icon } from "@phosphor-icons/react";

import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";

/**
 * The flat section vocabulary for the PR detail panes.
 *
 * The PR tab used to build every group with `floatingPane()` — a filled card
 * with a border, a large radius, and a drop shadow. Stacked three columns deep
 * that reads as a field of blobs: every group competes for depth, and none of
 * the nesting means anything.
 *
 * These sections carry no fill, no border box, and no shadow. Grouping comes
 * from a labelled header and vertical rhythm, and separation from a single
 * hairline rule. `floatingPane` is deliberately untouched — the Lanes tab still
 * uses it, and this is a PR-surface decision.
 */

/** Vertical rhythm between sections in a rail. Matches the header's optical gap. */
const PR_SECTION_GAP = 18;

/**
 * Rhythm around a section that is only one line tall (see `inlineEmpty`), and
 * between sections that belong to the same group. A single line has not earned
 * the full gap: three empty one-liners separated by 18/18 read as three
 * paragraphs of air rather than as one short list.
 */
export const PR_SECTION_GAP_COMPACT = 12;

type PrSectionProps = {
  /** Small leading glyph. Omit for a section whose label is enough. */
  icon?: Icon;
  /** Section label. Sentence case, never uppercase-tracked. */
  title: string;
  /**
   * Right-aligned count or status. Renders in the muted tone, so it reads as a
   * fact about the section rather than an action.
   */
  meta?: ReactNode;
  /** Right-aligned action ("View all", "Edit"). Accent-toned. */
  action?: ReactNode;
  /**
   * The section has nothing to list. Pass the empty word ("None") and the whole
   * section collapses to a single line: the word rides in the header between
   * the title and the action, and the header drops the gap it was reserving for
   * a body. The action stays exactly where it is, so "Request"/"Edit" is still
   * one click away.
   *
   * Callers still pass `children` — an editor input or a row of buttons is real
   * content and renders below the line. Only the *list* is empty.
   */
  inlineEmpty?: ReactNode;
  /** Hairline rule above the header, separating this section from the last. */
  divided?: boolean;
  /** Body scrolls when it overflows; the header stays put. */
  scroll?: boolean;
  className?: string;
  style?: CSSProperties;
  /**
   * Ref onto the BODY element, not the section root. A caller that sizes its
   * content to the space available needs the height the body was actually
   * given — the root includes the header, and the body is what scrolls.
   */
  bodyRef?: Ref<HTMLDivElement>;
  children: ReactNode;
  "data-testid"?: string;
};

export const PrSection = memo(function PrSection({
  icon: IconGlyph,
  title,
  meta,
  action,
  inlineEmpty,
  divided = false,
  scroll = false,
  className,
  style,
  bodyRef,
  children,
  "data-testid": testId,
}: PrSectionProps) {
  const collapsed = inlineEmpty != null;
  const gap = collapsed ? PR_SECTION_GAP_COMPACT : PR_SECTION_GAP;
  return (
    <section
      data-testid={testId}
      data-empty={collapsed ? "true" : undefined}
      className={`flex min-h-0 flex-col ${className ?? ""}`}
      style={{
        // The rule needs air on BOTH sides. Padding only below it would leave
        // the previous section's last row flush against the hairline, which is
        // what makes a divider read as a box edge instead of a separator.
        ...(divided
          ? {
              borderTop: `1px solid color-mix(in srgb, var(--color-border) 55%, transparent)`,
              marginTop: gap,
              paddingTop: gap,
            }
          : {}),
        ...style,
      }}
    >
      {/* The bottom gap belongs to the body. A collapsed section has no list to
          separate from, so it does not pay for one. */}
      <header className={`flex shrink-0 items-center gap-2 ${collapsed ? "" : "pb-2"}`}>
        {IconGlyph ? <IconGlyph size={13} weight="regular" style={{ color: COLORS.textDim, flexShrink: 0 }} /> : null}
        <span
          className="text-[11px] font-medium"
          style={{ color: COLORS.textSecondary, fontFamily: SANS_FONT }}
        >
          {title}
        </span>
        {meta != null ? (
          <span className="text-[11px]" style={{ color: COLORS.textDim, fontFamily: SANS_FONT }}>
            {meta}
          </span>
        ) : null}
        {collapsed ? (
          <span
            className="text-[11px]"
            style={{ color: COLORS.textDim, fontFamily: SANS_FONT }}
            data-testid={testId ? `${testId}-empty` : undefined}
          >
            {inlineEmpty}
          </span>
        ) : null}
        {action ? <span className="ml-auto flex items-center">{action}</span> : null}
      </header>
      <div ref={bodyRef} className={scroll ? "min-h-0 flex-1 overflow-y-auto" : "min-h-0"}>{children}</div>
    </section>
  );
});

/**
 * A section header's right-hand action. Text only, accent-toned, no chrome —
 * the row it sits in already carries the grouping.
 */
export function prSectionAction(overrides?: CSSProperties): CSSProperties {
  return {
    color: COLORS.accent,
    fontFamily: SANS_FONT,
    fontSize: 11,
    background: "none",
    border: "none",
    padding: 0,
    cursor: "pointer",
    ...overrides,
  };
}

/**
 * A flat control: one hairline border, small radius, no gradient and no shadow.
 * Pass a `tone` to colour the label and border for a destructive or accent
 * action; the fill stays transparent either way.
 */
export function prFlatButton(overrides?: CSSProperties & { tone?: string }): CSSProperties {
  const { tone, ...rest } = overrides ?? {};
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 28,
    padding: "0 10px",
    borderRadius: 6,
    fontFamily: SANS_FONT,
    fontSize: 11,
    fontWeight: 500,
    color: tone ?? COLORS.textPrimary,
    background: "transparent",
    border: `1px solid ${tone ? `color-mix(in srgb, ${tone} 34%, transparent)` : COLORS.border}`,
    cursor: "pointer",
    ...rest,
  };
}

/**
 * The one filled control on the surface. Solid, not a gradient: a single
 * accent-filled button reads as *the* action, which stops working the moment a
 * second gradient competes with it.
 */
export function prSolidButton(overrides?: CSSProperties & { tone?: string }): CSSProperties {
  const { tone, ...rest } = overrides ?? {};
  const fill = tone ?? COLORS.accent;
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 30,
    padding: "0 12px",
    borderRadius: 6,
    fontFamily: SANS_FONT,
    fontSize: 11,
    fontWeight: 600,
    color: "#fff",
    background: fill,
    border: `1px solid ${fill}`,
    cursor: "pointer",
    ...rest,
  };
}

export default PrSection;
