import fs from "node:fs";
import path from "node:path";

import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import { pluginHasRuntimeEntry, type PluginManifest } from "../../../shared/plugins/manifest";
import {
  PluginSdkError,
  type PluginDetail,
  type PluginDomainService,
  type PluginLogEntry,
  type PluginRuntimeStatus,
  type PluginSummary,
  type PluginUsageSummary,
} from "../../../shared/plugins/sdk";
import { createPluginDataStore, type PluginDataStore } from "./pluginDataStore";
import { createPluginChildSupervisor, type PluginChildSupervisor } from "./pluginChildSupervisor";
import { createPluginInstallService, type PluginInstalledPlugin, type PluginInstallService } from "./pluginInstallService";
import { createPluginSdkServer } from "./pluginSdkServer";
import { createPluginSecretStore, type PluginSecretStore } from "./pluginSecretStore";

/**
 * Machine-scoped per-plugin settings values.
 *
 * Kept beside the install registry rather than inside a plugin's own directory:
 * the directory is a git checkout the user may replace wholesale, and their
 * configured values must survive that. There is no writer in v1 — the settings
 * UI will need a `plugin.setConfig` action — but the reader and the file shape
 * are fixed here so `sdk.config.get()` has a real answer from day one.
 */
const PLUGIN_CONFIG_FILE = "config.json";

export type PluginProjectBinding = {
  projectId: string;
  projectRoot: string;
  db: AdeDb;
  invokeAdeAction: (domain: string, action: string, args: Record<string, unknown>) => Promise<unknown>;
};

export type PluginHostService = {
  attachProject(binding: PluginProjectBinding): { detach(): void };
  /** The `plugin` action-domain service, scoped to one project (null = machine). */
  domainService(projectId: string | null): PluginDomainService;
  /** Child pids for the resource sampler's "plugin-host" role. */
  listChildPids(): number[];
  skillRoots(): string[];
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
    })),
    cli: manifest?.cli ?? [],
    restartCount: runtime.restartCount,
    lastCrashAt: runtime.lastCrashAt,
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
    const usageStore = (): PluginDataStore | null => {
      const attached = projectId ? projects.get(projectId) : projects.values().next().value;
      return attached?.data ?? null;
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

      async install(installArgs) {
        const installed = await installs.install(installArgs);
        reconcile();
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
        return result;
      },

      async enable(enableArgs) {
        const installed = installs.setEnabled(enableArgs.pluginId, true);
        reconcile();
        return toSummary(installed, runtimeStateFor(installed));
      },

      async disable(disableArgs) {
        const installed = installs.setEnabled(disableArgs.pluginId, false);
        reconcile();
        return toSummary(installed, runtimeStateFor(installed));
      },

      async usageSummary(usageArgs): Promise<PluginUsageSummary> {
        const store = usageStore();
        if (store) return store.usage(usageArgs?.pluginId);
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
        const installed = installs.reload(reloadArgs.pluginId);
        return toSummary(installed, runtimeStateFor(installed));
      },
    };
  };

  return {
    attachProject(binding) {
      const existing = projects.get(binding.projectId);
      if (existing) {
        existing.attachCount += 1;
        // Rebind: a project reopened after a runtime restart carries a new db
        // handle, and holding the closed one would throw on the next write.
        existing.binding = binding;
        existing.data = createPluginDataStore({ db: binding.db });
        return { detach: () => detachProject(binding.projectId) };
      }
      projects.set(binding.projectId, {
        binding,
        data: createPluginDataStore({ db: binding.db }),
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
    async dispose() {
      if (disposed) return;
      disposed = true;
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
