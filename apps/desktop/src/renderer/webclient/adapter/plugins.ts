import type {
  SyncPluginDeltaPayload,
  SyncPluginSnapshotPayload,
} from "../../../shared/types/sync";
import type { PluginPanelHandlers } from "../sync/client";
import type { AdapterInfra } from "./types";
import { unavailableOnHost } from "./misc";

/**
 * Web adapter surface for plugins. Data and transport only — no UI.
 *
 * Two different mechanisms live here and it matters which is which. Panel
 * CONTENT arrives over the view-scoped `plugin_subscribe` stream, because the
 * browser has no local replica of the plugin tables and a panel's rows change
 * far more often than anything a command round trip would keep up with. Install
 * STATE (what exists, what to install) goes over remote commands, because it is
 * a rare, deliberate action whose answer is a single small object.
 *
 * The invalidation subscription is neither: it is the hint that plugin rows
 * changed on the host, for surfaces that read plugin data through a command
 * rather than through an open panel.
 */

export type WebPluginRecord = {
  pluginId: string;
  version: string;
  enabled: boolean;
  displayName: string;
  icon: string;
  accent: string;
  source: string;
  installedAt: string;
};

export type WebPluginPresenceRow = {
  pluginId: string;
  version: string;
  enabled: boolean;
  displayName: string;
  icon: string;
  accent: string;
};

export type WebPluginInstallSource =
  | { kind: "registry"; pluginId: string; version?: string | null }
  | { kind: "git"; url: string; ref?: string | null }
  | { kind: "path"; path: string };

export type PluginsWebNamespace = {
  list(): Promise<WebPluginRecord[]>;
  listPresence(): Promise<WebPluginPresenceRow[]>;
  install(source: WebPluginInstallSource): Promise<WebPluginRecord>;
  uninstall(pluginId: string): Promise<{ removed: boolean }>;
  setEnabled(pluginId: string, enabled: boolean): Promise<WebPluginRecord>;
  subscribePanel(
    pluginId: string,
    panelId: string,
    handlers: {
      snapshot?: (payload: SyncPluginSnapshotPayload) => void;
      delta?: (payload: SyncPluginDeltaPayload) => void;
      error?: (error: Error) => void;
    },
  ): () => void;
  onPluginsInvalidated(listener: () => void): () => void;
};

export function createPluginsNamespace(infra: AdapterInfra): PluginsWebNamespace {
  const { client, commands, events } = infra;

  return {
    async list() {
      // A host without the plugin platform simply has no plugins. Falling back
      // to an empty list rather than surfacing an error is the same "missing
      // plugins hide silently" rule the rest of the product follows.
      const result = await commands.call<{ plugins?: WebPluginRecord[] } | null>(
        "plugins.list",
        {},
        { fallback: () => null, idempotent: true },
      );
      return result?.plugins ?? [];
    },

    async listPresence() {
      const result = await commands.call<{ plugins?: WebPluginPresenceRow[] } | null>(
        "plugins.presenceList",
        {},
        { fallback: () => null, idempotent: true },
      );
      return result?.plugins ?? [];
    },

    // Mutations surface their failure. An install that quietly did nothing is
    // worse than an error: the user has no way to tell it apart from success.
    async install(source) {
      return await commands.call<WebPluginRecord>("plugins.install", { ...source }, {
        fallback: unavailableOnHost("Plugins aren't available on this computer."),
      });
    },

    async uninstall(pluginId) {
      return await commands.call<{ removed: boolean }>("plugins.uninstall", { pluginId }, {
        fallback: unavailableOnHost("Plugins aren't available on this computer."),
      });
    },

    async setEnabled(pluginId, enabled) {
      return await commands.call<WebPluginRecord>(
        enabled ? "plugins.enable" : "plugins.disable",
        { pluginId },
        { fallback: unavailableOnHost("Plugins aren't available on this computer.") },
      );
    },

    subscribePanel(pluginId, panelId, handlers) {
      return client.subscribePluginPanel(pluginId, panelId, handlers as PluginPanelHandlers);
    },

    onPluginsInvalidated(listener) {
      return events.on("pluginsInvalidated", () => listener());
    },
  };
}
