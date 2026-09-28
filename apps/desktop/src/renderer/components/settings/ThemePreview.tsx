import React, { useMemo } from "react";
import { resolveTheme, type AdeTheme } from "../../../shared/theme";

/**
 * A miniature of ADE painted in a theme's own colours.
 *
 * A colour dot tells you the accent; it does not tell you whether the theme is
 * comfortable to read. This draws the four surfaces a person actually stares at
 * — the shell chrome, a chat exchange, a lane row and a diff — from the
 * resolved palette, so the gallery card answers "what would ADE look like"
 * rather than "what is this theme's accent".
 *
 * It is deliberately inline-styled from `resolved.palette` rather than from the
 * app's own CSS variables: a preview of a theme must not be painted in the
 * active theme's colours.
 */
export function ThemePreview({ theme, height = 88 }: { theme: AdeTheme; height?: number }) {
  const { palette: p } = useMemo(() => resolveTheme(theme), [theme]);
  const line = (width: string, color: string, opacity = 1): React.CSSProperties => ({
    width,
    height: 3,
    borderRadius: 2,
    background: color,
    opacity,
  });
  return (
    <div
      aria-hidden
      data-theme-preview={theme.id}
      style={{
        display: "flex",
        height,
        borderRadius: 8,
        overflow: "hidden",
        border: `1px solid ${p.border}`,
        background: p.bg,
        flexShrink: 0,
      }}
    >
      {/* Shell rail + sidebar. */}
      <div
        style={{
          width: 26,
          flexShrink: 0,
          background: p.surface,
          borderRight: `1px solid ${p.border}`,
          display: "flex",
          flexDirection: "column",
          gap: 5,
          padding: "8px 6px",
        }}
      >
        <div style={{ width: 14, height: 14, borderRadius: 4, background: p.accent }} />
        <div style={line("100%", p.mutedFg, 0.5)} />
        <div style={line("80%", p.mutedFg, 0.35)} />
        <div style={line("90%", p.mutedFg, 0.35)} />
      </div>

      {/* Main column: header, chat, lane, diff. */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div
          style={{
            height: 14,
            background: p.surfaceRaised,
            borderBottom: `1px solid ${p.border}`,
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "0 6px",
          }}
        >
          <div style={{ width: 22, height: 3, borderRadius: 2, background: p.fg, opacity: 0.55 }} />
          <div style={{ flex: 1 }} />
          <div style={{ width: 8, height: 8, borderRadius: 999, background: p.accent, opacity: 0.9 }} />
        </div>

        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, padding: "6px 8px", minWidth: 0 }}>
          {/* Agent message. */}
          <div
            style={{
              alignSelf: "flex-start",
              maxWidth: "82%",
              background: p.card,
              border: `1px solid ${p.border}`,
              borderRadius: 6,
              padding: "4px 5px",
              display: "flex",
              flexDirection: "column",
              gap: 3,
            }}
          >
            <div style={line("52px", p.fg, 0.7)} />
            <div style={line("34px", p.mutedFg, 0.8)} />
          </div>
          {/* User message in the accent. */}
          <div
            style={{
              alignSelf: "flex-end",
              width: 44,
              height: 12,
              borderRadius: 6,
              background: p.accent,
              opacity: 0.9,
            }}
          />
        </div>

        {/* Lane row + diff strip. */}
        <div style={{ borderTop: `1px solid ${p.border}`, background: p.surfaceRecessed, padding: "4px 6px", display: "flex", flexDirection: "column", gap: 3 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div style={{ width: 6, height: 6, borderRadius: 999, background: p.success }} />
            <div style={line("40px", p.fg, 0.6)} />
            <div style={{ flex: 1 }} />
            <div style={{ width: 20, height: 5, borderRadius: 3, background: p.accentMuted }} />
          </div>
          <div style={{ display: "flex", gap: 3 }}>
            <div style={{ flex: 1, height: 5, borderRadius: 2, background: p.diffAdd, opacity: 0.35 }} />
            <div style={{ flex: 1, height: 5, borderRadius: 2, background: p.diffDel, opacity: 0.35 }} />
            <div style={{ flex: 1, height: 5, borderRadius: 2, background: p.diffHunk, opacity: 0.3 }} />
          </div>
        </div>
      </div>
    </div>
  );
}
