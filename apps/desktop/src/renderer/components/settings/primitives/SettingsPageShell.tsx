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
  icon,
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
  /** A tile left of the whole title block (title and description). */
  icon?: React.ReactNode;
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
        padding: "16px 18px",
        background: "color-mix(in srgb, var(--color-card) 55%, var(--color-bg) 45%)",
        border: "1px solid color-mix(in srgb, var(--color-border) 70%, transparent)",
        borderRadius: 14,
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
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0, flex: 1, width: headerStacked ? "100%" : undefined }}>
          {icon ?? null}
          <div style={{ minWidth: 0, flex: 1, alignSelf: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              {leading}
              <h3
                style={{
                  margin: 0,
                  fontFamily: SANS_FONT,
                  fontSize: 13,
                  fontWeight: 500,
                  color: COLORS.textPrimary,
                  letterSpacing: "-0.005em",
                }}
              >
                {title}
              </h3>
              {titleAdornment}
            </div>
            {description ? (
              <p
                style={{
                  margin: "3px 0 0",
                  fontFamily: SANS_FONT,
                  fontSize: 12,
                  lineHeight: 1.45,
                  color: COLORS.textMuted,
                }}
              >
                {description}
              </p>
            ) : null}
          </div>
        </div>
        {aside ?? null}
      </div>
      {children ? <div style={bodyStyle}>{children}</div> : null}
    </section>
  );
}
