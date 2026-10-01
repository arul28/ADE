import React, { useMemo, useState } from "react";
import { Desktop, MagnifyingGlass, Moon, Sun } from "@phosphor-icons/react";
import { selectEffectiveThemeId, useAppStore, type ThemeId } from "../../state/appStore";
import {
  ADE_THEME_FAMILIES,
  THEME_COLLECTIONS,
  resolveTheme,
  resolveThemeById,
  themeFamilyForId,
  type AdeTheme,
  type AdeThemeFamily,
} from "../../../shared/theme";
import { COLORS, MONO_FONT, SANS_FONT } from "../lanes/laneDesignTokens";
import { ThemePreview } from "./ThemePreview";

/**
 * The theme picker, as two independent choices.
 *
 * The mode (Auto, Light, Dark) picks which variant of a family is painted; the
 * family picks the colours. Every shipped family has both variants, so one
 * choice never undoes the other. A custom theme has one mode; choosing a mode
 * while one is active moves back to the ADE family.
 *
 * `ThemeStage` is the one place the active theme is shown large, with its name,
 * its palette and the mode switch. `ThemeGallery` is the grid of families, each
 * a swatch split on the diagonal into its light and dark variants.
 */

type Mode = "system" | ThemeId;

const ADE_FAMILY = ADE_THEME_FAMILIES[0]!;

function useThemeSelection() {
  const themeId = useAppStore((s) => s.themeId);
  const effectiveId = useAppStore(selectEffectiveThemeId);
  const followsSystem = useAppStore((s) => s.themeFollowsSystem);
  const mode = useAppStore((s) => s.theme);
  const customThemes = useAppStore((s) => s.customThemes);
  const setTheme = useAppStore((s) => s.setTheme);
  const setThemeFollowsSystem = useAppStore((s) => s.setThemeFollowsSystem);
  const family = themeFamilyForId(themeId);
  return { themeId, effectiveId, followsSystem, mode, customThemes, setTheme, setThemeFollowsSystem, family };
}

const RADIUS_TAG = { sharp: "Square corners", soft: "Soft corners", round: "Round corners" } as const;
const SHADOW_TAG = { flat: "Flat depth", hard: "Hard shadows", glow: "Glow" } as const;
const FONT_TAG = { mono: "Monospace type", serif: "Serif type", rounded: "Rounded type" } as const;
const BACKDROP_TAG = { grid: "Grid", dots: "Dot grid", scanlines: "Scanlines", noise: "Paper grain", aurora: "Aurora light" } as const;

/** The parts of a theme that are not colour, as short labels for the stage. */
function flairTags(theme: AdeTheme): string[] {
  const flair = theme.flair;
  if (!flair) return [];
  const tags: string[] = [];
  if (flair.radius && flair.radius !== "default") tags.push(RADIUS_TAG[flair.radius]);
  if (flair.shadow && flair.shadow !== "soft") tags.push(SHADOW_TAG[flair.shadow]);
  if (flair.sansFont && flair.sansFont !== "default") tags.push(FONT_TAG[flair.sansFont]);
  if (flair.backdrop && flair.backdrop !== "none") tags.push(BACKDROP_TAG[flair.backdrop]);
  return tags;
}

const MODE_OPTIONS: { mode: Mode; label: string; Icon: typeof Sun }[] = [
  { mode: "system", label: "Auto", Icon: Desktop },
  { mode: "light", label: "Light", Icon: Sun },
  { mode: "dark", label: "Dark", Icon: Moon },
];

export function ThemeStage() {
  const { effectiveId, followsSystem, mode, family, customThemes, setTheme, setThemeFollowsSystem } = useThemeSelection();
  const painted = resolveThemeById(effectiveId, customThemes);
  const palette = useMemo(() => resolveTheme(painted).palette, [painted]);
  const activeMode: Mode | null = !family ? null : followsSystem ? "system" : mode;
  const title = family?.name ?? painted.name;

  const choose = (next: Mode) => {
    if (next === "system") {
      if (!family) setTheme(ADE_FAMILY.dark.id);
      setThemeFollowsSystem(true);
      return;
    }
    setThemeFollowsSystem(false);
    setTheme((family ?? ADE_FAMILY)[next].id);
  };

  const chips: { label: string; color: string }[] = [
    { label: "Background", color: palette.bg },
    { label: "Surface", color: palette.surface },
    { label: "Text", color: palette.fg },
    { label: "Accent", color: palette.accent },
    { label: "Success", color: palette.success },
    { label: "Warning", color: palette.warning },
    { label: "Error", color: palette.error },
  ];

  return (
    <div className="ade-theme-stage" data-active-theme={painted.id}>
      <div
        className="ade-theme-stage-canvas"
        style={{
          background: `radial-gradient(120% 90% at 20% 0%, color-mix(in srgb, ${palette.accent} 22%, transparent), transparent 60%), ${palette.bg}`,
        }}
      >
        {/* Keyed so a theme change fades the new preview in. */}
        <div key={painted.id} className="ade-theme-stage-preview">
          <ThemePreview theme={painted} height={196} />
        </div>
      </div>

      <div className="ade-theme-stage-spec">
        <div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <span
              style={{
                fontFamily: SANS_FONT,
                fontSize: 22,
                fontWeight: 600,
                letterSpacing: "-0.02em",
                color: COLORS.textPrimary,
              }}
            >
              {title}
            </span>
            <span
              style={{
                fontFamily: MONO_FONT,
                fontSize: 10.5,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: COLORS.textMuted,
              }}
            >
              {painted.baseMode}
              {followsSystem && family ? " · auto" : ""}
            </span>
          </div>
          {painted.description ? (
            <p style={{ margin: "6px 0 0", fontFamily: SANS_FONT, fontSize: 12.5, lineHeight: 1.5, color: COLORS.textMuted }}>
              {painted.description}
            </p>
          ) : null}
          {flairTags(painted).length > 0 ? (
            <div aria-label="Shape and feel" style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 8 }}>
              {flairTags(painted).map((tag) => (
                <span key={tag} className="ade-theme-tag">{tag}</span>
              ))}
            </div>
          ) : null}
        </div>

        <div aria-label="Palette" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {chips.map((chip) => (
            <span
              key={chip.label}
              title={`${chip.label} ${chip.color}`}
              className="ade-theme-chip"
              style={{ background: chip.color }}
            />
          ))}
        </div>

        <div role="radiogroup" aria-label="Mode" className="ade-theme-mode">
          {MODE_OPTIONS.map(({ mode: option, label, Icon }) => {
            const checked = activeMode === option;
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={checked}
                className="ade-theme-mode-option"
                onClick={() => choose(option)}
              >
                <Icon size={13} weight={checked ? "fill" : "regular"} />
                {label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** One half of a swatch, drawn from its variant's own palette. */
function SwatchHalf({
  theme,
  side,
  active,
  onPick,
}: {
  theme: AdeTheme;
  side: "light" | "dark";
  active: boolean;
  onPick: () => void;
}) {
  const p = useMemo(() => resolveTheme(theme).palette, [theme]);
  const isLight = side === "light";
  const hint = flairHint(theme, p.accent, p.fg);
  return (
    <button
      type="button"
      aria-label={`Use ${theme.name}`}
      aria-pressed={active}
      className="ade-swatch-half"
      data-side={side}
      onClick={onPick}
      style={{ background: `linear-gradient(${isLight ? "160deg" : "340deg"}, ${p.surface}, ${p.bg})` }}
    >
      {/* A hint of the UI: an accent control and a line of text. */}
      <span
        className="ade-swatch-hint"
        style={isLight ? { top: 11, left: 11 } : { bottom: 11, right: 11, flexDirection: "row-reverse" }}
      >
        <span style={{ width: 9, height: 9, borderRadius: hint.radius, background: p.accent, boxShadow: hint.shadow, flexShrink: 0 }} />
        <span style={{ width: 26, height: 4, borderRadius: hint.radius, background: p.fg, opacity: 0.35 }} />
      </span>
      {active ? (
        <span
          aria-hidden
          className="ade-swatch-mark"
          style={isLight ? { bottom: 8, left: 8, color: p.fg } : { top: 8, right: 8, color: p.fg }}
        >
          {isLight ? <Sun size={10} weight="bold" /> : <Moon size={10} weight="bold" />}
        </span>
      ) : null}
    </button>
  );
}

/**
 * How a theme's shape shows in its swatch: the accent dot takes the theme's
 * corner and its depth, so a square, hard-shadowed theme looks it before it is
 * picked.
 */
function flairHint(theme: AdeTheme, accent: string, fg: string): { radius: number; shadow: string } {
  const flair = theme.flair;
  const radius = flair?.radius === "sharp" ? 1 : flair?.radius === "round" ? 999 : flair?.radius === "soft" ? 4 : 999;
  const shadow =
    flair?.shadow === "hard"
      ? `2px 2px 0 0 ${flair.shadowColor ?? fg}`
      : flair?.shadow === "glow"
        ? `0 0 7px 1px ${accent}`
        : "none";
  return { radius, shadow };
}

function FamilyTile({
  family,
  active,
  effectiveId,
  onSelect,
  onPickVariant,
}: {
  family: AdeThemeFamily;
  active: boolean;
  effectiveId: string;
  onSelect: () => void;
  onPickVariant: (theme: AdeTheme) => void;
}) {
  const lightAccent = useMemo(() => resolveTheme(family.light).palette.accent, [family]);
  const darkAccent = useMemo(() => resolveTheme(family.dark).palette.accent, [family]);
  return (
    <div className="ade-swatch-tile" data-active={active} data-theme-family={family.id}>
      <div className="ade-swatch">
        <SwatchHalf theme={family.light} side="light" active={active && effectiveId === family.light.id} onPick={() => onPickVariant(family.light)} />
        <SwatchHalf theme={family.dark} side="dark" active={active && effectiveId === family.dark.id} onPick={() => onPickVariant(family.dark)} />
      </div>
      <button
        type="button"
        aria-pressed={active}
        aria-label={`Use the ${family.name} theme`}
        className="ade-swatch-name"
        onClick={onSelect}
      >
        <span>{family.name}</span>
        <span aria-hidden style={{ display: "inline-flex", gap: 3, marginLeft: "auto" }}>
          <span className="ade-swatch-dot" style={{ background: lightAccent }} />
          <span className="ade-swatch-dot" style={{ background: darkAccent }} />
        </span>
      </button>
    </div>
  );
}

function CustomTile({ theme, active, onSelect }: { theme: AdeTheme; active: boolean; onSelect: () => void }) {
  const p = useMemo(() => resolveTheme(theme).palette, [theme]);
  const badge = theme.source === "vscode" ? "VS Code" : theme.source === "imported" ? "Imported" : "Custom";
  return (
    <div className="ade-swatch-tile" data-active={active}>
      <div className="ade-swatch">
        <button
          type="button"
          aria-label={`Use ${theme.name}`}
          aria-pressed={active}
          className="ade-swatch-single"
          onClick={onSelect}
          style={{ background: `linear-gradient(160deg, ${p.surface}, ${p.bg})` }}
        >
          <span className="ade-swatch-hint" style={{ top: 11, left: 11 }}>
            <span style={{ width: 9, height: 9, borderRadius: 999, background: p.accent, flexShrink: 0 }} />
            <span style={{ width: 26, height: 4, borderRadius: 999, background: p.fg, opacity: 0.35 }} />
          </span>
        </button>
      </div>
      <button type="button" aria-pressed={active} className="ade-swatch-name" onClick={onSelect}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{theme.name}</span>
        <span style={{ marginLeft: "auto", fontSize: 10.5, color: COLORS.textDim, flexShrink: 0 }}>{badge}</span>
      </button>
    </div>
  );
}

/** Everything the search matches on, as one lower-case string per family. */
function familySearchText(entry: AdeThemeFamily): string {
  const collection = THEME_COLLECTIONS.find((item) => item.id === entry.collection)?.label ?? "";
  return [
    entry.name,
    entry.dark.name,
    entry.light.name,
    entry.dark.description,
    entry.light.description,
    collection,
    ...entry.tags,
  ].join(" ").toLowerCase();
}

export function ThemeGallery() {
  const { themeId, effectiveId, mode, customThemes, family, setTheme, setThemeFollowsSystem } = useThemeSelection();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();

  const searchable = useMemo(() => ADE_THEME_FAMILIES.map((entry) => ({ entry, text: familySearchText(entry) })), []);
  const visible = useMemo(
    () => searchable.filter(({ text }) => !needle || needle.split(/\s+/).every((word) => text.includes(word))),
    [searchable, needle],
  );
  const visibleCustom = customThemes.filter((theme) => !needle || theme.name.toLowerCase().includes(needle));
  const nothing = visible.length === 0 && visibleCustom.length === 0;

  const shelfLabel: React.CSSProperties = {
    display: "flex",
    alignItems: "baseline",
    gap: 8,
    margin: "0 0 10px",
    fontFamily: SANS_FONT,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <label className="ade-theme-search">
        <MagnifyingGlass size={13} aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Search ${ADE_THEME_FAMILIES.length} themes: neon, serif, light, nord…`}
          aria-label="Search themes"
          spellCheck={false}
        />
      </label>

      {THEME_COLLECTIONS.map((collection) => {
        const entries = visible.filter(({ entry }) => entry.collection === collection.id);
        if (entries.length === 0) return null;
        return (
          <section key={collection.id} aria-label={collection.label}>
            <h3 style={shelfLabel}>
              <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.textSecondary }}>{collection.label}</span>
              <span style={{ fontSize: 11.5, color: COLORS.textDim }}>{collection.blurb}</span>
            </h3>
            <div role="group" aria-label={`${collection.label} themes`} className="ade-swatch-grid">
              {entries.map(({ entry }) => (
                <FamilyTile
                  key={entry.id}
                  family={entry}
                  active={family?.id === entry.id}
                  effectiveId={effectiveId}
                  // The name keeps the mode; a swatch half picks its variant and pins it.
                  onSelect={() => setTheme(entry[mode].id)}
                  onPickVariant={(variant) => {
                    setThemeFollowsSystem(false);
                    setTheme(variant.id);
                  }}
                />
              ))}
            </div>
          </section>
        );
      })}

      {visibleCustom.length > 0 ? (
        <section aria-label="Your themes">
          <h3 style={shelfLabel}>
            <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.textSecondary }}>Yours</span>
            <span style={{ fontSize: 11.5, color: COLORS.textDim }}>Imported and customized, kept on this computer.</span>
          </h3>
          <div role="group" aria-label="Your themes" className="ade-swatch-grid">
            {visibleCustom.map((theme) => (
              <CustomTile
                key={theme.id}
                theme={theme}
                active={themeId === theme.id}
                // A custom theme has one mode, so "follow the system" does not apply.
                onSelect={() => {
                  setThemeFollowsSystem(false);
                  setTheme(theme.id);
                }}
              />
            ))}
          </div>
        </section>
      ) : null}

      {nothing ? (
        <p style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 12.5, color: COLORS.textMuted }}>
          No theme matches “{query.trim()}”. Try a mood (neon, warm, calm), a feature (serif, monospace, glow) or a name.
        </p>
      ) : null}
    </div>
  );
}
