import React, { useEffect, useState } from "react";
import {
  DEFAULT_AUTO_UPDATE_PREFERENCES,
  type AutoUpdatePreferences,
} from "../../../shared/types";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { SettingsCard, SettingsGroup, SettingsToggle } from "./primitives";

/**
 * The two update-install preferences, as cards.
 *
 * `AboutSection` embeds this under its own "Updates" group, so the controls
 * carry the cards and the caller carries the group heading — the same split
 * `AppearanceSection` uses.
 */
export function AutoUpdatesControls() {
  const [preferences, setPreferences] = useState<AutoUpdatePreferences | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.ade.updateGetPreferences()
      .then((next) => {
        if (!cancelled) setPreferences(next);
      })
      .catch(() => {
        if (!cancelled) setError("Update settings are unavailable right now.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = async (patch: Partial<AutoUpdatePreferences>) => {
    if (saving) return;
    const current = preferences ?? DEFAULT_AUTO_UPDATE_PREFERENCES;
    setSaving(true);
    setError(null);
    try {
      setPreferences(await window.ade.updateSetPreferences({
        ...current,
        ...patch,
      }));
    } catch {
      setError("ADE could not save this update preference.");
    } finally {
      setSaving(false);
    }
  };

  const current = preferences ?? DEFAULT_AUTO_UPDATE_PREFERENCES;

  return (
    <>
      <SettingsCard
        anchor="auto-updates"
        title="Install ADE updates automatically"
        description="ADE shows a cancelable countdown before restarting. Leave this off to install updates from the top-right control."
        control={
          <SettingsToggle
            label="Install ADE updates automatically"
            checked={current.automaticInstall}
            disabled={!preferences || saving}
            onChange={(automaticInstall) => void update({ automaticInstall })}
          />
        }
      >
        {error ? (
          <p role="alert" style={{ margin: 0, color: COLORS.danger, fontFamily: SANS_FONT, fontSize: 11 }}>
            {error}
          </p>
        ) : null}
      </SettingsCard>

      {/* Only meaningful once automatic installs are on — it qualifies when the
          countdown may start, and there is no countdown otherwise. */}
      {current.automaticInstall ? (
        <SettingsCard
          anchor="auto-updates-only-when-idle"
          title="Wait until active work finishes"
          description="Start the restart countdown only when there are no active agent turns or work sessions."
          control={
            <SettingsToggle
              label="Wait until active work finishes"
              checked={current.onlyWhenIdle}
              disabled={saving}
              onChange={(onlyWhenIdle) => void update({ onlyWhenIdle })}
            />
          }
        />
      ) : null}
    </>
  );
}

export function AutoUpdatesSection() {
  return (
    <SettingsGroup title="Updates" description="Choose whether ADE installs downloaded updates automatically.">
      <AutoUpdatesControls />
    </SettingsGroup>
  );
}
