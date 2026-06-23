import React, { useCallback, useId } from "react";
import { CheckCircle, DownloadSimple, Microphone } from "@phosphor-icons/react";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
  cardStyle,
  inlineBadge,
  primaryButton,
} from "../lanes/laneDesignTokens";
import { useAppStore } from "../../state/appStore";
import { useVoiceModelInstall } from "../../hooks/useVoiceModelInstall";
import { VOICE_MODEL_SIZE_LABEL } from "../../services/globalVoiceModelInstaller";
import {
  SettingsToggle,
  SettingsSectionShell,
} from "./settingsSectionUi";

const detailPanelStyle: React.CSSProperties = {
  marginTop: 16,
  paddingTop: 16,
  borderTop: `1px solid ${COLORS.border}`,
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const bulletListStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: 18,
  display: "grid",
  gap: 6,
  fontSize: 12,
  fontFamily: SANS_FONT,
  color: COLORS.textMuted,
  lineHeight: 1.55,
};

function formatMb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

/**
 * Voice input settings (lives under Settings → General; the chat mic deep-links
 * here via #voice-input). The "Enable voice input in chat" toggle persists via
 * the Zustand user-preferences store and gates the mic in every composer.
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
  const alreadyInstalled = install.modelInstalled && !isDownloading;
  const needsDownload = !isDownloading && !alreadyInstalled;

  return (
    <SettingsSectionShell
      id="voice-input"
      title="Voice input"
      description="Dictate into chat composers with on-device transcription. Nothing leaves your machine."
      icon={Microphone}
      brandColor="#A78BFA"
    >
      <div style={cardStyle({ padding: 16, maxWidth: 720 })}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <label
              htmlFor={toggleId}
              style={{
                display: "block",
                fontSize: 14,
                fontWeight: 600,
                fontFamily: SANS_FONT,
                color: COLORS.textPrimary,
                cursor: "pointer",
                lineHeight: 1.4,
              }}
            >
              Enable voice input in chat
            </label>
            <p style={{ margin: "6px 0 0", fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.6 }}>
              Adds a mic button to chat composers. Speech is transcribed locally and inserted at your cursor.
            </p>

            {voiceInputEnabled ? (
              <div style={detailPanelStyle}>
                {isDownloading ? (
                  <>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
                        Downloading speech model
                      </span>
                      <span style={inlineBadge(COLORS.accent)}>{percent != null ? `${percent}%` : "Starting"}</span>
                    </div>
                    <div
                      style={{
                        height: 6,
                        borderRadius: 999,
                        background: "color-mix(in srgb, var(--chat-accent) 18%, transparent)",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          height: "100%",
                          width: percent != null ? `${percent}%` : "35%",
                          background: COLORS.accent,
                          borderRadius: 999,
                          transition: "width 120ms linear",
                        }}
                      />
                    </div>
                    <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
                      {percent != null
                        ? `${formatMb(install.receivedBytes)} of ~${VOICE_MODEL_SIZE_LABEL}`
                        : `Downloaded ${formatMb(install.receivedBytes)} so far`}
                    </div>
                    <p style={{ margin: 0, fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.6 }}>
                      You can leave Settings — the download continues in the background and the mic enables automatically when it finishes.
                    </p>
                  </>
                ) : alreadyInstalled ? (
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                    <CheckCircle size={18} weight="fill" style={{ color: COLORS.success, flexShrink: 0, marginTop: 1 }} />
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
                        Ready to use
                      </div>
                      <p style={{ margin: "4px 0 0", fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.6 }}>
                        The speech model is installed. Tap the mic in any chat composer to start dictating.
                      </p>
                    </div>
                  </div>
                ) : needsDownload ? (
                  <>
                    <div style={{ fontSize: 13, fontWeight: 600, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
                      One-time setup
                    </div>
                    <ul style={bulletListStyle}>
                      <li>Downloads a ~{VOICE_MODEL_SIZE_LABEL} on-device speech model once</li>
                      <li>Runs fully offline after install — no cloud transcription</li>
                      <li>Mic enables as soon as the download finishes — no restart needed</li>
                    </ul>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                      <button type="button" style={primaryButton({ height: 34 })} onClick={handleDownload}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <DownloadSimple size={14} weight="bold" />
                          {install.phase === "error" ? "Retry download" : "Download speech model"}
                        </span>
                      </button>
                      <span style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textDim }}>
                        ~{VOICE_MODEL_SIZE_LABEL}
                      </span>
                    </div>
                    {install.phase === "error" && install.error ? (
                      <div style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.danger, lineHeight: 1.5 }}>
                        {install.error}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : (
              <p style={{ margin: "12px 0 0", fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textDim, lineHeight: 1.6 }}>
                Turn this on to add a mic to chat composers and download the offline speech model.
              </p>
            )}
          </div>
          <SettingsToggle
            id={toggleId}
            checked={voiceInputEnabled}
            onChange={setVoiceInputEnabled}
          />
        </div>
      </div>
    </SettingsSectionShell>
  );
}
