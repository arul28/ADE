import React, { useCallback, useId } from "react";
import { COLORS, MONO_FONT, cardStyle, LABEL_STYLE } from "../lanes/laneDesignTokens";
import { useAppStore } from "../../state/appStore";
import { useVoiceModelInstall } from "../../hooks/useVoiceModelInstall";
import { VOICE_MODEL_SIZE_LABEL } from "../../services/globalVoiceModelInstaller";

const sectionLabelStyle: React.CSSProperties = {
  ...LABEL_STYLE,
  fontSize: 11,
  marginBottom: 16,
};

const dangerColor = COLORS.danger ?? "#e5484d";
const detailStyle: React.CSSProperties = {
  marginLeft: 24,
  fontSize: 10,
  fontFamily: MONO_FONT,
  color: COLORS.textMuted,
  lineHeight: 1.6,
};

function formatMb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

/**
 * Voice input settings (lives under Settings → General; the chat mic deep-links
 * here via #voice-input). The "Enable voice input in chat" toggle persists via
 * the Zustand user-preferences store and gates the mic in every composer.
 *
 * The ~141 MB speech model is NOT bundled (it would bloat the auto-update). When
 * voice input is enabled but the model hasn't been downloaded, this offers a
 * one-time download driven by the app-global installer — so it keeps running in
 * the background even if the user leaves Settings. After it lands, ADE must be
 * restarted for voice input to take effect everywhere.
 */
export function DictationSection() {
  const voiceInputEnabled = useAppStore((s) => s.voiceInputEnabled);
  const setVoiceInputEnabled = useAppStore((s) => s.setVoiceInputEnabled);
  const toggleId = useId();

  const install = useVoiceModelInstall(voiceInputEnabled);

  const handleDownload = useCallback(() => {
    install.start();
  }, [install]);

  const percent =
    install.totalBytes && install.totalBytes > 0
      ? Math.min(100, Math.round((install.receivedBytes / install.totalBytes) * 100))
      : null;

  const isDownloading = install.phase === "downloading";
  const justDownloaded = install.phase === "installed" && install.restartRequired;
  const alreadyInstalled = install.modelInstalled && !install.restartRequired && !isDownloading;
  const needsDownload = !isDownloading && !justDownloaded && !alreadyInstalled;

  return (
    <section id="voice-input">
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

        {!voiceInputEnabled ? null : isDownloading ? (
          <div style={{ marginLeft: 24, display: "flex", flexDirection: "column", gap: 6 }}>
            <div
              style={{
                height: 4,
                borderRadius: 2,
                background: "color-mix(in srgb, var(--chat-accent) 18%, transparent)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: percent != null ? `${percent}%` : "35%",
                  background: COLORS.accent,
                  borderRadius: 2,
                  transition: "width 120ms linear",
                }}
              />
            </div>
            <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
              {percent != null
                ? `Downloading voice model… ${percent}% (${formatMb(install.receivedBytes)})`
                : `Downloading voice model… ${formatMb(install.receivedBytes)}`}
            </span>
            <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
              You can leave this page — the download continues in the background.
            </span>
          </div>
        ) : justDownloaded ? (
          <div style={detailStyle}>
            <span style={{ color: COLORS.accent, fontWeight: 600 }}>✓ Voice model downloaded.</span>{" "}
            Restart ADE to enable voice input.
          </div>
        ) : alreadyInstalled ? (
          <div style={detailStyle}>
            <span style={{ color: COLORS.accent, fontWeight: 600 }}>✓ Voice model installed.</span>{" "}
            Tap the mic in any chat composer to dictate.
          </div>
        ) : needsDownload ? (
          <div style={{ marginLeft: 24, display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
              The on-device speech model (~{VOICE_MODEL_SIZE_LABEL}) downloads once, then runs fully offline. ADE
              must be restarted after it installs.
            </span>
            <button
              type="button"
              onClick={handleDownload}
              style={{
                alignSelf: "flex-start",
                fontSize: 11,
                fontWeight: 600,
                color: "#fff",
                background: COLORS.accent,
                border: "none",
                borderRadius: 6,
                padding: "6px 12px",
                cursor: "pointer",
              }}
            >
              {install.phase === "error"
                ? `Retry download (~${VOICE_MODEL_SIZE_LABEL})`
                : `Download voice model (~${VOICE_MODEL_SIZE_LABEL})`}
            </button>
            {install.phase === "error" && install.error ? (
              <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: dangerColor, lineHeight: 1.5 }}>
                {install.error}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
