/**
 * The account setting that holds ADE Cloud's sign-in choices (P5 §2.2),
 * `providerLogins.cloud`, and the one way to read it. Only the person writes
 * it (the sign-in sync's writes, from Settings). The sync, the Claude pass
 * reconcile (P6) and the Settings pages read it through `readCloudSetting`.
 */
import type { ProviderLoginProvider } from "./types/providerLogins";

export const PROVIDER_LOGINS_CLOUD_SETTING = "providerLogins.cloud";

// Kept here, not imported: this module has no runtime imports, so the renderer's settings chunk stays small.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * - `enabled`: the one off switch for all of ADE Cloud's sign-ins (absent = on).
 * - `inUse`: the pick by place (`cloudChoiceKey`): a vault key, or "key" for the saved key.
 * - `off`: the keys switched off for ADE Cloud.
 * - `smartBalance`: Claude's smart balance on ADE Cloud (`claude.smartBalance`, absent = off).
 */
export type ProviderLoginsCloudSetting = {
  enabled: boolean;
  inUse: Record<string, string>;
  off: string[];
  smartBalance: boolean;
};

export function readCloudSetting(raw: unknown): ProviderLoginsCloudSetting {
  const record = isRecord(raw) ? raw : {};
  const inUse: Record<string, string> = {};
  if (isRecord(record.inUse)) {
    for (const [place, key] of Object.entries(record.inUse)) if (typeof key === "string") inUse[place] = key;
  }
  return {
    enabled: record.enabled !== false,
    inUse,
    off: Array.isArray(record.off) ? record.off.filter((key): key is string => typeof key === "string") : [],
    // Absent = false: the switch is off at the start.
    smartBalance: isRecord(record.claude) && record.claude.smartBalance === true,
  };
}

/**
 * What ADE Cloud picks one sign-in for. One per provider, except Pi, whose
 * sub-providers (xAI, OpenRouter, ...) are separate logins: `pi:<sub>`.
 */
export function cloudChoiceKey(provider: ProviderLoginProvider, slot: string): string {
  return provider === "pi" ? `pi:${slot}` : provider;
}
