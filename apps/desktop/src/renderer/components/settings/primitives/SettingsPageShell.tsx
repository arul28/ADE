import React from "react";
import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";

/**
 * The chrome every settings surface shares: the anchored `<section>`, the
 * title, and the description beneath.
 *
 * All three page templates — the card, the manager, the dashboard — had a
 * verbatim copy of it. This is internal to `primitives`: a section file picks
 * one of the three templates, never the shell.
 *
 * There is no scope badge. Every settings page used to wear a violet "Account"
 * or amber "This computer" tag beside its title, and with one on every card the
 * tags stopped reading as information and started reading as decoration. The
 * sidebar already groups the pages by where they save, which is the same fact
 * said once instead of forty times.
 */
export function SettingsPageShell({
  anchor,
  title,
  description,
  leading,
  titleAdornment,
  sectionAttrs,
  sectionStyle,
  headerAlign = "center",
  headerStacked = false,
  headerWrap = false,
  aside,
  bodyStyle,
  children,
}: {
  anchor: string;
  title: string;
  description?: React.ReactNode;
  /** Sits before the title — a back control, a section mark. */
  leading?: React.ReactNode;
  /** Sits after the title — a help hint, a count. */
  titleAdornment?: React.ReactNode;
  /** Extra data-* attributes for the `<section>`, e.g. `data-settings-manager`. */
  sectionAttrs?: Record<string, string>;
  /** Merged over the shared section styling. */
  sectionStyle?: React.CSSProperties;
  headerAlign?: "center" | "flex-start";
  /** Stacks the aside below the title block instead of beside it. */
  headerStacked?: boolean;
  headerWrap?: boolean;
  /** Rendered opposite the title — a control, a toolbar. Callers wrap it. */
  aside?: React.ReactNode;
  /** Applied to the wrapper around `children`; omitted when there are none. */
  bodyStyle?: React.CSSProperties;
  children?: React.ReactNode;
}) {
  return (
    <section
      id={anchor}
      data-settings-anchor={anchor}
      {...sectionAttrs}
      style={{
        scrollMarginTop: 16,
        padding: 16,
        background: "color-mix(in srgb, var(--color-card) 90%, var(--color-bg) 10%)",
        border: `1px solid ${COLORS.borderMuted}`,
        borderRadius: 12,
        ...sectionStyle,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: headerStacked ? "flex-start" : headerAlign,
          justifyContent: "space-between",
          gap: 16,
          flexDirection: headerStacked ? "column" : "row",
          flexWrap: headerWrap ? "wrap" : "nowrap",
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            {leading}
            <h3
              style={{
                margin: 0,
                fontFamily: SANS_FONT,
                fontSize: 13,
                fontWeight: 600,
                color: COLORS.textPrimary,
                letterSpacing: "-0.01em",
              }}
            >
              {title}
            </h3>
            {titleAdornment}
          </div>
          {description ? (
            <p
              style={{
                margin: "4px 0 0",
                fontFamily: SANS_FONT,
                fontSize: 11,
                lineHeight: 1.55,
                color: COLORS.textMuted,
              }}
            >
              {description}
            </p>
          ) : null}
        </div>
        {aside ?? null}
      </div>
      {children ? <div style={bodyStyle}>{children}</div> : null}
    </section>
  );
}
