import React from "react";
import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";
import { SettingsPageShell } from "./SettingsPageShell";

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
  return (
    <SettingsPageShell
      anchor={anchor}
      title={title}
      description={description}
      remoteMachineName={remoteMachineName}
      sectionAttrs={{ "data-settings-dashboard": anchor }}
      sectionStyle={{ fontFamily: SANS_FONT, display: "flex", flexDirection: "column", gap: 16 }}
      bodyStyle={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}
    >
      {children}
    </SettingsPageShell>
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
