import { createHash } from "node:crypto";
import {
  canonicalAdeHomePath,
  readHardwareAnchorUuid,
  readHardwareAnchorUuidAsync,
} from "../../../../../ade-cli/src/services/account/hardwareAnchor";

/**
 * `machine_id`: which ADE install on which computer an event or report came
 * from, the same on Sentry, PostHog and diagnostic reports.
 *
 * PostHog's distinct id is the person once they sign in (the account hash), so
 * every machine a person owns read as one, and a triage of "which Mac froze"
 * had nothing to go on. This is the install: the OS's own machine identifier
 * (`IOPlatformUUID`, `MachineGuid`, `/etc/machine-id`, read by
 * `hardwareAnchor.ts`) and the ADE home path, hashed with a telemetry-only
 * domain and cut to 16 hex characters. The raw identifier never leaves the
 * process; the domain keeps the value unrelated to the account directory's
 * anchor, which hashes the same identifier for a different purpose. Two ADE
 * homes on one computer (`~/.ade` and Alpha's `~/.ade-alpha`) are two
 * installs, and a reinstall into the same home is the same install.
 *
 * Null where the OS gives no identifier (some VMs and containers): callers
 * then send no `machine_id` at all.
 */
export const MACHINE_TELEMETRY_DOMAIN = "ade-telemetry-machine-v1";

export function machineTelemetryIdFor(
  rawUuid: string,
  adeHome: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return createHash("sha256")
    .update(`${MACHINE_TELEMETRY_DOMAIN}:${rawUuid}:${canonicalAdeHomePath(adeHome, platform)}`)
    .digest("hex")
    .slice(0, 16);
}

const byHome = new Map<string, string | null>();

function remember(adeHome: string, rawUuid: string | null): string | null {
  const id = rawUuid ? machineTelemetryIdFor(rawUuid, adeHome) : null;
  byHome.set(adeHome, id);
  return id;
}

/**
 * The id once it is known, without probing: `undefined` until a probe has run
 * in this process. For hot paths (every PostHog capture, every Sentry scope)
 * that must never spawn.
 */
export function peekMachineTelemetryId(adeHome: string): string | null | undefined {
  return byHome.get(adeHome);
}

/** Synchronous; for the brain, where one cached `ioreg` at start costs nothing a window waits on. */
export function readMachineTelemetryId(adeHome: string): string | null {
  const known = byHome.get(adeHome);
  if (known !== undefined) return known;
  return remember(adeHome, readHardwareAnchorUuid());
}

const loading = new Map<string, Promise<string | null>>();

/**
 * Without blocking the event loop; for Electron's main process and the brain's
 * start. One probe per process however many callers ask at once.
 */
export function loadMachineTelemetryId(adeHome: string): Promise<string | null> {
  const known = byHome.get(adeHome);
  if (known !== undefined) return Promise.resolve(known);
  let pending = loading.get(adeHome);
  if (!pending) {
    pending = readHardwareAnchorUuidAsync()
      .then((rawUuid) => remember(adeHome, rawUuid), () => remember(adeHome, null))
      .finally(() => loading.delete(adeHome));
    loading.set(adeHome, pending);
  }
  return pending;
}

/**
 * A reader for hot paths (`createProductAnalyticsService({ machineId })`): the
 * cached id, and on the first ask the off-loop probe that fills it. It probes
 * only when a caller really sends something, so a build with analytics off or
 * unconfigured never spawns for it.
 */
export function machineTelemetryIdReader(adeHome: string): () => string | null | undefined {
  return () => {
    const known = byHome.get(adeHome);
    if (known === undefined) void loadMachineTelemetryId(adeHome);
    return known;
  };
}
