import type { Logger } from "../logging/logger";
import {
  normalizeBuiltInBrowserSettings,
  type BuiltInBrowserSettings,
  type BuiltInBrowserSettingsPatch,
} from "../../../shared/types/builtInBrowser";

/**
 * Machine-wide browser settings: tab limit, download folder, standing
 * permission grants.
 *
 * One browser profile per install, so the answers are per install too. The
 * controller is deliberately synchronous and allocation-light: the permission
 * *check* handler reads it on every probe, so `get()` must never touch disk.
 */
/** What is on disk: every field optional, older files predate some of them. */
export type BuiltInBrowserSettingsPersisted = {
  tabLimit?: number;
  downloadDir?: string | null;
  autoGrant?: Partial<BuiltInBrowserSettings["autoGrant"]>;
};

export type BuiltInBrowserSettingsStore = {
  read: () => BuiltInBrowserSettingsPersisted | null | undefined;
  write: (state: BuiltInBrowserSettings) => void;
};

export function createBuiltInBrowserSettingsController(args: {
  store?: BuiltInBrowserSettingsStore | null;
  getLogger?: () => Logger | null;
  onChange?: (settings: BuiltInBrowserSettings) => void;
}) {
  let loaded: BuiltInBrowserSettingsPersisted | null = null;
  try {
    loaded = args.store?.read() ?? null;
  } catch {
    loaded = null;
  }
  let current = normalizeBuiltInBrowserSettings(loaded);

  const snapshot = (): BuiltInBrowserSettings => ({
    tabLimit: current.tabLimit,
    downloadDir: current.downloadDir,
    autoGrant: { ...current.autoGrant },
  });

  const persist = (): void => {
    try {
      args.store?.write(snapshot());
    } catch (error) {
      args.getLogger?.()?.warn("built_in_browser.settings_persist_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return {
    get(): BuiltInBrowserSettings {
      return snapshot();
    },
    update(patch: BuiltInBrowserSettingsPatch): BuiltInBrowserSettings {
      const next = normalizeBuiltInBrowserSettings({
        tabLimit: patch.tabLimit ?? current.tabLimit,
        downloadDir: patch.downloadDir === undefined ? current.downloadDir : patch.downloadDir,
        autoGrant: { ...current.autoGrant, ...(patch.autoGrant ?? {}) },
      });
      current = next;
      persist();
      args.getLogger?.()?.info("built_in_browser.settings_changed", {
        tabLimit: next.tabLimit,
        downloadDir: next.downloadDir,
        autoGrant: next.autoGrant,
      });
      try {
        args.onChange?.(snapshot());
      } catch {
        // A listener must never break the settings write.
      }
      return snapshot();
    },
  };
}
