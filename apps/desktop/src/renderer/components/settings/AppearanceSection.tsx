import React, { useId, useState } from "react";
import {
  AGENT_TURN_COMPLETION_SOUND_IDS,
  CHAT_FONT_SIZE_MAX_PX,
  CHAT_FONT_SIZE_MIN_PX,
  CHAT_CHROME_TINT_IDS,
  CHAT_SHELL_GEOMETRY_IDS,
  CHAT_TRANSCRIPT_DENSITY_IDS,
  CODE_BLOCK_COPY_POSITION_IDS,
  DEFAULT_TERMINAL_FONT_FAMILY,
  THEME_IDS,
  useAppStore,
} from "../../state/appStore";
import type {
  AgentTurnCompletionSound,
  ChatChromeTint,
  ChatShellGeometry,
  ChatTranscriptDensity,
  CodeBlockCopyButtonPosition,
  ThemeId,
} from "../../state/appStore";
import { playAgentTurnCompletionSound } from "../../lib/agentTurnCompletionSound";
import {
  TERMINAL_FONT_FAMILY_OPTIONS,
  TERMINAL_FONT_SIZE_OPTIONS,
  TERMINAL_LINE_HEIGHT_OPTIONS,
  TERMINAL_SCROLLBACK_OPTIONS,
} from "./terminalOptions";
import {
  COLORS,
  MONO_FONT,
  cardStyle,
  LABEL_STYLE,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";
import { ChatAppearancePreview } from "./ChatAppearancePreview";
import { DictationSection } from "./DictationSection";

const sectionLabelStyle: React.CSSProperties = {
  ...LABEL_STYLE,
  fontSize: 11,
  marginBottom: 16,
};

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
    description: "Dark surfaces with a cool violet accent.",
    colors: { bg: "#0f0f11", fg: "#e4e4e7", accent: "#A78BFA", card: "#18181b", border: "#27272a" },
  },
  light: {
    label: "Light",
    description: "Light background with a saturated violet accent.",
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
        gap: 14,
        padding: 14,
        flex: 1,
        background: selected ? "color-mix(in srgb, var(--color-accent) 8%, transparent)" : hovered ? COLORS.hoverBg : COLORS.cardBg,
        border: selected
          ? `1px solid ${COLORS.accent}`
          : `1px solid ${hovered ? COLORS.outlineBorder : COLORS.border}`,
        boxShadow: selected ? `inset 3px 0 0 ${COLORS.accent}` : "none",
        borderRadius: 0,
        cursor: "pointer",
        position: "relative",
        transition: "border-color 150ms, background 150ms, box-shadow 150ms",
      }}
    >
      <div
        style={{
          width: 72,
          height: 48,
          flexShrink: 0,
          background: colors.bg,
          border: `1px solid ${colors.border}`,
          borderRadius: 0,
          overflow: "hidden",
        }}
      >
        <div style={{ height: 8, background: colors.card }} />
        <div
          style={{
            width: 40,
            height: 4,
            margin: "6px auto 0",
            background: colors.accent,
            borderRadius: 0,
          }}
        />
        <div style={{ margin: "5px 6px 0", display: "flex", flexDirection: "column", gap: 3 }}>
          <div style={{ height: 2, width: 36, background: colors.fg, opacity: 0.4 }} />
          <div style={{ height: 2, width: 24, background: colors.fg, opacity: 0.25 }} />
        </div>
      </div>

      <div style={{ textAlign: "left" }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            fontFamily: MONO_FONT,
            letterSpacing: "0.02em",
            color: selected ? COLORS.accent : COLORS.textPrimary,
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontSize: 11,
            fontFamily: MONO_FONT,
            color: COLORS.textMuted,
            marginTop: 4,
          }}
        >
          {description}
        </div>
      </div>
    </button>
  );
}

/** Label a copy-position id for display. */
const COPY_POSITION_META: Record<CodeBlockCopyButtonPosition, { label: string; hint: string }> = {
  top: { label: "Top", hint: "Stays pinned to the top corner" },
  bottom: { label: "Bottom", hint: "Easier to tap after scrolling" },
  auto: { label: "Auto-float", hint: "Tracks the viewport as you scroll" },
};

const TRANSCRIPT_DENSITY_LABEL: Record<ChatTranscriptDensity, string> = {
  compact: "Compact",
  comfortable: "Comfortable",
  spacious: "Spacious",
};

const CHAT_CHROME_TINT_LABEL: Record<ChatChromeTint, string> = {
  neutral: "No tint",
  colored: "Colored mode",
};

const SHELL_GEOMETRY_LABEL: Record<ChatShellGeometry, string> = {
  soft: "Soft",
  default: "Default",
  sharp: "Sharp",
};

/** Pill-button selected state matching ThemeSwatch language. Keeps the 'disabled-looking' 0.55 opacity out. */
function pillToggleStyle(selected: boolean): React.CSSProperties {
  return {
    ...primaryButton({ height: 32, padding: "0 14px", fontSize: 10 }),
    background: selected ? "color-mix(in srgb, var(--color-accent) 12%, transparent)" : COLORS.cardBg,
    color: selected ? COLORS.accent : COLORS.textPrimary,
    border: `1px solid ${selected ? COLORS.accent : COLORS.border}`,
    boxShadow: selected ? `inset 3px 0 0 ${COLORS.accent}` : "none",
    fontWeight: selected ? 700 : 500,
  };
}

export function AppearanceSection() {
  const chatFontSliderId = useId();
  const agentSoundSelectId = useId();
  const volumeSliderId = useId();
  const quietToggleId = useId();
  const launchPromptClipboardToggleId = useId();
  const launchPromptClipboardNoticeToggleId = useId();
  const terminalFieldId = useId();

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
  const launchPromptClipboardEnabled = useAppStore((s) => s.launchPromptClipboardEnabled);
  const setLaunchPromptClipboardEnabled = useAppStore((s) => s.setLaunchPromptClipboardEnabled);
  const launchPromptClipboardNoticeEnabled = useAppStore((s) => s.launchPromptClipboardNoticeEnabled);
  const setLaunchPromptClipboardNoticeEnabled = useAppStore((s) => s.setLaunchPromptClipboardNoticeEnabled);

  const codeBlockCopyButtonPosition = useAppStore((s) => s.codeBlockCopyButtonPosition);
  const setCodeBlockCopyButtonPosition = useAppStore((s) => s.setCodeBlockCopyButtonPosition);

  const agentTurnCompletionSound = useAppStore((s) => s.agentTurnCompletionSound);
  const setAgentTurnCompletionSound = useAppStore((s) => s.setAgentTurnCompletionSound);
  const agentTurnCompletionSoundVolume = useAppStore((s) => s.agentTurnCompletionSoundVolume);
  const setAgentTurnCompletionSoundVolume = useAppStore((s) => s.setAgentTurnCompletionSoundVolume);
  const agentTurnCompletionSoundQuietWhenFocused = useAppStore(
    (s) => s.agentTurnCompletionSoundQuietWhenFocused,
  );
  const setAgentTurnCompletionSoundQuietWhenFocused = useAppStore(
    (s) => s.setAgentTurnCompletionSoundQuietWhenFocused,
  );

  const terminalPreferences = useAppStore((s) => s.terminalPreferences);
  const setTerminalPreferences = useAppStore((s) => s.setTerminalPreferences);

  const volumePercent = Math.round(agentTurnCompletionSoundVolume * 100);
  const soundIsOff = agentTurnCompletionSound === "off";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      <section>
        <div style={sectionLabelStyle}>Theme</div>
        <div style={{ display: "flex", gap: 12 }}>
          {THEME_IDS.map((id) => (
            <ThemeSwatch key={id} themeId={id} selected={theme === id} onClick={() => setTheme(id)} />
          ))}
        </div>
      </section>

      <section>
        <div style={{ ...sectionLabelStyle, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <span>Chat typography & transcript</span>
          <button
            type="button"
            onClick={() => resetThemeAndChatFontDefaults()}
            style={outlineButton({ height: 30, padding: "0 12px", fontSize: 10 })}
            title="Sets theme to dark and chat font to 14px"
          >
            Restore theme & font defaults
          </button>
        </div>
        <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim, marginBottom: 12, lineHeight: 1.5 }}>
          Restore affects theme and chat font size only. Density, tint, geometry, and other controls stay as set.
        </div>
        <div style={{ ...cardStyle(), display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
            Font size applies to the agent chat transcript and composer using shared CSS sizing (no whole-surface zoom).
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              gap: 16,
              alignItems: "start",
            }}
          >
            <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
              <label htmlFor={chatFontSliderId} style={{ ...LABEL_STYLE, marginBottom: 0 }}>
                Chat font size ({chatFontSizePx}px)
              </label>
              <input
                id={chatFontSliderId}
                type="range"
                min={CHAT_FONT_SIZE_MIN_PX}
                max={CHAT_FONT_SIZE_MAX_PX}
                step={1}
                value={chatFontSizePx}
                onChange={(e) => setChatFontSizePx(Number(e.target.value))}
                style={{ width: "100%", maxWidth: 420, accentColor: COLORS.accent }}
              />
            </div>

            <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
              <div style={{ ...LABEL_STYLE, marginBottom: 0 }}>Transcript density</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {CHAT_TRANSCRIPT_DENSITY_IDS.map((id) => {
                  const selected = chatTranscriptDensity === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setChatTranscriptDensity(id)}
                      style={{
                        ...pillToggleStyle(selected),
                        height: 36,
                        minWidth: 110,
                        padding: "0 14px",
                      }}
                    >
                      {TRANSCRIPT_DENSITY_LABEL[id]}
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
              <div style={{ ...LABEL_STYLE, marginBottom: 0 }}>Chat tint</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {CHAT_CHROME_TINT_IDS.map((id) => {
                  const selected = chatChromeTint === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setChatChromeTint(id)}
                      style={{
                        ...pillToggleStyle(selected),
                        height: 36,
                        minWidth: 112,
                        padding: "0 14px",
                      }}
                    >
                      {CHAT_CHROME_TINT_LABEL[id]}
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
              <div style={{ ...LABEL_STYLE, marginBottom: 0 }}>Chat shell corners</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {CHAT_SHELL_GEOMETRY_IDS.map((id) => {
                  const selected = chatShellGeometry === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setChatShellGeometry(id)}
                      style={{
                        ...pillToggleStyle(selected),
                        height: 36,
                        minWidth: 88,
                        padding: "0 14px",
                      }}
                    >
                      {SHELL_GEOMETRY_LABEL[id]}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div>
            <div id="code-block-copy-position-label" style={{ ...LABEL_STYLE, marginBottom: 8 }}>
              Code block copy button
            </div>
            <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, marginBottom: 10, lineHeight: 1.5 }}>
              Where the copy control sits on code blocks in chat. Auto-float tracks the top of the viewport while you scroll a long block.
            </div>
            <div role="radiogroup" aria-labelledby="code-block-copy-position-label" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {CODE_BLOCK_COPY_POSITION_IDS.map((id) => {
                const meta = COPY_POSITION_META[id];
                const selected = codeBlockCopyButtonPosition === id;
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setCodeBlockCopyButtonPosition(id)}
                    style={{
                      ...pillToggleStyle(selected),
                      height: 44,
                      minWidth: 160,
                      padding: "0 16px",
                      display: "inline-flex",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      justifyContent: "center",
                      gap: 2,
                    }}
                  >
                    <span style={{ fontSize: 11, fontWeight: 700 }}>{meta.label}</span>
                    <span style={{ fontSize: 9, fontWeight: 400, opacity: 0.7, color: COLORS.textMuted }}>{meta.hint}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div style={{ ...LABEL_STYLE, marginBottom: 8 }}>User message minimap</div>
            <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, marginBottom: 10, lineHeight: 1.5 }}>
              Compact strip on the agent chat timeline to jump between your prompts in long threads. Hover for previews.
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button
                type="button"
                aria-pressed={chatUserMinimapEnabled}
                onClick={() => setChatUserMinimapEnabled(true)}
                style={{ ...pillToggleStyle(chatUserMinimapEnabled), height: 36, minWidth: 100, padding: "0 14px" }}
              >
                Show
              </button>
              <button
                type="button"
                aria-pressed={!chatUserMinimapEnabled}
                onClick={() => setChatUserMinimapEnabled(false)}
                style={{ ...pillToggleStyle(!chatUserMinimapEnabled), height: 36, minWidth: 100, padding: "0 14px" }}
              >
                Hide
              </button>
            </div>
          </div>

          <div>
            <div style={{ ...LABEL_STYLE, marginBottom: 8 }}>Live preview</div>
            <div
              style={{
                border: `1px solid ${COLORS.border}`,
                background: COLORS.recessedBg,
                padding: 14,
                overflowX: "auto",
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
          </div>
        </div>
      </section>

      <section>
        <div style={sectionLabelStyle}>Chat & notifications</div>
        <div style={{ ...cardStyle(), display: "flex", flexDirection: "column", gap: 20 }}>
          <div>
            <label
              id="chat-launch-clipboard"
              htmlFor={launchPromptClipboardToggleId}
              style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}
            >
              <input
                id={launchPromptClipboardToggleId}
                type="checkbox"
                checked={launchPromptClipboardEnabled}
                onChange={(e) => setLaunchPromptClipboardEnabled(e.target.checked)}
                style={{ accentColor: COLORS.accent, width: 14, height: 14 }}
              />
              <span style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: COLORS.textPrimary }}>
                  Copy launch prompts to clipboard
                </span>
                <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
                  Saves chat, CLI, and agent launch prompts before ADE sends them.
                </span>
              </span>
            </label>
            {launchPromptClipboardEnabled ? (
              <label
                htmlFor={launchPromptClipboardNoticeToggleId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginTop: 10,
                  marginLeft: 24,
                  cursor: "pointer",
                }}
              >
                <input
                  id={launchPromptClipboardNoticeToggleId}
                  type="checkbox"
                  checked={launchPromptClipboardNoticeEnabled}
                  onChange={(e) => setLaunchPromptClipboardNoticeEnabled(e.target.checked)}
                  style={{ accentColor: COLORS.accent, width: 14, height: 14 }}
                />
                <span style={{ display: "flex", flexDirection: "column" }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: COLORS.textPrimary }}>
                    Show clipboard reminder
                  </span>
                  <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
                    Shows the composer reminder before ADE copies the prompt.
                  </span>
                </span>
              </label>
            ) : null}
          </div>


          <div>
            <label htmlFor={agentSoundSelectId} style={{ ...LABEL_STYLE, marginBottom: 8, display: "block" }}>
              Agent turn completion sound
            </label>
            <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, marginBottom: 10, lineHeight: 1.5 }}>
              Plays when the assistant completes a turn and the chat is idle. Rapid successive turns collapse to a single chime.
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              <select
                id={agentSoundSelectId}
                value={agentTurnCompletionSound}
                onChange={(e) => setAgentTurnCompletionSound(e.target.value as AgentTurnCompletionSound)}
                style={{ height: 34, minWidth: 160, border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, color: COLORS.textPrimary, fontSize: 12, fontFamily: MONO_FONT, padding: "0 10px" }}
              >
                {AGENT_TURN_COMPLETION_SOUND_IDS.map((id) => (
                  <option key={id} value={id}>
                    {id === "off" ? "Off" : id.charAt(0).toUpperCase() + id.slice(1)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={soundIsOff}
                onClick={() => {
                  if (soundIsOff) return;
                  // Skip the global debounce on manual previews so rapid clicks always produce a tone.
                  playAgentTurnCompletionSound(agentTurnCompletionSound, {
                    volume: agentTurnCompletionSoundVolume,
                    skipWhenFocused: false,
                  });
                }}
                title={soundIsOff ? "Pick a sound to preview" : "Preview selected sound"}
                style={{
                  ...primaryButton({ height: 32, padding: "0 12px", fontSize: 10 }),
                  opacity: soundIsOff ? 0.45 : 1,
                  cursor: soundIsOff ? "not-allowed" : "pointer",
                }}
              >
                Preview
              </button>
              {soundIsOff ? (
                <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim }}>
                  Pick a sound to preview.
                </span>
              ) : null}
            </div>
          </div>

          <div style={{ display: "grid", gap: 6 }}>
            <label htmlFor={volumeSliderId} style={{ ...LABEL_STYLE, marginBottom: 0 }}>
              Volume ({volumePercent}%)
            </label>
            <input
              id={volumeSliderId}
              type="range"
              min={0}
              max={100}
              step={5}
              value={volumePercent}
              disabled={soundIsOff}
              onChange={(e) => setAgentTurnCompletionSoundVolume(Number(e.target.value) / 100)}
              style={{ width: 260, accentColor: COLORS.accent, opacity: soundIsOff ? 0.5 : 1 }}
            />
          </div>

          <label
            htmlFor={quietToggleId}
            style={{ display: "flex", alignItems: "center", gap: 10, cursor: soundIsOff ? "not-allowed" : "pointer", opacity: soundIsOff ? 0.5 : 1 }}
          >
            <input
              id={quietToggleId}
              type="checkbox"
              checked={agentTurnCompletionSoundQuietWhenFocused}
              disabled={soundIsOff}
              onChange={(e) => setAgentTurnCompletionSoundQuietWhenFocused(e.target.checked)}
              style={{ accentColor: COLORS.accent, width: 14, height: 14 }}
            />
            <span style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: COLORS.textPrimary }}>
                Only play when window is in the background
              </span>
              <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
                Skips the chime when ADE is the focused window.
              </span>
            </span>
          </label>
        </div>
      </section>

      <section>
        <div style={sectionLabelStyle}>Terminal</div>
        <div style={{ ...cardStyle(), display: "grid", gap: 14 }}>
          <div style={{ display: "grid", gap: 6 }}>
            <label htmlFor={`${terminalFieldId}-fontFamily`} style={{ ...LABEL_STYLE, marginBottom: 0 }}>
              Font family
            </label>
            <select
              id={`${terminalFieldId}-fontFamily`}
              value={
                TERMINAL_FONT_FAMILY_OPTIONS.some((option) => option.value === terminalPreferences.fontFamily)
                  ? terminalPreferences.fontFamily
                  : "__custom__"
              }
              onChange={(event) => {
                const next = event.target.value;
                if (next === "__custom__") return;
                setTerminalPreferences({ fontFamily: next });
              }}
              style={{ height: 34, border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, color: COLORS.textPrimary, fontSize: 12, fontFamily: MONO_FONT, padding: "0 10px" }}
            >
              {TERMINAL_FONT_FAMILY_OPTIONS.map((option) => (
                <option key={option.label} value={option.value}>
                  {option.label}
                </option>
              ))}
              <option value="__custom__">Custom stack</option>
            </select>
            <input
              aria-label="Custom terminal font family"
              value={terminalPreferences.fontFamily}
              onChange={(event) => setTerminalPreferences({ fontFamily: event.target.value })}
              placeholder={DEFAULT_TERMINAL_FONT_FAMILY}
              style={{ height: 34, border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, color: COLORS.textPrimary, fontSize: 12, fontFamily: MONO_FONT, padding: "0 10px" }}
            />
            <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim, lineHeight: 1.5 }}>
              Use a CSS font-family stack. Example: <code>"JetBrains Mono", monospace</code>
            </div>
          </div>

          <div style={{ display: "grid", gap: 6 }}>
            <label htmlFor={`${terminalFieldId}-fontSize`} style={{ ...LABEL_STYLE, marginBottom: 0 }}>
              Font size
            </label>
            <select
              id={`${terminalFieldId}-fontSize`}
              value={String(terminalPreferences.fontSize)}
              onChange={(event) => setTerminalPreferences({ fontSize: Number(event.target.value) })}
              style={{ height: 34, border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, color: COLORS.textPrimary, fontSize: 12, fontFamily: MONO_FONT, padding: "0 10px" }}
            >
              {TERMINAL_FONT_SIZE_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {value.toFixed(1).replace(/\.0$/, "")} px
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: "grid", gap: 6 }}>
            <label htmlFor={`${terminalFieldId}-lineHeight`} style={{ ...LABEL_STYLE, marginBottom: 0 }}>
              Line height
            </label>
            <select
              id={`${terminalFieldId}-lineHeight`}
              value={String(terminalPreferences.lineHeight)}
              onChange={(event) => setTerminalPreferences({ lineHeight: Number(event.target.value) })}
              style={{ height: 34, border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, color: COLORS.textPrimary, fontSize: 12, fontFamily: MONO_FONT, padding: "0 10px" }}
            >
              {TERMINAL_LINE_HEIGHT_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {value.toFixed(2).replace(/0$/, "")}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: "grid", gap: 6 }}>
            <label htmlFor={`${terminalFieldId}-scrollback`} style={{ ...LABEL_STYLE, marginBottom: 0 }}>
              Scrollback
            </label>
            <select
              id={`${terminalFieldId}-scrollback`}
              value={String(terminalPreferences.scrollback)}
              onChange={(event) => setTerminalPreferences({ scrollback: Number(event.target.value) })}
              style={{ height: 34, border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, color: COLORS.textPrimary, fontSize: 12, fontFamily: MONO_FONT, padding: "0 10px" }}
            >
              {TERMINAL_SCROLLBACK_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {value.toLocaleString()} lines
                </option>
              ))}
            </select>
          </div>

          <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.6 }}>
            These preferences apply across work terminals, lane shells, resolver terminals, and the chat drawer.
          </div>
        </div>
      </section>

      <DictationSection />
    </div>
  );
}
