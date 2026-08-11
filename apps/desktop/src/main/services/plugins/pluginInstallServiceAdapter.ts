import type {
  PluginInstallRecord as SyncPluginInstallRecord,
  PluginInstallService as SyncPluginInstallService,
  PluginInstallSource as SyncPluginInstallSource,
} from "../../../../../ade-cli/src/services/plugins/pluginInstallServiceRef";
import type { PluginPresenceRow } from "../../../../../ade-cli/src/services/plugins/pluginTableWriters";
import type { PluginInstallSource } from "../../../shared/plugins/sdk";
import type { PluginInstalledPlugin, PluginInstallService } from "./pluginInstallService";

/**
 * Wave A's install service, wearing the shape the sync layer's remote commands
 * expect.
 *
 * The two contracts differ in both directions and the translation is deliberate
 * rather than a rename: the sync side names a SOURCE KIND (`registry`/`git`/
 * `path`) because that is what arrives over the wire from another machine,
 * while this machine's service takes a single string it classifies itself. The
 * record shapes differ too — the sync side carries display fields so a peer can
 * render an install it does not have the manifest for.
 */

/** Human-readable install source for a peer that has no manifest of its own. */
function describeSource(source: PluginInstallSource): string {
  if (source.kind === "local") return source.path;
  if (source.kind === "git") return source.ref ? `${source.url}#${source.ref}` : source.url;
  return "builtin";
}

function toSyncRecord(installed: PluginInstalledPlugin): SyncPluginInstallRecord {
  const manifest = installed.manifest;
  return {
    pluginId: installed.record.pluginId,
    version: manifest?.version ?? installed.record.version,
    enabled: installed.record.enabled,
    // Display fields come from the manifest on disk, never from the registry
    // record: the registry stores identity, and a reinstall can change the name.
    displayName: manifest?.displayName ?? installed.record.pluginId,
    icon: manifest?.icon ?? "",
    accent: manifest?.accent ?? "",
    source: describeSource(installed.record.source),
    installedAt: installed.record.installedAt,
  };
}

export function createPluginInstallServiceAdapter(deps: {
  install: PluginInstallService;
  /** Fired after any install-state change, so presence can republish. */
  onChanged?: () => void;
}): SyncPluginInstallService {
  const changed = (): void => {
    deps.onChanged?.();
  };

  return {
    async install(source: SyncPluginInstallSource): Promise<SyncPluginInstallRecord> {
      if (source.kind === "registry") {
        // Resolving a registry id to a source is the registry service's job and
        // it is not wired here yet. Refusing is the honest answer: returning a
        // record for an install that never ran is indistinguishable from success
        // on the machine that asked.
        throw new Error("Installing a plugin by registry id is not supported on this computer yet.");
      }
      const installed = source.kind === "path"
        ? await deps.install.install({ source: source.path })
        : await deps.install.install({
          source: source.url,
          ...(source.ref ? { ref: source.ref } : {}),
        });
      changed();
      return toSyncRecord(installed);
    },

    async uninstall(pluginId: string): Promise<{ removed: boolean }> {
      const result = deps.install.uninstall(pluginId);
      changed();
      return result;
    },

    async setEnabled(pluginId: string, enabled: boolean): Promise<SyncPluginInstallRecord> {
      const installed = deps.install.setEnabled(pluginId, enabled);
      changed();
      return toSyncRecord(installed);
    },

    async list(): Promise<SyncPluginInstallRecord[]> {
      return deps.install.list().map(toSyncRecord);
    },
  };
}

/** The presence row for one installed plugin, from the same display fields. */
export function toPluginPresenceRow(installed: PluginInstalledPlugin): PluginPresenceRow {
  const record = toSyncRecord(installed);
  return {
    pluginId: record.pluginId,
    version: record.version,
    enabled: record.enabled,
    displayName: record.displayName,
    icon: record.icon,
    accent: record.accent,
  };
}
