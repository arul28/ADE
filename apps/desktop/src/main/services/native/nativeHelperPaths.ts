/**
 * Where ADE's native helper binaries live.
 *
 * Both `ade-attention-notch` and `ade-desktop-driver` are produced by the same
 * build step into the same `resources/native` directory and copied by the same
 * `extraResources` entry, so where they are is one question with one answer,
 * and it is answered here rather than inside either helper's client.
 *
 * Kept out of `attentionNotchHelper.ts` because the Mac Desktop service runs in
 * the ADE runtime daemon as well as in Electron main, and importing the notch
 * helper — a spawner with its own process state — to ask where a file is was a
 * dependency neither side wanted.
 */

import fs from "node:fs";
import path from "node:path";

export function resolveAttentionNotchExecutablePath(input: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}): string {
  return input.isPackaged
    ? path.join(input.resourcesPath, "native", "ade-attention-notch")
    : path.join(input.appPath, "resources", "native", "ade-attention-notch");
}

/** The name of the Mac Desktop helper, next to `ade-attention-notch`. */
const MAC_DESKTOP_DRIVER_BINARY = "ade-desktop-driver";

/**
 * The Mac Desktop native helper, resolved beside the notch helper.
 *
 * Both binaries are materialized by the same build step into the same
 * `resources/native` directory and copied by the same `extraResources` entry,
 * so one file means a packaging change is one edit. Every input is optional
 * because this service runs in the ADE runtime daemon as well as in Electron
 * main, and the daemon has no `app.getAppPath()`.
 *
 * Returns `null` off macOS rather than throwing: `getStatus` answers on every
 * platform, and a resolver that threw would turn "this host cannot host a
 * display" into a crash on a machine that was only ever going to view one.
 */
/** True only for a regular file this process is allowed to execute. */
function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveMacDesktopDriverBinary(input: {
  /** Absent in the ADE runtime daemon, which has no Electron `app`. */
  isPackaged?: boolean;
  resourcesPath?: string | null;
  appPath?: string | null;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Test seam and the reason `logOverrideIgnored` exists. */
  logger?: { debug: (event: string, detail?: Record<string, unknown>) => void } | null;
} = {}): string | null {
  if ((input.platform ?? process.platform) !== "darwin") return null;
  const env = input.env ?? process.env;
  const override = env.ADE_MAC_DESKTOP_DRIVER_PATH?.trim();
  // A developer override only counts when it names a file that can actually be
  // executed. Honouring a stale or misspelled path made the driver look
  // permanently "missing" with no hint that the environment variable — not the
  // installation — was the reason, so an unusable override is logged and the
  // normal search runs instead.
  if (override) {
    if (isExecutableFile(override)) return override;
    input.logger?.debug("mac_desktop.driver_path_override_ignored", { path: override });
  }
  if (input.isPackaged && input.resourcesPath) {
    return path.join(input.resourcesPath, "native", MAC_DESKTOP_DRIVER_BINARY);
  }
  if (input.appPath) {
    return path.join(input.appPath, "resources", "native", MAC_DESKTOP_DRIVER_BINARY);
  }
  // The daemon path: no Electron `app`, so walk up from this module to the same
  // `resources/native` directory the packaged build copies from.
  const candidates: string[] = [];
  const processResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (processResourcesPath) {
    candidates.push(path.join(processResourcesPath, "native", MAC_DESKTOP_DRIVER_BINARY));
  }
  let current = typeof __dirname === "string" ? __dirname : process.cwd();
  for (let depth = 0; depth < 10; depth += 1) {
    candidates.push(path.join(current, "resources", "native", MAC_DESKTOP_DRIVER_BINARY));
    candidates.push(path.join(current, "apps", "desktop", "resources", "native", MAC_DESKTOP_DRIVER_BINARY));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // An unreadable candidate is simply not the one.
    }
  }
  // Nothing on disk. Name the location the packaged build would use anyway, so
  // the health card can say which file is missing instead of "unknown".
  return candidates[0] ?? null;
}
