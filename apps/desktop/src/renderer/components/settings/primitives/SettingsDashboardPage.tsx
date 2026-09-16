import React from "react";
import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";
import { settingsScopeForAnchor } from "../settingsManifest";
import { ScopeChip } from "./ScopeChip";

/**
 * The dashboard page: read-only numbers. Usage and Storage are the two, and
 * both are the same shape — a headline, a picture, and a strip of figures.
 *
 * Nothing interactive lives in this template. A dashboard that grows a control
 * is a preference page or a manager wearing a dashboard's clothes, and the
 * control belongs in a `SettingsCard` or a manager toolbar instead.
 */
export function SettingsDashboardPage({
  anchor,
  title,
  description,
  remoteMachineName,
  children,
}: {
  anchor: string;
  title: string;
  description?: React.ReactNode;
  /** Names the machine a machine-scoped page is being viewed through, if remote. */
  remoteMachineName?: string | null;
  children: React.ReactNode;
}) {
  const scope = settingsScopeForAnchor(anchor);
  return (
    <section
      id={anchor}
      data-settings-anchor={anchor}
      data-settings-dashboard={anchor}
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
      <div style={{ minWidth: 0 }}>
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
      <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>{children}</div>
    </section>
  );
}

/**
 * One cell of a metric strip: a quiet label, a loud number, an optional hint.
 *
 * The number is tabular so a row of figures does not jitter as it refreshes —
 * the usage strip updates on a timer, and proportional digits made it twitch.
 */
export function SettingsDashboardStat({
  label,
  value,
  hint,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <div
      data-settings-stat=""
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minWidth: 0,
        padding: "12px 16px",
        background: "var(--color-card)",
        border: `1px solid ${COLORS.outlineBorder}`,
        borderRadius: 10,
        fontFamily: SANS_FONT,
      }}
    >
      <span style={{ fontSize: 10.5, color: COLORS.textMuted, letterSpacing: "0.02em" }}>{label}</span>
      <span
        style={{
          fontSize: 18,
          fontWeight: 600,
          color: COLORS.textPrimary,
          fontVariantNumeric: "tabular-nums",
          letterSpacing: "-0.01em",
        }}
      >
        {value}
      </span>
      {hint ? <span style={{ fontSize: 10.5, color: COLORS.textDim, lineHeight: 1.45 }}>{hint}</span> : null}
    </div>
  );
}
