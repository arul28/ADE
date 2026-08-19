import React, { useEffect, useId, useState } from "react";
import { Lifebuoy } from "@phosphor-icons/react";
import type { DiagnosticsSharingStatus } from "../../../shared/types/diagnostics";
import { COLORS, SANS_FONT, cardStyle } from "../lanes/laneDesignTokens";
import { SettingsSectionShell, SettingsToggle } from "./settingsSectionUi";

/**
 * The off switch for automatic diagnostic reports.
 *
 * Same shape as the analytics section next to it, and for the same reason: this
 * is a consent control, so it reads the real persisted state rather than
 * assuming, and it says plainly what gets sent and how often.
 */
export function DiagnosticsSharingSection() {
  const toggleId = useId();
  const [status, setStatus] = useState<DiagnosticsSharingStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const read = window.ade?.diagnostics?.getSharing;
    if (!read) return;
    void read()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        if (!cancelled) setError("This setting is unavailable right now.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setEnabled = async (enabled: boolean) => {
    const write = window.ade?.diagnostics?.setSharing;
    if (saving || !write) return;
    setSaving(true);
    setError(null);
    try {
      setStatus(await write(enabled));
    } catch {
      setError("ADE could not save this setting.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSectionShell
      id="diagnostics-sharing"
      title="Diagnostics"
      description="Send ADE a report when something breaks, so it can be fixed."
      icon={Lifebuoy}
      brandColor="#60A5FA"
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
              Share diagnostics with ADE when something breaks
            </label>
            <p style={{ margin: "6px 0 0", color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 12, lineHeight: 1.6 }}>
              ADE sends the same report the "Report issue" button makes: app and system versions, recent ADE logs, disk space and the failure code. Paths, names, emails and credentials are removed first. Never your code, chats or terminal output.
            </p>
            <p style={{ margin: "8px 0 0", color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 11, lineHeight: 1.5 }}>
              {`At most ${status?.limit ?? 3} a day, one per problem. You get a message every time one is sent.`}
            </p>
            {error ? (
              <p role="alert" style={{ margin: "8px 0 0", color: COLORS.danger, fontFamily: SANS_FONT, fontSize: 11 }}>
                {error}
              </p>
            ) : null}
          </div>
          <SettingsToggle
            id={toggleId}
            checked={status?.enabled ?? true}
            disabled={!status || saving}
            onChange={(enabled) => void setEnabled(enabled)}
          />
        </div>
      </div>
    </SettingsSectionShell>
  );
}
