import React, { useCallback } from "react";
import { Microphone, CheckCircle, DownloadSimple } from "@phosphor-icons/react";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
  inlineBadge,
  primaryButton,
} from "../lanes/laneDesignTokens";
import { useAppStore } from "../../state/appStore";
import { useVoiceModelInstall } from "../../hooks/useVoiceModelInstall";
import { VOICE_MODEL_SIZE_LABEL } from "../../services/globalVoiceModelInstaller";
import { SettingsPanel, SettingsRow, SettingsSection, SettingsToggle } from "./primitives";

const detailPanelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
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
    <SettingsSection title="Voice input">
      <SettingsPanel>
        <SettingsRow
          anchor="voice-input"
          icon={<Microphone size={15} weight="duotone" />}
          tone="red"
          title="Dictation"
          description={
            alreadyInstalled && voiceInputEnabled
              ? "Ready. Tap the mic in any composer. Speech never leaves this machine."
              : "A mic in chat composers, transcribed on this machine. Nothing is uploaded."
          }
          control={(
            <>
              {alreadyInstalled && voiceInputEnabled ? (
                <CheckCircle size={16} weight="fill" aria-label="Speech model installed" style={{ color: COLORS.success }} />
              ) : null}
              <SettingsToggle
                label="Enable voice input in chat"
                checked={voiceInputEnabled}
                onChange={setVoiceInputEnabled}
              />
            </>
          )}
        >
          {voiceInputEnabled && isDownloading ? (
            <div style={detailPanelStyle}>
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
                  background: "color-mix(in srgb, var(--color-accent) 18%, transparent)",
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
                {" · keeps going if you leave Settings"}
              </div>
            </div>
          ) : voiceInputEnabled && needsDownload ? (
            <div style={detailPanelStyle}>
              <span style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
                One ~{VOICE_MODEL_SIZE_LABEL} download, then fully offline. The mic turns on when it finishes.
              </span>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <button type="button" style={primaryButton()} onClick={handleDownload}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <DownloadSimple size={14} weight="bold" />
                    {install.phase === "error" ? "Retry download" : "Download speech model"}
                  </span>
                </button>
              </div>
              {install.phase === "error" && install.error ? (
                <div style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.danger, lineHeight: 1.5 }}>
                  {install.error}
                </div>
              ) : null}
            </div>
          ) : null}
        </SettingsRow>
      </SettingsPanel>
    </SettingsSection>
  );
}
