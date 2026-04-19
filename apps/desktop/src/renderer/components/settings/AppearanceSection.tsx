import React, { useId, useMemo, useState } from "react";
import {
  AGENT_TURN_COMPLETION_SOUND_IDS,
  CHAT_FONT_SIZE_MAX_PX,
  CHAT_FONT_SIZE_MIN_PX,
  CODE_BLOCK_COPY_POSITION_IDS,
  DEFAULT_CHAT_FONT_SIZE_PX,
  THEME_IDS,
  useAppStore,
} from "../../state/appStore";
import type { AgentTurnCompletionSound, ThemeId } from "../../state/appStore";
import { playAgentTurnCompletionSound } from "../../lib/agentTurnCompletionSound";
import { ChatMarkdown } from "../chat/chatMarkdown";
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
    label: "DARK",
    description: "After-hours office. Cyan glows against dark surfaces.",
    colors: { bg: "#0f0f11", fg: "#e4e4e7", accent: "#A78BFA", card: "#18181b", border: "#27272a" },
  },
  light: {
    label: "LIGHT",
    description: "Morning office. Sunlit, clean, crisp accent.",
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
            textTransform: "uppercase",
            letterSpacing: "1px",
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

export function AppearanceSection() {
  const chatFontSliderId = useId();
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const chatFontSizePx = useAppStore((s) => s.chatFontSizePx);
  const setChatFontSizePx = useAppStore((s) => s.setChatFontSizePx);
  const codeBlockCopyButtonPosition = useAppStore((s) => s.codeBlockCopyButtonPosition);
  const setCodeBlockCopyButtonPosition = useAppStore((s) => s.setCodeBlockCopyButtonPosition);
  const agentTurnCompletionSound = useAppStore((s) => s.agentTurnCompletionSound);
  const setAgentTurnCompletionSound = useAppStore((s) => s.setAgentTurnCompletionSound);

  const previewScale = useMemo(() => chatFontSizePx / DEFAULT_CHAT_FONT_SIZE_PX, [chatFontSizePx]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      <section>
        <div style={sectionLabelStyle}>THEME</div>
        <div style={{ display: "flex", gap: 12 }}>
          {THEME_IDS.map((id) => (
            <ThemeSwatch key={id} themeId={id} selected={theme === id} onClick={() => setTheme(id)} />
          ))}
        </div>
      </section>

      <section>
        <div style={sectionLabelStyle}>CHAT FONT SIZE</div>
        <div style={{ ...cardStyle(), display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
            Scales the work chat timeline and composer together. Default {DEFAULT_CHAT_FONT_SIZE_PX}px matches the previous layout.
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <label htmlFor={chatFontSliderId} style={{ ...LABEL_STYLE, marginBottom: 0, minWidth: 120 }}>
              SIZE ({chatFontSizePx}px)
            </label>
            <input
              id={chatFontSliderId}
              type="range"
              min={CHAT_FONT_SIZE_MIN_PX}
              max={CHAT_FONT_SIZE_MAX_PX}
              step={1}
              value={chatFontSizePx}
              onChange={(e) => setChatFontSizePx(Number(e.target.value))}
              style={{ flex: "1 1 200px", maxWidth: 360, accentColor: COLORS.accent }}
            />
          </div>

          <div>
            <div style={{ ...LABEL_STYLE, marginBottom: 8 }}>LIVE PREVIEW</div>
            <div
              style={{
                border: `1px solid ${COLORS.border}`,
                background: COLORS.recessedBg,
                padding: 14,
                maxHeight: 280,
                overflow: "auto",
                transform: `scale(${previewScale})`,
                transformOrigin: "top left",
                width: `${100 / previewScale}%`,
                maxWidth: `${100 / previewScale}%`,
              }}
            >
              <div style={{ fontFamily: MONO_FONT, fontSize: 9, color: COLORS.textDim, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.12em" }}>
                Assistant · preview
              </div>
              <ChatMarkdown>{PREVIEW_MARKDOWN}</ChatMarkdown>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div style={sectionLabelStyle}>CHAT & NOTIFICATIONS</div>
        <div style={{ ...cardStyle(), display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <div style={{ ...LABEL_STYLE, marginBottom: 8 }}>CODE BLOCK COPY BUTTON</div>
            <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, marginBottom: 10, lineHeight: 1.5 }}>
              On touch devices the copy control stays visible. Choose top or bottom so long fenced blocks are easier to copy after scrolling.
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {CODE_BLOCK_COPY_POSITION_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setCodeBlockCopyButtonPosition(id)}
                  style={{
                    ...primaryButton({ height: 32, padding: "0 14px", fontSize: 10 }),
                    opacity: codeBlockCopyButtonPosition === id ? 1 : 0.55,
                    border: `1px solid ${codeBlockCopyButtonPosition === id ? COLORS.accent : COLORS.border}`,
                  }}
                >
                  {id === "bottom" ? "Bottom" : "Top"}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div style={{ ...LABEL_STYLE, marginBottom: 8 }}>AGENT TURN COMPLETION SOUND</div>
            <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, marginBottom: 10, lineHeight: 1.5 }}>
              Plays when the assistant finishes a turn and the session is idle (not while you still owe a reply or approval).
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              <select
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
                disabled={agentTurnCompletionSound === "off"}
                onClick={() => {
                  if (agentTurnCompletionSound !== "off") playAgentTurnCompletionSound(agentTurnCompletionSound);
                }}
                style={{
                  ...primaryButton({ height: 32, padding: "0 12px", fontSize: 10 }),
                  opacity: agentTurnCompletionSound === "off" ? 0.45 : 1,
                  cursor: agentTurnCompletionSound === "off" ? "not-allowed" : "pointer",
                }}
              >
                Preview
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
