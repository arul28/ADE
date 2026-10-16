import React, { useRef, useState } from "react";
import { selectEffectiveThemeId, useAppStore } from "../../state/appStore";
import {
  allThemeOptions,
  ADE_SYNTAX_KEYS,
  importVscodeTheme,
  parseAdeThemeFile,
  parseJsonc,
  prepareImportedTheme,
  resolveThemeById,
  serializeAdeTheme,
  themeExportFileName,
  type AdeTheme,
  type AdeThemeSource,
} from "../../../shared/theme";
import { DownloadSimple, UploadSimple } from "@phosphor-icons/react";
import { Dialog } from "../ui/dialog";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { SettingsDisclosure, SettingsSectionAction } from "./primitives";
import { showToast } from "../app/toast/toastStore";
import { upsertCustomTheme } from "./themeCustomizerModel";
import { openExternalUrl } from "../../lib/openExternal";

/**
 * Import / export for themes.
 *
 * Export writes the active theme as the versioned ADE envelope to the clipboard
 * and to a `<file>.json` download. Import accepts either an ADE theme file or a
 * VS Code theme (detected by its `colors`/`tokenColors` keys), with the
 * comments and trailing commas VS Code files carry. The VS Code path is best
 * effort: it maps the workbench and code colours it understands and shows
 * exactly which keys it could not map rather than claiming more fidelity than
 * it has.
 *
 * Both paths store the result as a custom theme through the same
 * `setCustomThemes` / `setTheme` seam the customizer uses, so an imported theme
 * persists and syncs like any other.
 */

function looksLikeVscodeTheme(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if ("palette" in record) return false;
  return ("colors" in record && typeof record.colors === "object") || Array.isArray(record.tokenColors);
}

export function ThemeImportExport() {
  // Export what is on screen, which differs from the chosen variant when the
  // theme follows the system.
  const themeId = useAppStore(selectEffectiveThemeId);
  const customThemes = useAppStore((s) => s.customThemes);
  const setTheme = useAppStore((s) => s.setTheme);
  const setCustomThemes = useAppStore((s) => s.setCustomThemes);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [unmapped, setUnmapped] = useState<{ name: string; keys: string[]; syntaxCount: number } | null>(null);

  const activeTheme = resolveThemeById(themeId, customThemes);

  const storeImported = (theme: AdeTheme, source: Extract<AdeThemeSource, "imported" | "vscode">): AdeTheme => {
    const takenIds = allThemeOptions(customThemes).map((entry) => entry.id);
    const prepared = prepareImportedTheme(theme, source, takenIds);
    setCustomThemes(upsertCustomTheme(customThemes, prepared));
    setTheme(prepared.id);
    return prepared;
  };

  const handleExport = async () => {
    const json = serializeAdeTheme(activeTheme);
    try {
      await navigator.clipboard?.writeText(json);
    } catch {
      // Clipboard can be unavailable; the download below still delivers the file.
    }
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = themeExportFileName(activeTheme);
    anchor.click();
    URL.revokeObjectURL(url);
    showToast({ title: `Exported ${activeTheme.name}`, tone: "success" });
  };

  const handleFile = async (file: File) => {
    let parsed: unknown;
    try {
      parsed = parseJsonc(await file.text());
    } catch {
      showToast({ title: "That file is not valid JSON", tone: "error" });
      return;
    }
    if (looksLikeVscodeTheme(parsed)) {
      const result = importVscodeTheme(parsed);
      if (!result) {
        showToast({ title: "Couldn't read that VS Code theme", tone: "error" });
        return;
      }
      const saved = storeImported(result.theme, "vscode");
      if (result.unmapped.length > 0) setUnmapped({ name: saved.name, keys: result.unmapped, syntaxCount: result.syntaxMapped.length });
      else showToast({ title: `Imported ${saved.name}`, tone: "success" });
      return;
    }
    const ade = parseAdeThemeFile(parsed);
    if (!ade.ok) {
      showToast({ title: ade.error, tone: "error" });
      return;
    }
    const saved = storeImported(ade.theme, "imported");
    showToast({ title: `Imported ${saved.name}`, tone: "success" });
  };

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        aria-label="Import a theme file"
        style={{ display: "none" }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void handleFile(file);
        }}
      />
      <SettingsSectionAction
        icon={<UploadSimple size={13} />}
        label="Import"
        title="Import a theme file: an ADE theme, or a VS Code colour theme (.json)"
        onClick={() => fileInputRef.current?.click()}
      />
      <SettingsSectionAction
        icon={<DownloadSimple size={13} />}
        label="Export"
        title={`Save ${activeTheme.name} as a shareable theme file, and copy it`}
        onClick={() => void handleExport()}
      />

      <Dialog
        open={unmapped != null}
        onOpenChange={(open) => { if (!open) setUnmapped(null); }}
        title={`Imported ${unmapped?.name ?? "theme"}`}
        description="ADE mapped the interface, terminal and code colours it understands. These VS Code keys were not mapped."
        size="md"
        tone="accent"
        actions={[{ label: "Done", onClick: () => setUnmapped(null), variant: "solid" }]}
      >
        {unmapped ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>
              {unmapped.syntaxCount > 0
                ? `Code colours: ${unmapped.syntaxCount} of ${ADE_SYNTAX_KEYS.length} imported. `
                : unmapped.keys.includes("tokenColors")
                  ? "Code colours: none could be read, so the editor uses colours made from the terminal palette. "
                  : ""}
              {unmapped.keys.length} unmapped key{unmapped.keys.length === 1 ? "" : "s"}.
            </span>
            <div style={{ maxHeight: 180, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
              {unmapped.keys.map((key) => (
                <code key={key} style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: COLORS.textSecondary }}>
                  {key}
                </code>
              ))}
            </div>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}

type ThemeLink = { label: string; url: string };

const THEME_SOURCES: readonly ThemeLink[] = [
  { label: "Open VSX themes", url: "https://open-vsx.org/?category=Themes&sortBy=downloadCount" },
  { label: "VS Code Marketplace", url: "https://marketplace.visualstudio.com/search?target=VSCode&category=Themes&sortBy=Installs" },
  { label: "Preview on vscodethemes.com", url: "https://vscodethemes.com" },
];

/**
 * What Import and Export do, in plain words, with where to find themes.
 *
 * It sits under the gallery as a closed disclosure, so it costs no space until
 * someone wants it. The facts it states are the same ones the importer
 * enforces: which files it reads, what a VS Code file gives it, and that an
 * imported theme stays on this computer.
 */
export function ThemeFilesHelp() {
  const linkStyle: React.CSSProperties = {
    all: "unset",
    cursor: "pointer",
    color: COLORS.accent,
    fontFamily: SANS_FONT,
    fontSize: 12,
    textDecoration: "underline",
    textUnderlineOffset: 2,
  };
  const body: React.CSSProperties = { margin: 0, fontFamily: SANS_FONT, fontSize: 12, lineHeight: 1.55, color: COLORS.textMuted };
  const label: React.CSSProperties = { fontFamily: SANS_FONT, fontSize: 12, fontWeight: 600, color: COLORS.textSecondary };
  return (
    <SettingsDisclosure summary="Theme files: import, export and where to find themes">
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={label}>Import</span>
        <p style={body}>
          Choose a <code>.json</code> theme file. ADE reads two kinds. An ADE theme file comes from Export. A VS Code
          colour theme gives ADE its interface, terminal and code colours; comments and trailing commas in the file
          are fine. A VS Code extension (<code>.vsix</code>) is a zip file: unzip it and choose a file from its
          <code> themes</code> folder. The theme is saved on this computer and becomes the active theme.
        </p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={label}>Export</span>
        <p style={body}>
          Saves the active theme as <code>ade-theme-&lt;name&gt;.json</code> and copies the same text to the
          clipboard. The file holds the palette, terminal colours, code colours and shape settings, so it carries a
          theme to another computer or to a friend. Importing it there restores the theme.
        </p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={label}>Find more themes</span>
        <p style={body}>
          Any VS Code colour theme works. Browse them here, then download the file from the theme's repository.
        </p>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          {THEME_SOURCES.map((link) => (
            <button key={link.url} type="button" style={linkStyle} onClick={() => openExternalUrl(link.url)}>
              {link.label}
            </button>
          ))}
        </div>
      </div>
    </SettingsDisclosure>
  );
}
