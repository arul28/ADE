import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import { isValidPluginId, isValidPluginVersion } from "../../../../desktop/src/shared/plugins/manifest";
import { signPushRelayRequest } from "../push/pushRelayClient";
import type { PushRegistrationStore } from "../push/pushRegistrationStore";

/**
 * The install ping.
 *
 * The Marketplace sorts by installs, so somebody has to count them. This module
 * is the entire client half of that, and its whole design is about how little it
 * sends: `{pluginId, version}` and a machine signature. No project, no
 * repository, no account, no user, no timing beyond the request itself. The
 * signature reuses the machine identity the push relay already holds, so the
 * ping creates no new identifier and reveals nothing the relay did not already
 * know about this machine.
 *
 * Three properties the callers rely on:
 *
 * 1. **Fire and forget.** {@link reportPluginInstall} never throws and never
 *    retries. An install that succeeded must not report a failure because a
 *    directory could not be told about it, and a queue of pending pings would be
 *    a durable record of installs on disk — exactly the thing this avoids.
 * 2. **Never claims.** A machine that has not registered with the relay is not
 *    registered for this either. Minting an identity so telemetry can be sent
 *    would invert the consent: registration happens for push, and this rides
 *    along or does not happen at all.
 * 3. **One switch turns it off.** `ADE_PLUGIN_INSTALL_PINGS=0` (or `false`/
 *    `off`/`no`) disables it everywhere, and the Marketplace keeps working —
 *    the machine simply does not appear in anyone's count.
 */

const DEFAULT_RELAY_URL = "https://ade-push-relay.arulsharma1028.workers.dev";
/** Short: nothing waits on this, and a hung socket must not outlive the install. */
const PING_TIMEOUT_MS = 5_000;

export type PluginInstallPingOutcome = "sent" | "skipped" | "failed";

export type PluginInstallPingDeps = {
  /** Only the machine identity is used; nothing is written back to the store. */
  store: Pick<PushRegistrationStore, "getOrCreateIdentity" | "isClaimed">;
  logger: Logger;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
};

/**
 * Whether this machine reports installs at all.
 *
 * Opt-out rather than opt-in, and named for what it does. The default matters:
 * a directory whose counts come only from people who went looking for a setting
 * ranks the plugins used by people who read settings pages, which is worse than
 * no ranking.
 */
export function pluginInstallPingsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.ADE_PLUGIN_INSTALL_PINGS?.trim().toLowerCase();
  if (!raw) return true;
  return !["0", "false", "off", "no"].includes(raw);
}

export function resolvePluginInstallPingBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
  override?: string,
): string {
  return (override ?? env.ADE_PUSH_RELAY_URL?.trim() ?? "").trim() || DEFAULT_RELAY_URL;
}

/**
 * Tell the directory this machine installed a plugin.
 *
 * Returns an outcome rather than throwing so a caller can log it; no caller
 * should branch on it. `"skipped"` covers every reason not to send — disabled,
 * unregistered, or an id that would not be a valid plugin anyway.
 */
export async function reportPluginInstall(
  deps: PluginInstallPingDeps,
  install: { pluginId: string; version: string },
): Promise<PluginInstallPingOutcome> {
  const env = deps.env ?? process.env;
  if (!pluginInstallPingsEnabled(env)) return "skipped";
  if (!isValidPluginId(install.pluginId) || !isValidPluginVersion(install.version)) return "skipped";

  let machineKey: string;
  let machineSecret: string;
  try {
    // A machine that has never registered with the relay has no row there, so
    // the ping could only 401. Checking here keeps that out of the logs and,
    // more importantly, means telemetry never triggers registration.
    if (!deps.store.isClaimed()) return "skipped";
    ({ machineKey, machineSecret } = deps.store.getOrCreateIdentity());
  } catch {
    return "skipped";
  }

  const baseUrl = resolvePluginInstallPingBaseUrl(env, deps.baseUrl);
  let url: URL;
  try {
    url = new URL(`${baseUrl}/machines/${machineKey}/plugin-installs`);
  } catch {
    return "skipped";
  }

  const body = JSON.stringify({ pluginId: install.pluginId, version: install.version });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  try {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const response = await fetchImpl(url.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ade-push-timestamp": timestamp,
        // Signed over the pathname exactly as it goes on the wire, matching the
        // worker's `new URL(request.url).pathname`.
        "x-ade-push-signature": signPushRelayRequest(machineSecret, {
          timestamp,
          method: "POST",
          pathname: url.pathname,
          body,
        }),
      },
      body,
      signal: controller.signal,
    });
    if (response.ok) return "sent";
    deps.logger.debug("plugin.install_ping_rejected", {
      pluginId: install.pluginId,
      status: response.status,
    });
    return "failed";
  } catch (error) {
    // Offline is the common case and is not worth a warning: the count is a
    // nicety, and the install it followed already succeeded.
    deps.logger.debug("plugin.install_ping_failed", {
      pluginId: install.pluginId,
      message: error instanceof Error ? error.message : String(error),
    });
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}
