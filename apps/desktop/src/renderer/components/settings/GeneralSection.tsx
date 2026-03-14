import React, { useEffect, useState } from "react";
import type { AppInfo } from "../../../shared/types";
import { useAppStore, ThemeId, THEME_IDS } from "../../state/appStore";
import { EmptyState } from "../ui/EmptyState";
import { Info } from "@phosphor-icons/react";
import {
  COLORS,
  MONO_FONT,
  cardStyle,
  LABEL_STYLE,
} from "../lanes/laneDesignTokens";

const THEME_META: Record<
  ThemeId,
  {
    label: string;
    description: string;
    colors: { bg: string; fg: string; accent: string; card: string; border: string };
  }
> = {
  dark: {
    label: "DARK",
    description: "After-hours office. Cyan glows against dark surfaces.",
    colors: { bg: "#0f0f11", fg: "#e4e4e7", accent: "#A78BFA", card: "#18181b", border: "#27272a" },
  },
  light: {
    label: "LIGHT",
    description: "Morning office. Sunlit, clean, crisp accent.",
    colors: { bg: "#f5f5f6", fg: "#0f0f11", accent: "#7C3AED", card: "#ffffff", border: "#d4d4d8" },
  },
};

const sectionLabelStyle: React.CSSProperties = {
  ...LABEL_STYLE,
  fontSize: 11,
  marginBottom: 16,
};

function ThemeSwatch({
  themeId,
  selected,
  onClick,
}: {
  themeId: ThemeId;
  selected: boolean;
  onClick: () => void;
}) {
  const { label, description, colors } = THEME_META[themeId];
  const [hovered, setHovered] = useState(false);

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: 14,
        flex: 1,
        background: selected ? `${COLORS.accent}08` : hovered ? COLORS.hoverBg : COLORS.cardBg,
        border: selected
          ? `1px solid ${COLORS.accent}`
          : `1px solid ${hovered ? COLORS.outlineBorder : COLORS.border}`,
        borderLeft: selected ? `3px solid ${COLORS.accent}` : undefined,
        borderRadius: 0,
        cursor: "pointer",
        position: "relative",
        transition: "border-color 150ms, background 150ms",
      }}
    >
      <div
        style={{
          width: 72,
          height: 48,
          flexShrink: 0,
          background: colors.bg,
          border: `1px solid ${colors.border}`,
          borderRadius: 0,
          overflow: "hidden",
        }}
      >
        <div style={{ height: 8, background: colors.card }} />
        <div
          style={{
            width: 40,
            height: 4,
            margin: "6px auto 0",
            background: colors.accent,
            borderRadius: 0,
          }}
        />
        <div style={{ margin: "5px 6px 0", display: "flex", flexDirection: "column", gap: 3 }}>
          <div style={{ height: 2, width: 36, background: colors.fg, opacity: 0.4 }} />
          <div style={{ height: 2, width: 24, background: colors.fg, opacity: 0.25 }} />
        </div>
      </div>

      <div style={{ textAlign: "left" }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            fontFamily: MONO_FONT,
            textTransform: "uppercase",
            letterSpacing: "1px",
            color: selected ? COLORS.accent : COLORS.textPrimary,
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontSize: 11,
            fontFamily: MONO_FONT,
            color: COLORS.textMuted,
            marginTop: 4,
          }}
        >
          {description}
        </div>
      </div>
    </button>
  );
}

export function GeneralSection() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const providerMode = useAppStore((s) => s.providerMode);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);

  useEffect(() => {
    let cancelled = false;
    window.ade.app
      .getInfo()
      .then((value) => {
        if (!cancelled) setInfo(value);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loadError) {
    return <EmptyState title="General" description={`Failed to load: ${loadError}`} />;
  }

  if (!info) {
    return <EmptyState title="General" description="Loading..." />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      <section>
        <div style={sectionLabelStyle}>THEME</div>
        <div style={{ display: "flex", gap: 12 }}>
          {THEME_IDS.map((id) => (
            <ThemeSwatch key={id} themeId={id} selected={theme === id} onClick={() => setTheme(id)} />
          ))}
        </div>
      </section>

      <section>
        <div style={sectionLabelStyle}>AI MODE</div>
        <div style={{ ...cardStyle(), display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ ...LABEL_STYLE, marginBottom: 0 }}>CURRENT MODE</div>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "2px 8px",
              fontSize: 10,
              fontWeight: 700,
              fontFamily: MONO_FONT,
              textTransform: "uppercase",
              letterSpacing: "1px",
              color: providerMode === "subscription" ? COLORS.success : COLORS.textMuted,
              background: providerMode === "subscription" ? `${COLORS.success}18` : `${COLORS.textDim}18`,
              border:
                providerMode === "subscription"
                  ? `1px solid ${COLORS.success}30`
                  : `1px solid ${COLORS.textDim}30`,
            }}
          >
            {providerMode}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              padding: "10px 12px",
              background: COLORS.recessedBg,
              border: `1px solid ${COLORS.border}`,
            }}
          >
            <Info size={15} color={COLORS.textMuted} style={{ flexShrink: 0, marginTop: 1 }} />
            <span
              style={{
                fontSize: 11,
                lineHeight: 1.5,
                fontFamily: MONO_FONT,
                color: COLORS.textMuted,
              }}
            >
              Provider authentication, connection checks, API keys, and worker permissions are managed in the Providers tab.
            </span>
          </div>
        </div>
      </section>

      <section
        style={{
          paddingTop: 20,
          borderTop: `1px solid ${COLORS.border}`,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            fontFamily: MONO_FONT,
            textTransform: "uppercase",
            letterSpacing: "1px",
            color: COLORS.textDim,
          }}
        >
          APP VERSION
        </span>
        <span
          style={{
            fontSize: 10,
            fontFamily: MONO_FONT,
            color: COLORS.textMuted,
          }}
        >
          v{info.appVersion}
        </span>
        <span
          style={{
            fontSize: 9,
            fontFamily: MONO_FONT,
            color: COLORS.textDim,
            padding: "1px 6px",
            background: `${COLORS.textDim}18`,
            border: `1px solid ${COLORS.textDim}30`,
            borderRadius: 0,
            textTransform: "uppercase",
            letterSpacing: "0.5px",
          }}
        >
          {info.isPackaged ? "PACKAGED" : "DEV"}
        </span>
      </section>
    </div>
  );
}
