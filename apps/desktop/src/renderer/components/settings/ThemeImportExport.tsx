import React, { useRef, useState } from "react";
import { useAppStore } from "../../state/appStore";
import {
  allThemeOptions,
  importVscodeTheme,
  parseAdeThemeFile,
  prepareImportedTheme,
  resolveThemeById,
  serializeAdeTheme,
  themeExportFileName,
  type AdeTheme,
  type AdeThemeSource,
} from "../../../shared/theme";
import { Dialog } from "../ui/dialog";
import { COLORS, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { showToast } from "../app/toast/toastStore";
import { upsertCustomTheme } from "./themeCustomizerModel";

/**
 * Import / export for themes.
 *
 * Export writes the active theme as the versioned ADE envelope to the clipboard
 * and to a `<file>.json` download. Import accepts either an ADE theme file or a
 * VS Code theme (detected by its `colors`/`tokenColors` keys): the VS Code path
 * is best-effort and shows exactly which keys it could not map rather than
 * claiming more fidelity than it has.
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
  const themeId = useAppStore((s) => s.themeId);
  const customThemes = useAppStore((s) => s.customThemes);
  const setTheme = useAppStore((s) => s.setTheme);
  const setCustomThemes = useAppStore((s) => s.setCustomThemes);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [unmapped, setUnmapped] = useState<{ name: string; keys: string[] } | null>(null);

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
      parsed = JSON.parse(await file.text());
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
      if (result.unmapped.length > 0) setUnmapped({ name: saved.name, keys: result.unmapped });
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
    <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
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
      <button type="button" onClick={() => fileInputRef.current?.click()} style={toolbarButton}>
        Import theme…
      </button>
      <button type="button" onClick={() => void handleExport()} style={toolbarButton}>
        Export current
      </button>
      <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textDim }}>
        ADE or VS Code theme JSON
      </span>

      <Dialog
        open={unmapped != null}
        onOpenChange={(open) => { if (!open) setUnmapped(null); }}
        title={`Imported ${unmapped?.name ?? "theme"}`}
        description="ADE mapped the workbench colours it understands. These VS Code keys were not mapped."
        size="md"
        tone="accent"
        actions={[{ label: "Done", onClick: () => setUnmapped(null), variant: "solid" }]}
      >
        {unmapped ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>
              {unmapped.keys.length} unmapped key{unmapped.keys.length === 1 ? "" : "s"}
              {unmapped.keys.includes("tokenColors") ? " — syntax highlighting colours are not applied" : ""}.
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
    </div>
  );
}

const toolbarButton: React.CSSProperties = outlineButton({ height: 26, padding: "0 10px", fontSize: 11 });
