import { useEffect, useState } from "react";
import { GithubLogo } from "@phosphor-icons/react";
import { Banner } from "../ui/notice";
import { ModernRow, ModernRows, ModernSection, SettingsToggle } from "./primitives";
import { useSettingsMachineScope } from "./SettingsMachineScope";

export function PrChatTranscriptsSection() {
  // A per-checkout switch in `.ade/local.yaml`, on the machine the page shows.
  const { pin } = useSettingsMachineScope();
  const [configBusy, setConfigBusy] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [transcriptGistsEnabled, setTranscriptGistsEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.ade.projectConfig
      .get(pin)
      .then((snapshot) => {
        if (cancelled) return;
        setTranscriptGistsEnabled(snapshot.effective.github?.prTranscriptGists?.enabled === true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pin]);

  const handleToggleTranscriptGists = async (enabled: boolean) => {
    setConfigBusy(true);
    setActionError(null);
    setSaveNotice(null);
    try {
      const snapshot = await window.ade.projectConfig.get(pin);
      const next = await window.ade.projectConfig.save({
        shared: snapshot.shared,
        local: {
          ...snapshot.local,
          github: {
            ...(snapshot.local.github ?? {}),
            prTranscriptGists: { enabled },
          },
        },
      }, pin);
      setTranscriptGistsEnabled(next.effective.github?.prTranscriptGists?.enabled === true);
      setSaveNotice(enabled ? "PR chat transcripts enabled." : "PR chat transcripts disabled.");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setConfigBusy(false);
    }
  };

  return (
    <ModernSection
      group="PR chat transcripts"
      anchor="pr-chat-transcripts"
      title="PR chat transcripts"
      hint="Attach structured ADE chat links when creating or linking pull requests."
    >
      <ModernRows>
        <ModernRow
          title="Transcript links on PRs"
          hint="Transcripts are published as secret gists, which are link-accessible. ADE publishes only structured chat turns, not raw terminal logs."
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
              row doesn't grow an empty band under it. */}
          {saveNotice || actionError || transcriptGistsEnabled ? (
            <div className="ade-modern-stack" style={{ gap: 8 }}>
              {saveNotice ? (
                <Banner layout="inline" model={{ id: "pr-transcripts-saved", tone: "success", title: saveNotice }} />
              ) : null}
              {actionError ? (
                <Banner layout="inline" model={{ id: "pr-transcripts-error", tone: "error", title: actionError }} />
              ) : null}
              {transcriptGistsEnabled ? (
                <div className="ade-modern-note">
                  <GithubLogo size={14} weight="fill" />
                  <span>GitHub CLI auth needs the gist scope. Classic PATs need gist, and fine-grained tokens need Gists read/write permission.</span>
                </div>
              ) : null}
            </div>
          ) : null}
        </ModernRow>
      </ModernRows>
    </ModernSection>
  );
}
