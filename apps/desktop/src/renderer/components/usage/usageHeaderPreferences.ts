import { useSyncExternalStore } from "react";
import type { UsageProvider } from "../../../shared/types";

const STORAGE_KEY = "ade.usageHeaderPreferences";
const CHANGE_EVENT = "ade:usage-header-preferences-changed";
const PROVIDERS: UsageProvider[] = ["claude", "codex", "cursor", "copilot", "grok", "opencode", "kimi"];

export type UsageHeaderPreferences = {
  showInHeader: boolean;
  providers: Record<UsageProvider, boolean>;
};

const defaults = (): UsageHeaderPreferences => ({
  showInHeader: true,
  providers: Object.fromEntries(PROVIDERS.map((provider) => [provider, true])) as Record<UsageProvider, boolean>,
});

function read(): UsageHeaderPreferences {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults();
    const saved = JSON.parse(raw) as Partial<UsageHeaderPreferences>;
    const providers = Object.fromEntries(PROVIDERS.map((provider) => [
      provider,
      saved.providers?.[provider] !== false,
    ])) as Record<UsageProvider, boolean>;
    const anyProvider = Object.values(providers).some(Boolean);
    return { showInHeader: saved.showInHeader !== false && anyProvider, providers };
  } catch {
    return defaults();
  }
}

let current = typeof window === "undefined" ? defaults() : read();

function emit() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGE_EVENT));
}

function update(next: UsageHeaderPreferences) {
  current = next;
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* preference still works in memory */ }
  emit();
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) { current = read(); emit(); }
  });
}

export function useUsageHeaderPreferences(): UsageHeaderPreferences {
  return useSyncExternalStore((subscriber) => {
    window.addEventListener(CHANGE_EVENT, subscriber);
    return () => window.removeEventListener(CHANGE_EVENT, subscriber);
  }, () => current, () => defaults());
}

export function setUsageProviderVisible(provider: UsageProvider, visible: boolean) {
  const providers = { ...current.providers, [provider]: visible };
  const showInHeader = Object.values(providers).some(Boolean);
  update({ showInHeader, providers });
}

export function setUsageHeaderVisible(visible: boolean) {
  update(visible ? defaults() : { ...current, showInHeader: false });
}
