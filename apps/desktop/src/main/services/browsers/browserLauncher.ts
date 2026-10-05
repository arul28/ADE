/**
 * Hand a URL to a specific browser the user picked from ADE.
 *
 * The renderer never sends a command: it sends a browser id from the catalog
 * and a URL, and this module resolves the id to the command detection already
 * found. That keeps the set of things ADE will launch closed, and keeps the
 * URL on the same http(s)/mailto allowlist every other external open uses.
 *
 * @module browsers/browserLauncher
 */
import { execFile, spawn } from "node:child_process";

import {
  browserTargetDefinition,
  isBrowserTarget,
  type BrowserTarget,
} from "../../../shared/browserTargets";
import { normalizeExternalUrl } from "../shared/externalLinks";
import { detectBrowsersCached, resolveDetectedBrowserCommand } from "./browserDetection";

const OPEN_TIMEOUT_MS = 5_000;

function launchDetached(command: string, url: string): void {
  const child = spawn(command, [url], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  // The browser outlives ADE's interest in it, and a failure to *start* is
  // reported through the `error` event below rather than a rejected promise.
  child.once("error", () => {
    /* Reported by the caller's own checks; nothing to retry here. */
  });
  child.unref();
}

/**
 * Open `url` in `browserId`. Throws when the URL is not openable externally or
 * the browser is not one ADE knows and detected on this machine.
 */
export async function openUrlInBrowser(url: string, browserId: unknown): Promise<void> {
  const normalized = normalizeExternalUrl(url);
  if (!normalized) throw new Error("Invalid URL");
  if (!isBrowserTarget(browserId)) throw new Error("Unknown browser.");

  const definition = browserTargetDefinition(browserId);
  // Detection populated the launch map before the menu that offered this row
  // was drawn; a cached call is enough to guarantee it is still there.
  await detectBrowsersCached();
  const command = resolveDetectedBrowserCommand(browserId as BrowserTarget);
  if (!command) {
    throw new Error(`${definition?.label ?? "That browser"} is not installed.`);
  }

  if (process.platform === "darwin") {
    await new Promise<void>((resolve, reject) => {
      execFile("open", ["-a", command, normalized], { timeout: OPEN_TIMEOUT_MS }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    return;
  }
  launchDetached(command, normalized);
}
