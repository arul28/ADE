import { codedError } from "../../../../desktop/src/shared/codedError";
import { PLUGIN_SERVICE_UNAVAILABLE_CODE } from "../../../../desktop/src/shared/plugins/sdk";

/**
 * Late-bound handle to the three host operations a PLUGIN PAGE performs.
 *
 * A page is the plugin's own HTML, drawn in a guest whose plugin id the host
 * derives from the frame origin. On desktop it reaches the host through
 * `pluginWebviewBridgeServer`; on the phone it reaches it through the sync
 * socket, which is why these have to be resolvable from the sync layer. The
 * seam is the same one {@link setPluginInstallService} uses and exists for the
 * same reason: the plugin host lives in the desktop main tree, and importing it
 * here would invert the dependency and drag the whole host into the CLI bundle.
 *
 * Three operations and no more. Reads a page performs (`collections.get`,
 * `collections.list`) are answered from the phone's own replicated mirror, and
 * a plugin's own handlers are reached through `plugins.invoke`. What is left is
 * exactly what a mirror cannot answer and an action must not be able to do:
 * writing one collection row, and reading or writing the plugin's own settings.
 *
 * Every one of them is the SAME function the desktop bridge calls, not a second
 * implementation of it. That is the whole point of routing through the host
 * rather than writing the tables from here: the declared-collection rule, the
 * budget ceilings, the manifest validation and the refusal of `secret` settings
 * are enforced once, so a page cannot be held to a different rule depending on
 * which client is drawing it.
 *
 * Unbound is a normal runtime state — a headless brain, or a build with no
 * plugin host — and answers the typed `plugins_unavailable` the install service
 * raises rather than reporting a write that never happened.
 */
export type SyncPluginPageHost = {
  /**
   * One collection row, written on the plugin's behalf.
   *
   * Refuses a collection the plugin's manifest does not declare, and a plugin
   * that is not installed or not enabled. The budgets are the data store's,
   * applied inside its own transaction.
   */
  writeCollection(args: {
    pluginId: string;
    collection: string;
    key: string;
    value: unknown;
  }): void | Promise<void>;
  /** The plugin's effective settings: manifest defaults under stored values. */
  readConfig(args: { pluginId: string }): Promise<Record<string, string | number | boolean | null>>;
  /**
   * The plugin's own declared settings, written without restarting it.
   *
   * The restart `plugin.setConfig` performs is right for ADE's settings form
   * and fatal here: a page saving its own settings would kill the child that
   * serves it mid-save. Returns the new effective config.
   */
  writeConfig(args: {
    pluginId: string;
    values: Record<string, unknown>;
  }): Record<string, string | number | boolean | null>
    | Promise<Record<string, string | number | boolean | null>>;
};

let current: SyncPluginPageHost | null = null;

/** Bind the real host. Pass null on dispose so a stale handle cannot be used. */
export function setPluginPageHostService(service: SyncPluginPageHost | null): void {
  current = service;
}

/**
 * The host, or the same typed unavailability the install service raises.
 *
 * Never a silent no-op: a page told its save succeeded when nothing was written
 * is a page that reports the wrong thing to the person holding the phone.
 */
export function requirePluginPageHostService(): SyncPluginPageHost {
  if (!current) {
    throw codedError(
      "Plugins are not available on this computer.",
      PLUGIN_SERVICE_UNAVAILABLE_CODE,
    );
  }
  return current;
}
