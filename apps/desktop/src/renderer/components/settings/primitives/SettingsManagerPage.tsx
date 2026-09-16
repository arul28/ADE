import React from "react";
import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";
import { settingsScopeForAnchor } from "../settingsManifest";
import { ScopeChip } from "./ScopeChip";

/**
 * The manager page: a toolbar and a table.
 *
 * Secrets, lane templates and the provider grid each drew their own header,
 * their own "+ New" button placement and their own empty state, so three lists
 * that do the same job — add a thing, see the things, remove a thing — read as
 * three different products. This is the one template they share.
 *
 * Like `SettingsCard`, the page owns its anchor and reads its scope from the
 * manifest. A manager never hand-passes a scope: the whole point of the
 * manifest is that "where does this save" has exactly one answer per anchor.
 */

/** One table column. Widths are grid track sizes, so `132px` or `1.4fr` both work. */
export type SettingsManagerColumn = {
  label: string;
  /** Grid track size. Defaults to `minmax(120px, 1fr)`. */
  width?: string;
  align?: "left" | "right";
};

/** The CSS variable the table publishes so every row lines up with the header. */
const COLUMNS_VAR = "--settings-manager-columns";

export function SettingsManagerPage({
  anchor,
  title,
  description,
  remoteMachineName,
  toolbar,
  children,
}: {
  anchor: string;
  title: string;
  description?: React.ReactNode;
  /** Names the machine a machine-scoped page is being viewed through, if remote. */
  remoteMachineName?: string | null;
  /** Right-aligned actions beside the title — add buttons, import/export, filters. */
  toolbar?: React.ReactNode;
  children: React.ReactNode;
}) {
  const scope = settingsScopeForAnchor(anchor);
  return (
    <section
      id={anchor}
      data-settings-anchor={anchor}
      data-settings-manager={anchor}
      style={{
        scrollMarginTop: 16,
        padding: 16,
        background: "color-mix(in srgb, var(--color-card) 90%, var(--color-bg) 10%)",
        border: `1px solid ${COLORS.borderMuted}`,
        borderRadius: 12,
        fontFamily: SANS_FONT,
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
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
            {scope ? <ScopeChip scope={scope} remoteMachineName={remoteMachineName} /> : null}
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
        {toolbar ? (
          <div
            data-settings-manager-toolbar=""
            style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, flexWrap: "wrap" }}
          >
            {toolbar}
          </div>
        ) : null}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>{children}</div>
    </section>
  );
}

/**
 * The table shell: a header strip plus whatever rows the caller renders.
 *
 * The column template is published as a CSS variable rather than cloned into
 * every row, because the two copies in `SecretsSection` were a literal
 * copy-paste of the same four-track string — the failure mode is a header that
 * silently stops lining up with its rows.
 */
export function SettingsManagerTable({
  columns,
  minWidth,
  children,
}: {
  columns: SettingsManagerColumn[];
  /** Minimum body width before the table scrolls sideways. */
  minWidth?: number;
  children: React.ReactNode;
}) {
  const template = columns.map((column) => column.width ?? "minmax(120px, 1fr)").join(" ");
  return (
    <div
      style={{
        border: `1px solid ${COLORS.outlineBorder}`,
        borderRadius: 8,
        overflowX: "auto",
        background: "var(--color-card)",
      }}
    >
      <div style={{ [COLUMNS_VAR]: template, minWidth } as React.CSSProperties}>
        <div
          role="row"
          style={{
            display: "grid",
            gridTemplateColumns: `var(${COLUMNS_VAR})`,
            gap: 12,
            alignItems: "center",
            padding: "9px 12px",
            borderBottom: `1px solid ${COLORS.outlineBorder}`,
            color: COLORS.textMuted,
            fontFamily: SANS_FONT,
            fontSize: 10,
            fontWeight: 700,
            textTransform: "uppercase",
          }}
        >
          {columns.map((column) => (
            <span key={column.label} style={{ textAlign: column.align ?? "left" }}>
              {column.label}
            </span>
          ))}
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * One table row. `children` are the leading cells; `actions` is the trailing
 * cell, right-aligned — so a table with an "Actions" column passes its buttons
 * there rather than as a hand-aligned final child.
 */
export function SettingsManagerRow({
  children,
  actions,
}: {
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div
      role="row"
      style={{
        display: "grid",
        gridTemplateColumns: `var(${COLUMNS_VAR})`,
        gap: 12,
        alignItems: "center",
        padding: "10px 12px",
        borderTop: `1px solid ${COLORS.outlineBorder}`,
        minHeight: 54,
        fontFamily: SANS_FONT,
        fontSize: 12,
        color: COLORS.textPrimary,
      }}
    >
      {children}
      {actions ? (
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>{actions}</div>
      ) : null}
    </div>
  );
}

/**
 * The empty state. A manager with nothing in it is the first thing a new user
 * sees, so it says what the list is for and offers the one action that fills it.
 */
export function SettingsManagerEmpty({
  title,
  description,
  action,
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div
      data-settings-manager-empty=""
      style={{
        padding: 24,
        textAlign: "center",
        fontFamily: SANS_FONT,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>{title}</div>
      {description ? (
        <p
          style={{
            margin: "6px auto 0",
            maxWidth: 420,
            fontSize: 11.5,
            lineHeight: 1.5,
            color: COLORS.textMuted,
          }}
        >
          {description}
        </p>
      ) : null}
      {action ? <div style={{ marginTop: 16 }}>{action}</div> : null}
    </div>
  );
}
