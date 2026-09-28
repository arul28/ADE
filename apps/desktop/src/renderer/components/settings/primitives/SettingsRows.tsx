import React from "react";
import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";

/**
 * The grouped-rows page template: a quiet section label, then one panel whose
 * rows share a hairline instead of each row floating in its own card.
 *
 * `SettingsCard` gives every setting a bordered box, which is right for a page
 * of unrelated settings and wrong for a page of related ones: ten boxes stacked
 * read as ten separate products. A panel of rows reads as one thing, the way a
 * native preferences window does.
 *
 * Search still works row by row: each row carries its own anchor, and the
 * section carries `data-settings-group`, so the settings page hides a row that
 * does not match and a section whose rows all went.
 */

/**
 * The hues a row icon can take. Fixed colours, not theme tokens, so a page
 * keeps the same legend of meaning (green is "done", amber is "needs you")
 * under every theme; each is mixed down to a soft tile behind the glyph.
 */
export const SETTINGS_TONES = {
  accent: "var(--color-accent)",
  blue: "#5B8CFF",
  green: "#34C77B",
  amber: "#F5A524",
  red: "#F0616D",
  violet: "#A78BFA",
  pink: "#EC6FB0",
  teal: "#2BC2B2",
  orange: "#F2844B",
  slate: "#8C93A8",
} as const;

export type SettingsTone = keyof typeof SETTINGS_TONES;

/** A labelled band on the page. `actions` sit opposite the label. */
export function SettingsSection({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  /** One short line under the label, for what the whole section decides. */
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    // Layout lives in the class, not inline: the settings search clears the
    // inline `display` of every group when it shows it again.
    <section data-settings-group={title} className="ade-settings-section">
      <div
        className="ade-settings-head"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          // Tall enough for a toolbar, so a heading with actions and one
          // without line their panels up side by side.
          minHeight: 32,
          padding: "0 2px",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h2
            style={{
              margin: 0,
              fontFamily: SANS_FONT,
              fontSize: 13,
              fontWeight: 500,
              letterSpacing: "-0.005em",
              color: COLORS.textSecondary,
            }}
          >
            {title}
          </h2>
          {description ? (
            <p style={{ margin: "3px 0 0", fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textDim }}>
              {description}
            </p>
          ) : null}
        </div>
        {/* Actions share one joined toolbar rather than floating as loose buttons. */}
        {actions ? <div className="ade-settings-toolbar">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** The tinted tile a row leads with. */
export function SettingsRowIcon({ icon, tone = "accent" }: { icon: React.ReactNode; tone?: SettingsTone | string }) {
  return (
    <span
      aria-hidden
      className="ade-settings-row-icon"
      style={{ ["--tone" as string]: SETTINGS_TONES[tone as SettingsTone] ?? tone } as React.CSSProperties}
    >
      {icon}
    </span>
  );
}

/** The panel that holds a section's rows. Rows are divided by a hairline. */
export function SettingsPanel({ children }: { children: React.ReactNode }) {
  return <div className="ade-settings-panel">{children}</div>;
}

/**
 * One setting in a panel: title and a short description on the left, the
 * control on the right, and optional full-width content (a preview, a field)
 * beneath both.
 */
export function SettingsRow({
  anchor,
  icon,
  tone = "accent",
  title,
  description,
  control,
  children,
}: {
  anchor?: string;
  /** A small glyph in a tinted tile before the title, so a page scans by shape. */
  icon?: React.ReactNode;
  /** The tile's hue: one of `SETTINGS_TONES`, or any CSS colour. */
  tone?: SettingsTone | string;
  title: string;
  description?: React.ReactNode;
  control?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div
      id={anchor}
      data-settings-anchor={anchor}
      className="ade-settings-row"
      style={{ scrollMarginTop: 16 }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20 }}>
        {icon ? <SettingsRowIcon icon={icon} tone={tone} /> : null}
        <div style={{ minWidth: 0, flex: 1, marginLeft: icon ? -8 : 0 }}>
          <div style={{ fontFamily: SANS_FONT, fontSize: 13, fontWeight: 500, color: COLORS.textPrimary }}>
            {title}
          </div>
          {description ? (
            <div
              style={{
                marginTop: 3,
                fontFamily: SANS_FONT,
                fontSize: 12,
                lineHeight: 1.45,
                color: COLORS.textMuted,
              }}
            >
              {description}
            </div>
          ) : null}
        </div>
        {control ? <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>{control}</div> : null}
      </div>
      {children ? <div style={{ marginTop: 12 }}>{children}</div> : null}
    </div>
  );
}

/** A small quiet button for a section's action row: icon plus a short label. */
export function SettingsSectionAction({
  icon,
  label,
  onClick,
  title,
}: {
  icon?: React.ReactNode;
  label?: string;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={label ? undefined : title}
      className="ade-settings-section-action"
    >
      {icon}
      {label ? <span>{label}</span> : null}
    </button>
  );
}

/**
 * The page column. Narrow pages stay one centred column; `wide` lets a page
 * grow on a wide window so `SettingsSplit` can put related sections side by
 * side instead of leaving half the screen empty.
 */
export function SettingsColumn({ wide = false, children }: { wide?: boolean; children: React.ReactNode }) {
  return <div className={wide ? "ade-settings-column ade-settings-column--wide" : "ade-settings-column"}>{children}</div>;
}

/**
 * Two stacks of sections that sit side by side once the column is wide enough,
 * and stack (left first) when it is not. `stickyStart` pins the first stack
 * while the second scrolls — for a preview that should stay in view.
 */
export function SettingsSplit({
  start,
  end,
  stickyStart = false,
  ratio = "even",
}: {
  start: React.ReactNode;
  end: React.ReactNode;
  stickyStart?: boolean;
  ratio?: "even" | "start-wide";
}) {
  return (
    <div className="ade-settings-split" data-ratio={ratio}>
      <div className="ade-settings-split-stack" data-sticky={stickyStart || undefined}>{start}</div>
      <div className="ade-settings-split-stack">{end}</div>
    </div>
  );
}
