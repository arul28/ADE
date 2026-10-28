import React from "react";
import type { Icon as PhosphorIcon, IconWeight } from "@phosphor-icons/react";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";

export const settingsSectionTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  fontFamily: SANS_FONT,
  color: COLORS.textPrimary,
  marginBottom: 10,
};

export const settingsSectionDescriptionStyle: React.CSSProperties = {
  color: COLORS.textMuted,
  fontFamily: SANS_FONT,
  fontSize: 12,
  lineHeight: 1.6,
  marginBottom: 14,
};

export function SettingsSectionShell({
  id,
  title,
  description,
  icon: Icon,
  iconNode,
  brandColor,
  iconWeight = "duotone",
  children,
}: {
  id?: string;
  title: string;
  description: React.ReactNode;
  icon?: PhosphorIcon;
  iconNode?: React.ReactNode;
  brandColor: string;
  iconWeight?: IconWeight;
  children: React.ReactNode;
}) {
  return (
    // `data-settings-anchor` mirrors the id so shell-based sections take part
    // in settings search and Cmd-K landing like `SettingsCard` does. Without
    // it they stay visible through every filter and can't be deep-linked to.
    <section id={id} data-settings-anchor={id} style={{ scrollMarginTop: 16 }}>
      {/* The same quiet header every redesigned section uses, led by the
          section's brand tile. */}
      <div className="ade-settings-head" style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 14, padding: "0 2px" }}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 10,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            color: brandColor,
            background: `color-mix(in srgb, ${brandColor} 15%, transparent)`,
            boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${brandColor} 24%, transparent)`,
          }}
        >
          {iconNode ?? (Icon ? <Icon size={17} weight={iconWeight} style={{ color: brandColor }} /> : null)}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2
            style={{
              margin: 0,
              fontFamily: SANS_FONT,
              fontSize: 13.5,
              fontWeight: 600,
              letterSpacing: "-0.01em",
              color: COLORS.textPrimary,
            }}
          >
            {title}
          </h2>
          <p style={{ margin: "2px 0 0", fontFamily: SANS_FONT, fontSize: 12, lineHeight: 1.45, color: COLORS.textMuted }}>
            {description}
          </p>
        </div>
      </div>
      {children}
    </section>
  );
}

/** The one settings switch; this path stays for the sections that import it from here. */
export { SettingsToggle } from "./primitives/SettingsControls";
