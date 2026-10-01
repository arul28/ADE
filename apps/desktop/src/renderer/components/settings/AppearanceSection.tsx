import React, { useMemo, useState } from "react";
import { TextAa, Code, Waves, TerminalWindow, ArrowsDownUp, ClockCounterClockwise, ArrowCounterClockwise, PaintBrush } from "@phosphor-icons/react";
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  selectEffectiveThemeId,
  useAppStore,
  type InterfaceMonoFont,
  type InterfaceSansFont,
} from "../../state/appStore";
import type {
  ChatChromeTint,
  ChatShellGeometry,
  ChatTranscriptDensity,
  CodeBlockCopyButtonPosition,
} from "../../state/appStore";
import {
  TERMINAL_FONT_FAMILY_OPTIONS,
  TERMINAL_FONT_SIZE_OPTIONS,
  TERMINAL_LINE_HEIGHT_OPTIONS,
  TERMINAL_SCROLLBACK_OPTIONS,
} from "./terminalOptions";
import { resolveTheme, resolveThemeById, type AdeTerminalPalette } from "../../../shared/theme";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";
import {
  SettingsColumn,
  SettingsPanel,
  SettingsRow,
  SettingsSection,
  SettingsSplit,
  SettingsSectionAction,
  SettingsSelect,
  SettingsToggle,
} from "./primitives";
import { ThemeGallery, ThemeStage } from "./ThemeGallery";
import { ThemeCustomizer } from "./ThemeCustomizer";
import { ThemeFilesHelp, ThemeImportExport } from "./ThemeImportExport";

/**
 * Appearance settings.
 *
 * Everything here is per computer. Theme, interface and terminal rows persist
 * in the renderer `appStore` (localStorage) and never leave this machine: a
 * laptop, a desktop and a browser each keep their own look. Writes apply
 * immediately. The page is one centred column of sections, each a quiet label
 * over one panel of rows, so the whole page reads as one surface.
 */

export const COPY_POSITION_META: Record<CodeBlockCopyButtonPosition, { label: string; hint: string }> = {
  top: { label: "Top", hint: "Pinned to the corner" },
  bottom: { label: "Bottom", hint: "Easier after scrolling" },
  auto: { label: "Auto-float", hint: "Follows the viewport" },
};

export const TRANSCRIPT_DENSITY_LABEL: Record<ChatTranscriptDensity, string> = {
  compact: "Compact",
  comfortable: "Comfortable",
  spacious: "Spacious",
};

export const CHAT_CHROME_TINT_LABEL: Record<ChatChromeTint, string> = {
  neutral: "No tint",
  colored: "Colored",
};

export const SHELL_GEOMETRY_LABEL: Record<ChatShellGeometry, string> = {
  soft: "Soft",
  default: "Default",
  sharp: "Sharp",
};

export function AppearanceSection() {
  const resetThemeAndChatFontDefaults = useAppStore((s) => s.resetThemeAndChatFontDefaults);
  const [customizerOpen, setCustomizerOpen] = useState(false);

  const interfacePreferences = useAppStore((s) => s.interfacePreferences);
  const setInterfacePreferences = useAppStore((s) => s.setInterfacePreferences);
  const terminalPreferences = useAppStore((s) => s.terminalPreferences);
  const setTerminalPreferences = useAppStore((s) => s.setTerminalPreferences);

  const usingCustomTerminalFont = !TERMINAL_FONT_FAMILY_OPTIONS
    .some((option) => option.value === terminalPreferences.fontFamily);

  return (
    <SettingsColumn wide>
      <div id="theme" data-settings-anchor="theme" style={{ scrollMarginTop: 16 }}>
        <SettingsSection
          title="Theme"
          description="Colours, corners, depth and type for the whole app, and for the editor and terminal."
          actions={(
            <>
              <SettingsSectionAction
                icon={<PaintBrush size={13} />}
                label="Customize"
                title="Change colours and save the result as your own theme"
                onClick={() => setCustomizerOpen(true)}
              />
              <ThemeImportExport />
              <SettingsSectionAction
                icon={<ArrowCounterClockwise size={13} />}
                title="Restore defaults: ADE, dark, and a 14px chat font"
                onClick={() => resetThemeAndChatFontDefaults()}
              />
            </>
          )}
        >
          <div className="ade-theme-layout">
            <ThemeStage />
            <ThemeGallery />
          </div>
          <ThemeFilesHelp />
        </SettingsSection>
      </div>

      <SettingsSplit
        start={(
          <>
            <SettingsSection title="Terminal">
              <SettingsPanel>
                <SettingsRow
                  anchor="terminal-text"
                  icon={<TerminalWindow size={15} weight="duotone" />}
                  tone="green"
                  title="Font"
                  description="Work terminals, lane shells, and the chat drawer."
                  control={(
                    <>
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
                        style={{ minWidth: 150 }}
                      />
                      <SettingsSelect
                        ariaLabel="Terminal font size"
                        value={String(terminalPreferences.fontSize)}
                        onChange={(next) => setTerminalPreferences({ fontSize: Number(next) })}
                        options={TERMINAL_FONT_SIZE_OPTIONS.map((value) => ({
                          value: String(value),
                          label: `${value.toFixed(1).replace(/\.0$/, "")} px`,
                        }))}
                        style={{ minWidth: 84 }}
                      />
                    </>
                  )}
                >
                  {/* Only worth the space once "Custom stack…" is the active choice. */}
                  {usingCustomTerminalFont ? (
                    <input
                      id="terminal-custom-font"
                      aria-label="Custom font stack"
                      value={terminalPreferences.fontFamily}
                      onChange={(event) => setTerminalPreferences({ fontFamily: event.target.value })}
                      placeholder={DEFAULT_TERMINAL_FONT_FAMILY}
                      style={{
                        width: "100%",
                        height: 30,
                        marginBottom: 12,
                        padding: "0 10px",
                        fontFamily: MONO_FONT,
                        fontSize: 12,
                        color: COLORS.textPrimary,
                        background: COLORS.recessedBg,
                        border: `1px solid ${COLORS.outlineBorder}`,
                        borderRadius: 8,
                        boxSizing: "border-box",
                      }}
                    />
                  ) : null}
                  <TerminalPreview
                    fontFamily={terminalPreferences.fontFamily}
                    fontSize={terminalPreferences.fontSize}
                    lineHeight={terminalPreferences.lineHeight}
                  />
                </SettingsRow>

                <SettingsRow
                  title="Line height"
                  icon={<ArrowsDownUp size={15} weight="duotone" />}
                  tone="slate"
                  control={(
                    <SettingsSelect
                      ariaLabel="Terminal line height"
                      value={String(terminalPreferences.lineHeight)}
                      onChange={(next) => setTerminalPreferences({ lineHeight: Number(next) })}
                      options={TERMINAL_LINE_HEIGHT_OPTIONS.map((value) => ({
                        value: String(value),
                        label: value.toFixed(2).replace(/0$/, ""),
                      }))}
                      style={{ minWidth: 84 }}
                    />
                  )}
                />

                <SettingsRow
                  title="Scrollback"
                  icon={<ClockCounterClockwise size={15} weight="duotone" />}
                  tone="blue"
                  description="Lines each terminal keeps."
                  control={(
                    <SettingsSelect
                      ariaLabel="Terminal scrollback"
                      value={String(terminalPreferences.scrollback)}
                      onChange={(next) => setTerminalPreferences({ scrollback: Number(next) })}
                      options={TERMINAL_SCROLLBACK_OPTIONS.map((value) => ({
                        value: String(value),
                        label: `${value.toLocaleString()} lines`,
                      }))}
                      style={{ minWidth: 120 }}
                    />
                  )}
                />
              </SettingsPanel>
            </SettingsSection>
          </>
        )}
        end={(
          <>
            <SettingsSection title="Interface">
              <SettingsPanel>
                <SettingsRow
                  anchor="interface-font"
            icon={<TextAa size={15} weight="duotone" />}
            tone="violet"
                  title="Interface font"
                  description="Everything outside code and the terminal."
                  control={(
                    <SettingsSelect<InterfaceSansFont>
                      ariaLabel="Interface font"
                      value={interfacePreferences.sansFont}
                      onChange={(sansFont) => setInterfacePreferences({ sansFont })}
                      options={[
                        { value: "geist", label: "Geist" },
                        { value: "system", label: "System" },
                        { value: "geist-mono", label: "Geist Mono" },
                      ]}
                      style={{ minWidth: 140 }}
                    />
                  )}
                />
                <SettingsRow
                  anchor="code-font"
            icon={<Code size={15} weight="duotone" />}
            tone="blue"
                  title="Code font"
                  description="Code blocks, diffs, and file previews."
                  control={(
                    <SettingsSelect<InterfaceMonoFont>
                      ariaLabel="Code font"
                      value={interfacePreferences.monoFont}
                      onChange={(monoFont) => setInterfacePreferences({ monoFont })}
                      options={[
                        { value: "jetbrains", label: "JetBrains Mono" },
                        { value: "geist-mono", label: "Geist Mono" },
                        { value: "system", label: "System mono" },
                      ]}
                      style={{ minWidth: 140 }}
                    />
                  )}
                />
                <SettingsRow
                  anchor="reduce-motion"
            icon={<Waves size={15} weight="duotone" />}
            tone="teal"
                  title="Reduce motion"
                  description="Turn off animations and transitions everywhere."
                  control={(
                    <SettingsToggle
                      label="Reduce motion"
                      checked={interfacePreferences.reduceMotion}
                      onChange={(reduceMotion) => setInterfacePreferences({ reduceMotion })}
                    />
                  )}
                />
              </SettingsPanel>
            </SettingsSection>
          </>
        )}
      />

      <ThemeCustomizer open={customizerOpen} onOpenChange={setCustomizerOpen} />
    </SettingsColumn>
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
      style={{
        borderRadius: 10,
        padding: "12px 14px",
        background: t.background,
        color: t.foreground,
        border: "1px solid color-mix(in srgb, var(--color-border) 70%, transparent)",
        fontFamily,
        fontSize,
        lineHeight,
        whiteSpace: "pre",
        overflow: "hidden",
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
