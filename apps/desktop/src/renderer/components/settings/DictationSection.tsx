import React, { useId } from "react";
import { COLORS, MONO_FONT, cardStyle, LABEL_STYLE } from "../lanes/laneDesignTokens";
import { useAppStore } from "../../state/appStore";
import { useVoiceModelInstalled } from "../../hooks/useVoiceModelInstalled";

const sectionLabelStyle: React.CSSProperties = {
  ...LABEL_STYLE,
  fontSize: 11,
  marginBottom: 16,
};

/**
 * Voice input settings. The "Enable voice input in chat" toggle persists via the
 * Zustand user-preferences store (localStorage-backed, same mechanism as the
 * other renderer chat preferences). It gates the mic affordance in every chat
 * composer. We also surface whether the on-device transcription model is
 * installed so the row reads accurately before a model ships.
 */
export function DictationSection() {
  const voiceInputEnabled = useAppStore((s) => s.voiceInputEnabled);
  const setVoiceInputEnabled = useAppStore((s) => s.setVoiceInputEnabled);
  const toggleId = useId();
  const modelInstalled = useVoiceModelInstalled();

  return (
    <section>
      <div style={sectionLabelStyle}>Voice input</div>
      <div style={{ ...cardStyle(), display: "flex", flexDirection: "column", gap: 14 }}>
        <label
          htmlFor={toggleId}
          style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}
        >
          <input
            id={toggleId}
            type="checkbox"
            checked={voiceInputEnabled}
            onChange={(e) => setVoiceInputEnabled(e.target.checked)}
            style={{ accentColor: COLORS.accent, width: 14, height: 14 }}
          />
          <span style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: COLORS.textPrimary }}>
              Enable voice input in chat
            </span>
            <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
              Adds a mic to chat composers. Speech is transcribed on-device and cleaned text is inserted at the cursor.
            </span>
          </span>
        </label>

        {voiceInputEnabled && modelInstalled === false ? (
          <div
            style={{
              fontSize: 10,
              fontFamily: MONO_FONT,
              color: COLORS.textMuted,
              lineHeight: 1.5,
              marginLeft: 24,
            }}
          >
            The on-device voice model isn&apos;t installed in this build yet. The mic stays disabled until a future update delivers it.
          </div>
        ) : null}
      </div>
    </section>
  );
}
