import React, { useMemo, useState } from "react";
import { useAppStore } from "../../state/appStore";
import {
  allThemeOptions,
  type AdeTheme,
} from "../../../shared/theme";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { SettingsTextField } from "./primitives";
import { ThemePreview } from "./ThemePreview";

/**
 * The theme picker: a searchable gallery of preview cards.
 *
 * Replaces the two-swatch toggle that could only express dark and light. The
 * grid is grouped so a user's own themes sit apart from ADE's, every card shows
 * a real preview (`ThemePreview`), and selection is immediate — the whole point
 * of a theme picker is that you see it before you commit to it.
 */

function sourceBadge(theme: AdeTheme): string | null {
  switch (theme.source) {
    case "custom":
      return "Custom";
    case "imported":
      return "Imported";
    case "vscode":
      return "VS Code";
    default:
      return null;
  }
}

function ThemeGalleryCard({
  theme,
  active,
  onSelect,
}: {
  theme: AdeTheme;
  active: boolean;
  onSelect: () => void;
}) {
  const badge = sourceBadge(theme);
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={`Use the ${theme.name} theme`}
      onClick={onSelect}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 10,
        textAlign: "left",
        background: active ? "color-mix(in srgb, var(--color-accent) 8%, transparent)" : COLORS.recessedBg,
        border: `1px solid ${active ? COLORS.accent : COLORS.borderMuted}`,
        borderRadius: 12,
        cursor: "pointer",
        transition: "border-color 150ms, background 150ms",
      }}
    >
      <ThemePreview theme={theme} />
      <span style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 }}>
        <span
          style={{
            fontFamily: SANS_FONT,
            fontSize: 12,
            fontWeight: 600,
            color: active ? COLORS.accent : COLORS.textPrimary,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {theme.name}
        </span>
        {active ? (
          <span style={{ marginLeft: "auto", fontFamily: SANS_FONT, fontSize: 10, color: COLORS.accent }}>Active</span>
        ) : badge ? (
          <span
            style={{
              marginLeft: "auto",
              fontFamily: SANS_FONT,
              fontSize: 9,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: COLORS.textDim,
            }}
          >
            {badge}
          </span>
        ) : null}
      </span>
      {theme.description ? (
        <span
          style={{
            fontFamily: SANS_FONT,
            fontSize: 11,
            lineHeight: 1.35,
            color: COLORS.textMuted,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {theme.description}
        </span>
      ) : null}
    </button>
  );
}

function ThemeGallerySection({
  title,
  themes,
  activeThemeId,
  onSelect,
}: {
  title: string;
  themes: AdeTheme[];
  activeThemeId: string;
  onSelect: (id: string) => void;
}) {
  if (themes.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span
        style={{
          fontFamily: SANS_FONT,
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: COLORS.textDim,
        }}
      >
        {title}
      </span>
      <div
        role="group"
        aria-label={title}
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
          gap: 10,
        }}
      >
        {themes.map((theme) => (
          <ThemeGalleryCard
            key={theme.id}
            theme={theme}
            active={theme.id === activeThemeId}
            onSelect={() => onSelect(theme.id)}
          />
        ))}
      </div>
    </div>
  );
}

export function ThemeGallery() {
  const themeId = useAppStore((s) => s.themeId);
  const customThemes = useAppStore((s) => s.customThemes);
  const setTheme = useAppStore((s) => s.setTheme);
  const [query, setQuery] = useState("");

  const matches = useMemo(() => {
    const options = allThemeOptions(customThemes);
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((theme) =>
      theme.name.toLowerCase().includes(q)
      || theme.id.toLowerCase().includes(q)
      || (theme.description ?? "").toLowerCase().includes(q),
    );
  }, [customThemes, query]);

  const shipped = matches.filter((theme) => theme.source === "builtin");
  const custom = matches.filter((theme) => theme.source !== "builtin");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <SettingsTextField
        value={query}
        onChange={setQuery}
        placeholder="Search themes"
        ariaLabel="Search themes"
        style={{ maxWidth: 280 }}
      />
      <ThemeGallerySection
        title="ADE themes"
        themes={shipped}
        activeThemeId={themeId}
        onSelect={setTheme}
      />
      <ThemeGallerySection
        title="Your themes"
        themes={custom}
        activeThemeId={themeId}
        onSelect={setTheme}
      />
      {matches.length === 0 ? (
        <span style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>
          No themes match “{query.trim()}”.
        </span>
      ) : null}
    </div>
  );
}
