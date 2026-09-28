import React, { useMemo } from "react";
import { resolveTheme, type AdeTheme, type ResolvedAdeThemePalette } from "../../../shared/theme";

/**
 * A miniature ADE window painted in a theme's own colours: a sidebar of lanes,
 * a chat column, a floating menu and the composer.
 *
 * It is inline-styled from the resolved palette rather than from the app's CSS
 * variables, because a preview of a theme must not be painted in the active
 * theme's colours. Pass `split` to draw the left half in `theme` and the right
 * half in `split` — the "System" card shows both variants at once that way.
 */
export function ThemePreview({
  theme,
  split,
  height = 132,
}: {
  theme: AdeTheme;
  split?: AdeTheme;
  height?: number;
}) {
  const palette = useMemo(() => resolveTheme(theme).palette, [theme]);
  const splitPalette = useMemo(() => (split ? resolveTheme(split).palette : null), [split]);
  return (
    <div
      aria-hidden
      data-theme-preview={theme.id}
      style={{
        position: "relative",
        height,
        borderRadius: 9,
        overflow: "hidden",
        flexShrink: 0,
        boxShadow: `0 0 0 1px ${palette.border}`,
      }}
    >
      <PreviewWindow p={palette} />
      {splitPalette ? (
        <div style={{ position: "absolute", inset: 0, clipPath: "inset(0 0 0 50%)" }}>
          <PreviewWindow p={splitPalette} />
        </div>
      ) : null}
    </div>
  );
}

function PreviewWindow({ p }: { p: ResolvedAdeThemePalette }) {
  const pill = (width: string, color: string, opacity = 1, height = 6): React.CSSProperties => ({
    width,
    height,
    borderRadius: 999,
    background: color,
    opacity,
    flexShrink: 0,
  });
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", background: p.bg }}>
      {/* Sidebar: search field and lane rows, the first one selected. */}
      <div
        style={{
          width: "28%",
          flexShrink: 0,
          background: p.surface,
          borderRight: `1px solid ${p.border}`,
          display: "flex",
          flexDirection: "column",
          gap: 7,
          padding: "10px 8px",
        }}
      >
        <div style={{ height: 11, borderRadius: 999, border: `1px solid ${p.border}`, background: p.bg }} />
        <div style={{ height: 11, borderRadius: 5, background: p.accentMuted, display: "flex", alignItems: "center", padding: "0 5px" }}>
          <div style={pill("70%", p.accent, 0.9, 4)} />
        </div>
        <div style={pill("80%", p.mutedFg, 0.35, 5)} />
        <div style={pill("60%", p.mutedFg, 0.3, 5)} />
        <div style={pill("72%", p.mutedFg, 0.25, 5)} />
      </div>

      {/* Chat column. */}
      <div style={{ position: "relative", flex: 1, minWidth: 0, padding: "12px 12px 10px", display: "flex", flexDirection: "column", gap: 7 }}>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <div style={pill("34%", p.secondary, 1, 10)} />
        </div>
        <div style={pill("62%", p.fg, 0.28)} />
        <div style={pill("44%", p.fg, 0.2)} />

        {/* A floating menu, where popover, border and status tones show. */}
        <div
          style={{
            position: "absolute",
            top: 10,
            right: 10,
            width: "30%",
            padding: "6px 6px",
            borderRadius: 7,
            background: p.popover,
            border: `1px solid ${p.border}`,
            boxShadow: "0 6px 14px -8px rgba(0, 0, 0, 0.45)",
            display: "flex",
            flexDirection: "column",
            gap: 5,
          }}
        >
          {[p.success, p.accent, p.warning].map((tone) => (
            <div key={tone} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <div style={{ width: 4, height: 4, borderRadius: 999, background: tone, flexShrink: 0 }} />
              <div style={pill("100%", p.mutedFg, 0.4, 4)} />
            </div>
          ))}
        </div>

        {/* Composer with the send button in the accent. */}
        <div
          style={{
            marginTop: "auto",
            height: 20,
            borderRadius: 8,
            border: `1px solid ${p.border}`,
            background: p.composer,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "0 4px 0 8px",
          }}
        >
          <div style={pill("36%", p.mutedFg, 0.35, 4)} />
          <div style={{ flex: 1 }} />
          <div style={{ width: 11, height: 11, borderRadius: 999, background: p.accent }} />
        </div>
      </div>
    </div>
  );
}
