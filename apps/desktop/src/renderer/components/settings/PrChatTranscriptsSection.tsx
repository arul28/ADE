import React, { useEffect, useState } from "react";
import { COLORS, MONO_FONT, SANS_FONT } from "../lanes/laneDesignTokens";
import { SettingsCard, SettingsGroup, SettingsToggle } from "./primitives";

const infoBoxStyle: React.CSSProperties = {
  background: "color-mix(in srgb, var(--color-info) 8%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-info) 20%, transparent)",
  borderRadius: 8,
  padding: "10px 14px",
  fontSize: 11,
  fontFamily: MONO_FONT,
  color: COLORS.textSecondary,
  lineHeight: "18px",
};

export function PrChatTranscriptsSection() {
  const [configBusy, setConfigBusy] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [transcriptGistsEnabled, setTranscriptGistsEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.ade.projectConfig
      .get()
      .then((snapshot) => {
        if (cancelled) return;
        setTranscriptGistsEnabled(snapshot.effective.github?.prTranscriptGists?.enabled === true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggleTranscriptGists = async (enabled: boolean) => {
    setConfigBusy(true);
    setActionError(null);
    setSaveNotice(null);
    try {
      const snapshot = await window.ade.projectConfig.get();
      const next = await window.ade.projectConfig.save({
        shared: snapshot.shared,
        local: {
          ...snapshot.local,
          github: {
            ...(snapshot.local.github ?? {}),
            prTranscriptGists: { enabled },
          },
        },
      });
      setTranscriptGistsEnabled(next.effective.github?.prTranscriptGists?.enabled === true);
      setSaveNotice(enabled ? "PR chat transcripts enabled." : "PR chat transcripts disabled.");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setConfigBusy(false);
    }
  };

  return (
    <SettingsGroup
      title="PR chat transcripts"
      description="Attach structured ADE chat links when creating or linking pull requests."
    >
      <SettingsCard
        anchor="pr-chat-transcripts"
        title="Transcript links on PRs"
        description="Attach ADE chat transcript links when creating or linking PRs. Transcripts are published as secret gists, which are link-accessible. ADE publishes only structured chat turns, not raw terminal logs."
        control={
          <SettingsToggle
            label="Attach ADE chat transcript links when creating or linking PRs."
            checked={transcriptGistsEnabled}
            disabled={configBusy}
            onChange={(enabled) => { void handleToggleTranscriptGists(enabled); }}
          />
        }
      >
        {/* Only mount the detail block when it has something to say, so the
            card doesn't grow an empty band under the row. */}
        {saveNotice || actionError || transcriptGistsEnabled ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {saveNotice ? (
              <p role="status" style={{ ...NOTICE_STYLE, color: COLORS.success }}>
                {saveNotice}
              </p>
            ) : null}
            {actionError ? (
              <p role="alert" style={{ ...NOTICE_STYLE, color: COLORS.danger }}>
                {actionError}
              </p>
            ) : null}
            {transcriptGistsEnabled ? (
              <div style={infoBoxStyle}>
                GitHub CLI auth needs the gist scope. Classic PATs need gist, and fine-grained tokens need Gists read/write permission.
              </div>
            ) : null}
          </div>
        ) : null}
      </SettingsCard>
    </SettingsGroup>
  );
}

const NOTICE_STYLE: React.CSSProperties = {
  margin: 0,
  fontFamily: SANS_FONT,
  fontSize: 11,
  lineHeight: 1.5,
};
