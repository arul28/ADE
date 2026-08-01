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
    <section id={id} data-settings-anchor={id}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 16 }}>
        <div
          style={{
            width: 42,
            height: 42,
            borderRadius: 12,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            color: brandColor,
            background: `color-mix(in srgb, ${brandColor} 16%, var(--color-card))`,
            border: `1px solid color-mix(in srgb, ${brandColor} 34%, transparent)`,
          }}
        >
          {iconNode ?? (Icon ? <Icon size={22} weight={iconWeight} style={{ color: brandColor }} /> : null)}
        </div>
        <div style={{ minWidth: 0, flex: 1, paddingTop: 2 }}>
          <h2
            style={{
              ...settingsSectionTitleStyle,
              marginBottom: 4,
              fontSize: 14,
              letterSpacing: "-0.01em",
            }}
          >
            {title}
          </h2>
          <p style={{ ...settingsSectionDescriptionStyle, marginBottom: 0 }}>{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

export function SettingsToggle({
  checked,
  onChange,
  id,
  disabled = false,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  id: string;
  disabled?: boolean;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        position: "relative",
        width: 36,
        height: 20,
        borderRadius: 10,
        border: "none",
        background: checked ? COLORS.accent : COLORS.outlineBorder,
        cursor: disabled ? "not-allowed" : "pointer",
        padding: 0,
        flexShrink: 0,
        opacity: disabled ? 0.5 : 1,
        transition: "background 150ms ease",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: checked ? 18 : 2,
          width: 16,
          height: 16,
          borderRadius: 8,
          background: COLORS.textPrimary,
          transition: "left 150ms ease",
        }}
      />
    </button>
  );
}
