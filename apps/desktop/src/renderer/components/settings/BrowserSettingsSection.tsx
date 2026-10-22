import { useState } from "react";
import {
  BUILT_IN_BROWSER_TAB_LIMIT_MAX,
  BUILT_IN_BROWSER_TAB_LIMIT_MIN,
} from "../../../shared/types/builtInBrowser";
import {
  BROWSER_SETTINGS_FALLBACK,
  browserSettingsActions,
  useBrowserSettings,
} from "../chat/browser/browserSettings";
import { ModernRow, ModernRows, ModernSection, SettingsNumber, SettingsToggle } from "./primitives";
import "./machineSettings.css";

function useSettingsAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (run: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch {
      setError("ADE couldn't save that.");
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, act };
}

/** Tab limit and download folder. */
export function BrowserSettingsSection() {
  const snapshot = useBrowserSettings();
  const settings = snapshot ?? BROWSER_SETTINGS_FALLBACK;
  const { busy, error, act } = useSettingsAction();

  const chooseFolder = async () => {
    const chosen = await window.ade.project.chooseDirectory({
      title: "Choose where ADE browser downloads go",
      defaultPath: settings.downloadDir ?? undefined,
    });
    if (!chosen) return;
    await browserSettingsActions.set({ downloadDir: chosen });
  };

  return (
    <ModernSection
      group="ADE browser"
      anchor="browser-settings"
      title="Browser behaviour"
      hint="Machine-wide, like the browser profile itself."
    >
      <ModernRows>
        <ModernRow
          anchor="browser-tab-limit"
          title="Tabs per browser"
          hint={`How many tabs this browser keeps, ${BUILT_IN_BROWSER_TAB_LIMIT_MIN}–${BUILT_IN_BROWSER_TAB_LIMIT_MAX}. Agents see this as "tabs N of M" and close their own tabs when they are done.`}
          control={(
            <SettingsNumber
              ariaLabel="Tabs per browser"
              value={settings.tabLimit}
              min={BUILT_IN_BROWSER_TAB_LIMIT_MIN}
              max={BUILT_IN_BROWSER_TAB_LIMIT_MAX}
              disabled={busy || !snapshot}
              onChange={(value) => void act(() => browserSettingsActions.set({ tabLimit: value }))}
            />
          )}
        />
        <ModernRow
          anchor="browser-download-folder"
          title="Download folder"
          hint={settings.downloadDir ?? "Your Downloads folder."}
          control={(
            <span style={{ display: "inline-flex", gap: 8, flexShrink: 0 }}>
              <button
                type="button"
                className="ade-modern-btn"
                data-size="sm"
                disabled={busy || !snapshot}
                onClick={() => void act(chooseFolder)}
              >
                Choose…
              </button>
              {settings.downloadDir ? (
                <button
                  type="button"
                  className="ade-modern-btn"
                  data-size="sm"
                  data-variant="ghost"
                  disabled={busy || !snapshot}
                  onClick={() => void act(() => browserSettingsActions.set({ downloadDir: null }))}
                >
                  Use Downloads
                </button>
              ) : null}
            </span>
          )}
        />
      </ModernRows>
      {error ? <p className="ade-modern-muted" role="alert">{error}</p> : null}
    </ModernSection>
  );
}

/**
 * Standing permission grants for agent-driven tabs.
 *
 * Off by default, and each switch says what it lets a site do. A saved per-site
 * Block still wins, and a combined camera+microphone request needs both
 * switches — never the microphone because only camera was enabled.
 */
export function BrowserAutoGrantSection() {
  const snapshot = useBrowserSettings();
  const settings = snapshot ?? BROWSER_SETTINGS_FALLBACK;
  const { busy, error, act } = useSettingsAction();
  const rows = [
    {
      key: "camera" as const,
      anchor: "browser-auto-camera",
      title: "Camera",
      hint: "Let a site an agent opens use your camera without asking. Only enable this while testing a video feature.",
    },
    {
      key: "microphone" as const,
      anchor: "browser-auto-microphone",
      title: "Microphone",
      hint: "Let a site an agent opens use your microphone without asking. Only enable this while testing audio.",
    },
    {
      key: "geolocation" as const,
      anchor: "browser-auto-geolocation",
      title: "Location",
      hint: "Let a site an agent opens read your approximate location without asking.",
    },
  ];

  return (
    <ModernSection
      group="ADE browser"
      anchor="browser-auto-grant"
      title="Let agents approve these without asking"
      hint="All off by default. A site you have explicitly blocked still stays blocked, and macOS or Windows can still refuse at the system level."
    >
      <ModernRows>
        {rows.map((row) => (
          <ModernRow
            key={row.key}
            anchor={row.anchor}
            title={row.title}
            hint={row.hint}
            control={(
              <SettingsToggle
                label={`Auto-approve ${row.title.toLowerCase()} for agents`}
                checked={settings.autoGrant[row.key]}
                disabled={busy || !snapshot}
                onChange={(next) => void act(() => browserSettingsActions.set({
                  autoGrant: { [row.key]: next },
                }))}
              />
            )}
          />
        ))}
      </ModernRows>
      {error ? <p className="ade-modern-muted" role="alert">{error}</p> : null}
      {settings.autoGrant.camera || settings.autoGrant.microphone
        ? <p className="ade-modern-muted">Camera and microphone also need the operating system's permission for ADE.</p>
        : null}
    </ModernSection>
  );
}
