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
} from "../../../shared/browserTargets";
import { normalizeExternalUrl } from "../shared/externalLinks";
import { detectBrowsersCached, resolveDetectedBrowserCommand } from "./browserDetection";

const OPEN_TIMEOUT_MS = 5_000;

/**
 * Launch the browser and return once the OS has actually started it.
 *
 * Resolving on `spawn` rather than immediately is the point: a browser that was
 * removed between detection and this click fails here, and the caller's error
 * row is the only thing that would tell the user. `unref` then lets ADE exit
 * without waiting on a browser that is meant to outlive it.
 */
function launchDetached(command: string, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, [url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    });
  });
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
  const command = resolveDetectedBrowserCommand(browserId);
  if (!command) {
    throw new Error(`${definition?.label ?? "That browser"} is not installed.`);
  }

  if (process.platform === "darwin") {
    // The absolute helper path, matching `externalLinks.openExternalUrl`: a
    // bare `open` resolves through PATH, and `-a` must not be hijackable.
    await new Promise<void>((resolve, reject) => {
      execFile("/usr/bin/open", ["-a", command, normalized], { timeout: OPEN_TIMEOUT_MS }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    return;
  }
  await launchDetached(command, normalized);
}
