import type {
  AttentionNotchRevealMode,
  AttentionNotchSettings,
  AttentionPreferences,
} from "../../../shared/types";
import {
  DEFAULT_ATTENTION_NOTCH_REVEAL_MODE,
  DEFAULT_ATTENTION_PREFERENCES,
  isAttentionNotchRevealMode,
} from "../../../shared/types";

const ATTENTION_NOTCH_ENABLED_KEY = "ade:attention:notch-enabled";
const ATTENTION_NOTCH_REVEAL_MODE_KEY = "ade:attention:notch-reveal-mode";
const ATTENTION_NOTCH_EXPANDED_PANEL_KEY = "ade:attention:notch-expanded-panel";
// New settings get new keys: the three above are frozen wire for anyone who
// has already made a choice on this Mac.
const ATTENTION_NOTCH_AUTO_REVEAL_KEY = "ade:attention:notch-auto-reveal";
const ATTENTION_NOTCH_TICKER_KEY = "ade:attention:notch-ticker";
const ATTENTION_NOTCH_SETTINGS_CHANGED_EVENT = "ade:attention-notch-settings-changed";

/**
 * How the notch presents itself on *this* Mac. It describes one display's
 * chrome, so it stays beside the enabled flag rather than in account
 * preferences that follow the user to every machine.
 */
export type AttentionNotchPresentation = {
  revealMode: AttentionNotchRevealMode;
  expandedPanelEnabled: boolean;
  automaticRevealEnabled: boolean;
  tickerEnabled: boolean;
};

/** What a Mac that has never been configured gets: today's behaviour. */
export const DEFAULT_ATTENTION_NOTCH_PRESENTATION: AttentionNotchPresentation = {
  revealMode: DEFAULT_ATTENTION_NOTCH_REVEAL_MODE,
  expandedPanelEnabled: true,
  automaticRevealEnabled: true,
  tickerEnabled: true,
};

function readLocalItem(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalItem(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A restricted renderer still keeps the setting for the current process
    // through the native helper update issued by the caller.
  }
}

export function readAttentionNotchEnabled(): boolean {
  return readLocalItem(ATTENTION_NOTCH_ENABLED_KEY) !== "false";
}

export function writeAttentionNotchEnabled(enabled: boolean): void {
  writeLocalItem(ATTENTION_NOTCH_ENABLED_KEY, String(enabled));
}

/** A value this build has never heard of falls back to the shipped behaviour. */
export function readAttentionNotchPresentation(): AttentionNotchPresentation {
  const revealMode = readLocalItem(ATTENTION_NOTCH_REVEAL_MODE_KEY);
  return {
    revealMode: isAttentionNotchRevealMode(revealMode)
      ? revealMode
      : DEFAULT_ATTENTION_NOTCH_PRESENTATION.revealMode,
    expandedPanelEnabled: readLocalItem(ATTENTION_NOTCH_EXPANDED_PANEL_KEY) !== "false",
    automaticRevealEnabled: readLocalItem(ATTENTION_NOTCH_AUTO_REVEAL_KEY) !== "false",
    tickerEnabled: readLocalItem(ATTENTION_NOTCH_TICKER_KEY) !== "false",
  };
}

export function writeAttentionNotchPresentation(
  presentation: AttentionNotchPresentation,
): void {
  writeLocalItem(ATTENTION_NOTCH_REVEAL_MODE_KEY, presentation.revealMode);
  writeLocalItem(
    ATTENTION_NOTCH_EXPANDED_PANEL_KEY,
    String(presentation.expandedPanelEnabled),
  );
  writeLocalItem(
    ATTENTION_NOTCH_AUTO_REVEAL_KEY,
    String(presentation.automaticRevealEnabled),
  );
  writeLocalItem(ATTENTION_NOTCH_TICKER_KEY, String(presentation.tickerEnabled));
}

/**
 * Notch presentation now lives in account preferences so a second Mac inherits
 * it, with localStorage kept as the offline cache. Read synced-else-local: a
 * signed-out or not-yet-loaded window still shows the choice this Mac made
 * rather than snapping back to the shipped default for a frame.
 */
export function resolveAttentionNotchPresentation(
  preferences: AttentionPreferences | null | undefined,
  local: AttentionNotchPresentation = readAttentionNotchPresentation(),
): AttentionNotchPresentation {
  const account = preferences?.account;
  return {
    revealMode: isAttentionNotchRevealMode(account?.notchRevealMode)
      ? account.notchRevealMode
      : local.revealMode,
    expandedPanelEnabled: typeof account?.notchExpandedPanel === "boolean"
      ? account.notchExpandedPanel
      : local.expandedPanelEnabled,
    automaticRevealEnabled: typeof account?.notchAutomaticReveal === "boolean"
      ? account.notchAutomaticReveal
      : local.automaticRevealEnabled,
    tickerEnabled: typeof account?.notchTicker === "boolean"
      ? account.notchTicker
      : local.tickerEnabled,
  };
}

/** The account half of a write-both. The caller still writes localStorage. */
export function attentionPreferencesWithNotchPresentation(
  preferences: AttentionPreferences,
  presentation: AttentionNotchPresentation,
): AttentionPreferences {
  return {
    ...preferences,
    account: {
      ...preferences.account,
      notchRevealMode: presentation.revealMode,
      notchExpandedPanel: presentation.expandedPanelEnabled,
      notchAutomaticReveal: presentation.automaticRevealEnabled,
      notchTicker: presentation.tickerEnabled,
    },
  };
}

export function persistAttentionNotchSettings(
  settings: AttentionNotchSettings,
): void {
  writeAttentionNotchEnabled(settings.enabled);
  writeAttentionNotchPresentation({
    revealMode: settings.revealMode,
    expandedPanelEnabled: settings.expandedPanelEnabled,
    automaticRevealEnabled: settings.automaticRevealEnabled,
    tickerEnabled: settings.tickerEnabled,
  });
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<AttentionNotchSettings>(
      ATTENTION_NOTCH_SETTINGS_CHANGED_EVENT,
      { detail: settings },
    ));
  }
}

export function onAttentionNotchSettingsChanged(
  callback: (settings: AttentionNotchSettings) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    callback(event.detail as AttentionNotchSettings);
  };
  window.addEventListener(ATTENTION_NOTCH_SETTINGS_CHANGED_EVENT, listener);
  return () =>
    window.removeEventListener(ATTENTION_NOTCH_SETTINGS_CHANGED_EVENT, listener);
}

export function normalizeAttentionPreferences(
  preferences: AttentionPreferences,
): AttentionPreferences {
  return {
    ...DEFAULT_ATTENTION_PREFERENCES,
    ...preferences,
    account: {
      ...DEFAULT_ATTENTION_PREFERENCES.account,
      ...preferences.account,
      eventPolicies: {
        ...DEFAULT_ATTENTION_PREFERENCES.account.eventPolicies,
        ...preferences.account?.eventPolicies,
      },
      quietHours: {
        ...DEFAULT_ATTENTION_PREFERENCES.account.quietHours,
        ...preferences.account?.quietHours,
      },
    },
    devices: preferences.devices ?? {},
    machines: preferences.machines ?? {},
    projects: preferences.projects ?? {},
    mutedSessionIds: preferences.mutedSessionIds ?? [],
  };
}

export function attentionNotchSettingsFromPreferences(
  preferences: AttentionPreferences,
  enabled = readAttentionNotchEnabled(),
  presentation: AttentionNotchPresentation = readAttentionNotchPresentation(),
): AttentionNotchSettings {
  const normalized = normalizeAttentionPreferences(preferences);
  return {
    enabled,
    revealMode: presentation.revealMode,
    expandedPanelEnabled: presentation.expandedPanelEnabled,
    automaticRevealEnabled: presentation.automaticRevealEnabled,
    tickerEnabled: presentation.tickerEnabled,
    preferredDisplayId: null,
    hideDetails: normalized.account.hideDetails,
    celebrationsEnabled: normalized.account.celebrationsEnabled,
    soundsEnabled: normalized.account.soundsEnabled,
  };
}
