import React, { useEffect, useId, useState } from "react";
import { GitMerge } from "@phosphor-icons/react";
import type { SessionLifecycleSettings } from "../../../shared/types";
import { COLORS, SANS_FONT, cardStyle } from "../lanes/laneDesignTokens";
import { SettingsSectionShell, SettingsToggle } from "./settingsSectionUi";

export function SessionLifecycleSection() {
  const toggleId = useId();
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
    <SettingsSectionShell
      id="session-lifecycle"
      title="Session lifecycle"
      description="Control when completed lane work moves into the quiet Settled section."
      icon={GitMerge}
      brandColor="#6EE7B7"
    >
      <div style={cardStyle({ padding: 16, maxWidth: 720 })}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <label
              htmlFor={toggleId}
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
              Auto-settle sessions when lane PR merges
            </label>
            <p style={{ margin: "6px 0 0", color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 12, lineHeight: 1.6 }}>
              Applies to future verified merges. Sessions with pending input, scheduled work, active subagents, unfinished goals or plans, failures, or incomplete reports stay active.
            </p>
            {error ? (
              <p role="alert" style={{ margin: "8px 0 0", color: COLORS.danger, fontFamily: SANS_FONT, fontSize: 11 }}>
                {error}
              </p>
            ) : null}
          </div>
          <SettingsToggle
            id={toggleId}
            checked={settings?.autoSettleLaneSessionsOnPrMerge ?? true}
            disabled={!settings || saving}
            onChange={(enabled) => void update(enabled)}
          />
        </div>
      </div>
    </SettingsSectionShell>
  );
}
