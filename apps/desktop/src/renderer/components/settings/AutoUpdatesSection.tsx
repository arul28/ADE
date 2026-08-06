import React, { useEffect, useId, useState } from "react";
import { ArrowsClockwise } from "@phosphor-icons/react";
import {
  DEFAULT_AUTO_UPDATE_PREFERENCES,
  type AutoUpdatePreferences,
} from "../../../shared/types";
import { COLORS, SANS_FONT, cardStyle } from "../lanes/laneDesignTokens";
import { SettingsSectionShell, SettingsToggle } from "./settingsSectionUi";

export function AutoUpdatesControls() {
  const automaticInstallId = useId();
  const onlyWhenIdleId = useId();
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
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <label
            htmlFor={automaticInstallId}
            style={{
              display: "block",
              color: COLORS.textPrimary,
              cursor: "pointer",
              fontFamily: SANS_FONT,
              fontSize: 14,
              fontWeight: 600,
              lineHeight: 1.4,
            }}
          >
            Install ADE updates automatically
          </label>
          <p style={{ margin: "6px 0 0", color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 12, lineHeight: 1.6 }}>
            ADE shows a cancelable countdown before restarting. Leave this off to install updates from the top-right control.
          </p>
        </div>
        <SettingsToggle
          id={automaticInstallId}
          checked={current.automaticInstall}
          disabled={!preferences || saving}
          onChange={(automaticInstall) => void update({ automaticInstall })}
        />
      </div>

      {current.automaticInstall ? (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 16,
            paddingTop: 16,
            borderTop: `1px solid ${COLORS.outlineBorder}`,
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <label
              htmlFor={onlyWhenIdleId}
              style={{
                display: "block",
                color: COLORS.textPrimary,
                cursor: "pointer",
                fontFamily: SANS_FONT,
                fontSize: 13,
                fontWeight: 600,
                lineHeight: 1.4,
              }}
            >
              Wait until active work finishes
            </label>
            <p style={{ margin: "6px 0 0", color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 12, lineHeight: 1.6 }}>
              Start the restart countdown only when there are no active agent turns or work sessions.
            </p>
          </div>
          <SettingsToggle
            id={onlyWhenIdleId}
            checked={current.onlyWhenIdle}
            disabled={saving}
            onChange={(onlyWhenIdle) => void update({ onlyWhenIdle })}
          />
        </div>
      ) : null}

      {error ? (
        <p role="alert" style={{ margin: 0, color: COLORS.danger, fontFamily: SANS_FONT, fontSize: 11 }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function AutoUpdatesSection() {
  return (
    <SettingsSectionShell
      id="auto-updates"
      title="Updates"
      description="Choose whether ADE installs downloaded updates automatically."
      icon={ArrowsClockwise}
      brandColor="#60A5FA"
    >
      <div style={cardStyle({ padding: 16, maxWidth: 720 })}>
        <AutoUpdatesControls />
      </div>
    </SettingsSectionShell>
  );
}
