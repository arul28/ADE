import React from "react";
import { COLORS } from "../../lanes/laneDesignTokens";

/**
 * The three shared layout primitives every wizard step draws with.
 *
 * They live here rather than beside one step so the steps cannot drift into
 * three slightly different labels and three slightly different error lines.
 */

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", color: COLORS.textMuted }}>
      {children}
    </span>
  );
}

export function FieldError({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" style={{ margin: 0, fontSize: 10.5, color: COLORS.danger }}>{children}</p>
  );
}

export function Row({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, minWidth: 0 }}>
      <label htmlFor={htmlFor} style={{ fontSize: 12, fontWeight: 600, color: COLORS.textPrimary }}>{label}</label>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>{children}</div>
    </div>
  );
}
