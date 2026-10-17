import React, { useMemo } from "react";
import { DEFAULT_TERMINAL_FONT_FAMILY, selectEffectiveThemeId, useAppStore } from "../../state/appStore";
import { resolveTheme, resolveThemeById, type AdeTerminalPalette } from "../../../shared/theme";
import { SettingsSelect } from "./primitives";
import {
  TERMINAL_FONT_FAMILY_OPTIONS,
  TERMINAL_FONT_SIZE_OPTIONS,
  TERMINAL_LINE_HEIGHT_OPTIONS,
  TERMINAL_SCROLLBACK_OPTIONS,
} from "./terminalOptions";

/** The Terminal card of Settings › Appearance: a live sample over the font, size, line height and scrollback choices. */
/* ── Terminal ───────────────────────────────────────────────────────── */

export function TerminalSettings() {
  const terminalPreferences = useAppStore((s) => s.terminalPreferences);
  const setTerminalPreferences = useAppStore((s) => s.setTerminalPreferences);
  const usingCustomTerminalFont = !TERMINAL_FONT_FAMILY_OPTIONS.some((option) => option.value === terminalPreferences.fontFamily);
  return (
    <div className="ade-ap-terminal">
      <TerminalPreview
        fontFamily={terminalPreferences.fontFamily}
        fontSize={terminalPreferences.fontSize}
        lineHeight={terminalPreferences.lineHeight}
      />
      <div className="ade-ap-terminal-controls">
        <label className="ade-ap-field">
          <span className="kit-eyebrow">Font</span>
          <SettingsSelect
            ariaLabel="Terminal font family"
            value={usingCustomTerminalFont ? "__custom__" : terminalPreferences.fontFamily}
            onChange={(next) => {
              if (next === "__custom__") return;
              setTerminalPreferences({ fontFamily: next });
            }}
            options={[
              ...TERMINAL_FONT_FAMILY_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
              { value: "__custom__", label: "Custom stack…" },
            ]}
          />
        </label>
        <label className="ade-ap-field">
          <span className="kit-eyebrow">Size</span>
          <SettingsSelect
            ariaLabel="Terminal font size"
            value={String(terminalPreferences.fontSize)}
            onChange={(next) => setTerminalPreferences({ fontSize: Number(next) })}
            options={TERMINAL_FONT_SIZE_OPTIONS.map((value) => ({
              value: String(value),
              label: `${value.toFixed(1).replace(/\.0$/, "")} px`,
            }))}
          />
        </label>
        <label className="ade-ap-field">
          <span className="kit-eyebrow">Line height</span>
          <SettingsSelect
            ariaLabel="Terminal line height"
            value={String(terminalPreferences.lineHeight)}
            onChange={(next) => setTerminalPreferences({ lineHeight: Number(next) })}
            options={TERMINAL_LINE_HEIGHT_OPTIONS.map((value) => ({
              value: String(value),
              label: value.toFixed(2).replace(/0$/, ""),
            }))}
          />
        </label>
        <label className="ade-ap-field">
          <span className="kit-eyebrow">Scrollback</span>
          <SettingsSelect
            ariaLabel="Terminal scrollback"
            value={String(terminalPreferences.scrollback)}
            onChange={(next) => setTerminalPreferences({ scrollback: Number(next) })}
            options={TERMINAL_SCROLLBACK_OPTIONS.map((value) => ({
              value: String(value),
              label: `${value.toLocaleString()} lines`,
            }))}
          />
        </label>
      </div>
      {usingCustomTerminalFont ? (
        <input
          id="terminal-custom-font"
          aria-label="Custom font stack"
          className="ade-ap-input"
          value={terminalPreferences.fontFamily}
          onChange={(event) => setTerminalPreferences({ fontFamily: event.target.value })}
          placeholder={DEFAULT_TERMINAL_FONT_FAMILY}
        />
      ) : null}
    </div>
  );
}

/**
 * A few lines of a real-looking session in the active theme's terminal colours
 * and the chosen font, so a font or theme change shows before a terminal opens.
 */
function TerminalPreview({
  fontFamily,
  fontSize,
  lineHeight,
}: {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
}) {
  const themeId = useAppStore(selectEffectiveThemeId);
  const customThemes = useAppStore((s) => s.customThemes);
  const t: AdeTerminalPalette = useMemo(
    () => resolveTheme(resolveThemeById(themeId, customThemes)).terminal,
    [themeId, customThemes],
  );
  const c = (color: string | undefined, children: React.ReactNode, bold = false) => (
    <span style={{ color, fontWeight: bold ? 700 : undefined }}>{children}</span>
  );
  return (
    <div
      aria-hidden
      className="ade-ap-terminal-preview"
      style={{
        background: t.background,
        color: t.foreground,
        fontFamily,
        fontSize,
        lineHeight,
      }}
    >
      <div>{c(t.green, "➜", true)} {c(t.cyan, "ade", true)} {c(t.blue, "git:(")}{c(t.red, "main")}{c(t.blue, ")")} npm run dev</div>
      <div>{" "}</div>
      <div>  {c(t.green, "VITE", true)} {c(t.green, "v7.1.1")}  ready in {c(t.foreground, "1.24s", true)}</div>
      <div>  {c(t.green, "➜")}  Local:   {c(t.cyan, "http://127.0.0.1:5173/")}</div>
      <div>  {c(t.brightBlack, "✓")} {c(t.green, "85 passed")}  {c(t.yellow, "△ 2 warnings")}  {c(t.red, "✗ 0 failed")}</div>
      <div>
        {c(t.green, "➜", true)} {c(t.cyan, "ade", true)}{" "}
        <span style={{ display: "inline-block", width: "0.6em", height: "1.1em", verticalAlign: "text-bottom", background: t.cursor }} />
      </div>
    </div>
  );
}
