import { codedError } from "../../../../desktop/src/shared/codedError";

/**
 * Late-bound handle to the plugin install service.
 *
 * The sync layer has to answer `plugins.install` from a remote machine, but the
 * service that performs an install lives in the desktop main process and is
 * constructed long after the sync host. Importing it here would invert the
 * dependency (sync → main) and drag the whole plugin host into the CLI bundle.
 * So this module owns a narrow interface and a setter; whoever constructs the
 * real service registers it, and the remote-command handlers resolve it at call
 * time.
 *
 * Unbound is a normal runtime state, not a bug: a headless brain or a build
 * without the plugin host answers `plugins_unavailable` rather than crashing or
 * — worse — reporting success for an install that never happened.
 */

export const PLUGIN_SERVICE_UNAVAILABLE_CODE = "plugins_unavailable";

export type PluginInstallSource =
  | { kind: "registry"; pluginId: string; version?: string | null }
  | { kind: "git"; url: string; ref?: string | null }
  | { kind: "path"; path: string };

export type PluginInstallRecord = {
  pluginId: string;
  version: string;
  enabled: boolean;
  displayName: string;
  icon: string;
  accent: string;
  source: string;
  installedAt: string;
};

export type PluginInstallService = {
  install(source: PluginInstallSource): Promise<PluginInstallRecord>;
  uninstall(pluginId: string): Promise<{ removed: boolean }>;
  setEnabled(pluginId: string, enabled: boolean): Promise<PluginInstallRecord>;
  list(): Promise<PluginInstallRecord[]>;
};

let current: PluginInstallService | null = null;

/** Bind the real service. Pass null on dispose so a stale handle cannot be used. */
export function setPluginInstallService(service: PluginInstallService | null): void {
  current = service;
}

export function getPluginInstallService(): PluginInstallService | null {
  return current;
}

/**
 * The service, or a typed error. Callers must not substitute a silent no-op:
 * a remote install that returns `{ ok: true }` without installing anything is
 * indistinguishable from success on the calling machine.
 */
export function requirePluginInstallService(): PluginInstallService {
  if (!current) {
    throw codedError(
      "Plugins are not available on this computer.",
      PLUGIN_SERVICE_UNAVAILABLE_CODE,
    );
  }
  return current;
}
