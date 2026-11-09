import { useEffect, useRef, useState } from "react";
import type { SessionLifecycleSettings } from "../../../shared/types";
import { ModernRow, SettingsToggle } from "./primitives";
import { Banner } from "../ui/notice";
import { useSettingsMachineScope } from "./SettingsMachineScope";

/**
 * The "Chats" group of Storage & cleanup → Rules: settle a lane's chats when
 * its PR merges, and optionally release what they were using once settled. Stored in each machine's runtime; read and written on the
 * machine shown (`useSettingsMachineScope().pin`).
 */
export function SessionLifecycleSection() {
  const { pin } = useSettingsMachineScope();
  // The effect is keyed on the machine, not on a pin rebuilt with the same key.
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;
  const [settings, setSettings] = useState<SessionLifecycleSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSettings(null);
    setLoadFailed(false);
    setError(null);
    void window.ade.sessions.getLifecycleSettings(pinRef.current)
      .then((next) => {
        if (!cancelled) setSettings(next);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadFailed(true);
        setError("Couldn't read this chat setting right now.");
      });
    return () => {
      cancelled = true;
    };
  }, [pinKey, attempt]);

  const update = async (patch: Partial<SessionLifecycleSettings>) => {
    if (saving || !settings) return;
    setSaving(true);
    setError(null);
    try {
      setSettings(await window.ade.sessions.updateLifecycleSettings({
        ...settings,
        ...patch,
      }, pinRef.current));
    } catch {
      setError("ADE couldn't save this chat setting.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ade-cleanup-group" id="session-lifecycle" data-settings-anchor="session-lifecycle">
      <h3 className="ade-cleanup-group-title">Chats</h3>
      <div className="ade-cleanup-rows">
        <ModernRow
          title="Settle chats when the lane's PR merges"
          hint="Once any running turn finishes, they move to Settled."
          control={
            // Until the machine answers, the toggle is not drawn: a switch
            // shown "on" while loading (or after a failed read) claimed a
            // setting nobody had read.
            settings ? (
              <SettingsToggle
                label="Settle chats when the lane's PR merges"
                checked={settings.autoSettleLaneSessionsOnPrMerge}
                disabled={saving}
                onChange={(enabled) => void update({ autoSettleLaneSessionsOnPrMerge: enabled })}
              />
            ) : loadFailed ? (
              <button type="button" className="ade-modern-btn" data-size="sm" onClick={() => setAttempt((value) => value + 1)}>
                Try again
              </button>
            ) : (
              <span className="ade-modern-muted" aria-live="polite">Loading…</span>
            )
          }
        >
          {error ? (
            <Banner
              layout="inline"
              model={{
                id: "session-lifecycle-error",
                tone: "error",
                title: error,
                report: { surface: "session_lifecycle_settings" },
                dismiss: { onDismiss: () => setError(null) },
              }}
            />
          ) : null}
        </ModernRow>
        <ModernRow
          title="Release what settled chats were using"
          hint="Five minutes after a lane's last chat settles, power off the simulators and emulators its chats started, stop their dev servers, and release their Mac Desktop screens. Anything you started yourself, pinned to keep running, or are viewing stays on. A chat waking cancels it."
          control={
            settings ? (
              <SettingsToggle
                label="Release what settled chats were using"
                checked={settings.releaseLaneResourcesOnSettle === true}
                disabled={saving}
                onChange={(enabled) => void update({ releaseLaneResourcesOnSettle: enabled })}
              />
            ) : (
              <span className="ade-modern-muted" aria-live="polite">{loadFailed ? "" : "Loading…"}</span>
            )
          }
        />
      </div>
    </div>
  );
}
