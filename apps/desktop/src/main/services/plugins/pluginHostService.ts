import fs from "node:fs";
import path from "node:path";

import { setPluginInstallService } from "../../../../../ade-cli/src/services/plugins/pluginInstallServiceRef";
import { getPluginPresenceService } from "../../../../../ade-cli/src/services/plugins/pluginPresenceService";
import type { PluginSyncMeter } from "../../../../../ade-cli/src/services/plugins/pluginSyncMeter";
import type { PluginPresenceRow } from "../../../../../ade-cli/src/services/plugins/pluginTableWriters";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import { pluginHasRuntimeEntry, type PluginManifest, type PluginManifestSetting } from "../../../shared/plugins/manifest";
import { writeTextAtomic } from "../shared/utils";
import {
  PluginSdkError,
  type PluginCollectionRow,
  type PluginDetail,
  type PluginDomainService,
  type PluginLogEntry,
  type PluginPanelRecord,
  type PluginRuntimeStatus,
  type PluginSummary,
  type PluginUsageSummary,
} from "../../../shared/plugins/sdk";
import { createPluginDataStore, type PluginDataStore } from "./pluginDataStore";
import { createPluginChildSupervisor, type PluginChildSupervisor } from "./pluginChildSupervisor";
import { createPluginInstallService, type PluginInstalledPlugin, type PluginInstallService } from "./pluginInstallService";
import { createPluginInstallServiceAdapter, toPluginPresenceRow } from "./pluginInstallServiceAdapter";
import { createPluginSdkServer } from "./pluginSdkServer";
import { createPluginSecretStore, type PluginSecretStore } from "./pluginSecretStore";

/**
 * Machine-scoped per-plugin settings values, for every installed plugin.
 *
 * ONE file beside the install registry, not one inside each plugin: a plugin's
 * directory IS its git checkout, which `plugin install` replaces wholesale on
 * upgrade, and settings the user typed must survive that. `plugin.setConfig`
 * writes it; `sdk.config.get()` and the settings UI read it back through
 * {@link effectiveConfig}, which layers stored values over manifest defaults.
 */
const PLUGIN_CONFIG_FILE = "config.json";

export type PluginProjectBinding = {
  projectId: string;
  projectRoot: string;
  db: AdeDb;
  invokeAdeAction: (domain: string, action: string, args: Record<string, unknown>) => Promise<unknown>;
  /**
   * Per-plugin wire accounting for this project's sync host. Optional: a scope
   * with no sync host reports storage usage and zero wire bytes, which is the
   * truth rather than a gap.
   */
  syncMeter?: PluginSyncMeter | null;
  /** Pushes plugin panels to subscribed peers now instead of on the next poll. */
  onPluginDataChanged?: () => void;
};

export type PluginHostService = {
  attachProject(binding: PluginProjectBinding): { detach(): void };
  /** The `plugin` action-domain service, scoped to one project (null = machine). */
  domainService(projectId: string | null): PluginDomainService;
  /** Child pids for the resource sampler's "plugin-host" role. */
  listChildPids(): number[];
  skillRoots(): string[];
  /** This machine's install state, as the presence service publishes it. */
  listPresenceRows(): PluginPresenceRow[];
  dispose(): Promise<void>;
};

type AttachedProject = {
  binding: PluginProjectBinding;
  data: PluginDataStore;
  attachCount: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readStoredConfig(pluginsRoot: string): Record<string, Record<string, string | number | boolean | null>> {
  try {
    const decoded = JSON.parse(fs.readFileSync(path.join(pluginsRoot, PLUGIN_CONFIG_FILE), "utf8")) as unknown;
    if (!isRecord(decoded) || !isRecord(decoded.config)) return {};
    const config: Record<string, Record<string, string | number | boolean | null>> = {};
    for (const [pluginId, values] of Object.entries(decoded.config)) {
      if (!isRecord(values)) continue;
      const entry: Record<string, string | number | boolean | null> = {};
      for (const [key, value] of Object.entries(values)) {
        if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          entry[key] = value;
        }
      }
      config[pluginId] = entry;
    }
    return config;
  } catch {
    return {};
  }
}

/**
 * Replace the whole settings file.
 *
 * Atomic because one file holds every plugin's settings: this is read at every
 * child spawn, and a torn write reads back as `{}` — every plugin on the machine
 * losing its configuration at once, with no error anywhere to explain it.
 */
function writeStoredConfig(
  pluginsRoot: string,
  config: Record<string, Record<string, string | number | boolean | null>>,
): void {
  fs.mkdirSync(pluginsRoot, { recursive: true });
  writeTextAtomic(path.join(pluginsRoot, PLUGIN_CONFIG_FILE), `${JSON.stringify({ version: 1, config }, null, 2)}\n`);
}

/**
 * Bring one submitted value to the type its setting declares.
 *
 * A `number` setting that stores the string "8080" reads back as a string in
 * the plugin, which is a bug the plugin cannot defend against — the manifest
 * promised it a number.
 */
function coerceSettingValue(setting: PluginManifestSetting, value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (setting.kind === "toggle") {
    if (typeof value === "boolean") return value;
    throw new PluginSdkError("invalid_args", `Setting "${setting.key}" expects true or false.`);
  }
  if (setting.kind === "number") {
    const parsed = typeof value === "number" ? value : Number(value);
    if (typeof value !== "number" && typeof value !== "string") {
      throw new PluginSdkError("invalid_args", `Setting "${setting.key}" expects a number.`);
    }
    if (!Number.isFinite(parsed)) {
      throw new PluginSdkError("invalid_args", `Setting "${setting.key}" expects a number.`);
    }
    return parsed;
  }
  if (typeof value !== "string") {
    throw new PluginSdkError("invalid_args", `Setting "${setting.key}" expects text.`);
  }
  if (setting.kind === "select" && setting.options && setting.options.length > 0) {
    if (!setting.options.some((option) => option.value === value)) {
      throw new PluginSdkError("invalid_args", `"${value}" is not an option for setting "${setting.key}".`);
    }
  }
  return value;
}

function effectiveConfig(
  manifest: PluginManifest | null,
  stored: Record<string, string | number | boolean | null> | undefined,
): Record<string, string | number | boolean | null> {
  const config: Record<string, string | number | boolean | null> = {};
  for (const setting of manifest?.settings ?? []) {
    config[setting.key] = setting.default ?? null;
  }
  for (const [key, value] of Object.entries(stored ?? {})) config[key] = value;
  return config;
}

function toSummary(
  installed: PluginInstalledPlugin,
  runtime: { status: PluginRuntimeStatus; restartCount: number; lastCrashAt: string | null },
): PluginSummary {
  const manifest = installed.manifest;
  return {
    pluginId: installed.record.pluginId,
    version: manifest?.version ?? installed.record.version,
    displayName: manifest?.displayName ?? installed.record.pluginId,
    description: manifest?.description ?? "",
    icon: manifest?.icon ?? null,
    accent: manifest?.accent ?? null,
    enabled: installed.record.enabled,
    status: runtime.status,
    warnings: installed.warnings,
    errors: installed.errors,
    source: installed.record.source,
    installedAt: installed.record.installedAt,
    hasEntry: manifest ? pluginHasRuntimeEntry(manifest) : false,
    surfaces: (manifest?.surfaces ?? []).map((surface) => ({
      kind: surface.kind,
      id: surface.id,
      title: surface.title,
      panelId: surface.panelId,
      ...(surface.icon ? { icon: surface.icon } : {}),
    })),
    // Present only when the manifest declares tokens: the renderer's theme
    // engine treats a non-null `theme` as "this plugin can be applied as one".
    theme: manifest?.theme ? { displayName: manifest.displayName, tokens: manifest.theme.tokens } : null,
    cli: manifest?.cli ?? [],
    restartCount: runtime.restartCount,
    lastCrashAt: runtime.lastCrashAt,
  };
}

/**
 * Fold the sync meter's wire bytes into the storage numbers.
 *
 * The meter is the only source for these: it buffers counters in memory and
 * flushes on a timer, so reading its table directly would report zero for
 * traffic that happened in the current window and read as a broken meter.
 * A plugin that has sent frames but stores nothing still gets an entry — the
 * bytes are real usage whether or not it holds a row.
 */
function mergeWireUsage(
  summary: PluginUsageSummary,
  meter: PluginSyncMeter | null,
  pluginId: string | null,
): PluginUsageSummary {
  if (!meter) return summary;
  const entries = new Map(summary.entries.map((entry) => [entry.pluginId, { ...entry }]));
  for (const wire of meter.summary({ pluginId }).plugins) {
    const entry = entries.get(wire.pluginId) ?? {
      pluginId: wire.pluginId,
      collectionRows: 0,
      collectionBytes: 0,
      contributionRows: 0,
      panelRows: 0,
      syncBytesOut: 0,
      syncBytesIn: 0,
    };
    entry.syncBytesOut = wire.bytesOut;
    entry.syncBytesIn = wire.bytesIn;
    entries.set(wire.pluginId, entry);
  }
  return {
    ...summary,
    entries: [...entries.values()].sort((left, right) => left.pluginId.localeCompare(right.pluginId)),
  };
}

function createHost(args: { logger: Logger; pluginsRoot?: string; adeVersion?: string | null }): PluginHostService {
  const { logger } = args;
  const installs: PluginInstallService = createPluginInstallService({
    logger,
    ...(args.pluginsRoot ? { pluginsRoot: args.pluginsRoot } : {}),
    adeVersion: args.adeVersion ?? null,
  });
  const secrets: PluginSecretStore = createPluginSecretStore();
  /**
   * Republish this machine's presence rows after a local install-state change.
   *
   * Fire-and-forget with a caught rejection on purpose: presence is a
   * convenience for other machines, and an install that succeeded must not be
   * reported as failed because a peer was unreachable.
   */
  const publishPresence = (): void => {
    void getPluginPresenceService()?.publishLocalPresence().catch((error: unknown) => {
      logger.debug("plugin.presence_publish_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  // The sync layer resolves this handle at call time to answer `plugins.*` from
  // another machine; `dispose()` clears it, because a stale handle answering
  // after teardown is worse than "plugins are unavailable on this computer".
  setPluginInstallService(createPluginInstallServiceAdapter({ install: installs, onChanged: publishPresence }));
  const projects = new Map<string, AttachedProject>();
  const supervisors = new Map<string, PluginChildSupervisor>();
  /**
   * Which project a plugin's SDK calls resolve against.
   *
   * Plugin children are machine-scoped but `plugin_collections` lives in a
   * project database, so a child needs a project to write into. It is set to
   * the project an `invoke` arrived through, which makes a plugin's writes land
   * in the project the user is acting in; background work (event handlers,
   * timers) follows the most recent one. Multi-project plugin state is a v2
   * problem the single `plugin` action domain does not yet express.
   */
  const activeProjectByPlugin = new Map<string, string>();
  let disposed = false;

  const resolveProject = (pluginId: string): AttachedProject | null => {
    const preferred = activeProjectByPlugin.get(pluginId);
    if (preferred) {
      const attached = projects.get(preferred);
      if (attached) return attached;
    }
    const first = projects.values().next();
    return first.done ? null : first.value;
  };

  const requireProject = (pluginId: string): AttachedProject => {
    const attached = resolveProject(pluginId);
    if (!attached) {
      throw new PluginSdkError("internal_error", "No project is open, so plugin data is unavailable.");
    }
    return attached;
  };

  /**
   * A `PluginDataStore` that resolves its project at call time. The supervisor
   * and its SDK server are built once, but the project they write into changes
   * as the user moves between projects.
   */
  const routingDataStore = (pluginId: string): PluginDataStore => ({
    getCollection: (id, collection, key) => requireProject(pluginId).data.getCollection(id, collection, key),
    putCollection: (id, collection, key, value) => requireProject(pluginId).data.putCollection(id, collection, key, value),
    deleteCollection: (id, collection, key) => requireProject(pluginId).data.deleteCollection(id, collection, key),
    listCollection: (id, collection, options) => requireProject(pluginId).data.listCollection(id, collection, options),
    publishContribution: (id, entityKind, entityId, socket, payload) =>
      requireProject(pluginId).data.publishContribution(id, entityKind, entityId, socket, payload),
    updatePanel: (id, panelId, panelArgs) => requireProject(pluginId).data.updatePanel(id, panelId, panelArgs),
    readPanel: (id, panelId) => requireProject(pluginId).data.readPanel(id, panelId),
    usage: (id) => requireProject(pluginId).data.usage(id),
    removePluginData: (id) => requireProject(pluginId).data.removePluginData(id),
  });

  const configFor = (pluginId: string, manifest: PluginManifest | null): Record<string, string | number | boolean | null> =>
    effectiveConfig(manifest, readStoredConfig(installs.root)[pluginId]);

  const ensureSupervisor = (installed: PluginInstalledPlugin): PluginChildSupervisor => {
    const pluginId = installed.record.pluginId;
    const existing = supervisors.get(pluginId);
    if (existing) return existing;
    const manifest = installed.manifest;
    if (!manifest) throw new PluginSdkError("plugin_not_found", `Plugin "${pluginId}" has no readable manifest.`);
    const sdkServer = createPluginSdkServer({
      pluginId,
      manifest,
      logger,
      data: routingDataStore(pluginId),
      secrets,
      invokeAdeAction: (domain, action, actionArgs) =>
        requireProject(pluginId).binding.invokeAdeAction(domain, action, actionArgs),
      readConfig: () => configFor(pluginId, manifest),
    });
    const supervisor = createPluginChildSupervisor({
      pluginId,
      pluginRoot: installed.root,
      manifest,
      logger,
      config: configFor(pluginId, manifest),
      onSdkCall: (method, params) => sdkServer.handle(method, params),
    });
    supervisors.set(pluginId, supervisor);
    return supervisor;
  };

  const runtimeStateFor = (installed: PluginInstalledPlugin): {
    status: PluginRuntimeStatus;
    restartCount: number;
    lastCrashAt: string | null;
  } => {
    const supervisor = supervisors.get(installed.record.pluginId);
    if (supervisor) {
      return {
        status: supervisor.status(),
        restartCount: supervisor.restartCount(),
        lastCrashAt: supervisor.lastCrashAt(),
      };
    }
    const hasEntry = installed.manifest ? pluginHasRuntimeEntry(installed.manifest) : false;
    return { status: hasEntry ? "idle" : "no-entry", restartCount: 0, lastCrashAt: null };
  };

  /** Drop supervisors whose plugin was disabled, removed, or reloaded. */
  const reconcile = (): void => {
    const enabled = new Map(installs.list().map((plugin) => [plugin.record.pluginId, plugin]));
    for (const [pluginId, supervisor] of [...supervisors]) {
      const installed = enabled.get(pluginId);
      if (installed && installed.record.enabled && installed.manifest && pluginHasRuntimeEntry(installed.manifest)) {
        continue;
      }
      supervisors.delete(pluginId);
      void supervisor.dispose().catch((error: unknown) => {
        logger.warn("plugin.supervisor_dispose_failed", {
          pluginId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  };

  const requireInstalled = (pluginId: string): PluginInstalledPlugin => {
    const installed = installs.get(pluginId);
    if (!installed) throw new PluginSdkError("plugin_not_found", `Plugin "${pluginId}" is not installed.`);
    return installed;
  };

  const detailFor = (installed: PluginInstalledPlugin): PluginDetail => {
    const supervisor = supervisors.get(installed.record.pluginId);
    return {
      ...toSummary(installed, runtimeStateFor(installed)),
      manifest: installed.manifest,
      settings: installed.manifest?.settings ?? [],
      config: configFor(installed.record.pluginId, installed.manifest),
      root: installed.root,
      logs: supervisor ? supervisor.logs() : ([] as PluginLogEntry[]),
    };
  };

  const domainService = (projectId: string | null): PluginDomainService => {
    const scopedProject = (): AttachedProject | null => {
      const attached = projectId ? projects.get(projectId) : projects.values().next().value;
      return attached ?? null;
    };
    const requireScopedProject = (): AttachedProject => {
      const attached = scopedProject();
      if (!attached) {
        throw new PluginSdkError("internal_error", "No project is open, so plugin data is unavailable.");
      }
      return attached;
    };
    const requireId = (value: unknown, field: string): string => {
      if (typeof value !== "string" || !value.trim()) {
        throw new PluginSdkError("invalid_args", `"${field}" is required.`);
      }
      return value;
    };
    return {
      async invoke(invokeArgs) {
        const pluginId = invokeArgs?.pluginId;
        if (typeof pluginId !== "string" || !pluginId) {
          throw new PluginSdkError("invalid_args", '"pluginId" is required.');
        }
        const action = invokeArgs?.action;
        if (typeof action !== "string" || !action) {
          throw new PluginSdkError("invalid_args", '"action" is required.');
        }
        const installed = requireInstalled(pluginId);
        if (!installed.record.enabled) {
          throw new PluginSdkError("plugin_disabled", `Plugin "${pluginId}" is disabled.`);
        }
        if (!installed.manifest || !pluginHasRuntimeEntry(installed.manifest)) {
          throw new PluginSdkError("plugin_no_entry", `Plugin "${pluginId}" ships no runtime entry.`);
        }
        if (projectId) activeProjectByPlugin.set(pluginId, projectId);
        const supervisor = ensureSupervisor(installed);
        return await supervisor.invoke(action, {
          ...(invokeArgs.args ?? {}),
          ...(invokeArgs.argv ? { argv: invokeArgs.argv } : {}),
        });
      },

      async list(listArgs) {
        const includeDisabled = listArgs?.includeDisabled !== false;
        return installs
          .list()
          .filter((installed) => includeDisabled || installed.record.enabled)
          .map((installed) => toSummary(installed, runtimeStateFor(installed)));
      },

      async get(getArgs) {
        const installed = installs.get(getArgs.pluginId);
        return installed ? detailFor(installed) : null;
      },

      async getPanel(panelArgs): Promise<PluginPanelRecord | null> {
        const pluginId = requireId(panelArgs?.pluginId, "pluginId");
        const panelId = requireId(panelArgs?.panelId, "panelId");
        return requireScopedProject().data.readPanel(pluginId, panelId);
      },

      async getCollection(collectionArgs): Promise<PluginCollectionRow[]> {
        const pluginId = requireId(collectionArgs?.pluginId, "pluginId");
        const collection = requireId(collectionArgs?.collection, "collection");
        return requireScopedProject().data.listCollection(pluginId, collection, {
          ...(collectionArgs.keyPrefix === undefined ? {} : { keyPrefix: collectionArgs.keyPrefix }),
          ...(collectionArgs.limit === undefined ? {} : { limit: collectionArgs.limit }),
        });
      },

      async setConfig(configArgs): Promise<PluginDetail> {
        const pluginId = requireId(configArgs?.pluginId, "pluginId");
        const installed = requireInstalled(pluginId);
        const declared = new Map((installed.manifest?.settings ?? []).map((setting) => [setting.key, setting]));
        const stored = readStoredConfig(installs.root);
        const values = { ...(stored[pluginId] ?? {}) };
        for (const [key, value] of Object.entries(configArgs?.values ?? {})) {
          const setting = declared.get(key);
          // An undeclared key would read back as a setting the plugin never
          // sees, which is indistinguishable from a broken plugin.
          if (!setting) {
            throw new PluginSdkError("invalid_args", `Plugin "${pluginId}" declares no setting "${key}".`);
          }
          const coerced = coerceSettingValue(setting, value);
          // null means "reset", so the stored override is REMOVED rather than
          // written as null: `effectiveConfig` layers stored values over the
          // manifest defaults, so a stored null would shadow the default with
          // nothing instead of restoring it.
          if (coerced === null) delete values[key];
          else values[key] = coerced;
        }
        stored[pluginId] = values;
        writeStoredConfig(installs.root, stored);
        // The child is handed its config at spawn, so a running one keeps the
        // old values until it is replaced.
        const supervisor = supervisors.get(pluginId);
        if (supervisor) {
          supervisors.delete(pluginId);
          await supervisor.dispose();
        }
        return detailFor(requireInstalled(pluginId));
      },

      async install(installArgs) {
        const installed = await installs.install(installArgs);
        reconcile();
        publishPresence();
        return toSummary(installed, runtimeStateFor(installed));
      },

      async uninstall(uninstallArgs) {
        const supervisor = supervisors.get(uninstallArgs.pluginId);
        if (supervisor) {
          supervisors.delete(uninstallArgs.pluginId);
          await supervisor.dispose();
        }
        const result = installs.uninstall(uninstallArgs.pluginId);
        // Rows outlive the install otherwise: `plugin_collections` is keyed by
        // plugin id and nothing else would ever collect them.
        for (const attached of projects.values()) {
          try {
            attached.data.removePluginData(uninstallArgs.pluginId);
          } catch (error) {
            logger.warn("plugin.data_cleanup_failed", {
              pluginId: uninstallArgs.pluginId,
              projectId: attached.binding.projectId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        publishPresence();
        return result;
      },

      async enable(enableArgs) {
        const installed = installs.setEnabled(enableArgs.pluginId, true);
        reconcile();
        publishPresence();
        return toSummary(installed, runtimeStateFor(installed));
      },

      async disable(disableArgs) {
        const installed = installs.setEnabled(disableArgs.pluginId, false);
        reconcile();
        publishPresence();
        return toSummary(installed, runtimeStateFor(installed));
      },

      async usageSummary(usageArgs): Promise<PluginUsageSummary> {
        const attached = scopedProject();
        if (attached) {
          const summary = attached.data.usage(usageArgs?.pluginId);
          return mergeWireUsage(summary, attached.binding.syncMeter ?? null, usageArgs?.pluginId ?? null);
        }
        // No project attached: report the budgets so the UI can still render
        // its meters rather than showing a broken card.
        return {
          entries: [],
          budgets: {
            collectionBytesPerPlugin: 0,
            collectionRowsPerPlugin: 0,
            contributionsPerPlugin: 0,
            panelsPerPlugin: 0,
          },
        };
      },

      async reload(reloadArgs) {
        const supervisor = supervisors.get(reloadArgs.pluginId);
        if (supervisor) {
          supervisors.delete(reloadArgs.pluginId);
          await supervisor.dispose();
        }
        const before = installs.get(reloadArgs.pluginId)?.record.version ?? null;
        const installed = installs.reload(reloadArgs.pluginId);
        // Only a version change is news for presence; the `ade plugin dev` loop
        // reloads constantly and republishing every time would be pure noise.
        if (installed.record.version !== before) publishPresence();
        return toSummary(installed, runtimeStateFor(installed));
      },
    };
  };

  const storeFor = (binding: PluginProjectBinding): PluginDataStore => createPluginDataStore({
    db: binding.db,
    ...(binding.onPluginDataChanged ? { onCollectionChanged: binding.onPluginDataChanged } : {}),
  });

  return {
    attachProject(binding) {
      const existing = projects.get(binding.projectId);
      if (existing) {
        existing.attachCount += 1;
        // Rebind: a project reopened after a runtime restart carries a new db
        // handle, and holding the closed one would throw on the next write.
        existing.binding = binding;
        existing.data = storeFor(binding);
        return { detach: () => detachProject(binding.projectId) };
      }
      projects.set(binding.projectId, {
        binding,
        data: storeFor(binding),
        attachCount: 1,
      });
      return { detach: () => detachProject(binding.projectId) };
    },
    domainService,
    listChildPids() {
      return [...supervisors.values()]
        .map((supervisor) => supervisor.pid())
        .filter((pid): pid is number => typeof pid === "number");
    },
    skillRoots() {
      return installs.skillRoots();
    },
    listPresenceRows() {
      return installs.list().map(toPluginPresenceRow);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      setPluginInstallService(null);
      const running = [...supervisors.values()];
      supervisors.clear();
      projects.clear();
      activeProjectByPlugin.clear();
      await Promise.allSettled(running.map((supervisor) => supervisor.dispose()));
    },
  };

  /** Detaching one project never tears down the machine-scoped host. */
  function detachProject(projectId: string): void {
    const attached = projects.get(projectId);
    if (!attached) return;
    attached.attachCount -= 1;
    if (attached.attachCount > 0) return;
    projects.delete(projectId);
    for (const [pluginId, active] of [...activeProjectByPlugin]) {
      if (active === projectId) activeProjectByPlugin.delete(pluginId);
    }
  }
}

let sharedHost: PluginHostService | null = null;

/** Machine-scoped singleton, mirroring `getSharedProductAnalyticsService`. */
export function getSharedPluginHostService(args: {
  logger: Logger;
  pluginsRoot?: string;
  adeVersion?: string | null;
}): PluginHostService {
  if (!sharedHost) sharedHost = createHost(args);
  return sharedHost;
}

/** Test/teardown seam. */
export async function disposeSharedPluginHostService(): Promise<void> {
  const host = sharedHost;
  sharedHost = null;
  await host?.dispose();
}
