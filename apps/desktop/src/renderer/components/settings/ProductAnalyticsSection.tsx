import React, { useEffect, useState } from "react";
import type { ProductAnalyticsStatus } from "../../../shared/types/productAnalytics";
import { ModernRow, ModernRows, ModernSection, SettingsToggle } from "./primitives";
import "./machineSettings.css";

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
    <ModernSection
      group="Privacy"
      anchor="product-analytics"
      title="Product analytics"
      hint="Help improve ADE by sharing anonymous usage events and a daily usage summary."
    >
      <ModernRows>
        <ModernRow
          title="Share anonymous usage analytics"
          hint={footnote}
          control={
            <SettingsToggle
              label="Share anonymous usage analytics"
              checked={status?.enabled ?? true}
              disabled={!status || saving}
              onChange={(enabled) => void setEnabled(enabled)}
            />
          }
        >
          <div className="ade-ms-privacy">
            <div>
              <span className="kit-eyebrow">Events</span>
              <p className="ade-modern-muted">
                ADE uses a random installation ID plus installation-salted opaque project and session IDs.
                It sends only allowlisted feature, screen, outcome, version, and aggregate usage
                counts—never prompts, code, file or terminal content, repository names or paths, command
                arguments, or recordings.
              </p>
            </div>
            <div>
              <span className="kit-eyebrow">Daily summary</span>
              <p className="ade-modern-muted">
                ADE also sends one usage summary a day to ADE&apos;s own servers: the providers and models you
                used, token counts, costs, your plan tier, and the local hour of each turn. It never
                includes prompts, file paths, or account emails.
              </p>
            </div>
          </div>
          {error ? <p role="alert" className="ade-modern-error" style={{ marginTop: 8 }}>{error}</p> : null}
        </ModernRow>
      </ModernRows>
    </ModernSection>
  );
}
