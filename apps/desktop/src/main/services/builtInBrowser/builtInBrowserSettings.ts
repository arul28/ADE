import fs from "node:fs/promises";
import fsSync from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Logger } from "../logging/logger";
import {
  applyBuiltInBrowserSettingsPatch,
  normalizeBuiltInBrowserSettings,
  type BuiltInBrowserSettings,
  type BuiltInBrowserSettingsPatch,
  type BuiltInBrowserSettingsPersisted,
} from "../../../shared/types/builtInBrowser";

/**
 * Machine-wide browser settings: tab limit, download folder, standing
 * permission grants, the address bar's search engine.
 *
 * One browser profile per install, so the answers are per install too. The
 * read path is deliberately synchronous and allocation-light: the permission
 * *check* handler reads it on every probe, so `get()` must never touch disk.
 */
/**
 * Throw when a directory exists but cannot be written to.
 *
 * `access(W_OK)` is advisory on Windows (it ignores ACLs), so the check creates
 * and removes a probe file — the same operation a download performs. One copy,
 * because Settings validating a folder and a download writing to it must agree.
 */
export function assertWritableDirectory(dir: string): void {
  const probe = path.join(dir, `.ade-write-probe-${randomUUID()}`);
  try {
    fsSync.writeFileSync(probe, "");
  } finally {
    try {
      fsSync.unlinkSync(probe);
    } catch {
      // A probe that could not be created has nothing to remove.
    }
  }
}

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
  } catch (error) {
    // A corrupt state file silently reset the tab limit, download folder and
    // grants; say so once so the log explains the defaults.
    args.getLogger?.()?.warn("built_in_browser.settings_load_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    loaded = null;
  }
  let current = normalizeBuiltInBrowserSettings(loaded);

  const snapshot = (): BuiltInBrowserSettings => ({
    tabLimit: current.tabLimit,
    downloadDir: current.downloadDir,
    autoGrant: { ...current.autoGrant },
    searchEngine: current.searchEngine,
    customSearchUrl: current.customSearchUrl,
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

  const same = (left: BuiltInBrowserSettings, right: BuiltInBrowserSettings): boolean => (
    left.tabLimit === right.tabLimit
    && left.downloadDir === right.downloadDir
    && left.autoGrant.camera === right.autoGrant.camera
    && left.autoGrant.microphone === right.autoGrant.microphone
    && left.autoGrant.geolocation === right.autoGrant.geolocation
    && left.searchEngine === right.searchEngine
    && left.customSearchUrl === right.customSearchUrl
  );

  return {
    get(): BuiltInBrowserSettings {
      return snapshot();
    },
    /**
     * Validate the folder here rather than in the facade: every writer gets the
     * same checks, and the facade stays one line like its siblings.
     */
    async update(patch: BuiltInBrowserSettingsPatch): Promise<BuiltInBrowserSettings> {
      let next = patch;
      if (patch.downloadDir !== undefined && patch.downloadDir !== null) {
        const dir = patch.downloadDir.trim();
        if (!dir || !path.isAbsolute(dir)) {
          throw new Error("The download folder must be an absolute path.");
        }
        await fs.mkdir(dir, { recursive: true });
        const stat = await fs.stat(dir);
        if (!stat.isDirectory()) throw new Error(`The download folder is not a directory: ${dir}`);
        assertWritableDirectory(dir);
        next = { ...patch, downloadDir: dir };
      }
      const candidate = applyBuiltInBrowserSettingsPatch(current, next);
      if (same(candidate, current)) return snapshot();
      current = candidate;
      persist();
      args.getLogger?.()?.info("built_in_browser.settings_changed", {
        tabLimit: current.tabLimit,
        // The absolute path is a fact about the person's disk; the fact that
        // there is one is enough to diagnose a setting that did not stick.
        downloadDirSet: current.downloadDir != null,
        autoGrant: current.autoGrant,
        // The engine, not the custom URL: a person's own search URL can carry
        // an account token.
        searchEngine: current.searchEngine,
      });
      try {
        args.onChange?.(snapshot());
      } catch (error) {
        // A listener must never break the settings write, but a broken listener
        // should not be invisible either.
        args.getLogger?.()?.warn("built_in_browser.settings_listener_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return snapshot();
    },
  };
}
