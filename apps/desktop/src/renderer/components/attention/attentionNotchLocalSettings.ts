import type {
  AttentionNotchSettings,
  AttentionPreferences,
} from "../../../shared/types";
import { DEFAULT_ATTENTION_PREFERENCES } from "../../../shared/types";

const ATTENTION_NOTCH_ENABLED_KEY = "ade:attention:notch-enabled";

export function readAttentionNotchEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(ATTENTION_NOTCH_ENABLED_KEY) !== "false";
  } catch {
    return true;
  }
}

export function writeAttentionNotchEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ATTENTION_NOTCH_ENABLED_KEY, String(enabled));
  } catch {
    // A restricted renderer still keeps the setting for the current process
    // through the native helper update issued by the caller.
  }
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
): AttentionNotchSettings {
  const normalized = normalizeAttentionPreferences(preferences);
  return {
    enabled,
    preferredDisplayId: null,
    hideDetails: normalized.account.hideDetails,
    celebrationsEnabled: normalized.account.celebrationsEnabled,
    soundsEnabled: normalized.account.soundsEnabled,
  };
}
