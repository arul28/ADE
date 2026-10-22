/**
 * Machine-wide browser settings in the renderer: one shared read, kept current
 * by main's push event. Same shape as `browserAgentAccess.ts` — one `get` when
 * the first subscriber mounts, then events, never a poll.
 */
import { useSyncExternalStore } from "react";
import {
  BUILT_IN_BROWSER_SETTINGS_DEFAULTS,
  type BuiltInBrowserSettings,
  type BuiltInBrowserSettingsPatch,
} from "../../../../shared/types/builtInBrowser";

type BrowserSettingsApi = {
  get: () => Promise<BuiltInBrowserSettings>;
  set: (patch: BuiltInBrowserSettingsPatch) => Promise<BuiltInBrowserSettings>;
  onChange: (cb: (settings: BuiltInBrowserSettings) => void) => () => void;
};

function api(): BrowserSettingsApi | null {
  const candidate = (typeof window === "undefined" ? null : window.ade?.builtInBrowser?.browserSettings) as
    | Partial<BrowserSettingsApi>
    | null
    | undefined;
  return candidate && typeof candidate.get === "function" ? (candidate as BrowserSettingsApi) : null;
}

function isSettings(value: unknown): value is BuiltInBrowserSettings {
  return Boolean(
    value
    && typeof value === "object"
    && typeof (value as { tabLimit?: unknown }).tabLimit === "number"
    && (value as { autoGrant?: unknown }).autoGrant
    && typeof (value as { autoGrant: { camera?: unknown } }).autoGrant === "object",
  );
}

let current: BuiltInBrowserSettings | null = null;
const listeners = new Set<() => void>();
let started = false;

function publish(next: unknown): void {
  if (!isSettings(next)) return;
  current = next;
  for (const listener of [...listeners]) listener();
}

function start(): void {
  if (started) return;
  started = true;
  const bridge = api();
  if (!bridge) return;
  try {
    bridge.onChange((settings) => publish(settings));
  } catch {
    // No event: the one read below still seeds the UI.
  }
  void bridge.get().then(publish, () => {});
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = (): BuiltInBrowserSettings | null => current;

/** `null` means this renderer cannot reach the setting (hosted web). */
export function useBrowserSettings(): BuiltInBrowserSettings | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export const BROWSER_SETTINGS_FALLBACK = BUILT_IN_BROWSER_SETTINGS_DEFAULTS;

export const browserSettingsActions = {
  async set(patch: BuiltInBrowserSettingsPatch): Promise<void> {
    const bridge = api();
    if (!bridge) return;
    publish(await bridge.set(patch));
  },
};
