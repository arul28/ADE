import { useEffect, useState } from "react";
import {
  BUILT_IN_BROWSER_SETTINGS_DEFAULTS,
  BUILT_IN_BROWSER_TAB_LIMIT_MAX,
  BUILT_IN_BROWSER_TAB_LIMIT_MIN,
} from "../../../shared/types/builtInBrowser";
import { browserSettingsActions, useBrowserSettings, useBrowserSettingsStatus } from "../chat/browser/browserSettings";
import { ModernRow, ModernRows, ModernSection, SettingsNumber, SettingsToggle } from "./primitives";
import { useSettingsAction } from "./useSettingsAction";
import "./machineSettings.css";

/** Tab limit and download folder. */
export function BrowserSettingsSection() {
  const snapshot = useBrowserSettings();
  const loadStatus = useBrowserSettingsStatus();
  const settings = snapshot ?? BUILT_IN_BROWSER_SETTINGS_DEFAULTS;
  const { busy, error, run } = useSettingsAction();
  // One row's save at a time; a string key keeps the shared hook's shape.
  const act = (work: () => Promise<void>) => run("browser-settings", work);
  // The limit is committed on blur/Enter: saving every keystroke turned "25"
  // into 2 (the field disables while saving), and an empty field into 1.
  const [draftLimit, setDraftLimit] = useState<number | null>(null);
  useEffect(() => setDraftLimit(null), [settings.tabLimit]);
  const commitLimit = () => {
    // SettingsNumber reports 0 for an emptied field. Revert rather than clamp
    // that to 1: leaving the field empty must not silently change the limit.
    if (draftLimit == null || draftLimit < BUILT_IN_BROWSER_TAB_LIMIT_MIN) {
      setDraftLimit(null);
      return;
    }
    const next = Math.max(BUILT_IN_BROWSER_TAB_LIMIT_MIN, Math.min(BUILT_IN_BROWSER_TAB_LIMIT_MAX, Math.trunc(draftLimit)));
    setDraftLimit(null);
    if (next !== settings.tabLimit) void act(() => browserSettingsActions.set({ tabLimit: next }));
  };

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
      {loadStatus === "failed" ? (
        <p className="ade-modern-error" role="alert">
          Couldn't load browser settings.{" "}
          <button type="button" className="ade-modern-btn" data-size="sm" onClick={() => browserSettingsActions.reload()}>
            Retry
          </button>
        </p>
      ) : null}
      <ModernRows>
        <ModernRow
          anchor="browser-tab-limit"
          title="Tabs per browser"
          hint={`How many tabs it keeps open, ${BUILT_IN_BROWSER_TAB_LIMIT_MIN}–${BUILT_IN_BROWSER_TAB_LIMIT_MAX}. Agents close their own.`}
          control={(
            <span
              onBlur={commitLimit}
              onKeyDown={(event) => {
                if (event.key === "Enter") (event.target as HTMLElement).blur();
              }}
            >
              <SettingsNumber
                ariaLabel="Tabs per browser"
                value={draftLimit ?? settings.tabLimit}
                min={BUILT_IN_BROWSER_TAB_LIMIT_MIN}
                max={BUILT_IN_BROWSER_TAB_LIMIT_MAX}
                disabled={busy != null || !snapshot}
                onChange={setDraftLimit}
              />
            </span>
          )}
        />
        <ModernRow
          anchor="browser-download-folder"
          title="Download folder"
          hint={settings.downloadDir ?? "Your Downloads folder."}
          control={(
            <span className="ade-modern-inline-actions">
              <button
                type="button"
                className="ade-modern-btn"
                data-size="sm"
                disabled={busy != null || !snapshot}
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
                  disabled={busy != null || !snapshot}
                  onClick={() => void act(() => browserSettingsActions.set({ downloadDir: null }))}
                >
                  Use Downloads
                </button>
              ) : null}
            </span>
          )}
        />
      </ModernRows>
      {error ? <p className="ade-modern-error" role="alert">{error}</p> : null}
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
  const settings = snapshot ?? BUILT_IN_BROWSER_SETTINGS_DEFAULTS;
  const { busy, error, run } = useSettingsAction();
  // One row's save at a time; a string key keeps the shared hook's shape.
  const act = (work: () => Promise<void>) => run("browser-settings", work);
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
      hint="All off by default. Sites you blocked stay blocked."
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
                disabled={busy != null || !snapshot}
                onChange={(next) => void act(() => browserSettingsActions.set({
                  autoGrant: { [row.key]: next },
                }))}
              />
            )}
          />
        ))}
      </ModernRows>
      {error ? <p className="ade-modern-error" role="alert">{error}</p> : null}
      {settings.autoGrant.camera || settings.autoGrant.microphone
        ? <p className="ade-modern-muted">Camera and microphone also need the operating system's permission for ADE.</p>
        : null}
    </ModernSection>
  );
}
