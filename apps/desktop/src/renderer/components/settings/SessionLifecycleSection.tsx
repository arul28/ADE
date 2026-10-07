import { useEffect, useState } from "react";
import type { SessionLifecycleSettings } from "../../../shared/types";
import { ModernRow, ModernRows, ModernSection, SettingsToggle } from "./primitives";
import { useSettingsMachineScope } from "./SettingsMachineScope";

export function SessionLifecycleSection() {
  // Stored in each machine's runtime; read and written on the machine shown.
  const { pin } = useSettingsMachineScope();
  const [settings, setSettings] = useState<SessionLifecycleSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSettings(null);
    void window.ade.sessions.getLifecycleSettings(pin)
      .then((next) => {
        if (!cancelled) setSettings(next);
      })
      .catch(() => {
        if (!cancelled) setError("Session lifecycle settings are unavailable right now.");
      });
    return () => {
      cancelled = true;
    };
  }, [pin]);

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
      hint="Control when completed lane work moves into the quiet Settled section."
    >
      <ModernRows>
        <ModernRow
          title="Auto-settle sessions when lane PR merges"
          hint="A merged PR settles the sessions it covers. ADE waits until a running turn finishes. An interrupted settle leaves the session active, and ADE tries again later."
          control={
            <SettingsToggle
              label="Auto-settle sessions when lane PR merges"
              checked={settings?.autoSettleLaneSessionsOnPrMerge ?? true}
              disabled={!settings || saving}
              onChange={(enabled) => void update(enabled)}
            />
          }
        >
          {error ? <p role="alert" className="ade-modern-error">{error}</p> : null}
        </ModernRow>
      </ModernRows>
    </ModernSection>
  );
}
