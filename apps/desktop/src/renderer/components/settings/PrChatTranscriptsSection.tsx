import { useEffect, useState } from "react";
import { GithubLogo } from "@phosphor-icons/react";
import { Banner } from "../ui/notice";
import { ModernRow, ModernRows, ModernSection, SettingsToggle } from "./primitives";
import { useSettingsMachineScope } from "./SettingsMachineScope";

export function PrChatTranscriptsSection() {
  // A per-checkout switch in `.ade/local.yaml`, on the machine the page shows.
  const { pin } = useSettingsMachineScope();
  const [configBusy, setConfigBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [transcriptGistsEnabled, setTranscriptGistsEnabled] = useState<boolean | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const pinKey = pin?.key ?? null;

  useEffect(() => {
    let cancelled = false;
    setTranscriptGistsEnabled(null);
    setLoadFailed(false);
    window.ade.projectConfig
      .get(pin)
      .then((snapshot) => {
        if (cancelled) return;
        setTranscriptGistsEnabled(snapshot.effective.github?.prTranscriptGists?.enabled === true);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // Keyed on the pin's key: a rebuilt pin for the same machine is no reason to reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinKey, attempt]);

  const handleToggleTranscriptGists = async (enabled: boolean) => {
    setConfigBusy(true);
    setActionError(null);
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
      hint="Link the ADE chat behind a pull request when you create or link it."
    >
      <ModernRows>
        {loadFailed ? (
          <ModernRow
            title="Couldn't load this setting"
            control={(
              <button type="button" className="ade-modern-btn" data-size="sm" onClick={() => setAttempt((value) => value + 1)}>
                Try again
              </button>
            )}
          />
        ) : (
          <ModernRow
            title="Transcript links on PRs"
            hint="Published as secret gists: anyone with the link can read them. Chat turns only, never terminal logs."
            control={
              <SettingsToggle
                label="Attach ADE chat transcript links when creating or linking PRs."
                checked={transcriptGistsEnabled === true}
                disabled={configBusy || transcriptGistsEnabled === null}
                onChange={(enabled) => { void handleToggleTranscriptGists(enabled); }}
              />
            }
          >
            {/* Only mount the detail block when it has something to say, so the
                row doesn't grow an empty band under it. */}
            {actionError || transcriptGistsEnabled ? (
              <div className="ade-modern-stack" style={{ gap: 8 }}>
                {actionError ? (
                  <Banner layout="inline" model={{ id: "pr-transcripts-error", tone: "error", title: actionError }} />
                ) : null}
                {transcriptGistsEnabled ? (
                  <div className="ade-modern-note">
                    <GithubLogo size={14} weight="fill" />
                    <span>Needs the gist scope on your GitHub sign-in (Gists read and write for fine-grained tokens).</span>
                  </div>
                ) : null}
              </div>
            ) : null}
          </ModernRow>
        )}
      </ModernRows>
    </ModernSection>
  );
}
