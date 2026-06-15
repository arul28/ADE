import React, { useCallback, useEffect, useId, useState } from "react";
import { COLORS, MONO_FONT, cardStyle, LABEL_STYLE } from "../lanes/laneDesignTokens";
import { useAppStore } from "../../state/appStore";

const sectionLabelStyle: React.CSSProperties = {
  ...LABEL_STYLE,
  fontSize: 11,
  marginBottom: 16,
};

type TranscriptionStatus = {
  installed: boolean;
  binaryInstalled: boolean;
  modelInstalled: boolean;
  downloading: boolean;
};

const EMPTY_STATUS: TranscriptionStatus = {
  installed: false,
  binaryInstalled: false,
  modelInstalled: false,
  downloading: false,
};

function formatMb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

/**
 * Voice input settings. The "Enable voice input in chat" toggle persists via the
 * Zustand user-preferences store (localStorage-backed). It gates the mic
 * affordance in every chat composer.
 *
 * The ~141 MB speech model is NOT bundled (it would bloat the auto-update). When
 * voice input is enabled but the model hasn't been downloaded yet, this section
 * offers a one-time download with progress; once it lands, the mic lights up in
 * every composer.
 */
export function DictationSection() {
  const voiceInputEnabled = useAppStore((s) => s.voiceInputEnabled);
  const setVoiceInputEnabled = useAppStore((s) => s.setVoiceInputEnabled);
  const toggleId = useId();

  const [status, setStatus] = useState<TranscriptionStatus | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<{ receivedBytes: number; totalBytes: number | null } | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const refreshStatus = useCallback(() => {
    const probe = window.ade?.transcription?.status;
    if (!probe) {
      setStatus(EMPTY_STATUS);
      return;
    }
    probe()
      .then((result) => setStatus(result))
      .catch(() => setStatus(EMPTY_STATUS));
  }, []);

  useEffect(() => {
    if (voiceInputEnabled) refreshStatus();
  }, [voiceInputEnabled, refreshStatus]);

  const handleDownload = useCallback(async () => {
    const api = window.ade?.transcription;
    if (!api?.downloadModel) return;
    setDownloadError(null);
    setDownloading(true);
    setProgress({ receivedBytes: 0, totalBytes: null });
    const unsubscribe = api.onModelDownloadProgress?.((p) => setProgress(p));
    try {
      const next = await api.downloadModel();
      setStatus(next);
    } catch {
      setDownloadError("Download failed — check your connection and try again.");
    } finally {
      setDownloading(false);
      setProgress(null);
      unsubscribe?.();
    }
  }, []);

  const percent =
    progress && progress.totalBytes && progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100))
      : null;

  const needsModel = Boolean(status && status.binaryInstalled && !status.modelInstalled);
  const binaryMissing = Boolean(status && !status.binaryInstalled);

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

        {voiceInputEnabled && needsModel ? (
          <div style={{ marginLeft: 24, display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
              The on-device speech model (~141 MB) downloads once, then runs fully offline.
            </span>
            {downloading ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
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
                  {progress
                    ? percent != null
                      ? `Downloading model… ${percent}% (${formatMb(progress.receivedBytes)})`
                      : `Downloading model… ${formatMb(progress.receivedBytes)}`
                    : "Starting download…"}
                </span>
              </div>
            ) : (
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
                Download voice model (~141 MB)
              </button>
            )}
            {downloadError ? (
              <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.danger ?? "#e5484d", lineHeight: 1.5 }}>
                {downloadError}
              </span>
            ) : null}
          </div>
        ) : null}

        {voiceInputEnabled && binaryMissing ? (
          <div
            style={{
              fontSize: 10,
              fontFamily: MONO_FONT,
              color: COLORS.textMuted,
              lineHeight: 1.5,
              marginLeft: 24,
            }}
          >
            Voice transcription isn&apos;t available in this build.
          </div>
        ) : null}
      </div>
    </section>
  );
}
