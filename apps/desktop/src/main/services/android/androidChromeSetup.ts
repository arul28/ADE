import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import { runDeviceScript, runDeviceShell, type BootedDevice } from "./androidDeviceShell";

/*
 * Chrome's first run, out of the way: on a fresh emulator `ade android
 * open-url https://…` landed on "Welcome to Chrome" and then on the
 * notifications prompt, so the page never showed (Safari on Apple has
 * neither). With no root, Chrome reads its flags from
 * `/data/local/tmp/chrome-command-line` once it is the debug app:
 *
 *   am set-debug-app --persistent com.android.chrome
 *   echo '_ --disable-fre --no-default-browser-check --no-first-run' > …
 *   pm grant com.android.chrome android.permission.POST_NOTIFICATIONS   (API 33+)
 *   am force-stop com.android.chrome   (only when its first-run screen shows)
 *
 * Once per boot per lane, before the first URL Chrome opens (or a launch of
 * Chrome), best effort: a failure is logged and the open goes on. A later
 * open-url pays nothing. Device commands only, so it is the same on every host.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

export const ANDROID_CHROME_PACKAGE = "com.android.chrome";

const CHROME_SETUP_SCRIPT = [
  `am set-debug-app --persistent ${ANDROID_CHROME_PACKAGE} >/dev/null 2>&1`,
  "echo '_ --disable-fre --no-default-browser-check --no-first-run' > /data/local/tmp/chrome-command-line",
  "chmod 644 /data/local/tmp/chrome-command-line 2>/dev/null",
  // Fails quietly below API 33, where the permission does not exist.
  `pm grant ${ANDROID_CHROME_PACKAGE} android.permission.POST_NOTIFICATIONS >/dev/null 2>&1`,
  // Chrome reads the flags when it starts: a first-run screen already up must go.
  `dumpsys window 2>/dev/null | grep -E 'mFocusedApp=ActivityRecord' | head -n 1 | grep -qiE '${ANDROID_CHROME_PACKAGE}/.*(FirstRun|Fre)' && am force-stop ${ANDROID_CHROME_PACKAGE}`,
  "echo chrome-setup-done",
].join("; ");

export function createAndroidChromeSetup(deps: { signal: AbortSignal; logger: Logger | null }) {
  /** laneId → the serial it was done on. A new boot forgets it (`forget`). */
  const done = new Map<string, string>();
  /** laneId:serial → the URL host kind checked: Chrome opens http(s) here, or not. */
  const opensInChrome = new Map<string, boolean>();

  const prepare = async (laneId: string, booted: BootedDevice): Promise<void> => {
    if (done.get(laneId) === booted.serial) return;
    try {
      const installed = await runDeviceShell(booted.adbPath, booted.serial, ["pm", "path", ANDROID_CHROME_PACKAGE], { timeoutMs: 10_000, signal: deps.signal });
      if (!/^package:/mu.test(installed.stdout)) {
        done.set(laneId, booted.serial);
        return;
      }
      const result = await runDeviceScript(booted, CHROME_SETUP_SCRIPT, { timeoutMs: 15_000, signal: deps.signal });
      if (!result.stdout.includes("chrome-setup-done")) throw new Error(result.text.slice(0, 200) || `exit ${result.exitCode}`);
      done.set(laneId, booted.serial);
    } catch (error) {
      // Marked done anyway: one try per boot, so a broken device never slows every open-url.
      done.set(laneId, booted.serial);
      deps.logger?.warn("android.chrome_first_run_setup_failed", { laneId, error: getErrorMessage(error) });
    }
  };

  return {
    /** Before an `open-url`: when Chrome is the app that opens this http(s) URL. */
    async beforeOpenUrl(laneId: string, booted: BootedDevice, url: string): Promise<void> {
      if (!/^https?:/iu.test(url) || done.get(laneId) === booted.serial) return;
      const key = `${laneId}:${booted.serial}`;
      let chrome = opensInChrome.get(key);
      if (chrome === undefined) {
        const resolved = await runDeviceShell(booted.adbPath, booted.serial, [
          "cmd", "package", "resolve-activity", "--brief", "-a", "android.intent.action.VIEW", "-d", url,
        ], { timeoutMs: 10_000, signal: deps.signal }).catch((error: unknown) => {
          deps.logger?.warn("android.chrome_resolve_failed", { laneId, error: getErrorMessage(error) });
          return null;
        });
        const last = resolved?.stdout.trim().split(/\r?\n/u).at(-1) ?? "";
        // A chooser (`android/com.android.internal.app.ResolverActivity`) means Chrome may be picked too.
        chrome = last.startsWith(`${ANDROID_CHROME_PACKAGE}/`) || /ResolverActivity/u.test(last);
        opensInChrome.set(key, chrome);
      }
      if (chrome) await prepare(laneId, booted);
    },

    /** Before `launch --package com.android.chrome`. */
    async beforeLaunch(laneId: string, booted: BootedDevice, packageName: string): Promise<void> {
      if (packageName === ANDROID_CHROME_PACKAGE) await prepare(laneId, booted);
    },

    /** The lane's emulator booted again: do it once more. */
    forget(laneId: string): void {
      done.delete(laneId);
      for (const key of [...opensInChrome.keys()]) if (key.startsWith(`${laneId}:`)) opensInChrome.delete(key);
    },
  };
}
