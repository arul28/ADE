import React, { useEffect, useState } from "react";
import type { SessionLifecycleSettings } from "../../../shared/types";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { SettingsCard, SettingsGroup, SettingsToggle } from "./primitives";

export function SessionLifecycleSection() {
  const [settings, setSettings] = useState<SessionLifecycleSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.ade.sessions.getLifecycleSettings()
      .then((next) => {
        if (!cancelled) setSettings(next);
      })
      .catch(() => {
        if (!cancelled) setError("Session lifecycle settings are unavailable right now.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = async (enabled: boolean) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      setSettings(await window.ade.sessions.updateLifecycleSettings({
        autoSettleLaneSessionsOnPrMerge: enabled,
      }));
    } catch {
      setError("ADE could not save this session lifecycle preference.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsGroup
      title="Session lifecycle"
      description="Control when completed lane work moves into the quiet Settled section."
    >
      <SettingsCard
        anchor="session-lifecycle"
        title="Auto-settle sessions when lane PR merges"
        description="A merged PR settles the sessions it covers. ADE waits until a running turn finishes. An interrupted settle leaves the session active, and ADE tries again later."
        control={
          <SettingsToggle
            label="Auto-settle sessions when lane PR merges"
            checked={settings?.autoSettleLaneSessionsOnPrMerge ?? true}
            disabled={!settings || saving}
            onChange={(enabled) => void update(enabled)}
          />
        }
      >
        {error ? (
          <p role="alert" style={{ margin: 0, color: COLORS.danger, fontFamily: SANS_FONT, fontSize: 11 }}>
            {error}
          </p>
        ) : null}
      </SettingsCard>
    </SettingsGroup>
  );
}
