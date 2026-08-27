import type {
  SyncPluginInstallRecord,
  SyncPluginRecordRuntimeStatus,
  SyncPluginRecordSocket,
  SyncPluginRecordTab,
  SyncPluginInstallService,
  SyncPluginInstallSource,
} from "../../../../../ade-cli/src/services/plugins/pluginInstallServiceRef";
import type { PluginPresenceRow } from "../../../../../ade-cli/src/services/plugins/pluginTableWriters";
import type { PluginInstallSource, PluginRuntimeStatus } from "../../../shared/plugins/sdk";
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

/**
 * Host status -> the union a peer understands.
 *
 * The host tracks more states than the record carries because it owns the
 * child; a reader only needs to know what to draw. `restarting` collapses into
 * `starting` (the host is still trying, so a spinner is right) while `crashed`
 * stays distinct, because that is the one state the user has to act on — and
 * after crash containment it is also terminal.
 */
function toRecordStatus(status: PluginRuntimeStatus): SyncPluginRecordRuntimeStatus {
  switch (status) {
    case "running":
      return "running";
    case "starting":
    case "restarting":
      return "starting";
    case "crashed":
      return "crashed";
    case "idle":
    case "stopped":
      return "stopped";
    case "no-entry":
      return "none";
    default:
      return "none";
  }
}

/**
 * The rail surfaces, as the wire record carries them.
 *
 * `webview` joins `tab` for the same reason the desktop preload keeps both:
 * they are one rail entry at `/plugin/<id>` and only the page itself cares
 * which one it draws. Filtering on `kind === "tab"` alone gave a plugin whose
 * only full-page surface is a `webview` ZERO tabs on the wire, so the phone and
 * the web client did not list it at all while the desktop rail showed it.
 *
 * `entryHtml` is deliberately NOT carried: no reader of this record can host a
 * guest, and every one of them renders the surface's panel. That is the
 * cross-surface fallback working as designed, not a field lost in transit.
 */
function toRecordTabs(installed: PluginInstalledPlugin): SyncPluginRecordTab[] {
  return (installed.manifest?.surfaces ?? [])
    .filter((surface) => surface.kind === "tab" || surface.kind === "webview")
    .map((surface) => ({
      id: surface.id,
      title: surface.title,
      panelId: surface.panelId,
      icon: surface.icon ?? null,
    }));
}

/**
 * Manifest socket declarations, forwarded WHOLE rather than field by field.
 *
 * A spread, not an enumeration, and that is the entire point. An enumerated
 * copy silently drops any field added to `PluginManifestSocket` later — this
 * function was written enumerated and was already dropping `description`,
 * `argumentHint` and `section` within the same day, with no error anywhere:
 * the socket simply arrived on the phone and the web client missing its
 * subtitle. The parser is the validation boundary and emits only known-good
 * scalars and string arrays, each key present only when the manifest declared
 * it (`...(x ? {x} : {})`), so there is nothing here to filter and no
 * `undefined`-valued key to spend JSON bytes on.
 *
 * The array field is copied rather than shared: the source object belongs to
 * the install service's cached manifest, and a caller that mutated what it was
 * handed would corrupt the manifest for every later reader on this machine.
 */
function toRecordSockets(installed: PluginInstalledPlugin): SyncPluginRecordSocket[] {
  return (installed.manifest?.sockets ?? []).map((socket) => ({
    ...socket,
    ...(socket.extensions ? { extensions: [...socket.extensions] } : {}),
    // Copied for the same reason `extensions` is: the spread above shares the
    // parsed manifest's arrays, and this record is handed to the sync layer.
    ...(socket.menu ? { menu: socket.menu.map((item) => ({ ...item })) } : {}),
  }));
}

function toSyncRecord(
  installed: PluginInstalledPlugin,
  runtimeStatus?: (pluginId: string) => PluginRuntimeStatus | null,
): SyncPluginInstallRecord {
  const manifest = installed.manifest;
  // Absent means "this host cannot see it", which the reader renders as
  // unknown. Only a manifest we actually parsed lets us say "no tabs" or "not a
  // theme" — with an unreadable manifest, an empty array would be a claim we
  // have no basis for. Same rule for status: no reader supplied, no answer.
  const status = runtimeStatus?.(installed.record.pluginId) ?? null;
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
    ...(status ? { status: toRecordStatus(status) } : {}),
    ...(manifest
      ? {
        tabs: toRecordTabs(installed),
        theme: manifest.theme ? { displayName: manifest.displayName, tokens: manifest.theme.tokens } : null,
        // Guarded by the same `manifest` check as `tabs`, and for the same
        // reason: with an unreadable manifest an empty array would claim the
        // plugin declares no sockets, when the truth is that this host could
        // not read whether it does.
        sockets: toRecordSockets(installed),
        // Sent only when declared. An empty list and an absent field are the
        // same permission — no outbound network, no provider key — so the
        // record spells it one way and every reader has one thing to check.
        ...(manifest.network ? { network: { hosts: [...manifest.network.hosts] } } : {}),
        ...(manifest.providerKeys?.length ? { providerKeys: [...manifest.providerKeys] } : {}),
        ...(manifest.projectSecrets?.length ? { projectSecrets: [...manifest.projectSecrets] } : {}),
      }
      : {}),
    // NOT guarded by `manifest` — the toggles live in the install registry, not
    // in the manifest, so they are readable even when the manifest is not. Sent
    // only when non-empty: absent already means "none are disabled", so an
    // empty array is bytes spent restating the default on every plugin.
    ...(installed.record.disabledContributions?.length
      ? { disabledContributions: [...installed.record.disabledContributions] }
      : {}),
  };
}

/** What changed, for {@link PluginInstallServiceAdapterDeps.afterChange}. */
export type PluginInstallChangeKind = "install" | "uninstall" | "enable" | "disable";

type PluginInstallServiceAdapterDeps = {
  install: PluginInstallService;
  /** Fired after any install-state change, so presence can republish. */
  onChanged?: () => void;
  /**
   * Runs the SAME lifecycle a local install/enable/disable/uninstall goes
   * through — stopping the old child, materializing panels, and (on
   * uninstall) freeing the plugin's data and secrets — before the call
   * resolves.
   *
   * Without this a remote peer's `plugins.install`/`uninstall`/`enable`/
   * `disable` only ever touched the install REGISTRY: nothing stopped the old
   * child, nothing seeded a codeless plugin's declared panels, and an
   * uninstall left the child running and skipped `removePluginData` and
   * `secrets.removeAll` — because those all live in `pluginHostService`'s
   * `domainService`, which this adapter deliberately does not call (its own
   * `install` takes a `{kind}`-tagged source, not the plain string
   * `domainService.install` expects). Wired by the host to run the same steps
   * through a facade instead.
   */
  afterChange?: (pluginId: string, kind: PluginInstallChangeKind) => void | Promise<void>;
  /**
   * Live child status, straight from the supervisor. Optional: a host that
   * cannot answer leaves `status` off the record rather than guessing from
   * `enabled`, which would put a green dot next to a crashed plugin.
   */
  runtimeStatus?: (pluginId: string) => PluginRuntimeStatus | null;
  /**
   * Map a directory entry id to something installable. Null when the directory
   * is unreachable or does not list it — see the refusal in `install`.
   */
  resolveRegistrySource?: (
    pluginId: string,
    version: string | null,
  ) => Promise<{ source: string; ref?: string | null } | null>;
};

export function createPluginInstallServiceAdapter(
  deps: PluginInstallServiceAdapterDeps,
): SyncPluginInstallService {
  // `afterChange` runs BEFORE `onChanged`: presence should report state that
  // already reflects the stop/reconcile/cleanup this call just triggered, not
  // a snapshot from the instant before it.
  const changed = async (pluginId: string, kind: PluginInstallChangeKind): Promise<void> => {
    await deps.afterChange?.(pluginId, kind);
    deps.onChanged?.();
  };
  const record = (installed: PluginInstalledPlugin): SyncPluginInstallRecord =>
    toSyncRecord(installed, deps.runtimeStatus);

  return {
    async install(source: SyncPluginInstallSource): Promise<SyncPluginInstallRecord> {
      if (source.kind === "registry") {
        // A package ADE SHIPS needs no repository: the copy is already on this
        // disk. This is the path the starter themes arrive by — they are
        // bundled and deliberately not seeded, so an id is the only thing a
        // phone, the web client or another machine's Marketplace can send, and
        // before this the directory answered "not listed" and the install
        // refused for something sitting right there.
        const bundledVersion = deps.install.bundledPackageVersion(source.pluginId);
        const wantsAnotherVersion = Boolean(
          source.version && bundledVersion && source.version !== bundledVersion,
        );
        if (bundledVersion && !wantsAnotherVersion) {
          const installed = await deps.install.install({ source: source.pluginId });
          await changed(installed.record.pluginId, "install");
          return record(installed);
        }
        // Otherwise a registry id names an entry, not a place to clone from.
        // The directory is the only thing that maps one to the other, and a
        // machine that cannot reach it refuses rather than guessing a URL from
        // the id — a guessed source is an arbitrary repository running as this
        // plugin.
        const resolved = await deps.resolveRegistrySource?.(source.pluginId, source.version ?? null);
        if (!resolved) {
          throw new Error(
            bundledVersion
              ? `This computer ships "${source.pluginId}" ${bundledVersion}, not ${String(source.version)}, `
                + "and the plugin directory it can see does not list the version you asked for."
              : `"${source.pluginId}" is not in the plugin directory this computer can see, and this ADE does `
                + "not ship it, so there is nothing to install from.",
          );
        }
        const installed = await deps.install.install({
          source: resolved.source,
          ...(resolved.ref ? { ref: resolved.ref } : {}),
        });
        await changed(installed.record.pluginId, "install");
        return record(installed);
      }
      const installed = source.kind === "path"
        ? await deps.install.install({ source: source.path })
        : await deps.install.install({
          source: source.url,
          ...(source.ref ? { ref: source.ref } : {}),
        });
      await changed(installed.record.pluginId, "install");
      return record(installed);
    },

    async uninstall(pluginId: string): Promise<{ removed: boolean }> {
      const result = deps.install.uninstall(pluginId);
      await changed(pluginId, "uninstall");
      return result;
    },

    async setEnabled(pluginId: string, enabled: boolean): Promise<SyncPluginInstallRecord> {
      const installed = deps.install.setEnabled(pluginId, enabled);
      await changed(pluginId, enabled ? "enable" : "disable");
      return record(installed);
    },

    async list(): Promise<SyncPluginInstallRecord[]> {
      return deps.install.list().map(record);
    },
  };
}

/** The presence row for one installed plugin, from the same display fields. */
export function toPluginPresenceRow(installed: PluginInstalledPlugin): PluginPresenceRow {
  const syncRecord = toSyncRecord(installed);
  return {
    pluginId: syncRecord.pluginId,
    version: syncRecord.version,
    enabled: syncRecord.enabled,
    displayName: syncRecord.displayName,
    icon: syncRecord.icon,
    accent: syncRecord.accent,
  };
}
