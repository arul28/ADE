import React, { useEffect, useState } from "react";
import type { ProductAnalyticsStatus } from "../../../shared/types/productAnalytics";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { SettingsCard, SettingsGroup, SettingsToggle } from "./primitives";

const READ_ERROR = "Analytics settings are unavailable right now.";
const WRITE_ERROR = "ADE could not save this analytics preference.";

/**
 * The analytics consent, as one card.
 *
 * It reads and writes the real persisted value rather than rendering optimism:
 * a consent control that shows "off" for something that is on is the one bug
 * class this screen cannot afford.
 */
export function ProductAnalyticsSection() {
  const [status, setStatus] = useState<ProductAnalyticsStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // A build whose preload predates the setting has no bridge here; the
    // switch then renders in its default position and stays disabled rather
    // than pretending to work.
    void (async () => {
      try {
        const next = await window.ade.analytics.getStatus();
        if (!cancelled) setStatus(next);
      } catch {
        if (!cancelled) setError(READ_ERROR);
      }
    })();
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
      setError(WRITE_ERROR);
    } finally {
      setSaving(false);
    }
  };

  const footnote = status?.configured
    ? `Daily safety limit: ${status.dailyBudget} events on this ADE installation.`
    : "Analytics delivery will remain idle until this ADE build is connected to its analytics project.";

  return (
    <SettingsGroup title="Privacy">
      <SettingsCard
        anchor="product-analytics"
        title="Anonymous product analytics"
        description="Help improve ADE by sharing bounded, anonymous usage events."
        control={
          <SettingsToggle
            label="Share anonymous usage analytics"
            checked={status?.enabled ?? true}
            disabled={!status || saving}
            onChange={(enabled) => void setEnabled(enabled)}
          />
        }
      >
        <p style={{ margin: 0, color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 12, lineHeight: 1.6 }}>
          ADE uses a random installation ID plus installation-salted opaque project and session IDs.
          It sends only allowlisted feature, screen, outcome, version, and aggregate usage
          counts—never prompts, code, file or terminal content, repository names or paths, command
          arguments, or recordings.
        </p>
        <p style={{ margin: "8px 0 0", color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 11, lineHeight: 1.5 }}>
          {footnote}
        </p>
        {error ? (
          <p role="alert" style={{ margin: "8px 0 0", color: COLORS.danger, fontFamily: SANS_FONT, fontSize: 11 }}>
            {error}
          </p>
        ) : null}
      </SettingsCard>
    </SettingsGroup>
  );
}
