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
const ATTENTION_NOTCH_SETTINGS_CHANGED_EVENT = "ade:attention-notch-settings-changed";

/**
 * How the notch presents itself on *this* Mac. It describes one display's
 * chrome, so it stays beside the enabled flag rather than in account
 * preferences that follow the user to every machine.
 */
export type AttentionNotchPresentation = {
  revealMode: AttentionNotchRevealMode;
  expandedPanelEnabled: boolean;
};

/** What a Mac that has never been configured gets: today's behaviour. */
export const DEFAULT_ATTENTION_NOTCH_PRESENTATION: AttentionNotchPresentation = {
  revealMode: DEFAULT_ATTENTION_NOTCH_REVEAL_MODE,
  expandedPanelEnabled: true,
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
}

export function persistAttentionNotchSettings(
  settings: AttentionNotchSettings,
): void {
  writeAttentionNotchEnabled(settings.enabled);
  writeAttentionNotchPresentation({
    revealMode: settings.revealMode,
    expandedPanelEnabled: settings.expandedPanelEnabled,
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
    preferredDisplayId: null,
    hideDetails: normalized.account.hideDetails,
    celebrationsEnabled: normalized.account.celebrationsEnabled,
    soundsEnabled: normalized.account.soundsEnabled,
  };
}
