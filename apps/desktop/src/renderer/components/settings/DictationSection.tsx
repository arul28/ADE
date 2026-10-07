import React, { useCallback } from "react";
import { CheckCircle, DownloadSimple } from "@phosphor-icons/react";
import { primaryButton } from "../lanes/laneDesignTokens";
import { useAppStore } from "../../state/appStore";
import { useVoiceModelInstall } from "../../hooks/useVoiceModelInstall";
import { VOICE_MODEL_SIZE_LABEL } from "../../services/globalVoiceModelInstaller";
import { ModernRow, ModernRows, ModernSection, SettingsToggle } from "./primitives";

const detailPanelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  paddingTop: 2,
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
    <ModernSection
      group="Voice input"
      title="Voice input"
      hint="Dictate into any composer. Speech is transcribed on this machine and never uploaded."
    >
      <ModernRows>
        <ModernRow
          anchor="voice-input"
          title="Dictation"
          hint={
            alreadyInstalled && voiceInputEnabled
              ? "Ready. Tap the mic in any composer."
              : "A mic in chat composers, transcribed on this machine."
          }
          control={(
            <>
              {alreadyInstalled && voiceInputEnabled ? (
                <span className="kit-tag" data-tone="ok" aria-label="Speech model installed">
                  <CheckCircle size={11} weight="fill" style={{ marginRight: 4 }} />
                  Installed
                </span>
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
                <span className="kit-eyebrow">Downloading speech model</span>
                <span className="kit-num" style={{ fontSize: 11, color: "var(--color-muted-fg)" }}>
                  {percent != null ? `${percent}%` : "Starting"}
                </span>
              </div>
              <div className="kit-meter" role="progressbar" aria-label="Speech model download" aria-valuenow={percent ?? undefined} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ width: percent != null ? `${percent}%` : "35%" }} />
              </div>
              <div className="kit-num" style={{ fontSize: 11, color: "var(--color-muted-fg)" }}>
                {percent != null
                  ? `${formatMb(install.receivedBytes)} of ~${VOICE_MODEL_SIZE_LABEL}`
                  : `Downloaded ${formatMb(install.receivedBytes)} so far`}
                <span style={{ fontFamily: "var(--font-sans)" }}>{" · keeps going if you leave Settings"}</span>
              </div>
            </div>
          ) : voiceInputEnabled && needsDownload ? (
            <div style={{ ...detailPanelStyle, flexDirection: "row", alignItems: "center", flexWrap: "wrap", justifyContent: "space-between" }}>
              <span className="ade-ap-rowhint" style={{ marginTop: 0 }}>
                One ~{VOICE_MODEL_SIZE_LABEL} download, then fully offline. The mic turns on when it finishes.
              </span>
              <button type="button" style={primaryButton()} onClick={handleDownload}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <DownloadSimple size={14} weight="bold" />
                  {install.phase === "error" ? "Retry download" : "Download speech model"}
                </span>
              </button>
              {install.phase === "error" && install.error ? (
                <div style={{ flexBasis: "100%", fontSize: 12, color: "var(--color-error)", lineHeight: 1.5 }}>
                  {install.error}
                </div>
              ) : null}
            </div>
          ) : null}
        </ModernRow>
      </ModernRows>
    </ModernSection>
  );
}
