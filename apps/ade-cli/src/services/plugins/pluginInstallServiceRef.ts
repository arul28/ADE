import { codedError } from "../../../../desktop/src/shared/codedError";
import { PLUGIN_SERVICE_UNAVAILABLE_CODE } from "../../../../desktop/src/shared/plugins/sdk";

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

/**
 * Re-exported, not restated: the renderer branches on this code and so does the
 * sync layer, and two spellings of it would mean a caller degrades honestly on
 * one route and shows an internal error on the other.
 */
export { PLUGIN_SERVICE_UNAVAILABLE_CODE } from "../../../../desktop/src/shared/plugins/sdk";

/**
 * A remote peer asked this machine to install from `git` or `path`.
 *
 * Only `registry` crosses the wire from another machine — see
 * `parsePluginInstallSource` in `syncRemoteCommandService.ts`. A remote git URL
 * or local path names an ARBITRARY source to clone or copy onto this machine,
 * which is a trust decision the person sitting at THIS keyboard makes, not one
 * a paired peer gets to make for them. The desktop's own local install action
 * still accepts all three kinds; only the peer-reachable path is narrowed.
 */
export const PLUGIN_REMOTE_SOURCE_UNSUPPORTED_CODE = "plugin_remote_source_unsupported";

export type SyncPluginInstallSource =
  | { kind: "registry"; pluginId: string; version?: string | null }
  | { kind: "git"; url: string; ref?: string | null }
  | { kind: "path"; path: string };

/**
 * Child-process health as the plugin host reports it.
 *
 * Declared here rather than imported from `renderer/lib/pluginRuntimeBridge`,
 * which is where the UI's copy lives: the sync layer must not depend on the
 * renderer. The two must stay in step — the union is closed and small enough
 * that duplicating it costs less than the dependency would.
 */
export type SyncPluginRecordRuntimeStatus =
  | "running"
  | "starting"
  | "stopped"
  | "crashed"
  | "none";

/** One `{"kind":"tab"}` surface from a plugin's manifest. */
export type SyncPluginRecordTab = {
  id: string;
  title: string;
  panelId: string;
  icon?: string | null;
};

export type SyncPluginInstallRecord = {
  pluginId: string;
  version: string;
  enabled: boolean;
  displayName: string;
  icon: string;
  accent: string;
  source: string;
  installedAt: string;
  /**
   * Manifest- and runtime-derived detail, for peers that have neither.
   *
   * A machine reading this record over sync has no access to the plugin's
   * manifest on disk or to its child process, so without these it can only
   * report a plugin as installed — not which tabs it contributes, whether it is
   * a theme, or whether it is actually running. The web client is the case that
   * forces it: plugin tabs simply do not appear there otherwise.
   *
   * All three are OPTIONAL, and that is the contract, not laziness. A host that
   * does not populate them must leave them absent so the reader can fall back to
   * "unknown" — `status: "none"`, no tabs, no theme. Filling them in with a
   * guess (`enabled ? "running" : "stopped"`) would put a green dot next to a
   * crashed plugin, which is worse than admitting the transport cannot see it.
   */
  status?: SyncPluginRecordRuntimeStatus;
  tabs?: SyncPluginRecordTab[];
  /** Present only for theme plugins. `tokens` stays opaque on this path. */
  theme?: { displayName: string; tokens: Record<string, unknown> } | null;
};

export type SyncPluginInstallService = {
  install(source: SyncPluginInstallSource): Promise<SyncPluginInstallRecord>;
  uninstall(pluginId: string): Promise<{ removed: boolean }>;
  setEnabled(pluginId: string, enabled: boolean): Promise<SyncPluginInstallRecord>;
  list(): Promise<SyncPluginInstallRecord[]>;
};

let current: SyncPluginInstallService | null = null;

/** Bind the real service. Pass null on dispose so a stale handle cannot be used. */
export function setPluginInstallService(service: SyncPluginInstallService | null): void {
  current = service;
}

/**
 * The service, or a typed error. Callers must not substitute a silent no-op:
 * a remote install that returns `{ ok: true }` without installing anything is
 * indistinguishable from success on the calling machine.
 */
export function requirePluginInstallService(): SyncPluginInstallService {
  if (!current) {
    throw codedError(
      "Plugins are not available on this computer.",
      PLUGIN_SERVICE_UNAVAILABLE_CODE,
    );
  }
  return current;
}

/**
 * Run one of a plugin's own named handlers.
 *
 * The same late-binding seam as the install service, and separate from it on
 * purpose: installing is registry work this module can describe, while invoking
 * reaches the plugin HOST — the child processes, the SDK server and the project
 * binding — none of which the sync layer may import.
 */
export type PluginActionInvoker = (args: {
  pluginId: string;
  action: string;
  args?: Record<string, unknown>;
}) => Promise<unknown>;

let invoker: PluginActionInvoker | null = null;

/** Bind the host's invoker. Pass null on dispose. */
export function setPluginActionInvoker(next: PluginActionInvoker | null): void {
  invoker = next;
}

/** The invoker, or the same typed unavailability the install service raises. */
export function requirePluginActionInvoker(): PluginActionInvoker {
  if (!invoker) {
    throw codedError(
      "Plugins are not available on this computer.",
      PLUGIN_SERVICE_UNAVAILABLE_CODE,
    );
  }
  return invoker;
}
