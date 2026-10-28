import { useEffect, useState } from "react";
import type { SessionLifecycleSettings } from "../../../shared/types";
import { ModernRow, ModernRows, ModernSection, SettingsToggle } from "./primitives";
import { Banner } from "../ui/notice";
import { useSettingsMachineScope } from "./SettingsMachineScope";

export function SessionLifecycleSection() {
  // Stored in each machine's runtime; read and written on the machine shown.
  const { pin } = useSettingsMachineScope();
  const [settings, setSettings] = useState<SessionLifecycleSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSettings(null);
    setLoadFailed(false);
    setError(null);
    void window.ade.sessions.getLifecycleSettings(pin)
      .then((next) => {
        if (!cancelled) setSettings(next);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadFailed(true);
        setError("Session lifecycle settings are unavailable right now.");
      });
    return () => {
      cancelled = true;
    };
  }, [pin, attempt]);

  const update = async (enabled: boolean) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      setSettings(await window.ade.sessions.updateLifecycleSettings({
        autoSettleLaneSessionsOnPrMerge: enabled,
      }, pin));
    } catch {
      setError("ADE could not save this session lifecycle preference.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModernSection
      group="Session lifecycle"
      anchor="session-lifecycle"
      title="Session lifecycle"
      hint="When finished lane work moves to Settled."
    >
      <ModernRows>
        <ModernRow
          title="Auto-settle sessions when lane PR merges"
          hint="A merged PR settles the sessions it covers, once any running turn finishes."
          control={
            // Until the machine answers, the toggle is not drawn: a switch
            // shown "on" while loading (or after a failed read) claimed a
            // setting nobody had read.
            settings ? (
              <SettingsToggle
                label="Auto-settle sessions when lane PR merges"
                checked={settings.autoSettleLaneSessionsOnPrMerge}
                disabled={saving}
                onChange={(enabled) => void update(enabled)}
              />
            ) : loadFailed ? (
              <button type="button" className="ade-modern-btn" data-size="sm" onClick={() => setAttempt((value) => value + 1)}>
                Try again
              </button>
            ) : (
              <span className="ade-modern-muted" aria-live="polite">Loading…</span>
            )
          }
        >
          {error ? (
            <Banner
              layout="inline"
              model={{
                id: "session-lifecycle-error",
                tone: "error",
                title: error,
                report: { surface: "session_lifecycle_settings" },
                dismiss: { onDismiss: () => setError(null) },
              }}
            />
          ) : null}
        </ModernRow>
      </ModernRows>
    </ModernSection>
  );
}
