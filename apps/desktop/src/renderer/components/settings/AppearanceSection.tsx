import React, { useId, useMemo, useState } from "react";
import {
  AGENT_TURN_COMPLETION_SOUND_IDS,
  CODE_BLOCK_COPY_POSITION_IDS,
  DEFAULT_CHAT_FONT_SIZE_PX,
  DEFAULT_TERMINAL_FONT_FAMILY,
  THEME_IDS,
  useAppStore,
} from "../../state/appStore";
import type {
  AgentTurnCompletionSound,
  CodeBlockCopyButtonPosition,
  ThemeId,
} from "../../state/appStore";
import { playAgentTurnCompletionSound } from "../../lib/agentTurnCompletionSound";
import { ChatMarkdown } from "../chat/chatMarkdown";
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
  primaryButton,
} from "../lanes/laneDesignTokens";

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
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: 14,
        flex: 1,
        background: selected ? `${COLORS.accent}08` : hovered ? COLORS.hoverBg : COLORS.cardBg,
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

const PREVIEW_MARKDOWN = [
  "Here's a **sample** reply with a list:",
  "",
  "- First item",
  "- Second item",
  "",
  "Inline `code` and a block:",
  "",
  "```ts",
  "export function greet(name: string) {",
  '  return `Hello, ${name}`;',
  "}",
  "```",
  "",
].join("\n");

/** Font-size swatches: 3 discrete sizes mapping to whole-pixel integer scales so `transform: scale` stays crisp. */
const CHAT_FONT_SIZE_SWATCHES: { px: number; label: string; hint: string }[] = [
  { px: 13, label: "Small", hint: "Compact" },
  { px: 14, label: "Default", hint: "Original sizing" },
  { px: 16, label: "Large", hint: "Easier to read" },
];

/** Label a copy-position id for display. */
const COPY_POSITION_META: Record<CodeBlockCopyButtonPosition, { label: string; hint: string }> = {
  top: { label: "Top", hint: "Stays pinned to the top corner" },
  bottom: { label: "Bottom", hint: "Easier to tap after scrolling" },
  auto: { label: "Auto-float", hint: "Tracks the viewport as you scroll" },
};

/** Pill-button selected state matching ThemeSwatch language. Keeps the 'disabled-looking' 0.55 opacity out. */
function pillToggleStyle(selected: boolean): React.CSSProperties {
  return {
    ...primaryButton({ height: 32, padding: "0 14px", fontSize: 10 }),
    background: selected ? `${COLORS.accent}12` : COLORS.cardBg,
    color: selected ? COLORS.accent : COLORS.textPrimary,
    border: `1px solid ${selected ? COLORS.accent : COLORS.border}`,
    boxShadow: selected ? `inset 3px 0 0 ${COLORS.accent}` : "none",
    fontWeight: selected ? 700 : 500,
  };
}

export function AppearanceSection() {
  const chatFontGroupId = useId();
  const agentSoundSelectId = useId();
  const volumeSliderId = useId();
  const quietToggleId = useId();
  const terminalFieldId = useId();

  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);

  const chatFontSizePx = useAppStore((s) => s.chatFontSizePx);
  const setChatFontSizePx = useAppStore((s) => s.setChatFontSizePx);

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

  const previewScale = useMemo(() => chatFontSizePx / DEFAULT_CHAT_FONT_SIZE_PX, [chatFontSizePx]);
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
        <div style={sectionLabelStyle}>Chat font size</div>
        <div style={{ ...cardStyle(), display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
            Scales the agent chat transcript and composer together. Three sizes keep text crisp at integer scales.
          </div>
          <div
            role="radiogroup"
            aria-labelledby={chatFontGroupId}
            style={{ display: "flex", flexWrap: "wrap", gap: 8 }}
          >
            <span id={chatFontGroupId} style={{ position: "absolute", left: -9999 }}>Chat font size</span>
            {CHAT_FONT_SIZE_SWATCHES.map((swatch) => {
              const selected = chatFontSizePx === swatch.px;
              return (
                <button
                  key={swatch.px}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setChatFontSizePx(swatch.px)}
                  style={{
                    ...pillToggleStyle(selected),
                    height: 44,
                    minWidth: 120,
                    padding: "0 16px",
                    display: "inline-flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    justifyContent: "center",
                    gap: 2,
                  }}
                >
                  <span style={{ fontSize: 11, fontWeight: 700 }}>
                    {swatch.label} ({swatch.px}px)
                  </span>
                  <span style={{ fontSize: 9, fontWeight: 400, opacity: 0.7, color: COLORS.textMuted }}>
                    {swatch.hint}
                  </span>
                </button>
              );
            })}
          </div>

          <div>
            <div style={{ ...LABEL_STYLE, marginBottom: 8 }}>Live preview</div>
            <div
              style={{
                border: `1px solid ${COLORS.border}`,
                background: COLORS.recessedBg,
                padding: 14,
                maxHeight: 280,
                overflow: "auto",
              }}
            >
              <div
                style={{
                  transform: `scale(${previewScale})`,
                  transformOrigin: "top left",
                  // Downscale previews must not exceed the parent width; only expand the wrapper when scaling up.
                  width: previewScale >= 1 ? `${100 / previewScale}%` : "100%",
                  maxWidth: previewScale >= 1 ? `${100 / previewScale}%` : "100%",
                }}
              >
                <div style={{ fontFamily: MONO_FONT, fontSize: 9, color: COLORS.textDim, marginBottom: 8, letterSpacing: "0.06em" }}>
                  Sample assistant reply
                </div>
                <ChatMarkdown>{PREVIEW_MARKDOWN}</ChatMarkdown>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div style={sectionLabelStyle}>Chat & notifications</div>
        <div style={{ ...cardStyle(), display: "flex", flexDirection: "column", gap: 20 }}>
          <div>
            <div id="code-block-copy-position-label" style={{ ...LABEL_STYLE, marginBottom: 8 }}>
              Code block copy button
            </div>
            <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, marginBottom: 10, lineHeight: 1.5 }}>
              Where the copy control sits on code blocks in chat. Auto-float tracks the top of the viewport while you scroll a long block.
            </div>
            <div
              role="radiogroup"
              aria-labelledby="code-block-copy-position-label"
              style={{ display: "flex", flexWrap: "wrap", gap: 8 }}
            >
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
                    <span style={{ fontSize: 9, fontWeight: 400, opacity: 0.7, color: COLORS.textMuted }}>
                      {meta.hint}
                    </span>
                  </button>
                );
              })}
            </div>
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
    </div>
  );
}
