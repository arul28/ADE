import React, { useEffect, useState } from "react";
import { ChatTeardropText, ShieldCheck } from "@phosphor-icons/react";
import type { ProjectConfigSnapshot } from "../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT, cardStyle, inlineBadge } from "../lanes/laneDesignTokens";
import { SettingsSectionShell } from "./settingsSectionUi";

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
    <SettingsSectionShell
      id="pr-chat-transcripts"
      title="PR chat transcripts"
      description="Attach structured ADE chat links when creating or linking pull requests."
      icon={ChatTeardropText}
      brandColor="#A371F7"
      iconWeight="duotone"
    >
      {saveNotice ? (
        <div
          style={{
            background: "color-mix(in srgb, var(--color-success) 12%, transparent)",
            border: "1px solid color-mix(in srgb, var(--color-success) 30%, transparent)",
            padding: "8px 12px",
            fontSize: 11,
            fontFamily: MONO_FONT,
            color: COLORS.success,
            borderRadius: 8,
            marginBottom: 12,
          }}
        >
          {saveNotice}
        </div>
      ) : null}
      {actionError ? (
        <div
          style={{
            background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
            border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
            padding: "8px 12px",
            fontSize: 11,
            fontFamily: MONO_FONT,
            color: COLORS.danger,
            borderRadius: 8,
            marginBottom: 12,
          }}
        >
          {actionError}
        </div>
      ) : null}

      <div style={cardStyle({ padding: 16, maxWidth: 720 })}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <ShieldCheck size={18} color={transcriptGistsEnabled ? COLORS.success : COLORS.textMuted} weight="fill" />
            <span style={{ fontSize: 13, fontWeight: 600, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
              Transcript links on PRs
            </span>
          </div>
          <span style={inlineBadge(transcriptGistsEnabled ? COLORS.success : COLORS.textMuted)}>
            {transcriptGistsEnabled ? "On" : "Off"}
          </span>
        </div>
        <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: configBusy ? "default" : "pointer" }}>
          <input
            type="checkbox"
            checked={transcriptGistsEnabled}
            disabled={configBusy}
            onChange={(event) => {
              void handleToggleTranscriptGists(event.currentTarget.checked);
            }}
            style={{ marginTop: 2 }}
          />
          <span style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
              Attach ADE chat transcript links when creating or linking PRs.
            </span>
            <span style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textSecondary, lineHeight: "18px" }}>
              Transcripts are published as secret gists, which are link-accessible. ADE publishes only structured chat turns, not raw terminal logs.
            </span>
          </span>
        </label>
        {transcriptGistsEnabled ? (
          <div style={{ ...infoBoxStyle, marginTop: 12 }}>
            GitHub CLI auth needs the gist scope. Classic PATs need gist, and fine-grained tokens need Gists read/write permission.
          </div>
        ) : null}
      </div>
    </SettingsSectionShell>
  );
}
