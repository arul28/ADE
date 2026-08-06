import React, { useState } from "react";
import {
  CHAT_FONT_SIZE_MAX_PX,
  CHAT_FONT_SIZE_MIN_PX,
  CHAT_CHROME_TINT_IDS,
  CHAT_SHELL_GEOMETRY_IDS,
  CHAT_TRANSCRIPT_DENSITY_IDS,
  CODE_BLOCK_COPY_POSITION_IDS,
  DEFAULT_TERMINAL_FONT_FAMILY,
  THEME_IDS,
  useAppStore,
  useRootAppStore,
} from "../../state/appStore";
import type {
  ChatChromeTint,
  ChatShellGeometry,
  ChatTranscriptDensity,
  CodeBlockCopyButtonPosition,
  ThemeId,
} from "../../state/appStore";
import {
  TERMINAL_FONT_FAMILY_OPTIONS,
  TERMINAL_FONT_SIZE_OPTIONS,
  TERMINAL_LINE_HEIGHT_OPTIONS,
  TERMINAL_SCROLLBACK_OPTIONS,
} from "./terminalOptions";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { ChatAppearancePreview } from "./ChatAppearancePreview";
import { LaunchPromptSection } from "./LaunchPromptSection";
import {
  SettingsCard,
  SettingsGroup,
  SettingsSegmented,
  SettingsSelect,
  SettingsSlider,
  SettingsToggle,
} from "./primitives";

/**
 * Appearance settings.
 *
 * Everything here is app-scoped (renderer `appStore` → localStorage), so no
 * card carries a scope chip — nothing about "this install only" surprises for
 * a font size. Writes land immediately; the store is synchronous, so there is
 * nothing to fail and nothing to confirm.
 */

export const THEME_META: Record<
  ThemeId,
  {
    label: string;
    description: string;
    colors: { bg: string; fg: string; accent: string; card: string; border: string };
  }
> = {
  dark: {
    label: "Dark",
    description: "Dark surfaces, cool violet accent.",
    colors: { bg: "#0f0f11", fg: "#e4e4e7", accent: "#A78BFA", card: "#18181b", border: "#27272a" },
  },
  light: {
    label: "Light",
    description: "Light background, saturated violet accent.",
    colors: { bg: "#f5f5f6", fg: "#0f0f11", accent: "#7C3AED", card: "#ffffff", border: "#d4d4d8" },
  },
};

export function ThemeSwatch({
  themeId,
  selected,
  onClick,
}: {
  themeId: ThemeId;
  selected: boolean;
  onClick: () => void;
}) {
  const { label, description, colors } = THEME_META[themeId];
  const [hovered, setHovered] = useState(false);

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: 12,
        flex: 1,
        minWidth: 0,
        textAlign: "left",
        background: selected
          ? "color-mix(in srgb, var(--color-accent) 10%, transparent)"
          : hovered
            ? COLORS.hoverBg
            : COLORS.recessedBg,
        border: `1px solid ${selected ? COLORS.accent : hovered ? COLORS.outlineBorder : COLORS.borderMuted}`,
        borderRadius: 10,
        cursor: "pointer",
        transition: "border-color 150ms, background 150ms",
      }}
    >
      {/* Miniature of the theme: title bar, accent, two text lines. */}
      <span
        aria-hidden
        style={{
          width: 60,
          height: 42,
          flexShrink: 0,
          background: colors.bg,
          border: `1px solid ${colors.border}`,
          borderRadius: 6,
          overflow: "hidden",
          display: "block",
        }}
      >
        <span style={{ display: "block", height: 8, background: colors.card }} />
        <span
          style={{
            display: "block",
            width: 32,
            height: 3,
            margin: "6px auto 0",
            background: colors.accent,
            borderRadius: 2,
          }}
        />
        <span style={{ display: "block", margin: "5px 6px 0" }}>
          <span style={{ display: "block", height: 2, width: 30, background: colors.fg, opacity: 0.4, borderRadius: 1 }} />
          <span style={{ display: "block", height: 2, width: 20, marginTop: 3, background: colors.fg, opacity: 0.25, borderRadius: 1 }} />
        </span>
      </span>

      <span style={{ minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontFamily: SANS_FONT,
            fontSize: 12,
            fontWeight: 600,
            color: selected ? COLORS.accent : COLORS.textPrimary,
          }}
        >
          {label}
        </span>
        <span
          style={{
            display: "block",
            marginTop: 2,
            fontFamily: SANS_FONT,
            fontSize: 11,
            color: COLORS.textMuted,
          }}
        >
          {description}
        </span>
      </span>
    </button>
  );
}

const COPY_POSITION_META: Record<CodeBlockCopyButtonPosition, { label: string; hint: string }> = {
  top: { label: "Top", hint: "Pinned to the corner" },
  bottom: { label: "Bottom", hint: "Easier after scrolling" },
  auto: { label: "Auto-float", hint: "Follows the viewport" },
};

const TRANSCRIPT_DENSITY_LABEL: Record<ChatTranscriptDensity, string> = {
  compact: "Compact",
  comfortable: "Comfortable",
  spacious: "Spacious",
};

const CHAT_CHROME_TINT_LABEL: Record<ChatChromeTint, string> = {
  neutral: "No tint",
  colored: "Colored",
};

const SHELL_GEOMETRY_LABEL: Record<ChatShellGeometry, string> = {
  soft: "Soft",
  default: "Default",
  sharp: "Sharp",
};

export function AppearanceSection() {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);

  const chatFontSizePx = useAppStore((s) => s.chatFontSizePx);
  const setChatFontSizePx = useAppStore((s) => s.setChatFontSizePx);
  const resetThemeAndChatFontDefaults = useAppStore((s) => s.resetThemeAndChatFontDefaults);
  const chatTranscriptDensity = useAppStore((s) => s.chatTranscriptDensity);
  const setChatTranscriptDensity = useAppStore((s) => s.setChatTranscriptDensity);
  const chatChromeTint = useAppStore((s) => s.chatChromeTint);
  const setChatChromeTint = useAppStore((s) => s.setChatChromeTint);
  const chatShellGeometry = useAppStore((s) => s.chatShellGeometry);
  const setChatShellGeometry = useAppStore((s) => s.setChatShellGeometry);
  const chatUserMinimapEnabled = useAppStore((s) => s.chatUserMinimapEnabled);
  const setChatUserMinimapEnabled = useAppStore((s) => s.setChatUserMinimapEnabled);
  const promptStashButtonEnabled = useRootAppStore((s) => s.promptStashButtonEnabled);
  const setPromptStashButtonEnabled = useRootAppStore((s) => s.setPromptStashButtonEnabled);

  const codeBlockCopyButtonPosition = useAppStore((s) => s.codeBlockCopyButtonPosition);
  const setCodeBlockCopyButtonPosition = useAppStore((s) => s.setCodeBlockCopyButtonPosition);

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
            <button
              type="button"
              onClick={() => resetThemeAndChatFontDefaults()}
              style={outlineButton({ height: 28, padding: "0 10px", fontSize: 11 })}
              title="Sets theme to dark and chat font to 14px. Density, tint, and geometry stay as set."
            >
              Restore defaults
            </button>
          }
          stacked
        >
          <div style={{ display: "flex", gap: 10 }}>
            {THEME_IDS.map((id) => (
              <ThemeSwatch key={id} themeId={id} selected={theme === id} onClick={() => setTheme(id)} />
            ))}
          </div>
        </SettingsCard>
      </SettingsGroup>

      <SettingsGroup title="Chat typography">
        <SettingsCard
          anchor="chat-font-size"
          title="Chat font size"
          description="Sizes the transcript and composer. Not a whole-window zoom."
          control={
            <SettingsSlider
              min={CHAT_FONT_SIZE_MIN_PX}
              max={CHAT_FONT_SIZE_MAX_PX}
              value={chatFontSizePx}
              onChange={setChatFontSizePx}
              ariaLabel="Chat font size"
              valueLabel={`${chatFontSizePx}px`}
            />
          }
        />
        <SettingsCard
          anchor="transcript-density"
          title="Transcript density"
          description="Vertical spacing between messages."
          control={
            <SettingsSegmented
              ariaLabel="Transcript density"
              value={chatTranscriptDensity}
              onChange={setChatTranscriptDensity}
              options={CHAT_TRANSCRIPT_DENSITY_IDS.map((id) => ({
                value: id,
                label: TRANSCRIPT_DENSITY_LABEL[id],
              }))}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Chat surface">
        <SettingsCard
          anchor="chat-tint"
          title="Chat tint"
          description="Colored gives each runtime its own hue in the chat chrome."
          control={
            <SettingsSegmented
              ariaLabel="Chat tint"
              value={chatChromeTint}
              onChange={setChatChromeTint}
              options={CHAT_CHROME_TINT_IDS.map((id) => ({ value: id, label: CHAT_CHROME_TINT_LABEL[id] }))}
            />
          }
        />
        <SettingsCard
          anchor="chat-corners"
          title="Chat shell corners"
          control={
            <SettingsSegmented
              ariaLabel="Chat shell corners"
              value={chatShellGeometry}
              onChange={setChatShellGeometry}
              options={CHAT_SHELL_GEOMETRY_IDS.map((id) => ({ value: id, label: SHELL_GEOMETRY_LABEL[id] }))}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Chat details">
        <SettingsCard
          anchor="code-block-copy-position"
          title="Code block copy button"
          description="Where the copy control sits on a code block."
          control={
            <SettingsSegmented
              ariaLabel="Code block copy button position"
              value={codeBlockCopyButtonPosition}
              onChange={setCodeBlockCopyButtonPosition}
              options={CODE_BLOCK_COPY_POSITION_IDS.map((id) => ({
                value: id,
                label: COPY_POSITION_META[id].label,
                hint: COPY_POSITION_META[id].hint,
              }))}
            />
          }
        />
        <SettingsCard
          anchor="user-message-minimap"
          title="User message minimap"
          description="A tick per message you sent, in the chat's left gutter. Hover to preview, click to jump. Mouse only."
          control={
            <SettingsToggle
              label="User message minimap"
              checked={chatUserMinimapEnabled}
              onChange={setChatUserMinimapEnabled}
            />
          }
        />
        <SettingsCard
          anchor="prompt-stash-button"
          title="Prompt stash button"
          description="The bookmark beside the context meter. Cmd/Ctrl+S works either way."
          control={
            <SettingsToggle
              label="Prompt stash button"
              checked={promptStashButtonEnabled}
              onChange={setPromptStashButtonEnabled}
            />
          }
        />
        <LaunchPromptSection />
        <SettingsCard
          anchor="appearance-preview"
          title="Live preview"
          description="Reflects every choice above."
          stacked
        >
          <div
            style={{
              border: `1px solid ${COLORS.borderMuted}`,
              borderRadius: 10,
              background: COLORS.recessedBg,
              padding: 14,
              overflow: "hidden",
              maxWidth: "100%",
            }}
          >
            <ChatAppearancePreview
              theme={theme}
              chatFontSizePx={chatFontSizePx}
              transcriptDensity={chatTranscriptDensity}
              chromeTint={chatChromeTint}
              shellGeometry={chatShellGeometry}
              chatUserMinimapEnabled={chatUserMinimapEnabled}
            />
          </div>
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
