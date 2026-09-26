import React, { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../../state/appStore";
import {
  ADE_THEME_PALETTE_KEYS,
  DEFAULT_THEME_ID,
  allThemeOptions,
  parseColor,
  resolveTheme,
  resolveThemeById,
  toHex,
  uniqueThemeId,
  type AdeTheme,
  type AdeThemePaletteKey,
  type ThemeBaseMode,
} from "../../../shared/theme";
import { Dialog } from "../ui/dialog";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { SettingsSegmented, SettingsTextField } from "./primitives";
import { ThemePreview } from "./ThemePreview";
import { planThemeSave, upsertCustomTheme } from "./themeCustomizerModel";

/**
 * The advanced theme editor.
 *
 * Pick any shipped or custom theme as a base, override individual semantic
 * tokens, watch a live preview and the contrast warnings, then save it as a
 * custom theme. Editing a shipped theme never mutates it — Save always writes a
 * custom theme (with a fresh id) so ADE's two defaults stay pristine.
 *
 * The editor works on a draft `AdeTheme` and renders the same `resolveTheme`
 * the app paints with, so what the preview shows is what the save produces.
 */

type TokenGroup = { title: string; keys: AdeThemePaletteKey[] };

const TOKEN_GROUPS: TokenGroup[] = [
  { title: "Core", keys: ["bg", "canvas", "fg", "surface", "card", "accent"] },
  {
    title: "Surfaces",
    keys: ["surfaceRaised", "surfaceRecessed", "surfaceOverlay", "popover", "modal", "composer", "muted", "secondary"],
  },
  { title: "Text and lines", keys: ["mutedFg", "cardFg", "secondaryFg", "border", "separator", "separatorActive"] },
  { title: "Accent", keys: ["accentFg", "accentBright", "accentDeep", "accentMuted"] },
  { title: "Status", keys: ["success", "warning", "error", "info", "diffAdd", "diffDel", "diffHunk"] },
];

const TOKEN_LABELS: Record<AdeThemePaletteKey, string> = {
  bg: "Background",
  canvas: "Canvas",
  fg: "Text",
  surface: "Surface",
  surfaceRaised: "Surface raised",
  surfaceRecessed: "Surface recessed",
  surfaceOverlay: "Surface overlay",
  card: "Card",
  cardFg: "Card text",
  secondary: "Secondary",
  secondaryFg: "Secondary text",
  muted: "Muted",
  mutedFg: "Muted text",
  border: "Border",
  separator: "Separator",
  separatorActive: "Separator active",
  popover: "Popover",
  modal: "Modal",
  composer: "Composer",
  accent: "Accent",
  accentFg: "Accent text",
  accentBright: "Accent bright",
  accentDeep: "Accent deep",
  accentMuted: "Accent muted",
  success: "Success",
  warning: "Warning",
  error: "Error",
  info: "Info",
  diffAdd: "Diff added",
  diffDel: "Diff removed",
  diffHunk: "Diff hunk",
};

/** A colour input needs `#rrggbb`; a translucent token shows its opaque form. */
function swatchHex(value: string | undefined, fallback: string): string {
  const parsed = parseColor(value ?? "");
  return parsed ? toHex(parsed) : fallback;
}

function TokenRow({
  label,
  value,
  fallback,
  onChange,
  onReset,
}: {
  label: string;
  value: string | undefined;
  fallback: string;
  onChange: (next: string) => void;
  onReset: () => void;
}) {
  const [text, setText] = useState(value ?? "");
  useEffect(() => setText(value ?? ""), [value]);
  const shown = value ?? fallback;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 28px 1fr 24px", alignItems: "center", gap: 8 }}>
      <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textSecondary }}>{label}</span>
      <input
        type="color"
        aria-label={`${label} colour`}
        value={swatchHex(shown, "#000000")}
        onChange={(event) => onChange(event.target.value)}
        style={{
          width: 28,
          height: 24,
          padding: 0,
          border: `1px solid ${COLORS.borderMuted}`,
          borderRadius: 4,
          background: "transparent",
          cursor: "pointer",
        }}
      />
      <input
        aria-label={`${label} value`}
        value={text}
        placeholder={fallback}
        onChange={(event) => {
          setText(event.target.value);
          if (parseColor(event.target.value)) onChange(event.target.value);
        }}
        style={{
          height: 26,
          minWidth: 0,
          padding: "0 8px",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: COLORS.textPrimary,
          background: COLORS.recessedBg,
          border: `1px solid ${COLORS.outlineBorder}`,
          borderRadius: 6,
        }}
      />
      <button
        type="button"
        onClick={onReset}
        title={`Reset ${label}`}
        aria-label={`Reset ${label}`}
        style={{
          width: 24,
          height: 24,
          border: "none",
          background: "transparent",
          color: COLORS.textMuted,
          cursor: "pointer",
          fontSize: 13,
          lineHeight: 1,
        }}
      >
        ↺
      </button>
    </div>
  );
}

export function ThemeCustomizer({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const themeId = useAppStore((s) => s.themeId);
  const customThemes = useAppStore((s) => s.customThemes);
  const setTheme = useAppStore((s) => s.setTheme);
  const setCustomThemes = useAppStore((s) => s.setCustomThemes);

  const baseTheme = useMemo(() => resolveThemeById(themeId, customThemes), [themeId, customThemes]);
  const editingExisting = customThemes.some((theme) => theme.id === themeId);
  const [draft, setDraft] = useState<AdeTheme>(baseTheme);
  const [name, setName] = useState(baseTheme.name);

  // Re-seed the draft from the active theme each time the dialog opens, so the
  // editor always starts from what the user is looking at.
  useEffect(() => {
    if (!open) return;
    setDraft(baseTheme);
    setName(baseTheme.name);
  }, [open, baseTheme]);

  const resolvedDraft = useMemo(() => resolveTheme({ ...draft, name }), [draft, name]);
  const basePalette = useMemo(() => resolveTheme(baseTheme).palette, [baseTheme]);

  const setPaletteValue = (key: AdeThemePaletteKey, value: string) => {
    setDraft((prev) => ({ ...prev, palette: { ...prev.palette, [key]: value } }));
  };
  const resetPaletteValue = (key: AdeThemePaletteKey) => {
    setDraft((prev) => {
      const palette = { ...prev.palette };
      delete palette[key];
      return { ...prev, palette };
    });
  };

  const takenIds = allThemeOptions(customThemes).map((theme) => theme.id);
  const saveDisabled = name.trim().length === 0;

  const handleSave = () => {
    const saved = planThemeSave({
      draft,
      name,
      editingExisting,
      takenIds,
      baseId: draft.basedOn ?? baseTheme.id,
    });
    if (!saved) return;
    setCustomThemes(upsertCustomTheme(customThemes, saved));
    setTheme(saved.id);
    onOpenChange(false);
  };

  const handleDuplicate = () => {
    setName(`${baseTheme.name} copy`);
    setDraft({ ...draft, id: uniqueThemeId(`${baseTheme.name} copy`, takenIds), name: `${baseTheme.name} copy` });
  };

  const handleDelete = () => {
    if (!editingExisting) return;
    setCustomThemes(customThemes.filter((theme) => theme.id !== themeId));
    setTheme(DEFAULT_THEME_ID);
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Customize theme"
      description={`Start from ${baseTheme.name}. Saving creates a custom theme; shipped themes are never changed.`}
      size="lg"
      tone="accent"
      actions={[
        { label: "Cancel", onClick: () => onOpenChange(false), variant: "secondary" },
        { label: "Save theme", onClick: handleSave, variant: "solid", disabled: saveDisabled },
      ]}
      footerStart={
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" onClick={handleDuplicate} style={footerButton}>Duplicate</button>
          <button
            type="button"
            onClick={() => {
              setDraft(baseTheme);
              setName(baseTheme.name);
            }}
            style={footerButton}
          >
            Reset to base
          </button>
          {editingExisting ? (
            <button type="button" onClick={handleDelete} style={{ ...footerButton, color: COLORS.danger }}>
              Delete
            </button>
          ) : null}
        </div>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 240px", gap: 18 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0, maxHeight: "52vh", overflowY: "auto", paddingRight: 6 }}>
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 10, alignItems: "center" }}>
            <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textSecondary }}>Name</span>
            <SettingsTextField value={name} onChange={setName} ariaLabel="Theme name" placeholder="My theme" />
            <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textSecondary }}>Base mode</span>
            <SettingsSegmented<ThemeBaseMode>
              ariaLabel="Base mode"
              value={draft.baseMode}
              onChange={(mode) => setDraft((prev) => ({ ...prev, baseMode: mode }))}
              options={[
                { value: "dark", label: "Dark" },
                { value: "light", label: "Light" },
              ]}
            />
          </div>
          {TOKEN_GROUPS.map((group) => (
            <div key={group.title} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
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
                {group.title}
              </span>
              {group.keys.map((key) => (
                <TokenRow
                  key={key}
                  label={TOKEN_LABELS[key]}
                  value={draft.palette[key]}
                  fallback={basePalette[key]}
                  onChange={(next) => setPaletteValue(key, next)}
                  onReset={() => resetPaletteValue(key)}
                />
              ))}
            </div>
          ))}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <ThemePreview theme={{ ...draft, name }} />
          <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>
            {resolvedDraft.contrastIssues.length === 0
              ? "Text meets the contrast floor."
              : `${resolvedDraft.contrastIssues.length} contrast warning${resolvedDraft.contrastIssues.length === 1 ? "" : "s"}:`}
          </span>
          {resolvedDraft.contrastIssues.map((issue) => (
            <span key={issue.label} style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.warning, lineHeight: 1.35 }}>
              {issue.label} — {issue.ratio}:1 (below {issue.threshold}:1)
            </span>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

const footerButton: React.CSSProperties = {
  height: 28,
  padding: "0 10px",
  fontFamily: SANS_FONT,
  fontSize: 11,
  color: COLORS.textSecondary,
  background: COLORS.recessedBg,
  border: `1px solid ${COLORS.borderMuted}`,
  borderRadius: 8,
  cursor: "pointer",
};

/** Every palette key must have a label the editor can show. */
export const THEME_CUSTOMIZER_TOKEN_KEYS: readonly AdeThemePaletteKey[] = ADE_THEME_PALETTE_KEYS;
