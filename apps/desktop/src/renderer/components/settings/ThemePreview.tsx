import React, { useMemo } from "react";
import { resolveTheme, type AdeTheme, type AdeThemeFlair, type ResolvedAdeThemePalette } from "../../../shared/theme";

/**
 * The corner and depth a preview draws with, from the theme's flair. The
 * preview is inline-styled from the resolved palette, so the flair has to be
 * turned into the same few numbers here rather than read from CSS variables.
 */
type PreviewShape = { pill: number; box: number; control: number; shadow: (color: string) => string };

function previewShape(flair: AdeThemeFlair | undefined, fg: string, accent: string): PreviewShape {
  const base = flair?.radius === "sharp"
    ? { pill: 1, box: 2, control: 2 }
    : flair?.radius === "round"
      ? { pill: 999, box: 12, control: 999 }
      : flair?.radius === "soft"
        ? { pill: 999, box: 10, control: 10 }
        : { pill: 999, box: 8, control: 999 };
  const shadow = (color: string): string =>
    flair?.shadow === "hard"
      ? `3px 3px 0 0 ${flair.shadowColor ?? fg}`
      : flair?.shadow === "glow"
        ? `0 0 12px -1px ${accent}`
        : flair?.shadow === "flat"
          ? `0 0 0 1px ${color}`
          : "0 6px 14px -8px rgba(0, 0, 0, 0.45)";
  return { ...base, shadow };
}

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
  const shape = useMemo(() => previewShape(theme.flair, palette.fg, palette.accent), [theme.flair, palette]);
  const splitShape = useMemo(
    () => (split && splitPalette ? previewShape(split.flair, splitPalette.fg, splitPalette.accent) : null),
    [split, splitPalette],
  );
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
      <PreviewWindow p={palette} shape={shape} backdrop={theme.flair?.backdrop} />
      {splitPalette && splitShape ? (
        <div style={{ position: "absolute", inset: 0, clipPath: "inset(0 0 0 50%)" }}>
          <PreviewWindow p={splitPalette} shape={splitShape} backdrop={split?.flair?.backdrop} />
        </div>
      ) : null}
    </div>
  );
}

/** A hint of the theme's backdrop layer, drawn at preview scale. */
function previewBackdrop(kind: AdeThemeFlair["backdrop"], p: ResolvedAdeThemePalette): React.CSSProperties | null {
  switch (kind) {
    case "grid":
      return {
        backgroundImage: `linear-gradient(to right, ${p.accent}22 1px, transparent 1px), linear-gradient(to bottom, ${p.accent}22 1px, transparent 1px)`,
        backgroundSize: "14px 14px",
      };
    case "dots":
      return { backgroundImage: `radial-gradient(${p.fg}33 1px, transparent 1.2px)`, backgroundSize: "9px 9px" };
    case "scanlines":
      return { backgroundImage: "repeating-linear-gradient(0deg, rgba(0,0,0,0.22) 0, rgba(0,0,0,0.22) 1px, transparent 1px, transparent 3px)" };
    case "aurora":
      return {
        backgroundImage: `radial-gradient(60% 50% at 10% 0%, ${p.accent}44, transparent 70%), radial-gradient(50% 45% at 95% 10%, ${p.info}33, transparent 70%)`,
      };
    case "noise":
      return { backgroundImage: `radial-gradient(${p.fg}18 0.6px, transparent 0.8px)`, backgroundSize: "4px 4px" };
    default:
      return null;
  }
}

function PreviewWindow({
  p,
  shape,
  backdrop,
}: {
  p: ResolvedAdeThemePalette;
  shape: PreviewShape;
  backdrop: AdeThemeFlair["backdrop"];
}) {
  const layer = previewBackdrop(backdrop, p);
  const pill = (width: string, color: string, opacity = 1, height = 6): React.CSSProperties => ({
    width,
    height,
    borderRadius: shape.pill,
    background: color,
    opacity,
    flexShrink: 0,
  });
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", background: p.bg }}>
      {layer ? <div aria-hidden style={{ position: "absolute", inset: 0, zIndex: 2, pointerEvents: "none", ...layer }} /> : null}
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
        <div style={{ height: 11, borderRadius: shape.control, border: `1px solid ${p.border}`, background: p.bg }} />
        <div style={{ height: 11, borderRadius: Math.min(5, shape.box), background: p.accentMuted, display: "flex", alignItems: "center", padding: "0 5px" }}>
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
            borderRadius: shape.box,
            background: p.popover,
            border: `1px solid ${p.border}`,
            boxShadow: shape.shadow(p.border),
            display: "flex",
            flexDirection: "column",
            gap: 5,
          }}
        >
          {[p.success, p.accent, p.warning].map((tone) => (
            <div key={tone} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <div style={{ width: 4, height: 4, borderRadius: shape.pill, background: tone, flexShrink: 0 }} />
              <div style={pill("100%", p.mutedFg, 0.4, 4)} />
            </div>
          ))}
        </div>

        {/* Composer with the send button in the accent. */}
        <div
          style={{
            marginTop: "auto",
            height: 20,
            borderRadius: shape.box,
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
          <div style={{ width: 11, height: 11, borderRadius: shape.control, background: p.accent }} />
        </div>
      </div>
    </div>
  );
}
