import React, { useEffect, useId, useState } from "react";
import { ChartLineUp } from "@phosphor-icons/react";
import type { ProductAnalyticsStatus } from "../../../shared/types/productAnalytics";
import { COLORS, SANS_FONT, cardStyle } from "../lanes/laneDesignTokens";
import { SettingsSectionShell, SettingsToggle } from "./settingsSectionUi";

export function ProductAnalyticsSection() {
  const toggleId = useId();
  const [status, setStatus] = useState<ProductAnalyticsStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.ade.analytics.getStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        if (!cancelled) setError("Analytics settings are unavailable right now.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setEnabled = async (enabled: boolean) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      setStatus(await window.ade.analytics.setEnabled(enabled));
    } catch {
      setError("ADE could not save this analytics preference.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSectionShell
      id="product-analytics"
      title="Anonymous product analytics"
      description="Help improve ADE by sharing bounded, anonymous usage events."
      icon={ChartLineUp}
      brandColor="#A78BFA"
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
              Share anonymous usage analytics
            </label>
            <p style={{ margin: "6px 0 0", color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 12, lineHeight: 1.6 }}>
              ADE uses a random installation ID plus installation-salted opaque project and session IDs. It sends only allowlisted feature, screen, outcome, version, and aggregate usage counts—never prompts, code, file or terminal content, repository names or paths, command arguments, or recordings.
            </p>
            <p style={{ margin: "8px 0 0", color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 11, lineHeight: 1.5 }}>
              {status?.configured
                ? `Daily safety limit: ${status.dailyBudget} events on this ADE installation.`
                : "Analytics delivery will remain idle until this ADE build is connected to its analytics project."}
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
