import React, { useState } from "react";
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  useAppStore,
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
import { COLORS, MONO_FONT, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";
import {
  SettingsCard,
  SettingsGroup,
  SettingsSelect,
} from "./primitives";
import { AppleDevicesSection } from "./AppleDevicesSection";
import { ThemeGallery } from "./ThemeGallery";
import { ThemeCustomizer } from "./ThemeCustomizer";

/**
 * Appearance settings.
 *
 * Theme, terminal, and Apple device rows persist in the renderer `appStore`
 * (localStorage) and the Apple keys also sync with the signed-in account,
 * same as the rest of Appearance. Writes land immediately.
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

  const terminalPreferences = useAppStore((s) => s.terminalPreferences);
  const setTerminalPreferences = useAppStore((s) => s.setTerminalPreferences);

  const usingCustomTerminalFont = !TERMINAL_FONT_FAMILY_OPTIONS
    .some((option) => option.value === terminalPreferences.fontFamily);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      <SettingsGroup title="Theme">
        <SettingsCard
          anchor="theme"
          title="Theme"
          description="Applies to every ADE surface, not just chat."
          control={
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() => setCustomizerOpen(true)}
                style={outlineButton({ height: 28, padding: "0 10px", fontSize: 11 })}
                title="Override individual colours and save the result as a custom theme."
              >
                Customize…
              </button>
              <button
                type="button"
                onClick={() => resetThemeAndChatFontDefaults()}
                style={outlineButton({ height: 28, padding: "0 10px", fontSize: 11 })}
                title="Sets the theme to ADE Dark and chat font to 14px. Density, tint, and geometry stay as set."
              >
                Restore defaults
              </button>
            </div>
          }
          stacked
        >
          <ThemeGallery />
        </SettingsCard>
      </SettingsGroup>

      <SettingsGroup title="Terminal">
        <SettingsCard
          anchor="terminal-text"
          title="Terminal text"
          description="Applies to work terminals, lane shells, resolver terminals, and the chat drawer."
          stacked
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
              gap: 12,
            }}
          >
            <TerminalField label="Font family">
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
            </TerminalField>

            <TerminalField label="Font size">
              <SettingsSelect
                ariaLabel="Terminal font size"
                value={String(terminalPreferences.fontSize)}
                onChange={(next) => setTerminalPreferences({ fontSize: Number(next) })}
                options={TERMINAL_FONT_SIZE_OPTIONS.map((value) => ({
                  value: String(value),
                  label: `${value.toFixed(1).replace(/\.0$/, "")} px`,
                }))}
              />
            </TerminalField>

            <TerminalField label="Line height">
              <SettingsSelect
                ariaLabel="Terminal line height"
                value={String(terminalPreferences.lineHeight)}
                onChange={(next) => setTerminalPreferences({ lineHeight: Number(next) })}
                options={TERMINAL_LINE_HEIGHT_OPTIONS.map((value) => ({
                  value: String(value),
                  label: value.toFixed(2).replace(/0$/, ""),
                }))}
              />
            </TerminalField>

            <TerminalField label="Scrollback">
              <SettingsSelect
                ariaLabel="Terminal scrollback"
                value={String(terminalPreferences.scrollback)}
                onChange={(next) => setTerminalPreferences({ scrollback: Number(next) })}
                options={TERMINAL_SCROLLBACK_OPTIONS.map((value) => ({
                  value: String(value),
                  label: `${value.toLocaleString()} lines`,
                }))}
              />
            </TerminalField>
          </div>

          {/* Only worth the space once "Custom stack…" is the active choice. */}
          {usingCustomTerminalFont ? (
            <div style={{ marginTop: 12, display: "grid", gap: 6 }}>
              <label
                htmlFor="terminal-custom-font"
                style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}
              >
                Custom font stack
              </label>
              <input
                id="terminal-custom-font"
                value={terminalPreferences.fontFamily}
                onChange={(event) => setTerminalPreferences({ fontFamily: event.target.value })}
                placeholder={DEFAULT_TERMINAL_FONT_FAMILY}
                style={{
                  height: 30,
                  padding: "0 10px",
                  fontFamily: MONO_FONT,
                  fontSize: 12,
                  color: COLORS.textPrimary,
                  background: COLORS.recessedBg,
                  border: `1px solid ${COLORS.outlineBorder}`,
                  borderRadius: 8,
                }}
              />
              <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textDim }}>
                A CSS font-family stack, e.g.{" "}
                <span style={{ fontFamily: MONO_FONT }}>"JetBrains Mono", monospace</span>
              </span>
            </div>
          ) : null}
        </SettingsCard>
      </SettingsGroup>

      <AppleDevicesSection />

      <ThemeCustomizer open={customizerOpen} onOpenChange={setCustomizerOpen} />
    </div>
  );
}

function TerminalField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
      <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>{label}</span>
      {children}
    </div>
  );
}
