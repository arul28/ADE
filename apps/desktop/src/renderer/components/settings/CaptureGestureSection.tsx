import { useCallback, useEffect, useRef, useState } from "react";
import { WarningCircle } from "@phosphor-icons/react";

import type { CaptureGestureHealth } from "../../../shared/types/captureGesture";
import {
  captureGestureBlocker,
  captureGestureChord,
  supportsCaptureGesturePlatform,
} from "../../lib/platform";
import {
  captureGestureBridgeAvailable,
  onCaptureGestureEnabledChanged,
  readCaptureGestureEnabled,
  writeCaptureGestureEnabled,
} from "../capture/captureGestureLocalSettings";
import { ModernRow, ModernRows, ModernSection, SettingsToggle } from "./primitives";
import "./machineSettings.css";

/**
 * The on/off switch for the global capture gesture, plus whatever the native
 * helper currently has to say for itself.
 *
 * Health is shown rather than hidden because the two interesting failures are
 * both things only the user can fix: macOS has not been told ADE may record the
 * screen, or the helper is missing from the install. A bare toggle that is on
 * while the gesture does nothing is the state this card exists to prevent.
 */
export function CaptureGestureSection() {
  const supported = supportsCaptureGesturePlatform();
  const bridgePresent = captureGestureBridgeAvailable();
  const available = supported && bridgePresent;
  const [enabled, setEnabled] = useState(() => readCaptureGestureEnabled());
  const [health, setHealth] = useState<CaptureGestureHealth | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => onCaptureGestureEnabledChanged(setEnabled), []);

  const refreshHealth = useCallback(async () => {
    if (!available) return;
    try {
      const next = await window.ade?.captureGesture?.getHealth();
      if (mounted.current && next) setHealth(next);
    } catch {
      // The card degrades to "no health line", which is better than an error
      // banner about a diagnostic.
    }
  }, [available]);

  useEffect(() => { void refreshHealth(); }, [refreshHealth]);

  const toggle = useCallback(async (next: boolean) => {
    setEnabled(next);
    writeCaptureGestureEnabled(next);
    if (!available) return;
    setBusy(true);
    try {
      const updated = await window.ade?.captureGesture?.updateSettings({ enabled: next });
      if (mounted.current && updated) setHealth(updated);
    } catch {
      void refreshHealth();
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [available, refreshHealth]);

  const retry = useCallback(async () => {
    setBusy(true);
    try {
      const updated = await window.ade?.captureGesture?.retry();
      if (mounted.current && updated) setHealth(updated);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);

  const chord = captureGestureChord();
  const blocker = captureGestureBlocker();

  return (
    <ModernSection
      group="Screen capture"
      anchor="capture-gesture"
      title="Screen capture"
      hint={
        supported
          ? "Grab the window in front and hand it to the CTO, from anywhere on this computer."
          // Two different reasons land here, and only one of them is the
          // platform: a desktop build on Linux, and the hosted web client,
          // which has no main process to run a helper in at all.
          : blocker ?? "The capture gesture is not available on this computer."
      }
    >
      <div style={{ opacity: available ? 1 : 0.6 }}>
        <ModernRows>
          <ModernRow
            title={(
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                Capture with a key gesture
                {available ? <kbd className="ade-ms-kbd">{chord}</kbd> : null}
              </span>
            )}
            hint={
              available
                ? `Press ${chord} anywhere to capture the window in front. Over ADE, its tab, lane, PR and open file come along with the image.`
                : blocker ?? "This ADE surface cannot run the native capture helper."
            }
            control={
              <SettingsToggle
                id="capture-gesture-toggle"
                label="Capture with a key gesture"
                checked={enabled && available}
                disabled={!available || busy}
                onChange={(next) => void toggle(next)}
              />
            }
          >
            {available && health && health.state !== "running" && health.state !== "disabled" ? (
              <div className="ade-modern-note" data-tone="warn">
                <WarningCircle size={14} weight="fill" />
                <div className="ade-modern-note-body">
                  <strong style={{ fontWeight: 600, color: "var(--color-fg)" }}>{health.title}</strong>
                  <span>{health.message}</span>
                </div>
                {health.recovery === "retry" ? (
                  <button type="button" className="ade-modern-btn" data-size="sm" disabled={busy} onClick={() => void retry()}>
                    Try again
                  </button>
                ) : null}
              </div>
            ) : null}
          </ModernRow>
        </ModernRows>
      </div>
    </ModernSection>
  );
}
