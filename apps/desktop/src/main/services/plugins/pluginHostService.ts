import fs from "node:fs";
import path from "node:path";

import {
  setPluginActionInvoker,
  setPluginInstallService,
} from "../../../../../ade-cli/src/services/plugins/pluginInstallServiceRef";
import { getPluginPresenceService } from "../../../../../ade-cli/src/services/plugins/pluginPresenceService";
import type { PluginSyncMeter } from "../../../../../ade-cli/src/services/plugins/pluginSyncMeter";
import {
  readAllPluginPresence,
  readPluginContributions,
  type PluginPresenceRow,
} from "../../../../../ade-cli/src/services/plugins/pluginTableWriters";
import {
  createPluginRegistryService,
  type PluginRegistryService,
} from "../../../../../ade-cli/src/services/plugins/pluginRegistryService";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import {
  parsePluginManifestJson,
  pluginHasRuntimeEntry,
  pluginPanelShowsOnMobile,
  type PluginManifest,
  type PluginManifestSetting,
} from "../../../shared/plugins/manifest";
import { writeTextAtomic } from "../shared/utils";
import { isRecord } from "../../../shared/plugins/parse";
import { pluginActionIsFullyDisabled } from "../../../shared/plugins/disabledContributions";
import {
  assertPluginCollectionKey,
  assertPluginCollectionName,
  isPluginEventName,
  isPluginRuntimeHookName,
  PluginSdkError,
  type PluginAudioClip,
  type PluginRuntimeHookName,
  type PluginRuntimeHookPayload,
  type PluginCollectionRow,
  type PluginContributionRecord,
  type PluginDetail,
  type PluginDomainService,
  type PluginFilePickerOptions,
  type PluginLogEntry,
  type PluginMarketplaceIndex,
  type PluginNotificationResult,
  type PluginNotificationTargetRequest,
  type PluginPanelRecord,
  type PluginPresenceMachineRow,
  type PluginRuntimeStatus,
  type PluginSourceInspection,
  type PluginSummary,
  type PluginUsageSummary,
} from "../../../shared/plugins/sdk";
import {
  clampPluginInvokeTimeoutMs,
  isPluginEntityKind,
  isPluginSocketKind,
  isPluginSurfaceId,
} from "../../../shared/plugins/sockets";
import { createPluginDataStore, type PluginDataStore } from "./pluginDataStore";
import { createPluginChildSupervisor, type PluginChildSupervisor } from "./pluginChildSupervisor";
import { subscribeToPluginChanges } from "./pluginEvents";
import { subscribeToPluginRuntimeHooks, type PluginRuntimeHookEmission } from "./pluginRuntimeHooks";
import { createPluginInstallService, type PluginInstalledPlugin, type PluginInstallService } from "./pluginInstallService";
import { createPluginInstallServiceAdapter, toPluginPresenceRow } from "./pluginInstallServiceAdapter";
import {
  createPluginSdkServer,
  pluginAudioCaptureUnavailable,
  pluginAutomationsUnavailable,
  pluginDesktopUnavailable,
  pluginNotificationUnavailable,
} from "./pluginSdkServer";
import { createPluginNotificationLimiter } from "./pluginNotificationLimiter";
import { createPluginScheduleService } from "./pluginScheduleService";
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

/**
 * Per-plugin notification counters, beside the install registry for the same
 * reason {@link PLUGIN_CONFIG_FILE} is: the ceiling is per plugin per machine,
 * and a file inside a plugin's own directory would be erased by the upgrade
 * that replaces that directory — handing a plugin a fresh allowance for the
 * cost of publishing a patch release.
 */
const PLUGIN_NOTIFICATION_USAGE_FILE = "notification-usage.json";

/** Plugin-owned schedules. Machine-scoped, and survives a plugin upgrade. */
const PLUGIN_SCHEDULES_FILE = "schedules.json";

export type PluginProjectBinding = {
  projectId: string;
  projectRoot: string;
  db: AdeDb;
  invokeAdeAction: (
    domain: string,
    action: string,
    args: Record<string, unknown>,
    /**
     * Which plugin is calling, as the HOST knows it — resolved from the
     * supervisor that owns the child socket, never from the call's arguments.
     * The bridge uses it for anything that must be attributed rather than
     * merely permitted (`chat.emitAdeCard` stamps it onto the card).
     */
    caller: { pluginId: string; displayName?: string | null },
  ) => Promise<unknown>;
  /**
   * Per-plugin wire accounting for this project's sync host. Optional: a scope
   * with no sync host reports storage usage and zero wire bytes, which is the
   * truth rather than a gap.
   */
  syncMeter?: PluginSyncMeter | null;
  /** Pushes plugin panels to subscribed peers now instead of on the next poll. */
  onPluginDataChanged?: () => void;
  /**
   * Hand a plugin's fired trigger to THIS project's automation engine.
   *
   * Per-project rather than machine-scoped because a rule is per-project: it is
   * authored in this project's `ade.yaml` and its steps run against this
   * project's lanes. Optional, so a bootstrap with automations disabled binds
   * as it always did and the SDK verb refuses instead of silently succeeding.
   */
  emitAutomationTrigger?: (args: {
    pluginId: string;
    triggerId: string;
    payload?: Record<string, unknown>;
  }) => Promise<void>;
};

export type PluginHostServiceArgs = {
  logger: Logger;
  pluginsRoot?: string;
  adeVersion?: string | null;
  /**
   * Builds a plugin's child supervisor. Injected only by tests: the host starts
   * every enabled plugin on its own now, and a unit test that installs a
   * fixture must be able to prove the host asked without spawning node.
   */
  createSupervisor?: typeof createPluginChildSupervisor;
} & PluginMachineContext;

/**
 * The machine-identity half of the host's dependencies, supplied AFTER
 * construction.
 *
 * The host is built early in bootstrap — the resource sampler and the action
 * registry both need it — while the machine identity and the push-relay state
 * file are established much later in the same startup. Rather than move either,
 * the host starts without them and learns them when they exist; every consumer
 * reads through the current value, so nothing captures a stale one.
 */
export type PluginMachineContext = {
  localMachineKey?: () => string | null;
  listAccountMachines?: () => Promise<{ machineKey: string; label?: string | null; online?: boolean }[] | null>;
  reportInstall?: (install: { pluginId: string; version: string }) => void | Promise<void>;
  /**
   * Drop the third-party account connection a plugin owned, on uninstall.
   *
   * A plugin is the whole vertical, and the account link is part of it: with
   * `ade-linear` gone there is no pane to read the issues, no action domain to
   * write them and no skill to explain them, so a stored Linear token would be
   * a credential on disk with nothing left that can use it. The uninstall
   * dialog says so before the user commits.
   *
   * Supplied late, like the rest of this bag, because the credential services
   * are built well after the host.
   */
  disconnectAccountsForPlugin?: (pluginId: string) => void | Promise<void>;
  /**
   * Record a clip through ADE's microphone, for `ade.audio.captureClip`.
   *
   * In this bag rather than in the constructor because the host is machine-
   * scoped and built early, while the capability arrives from a desktop that
   * may attach later, or never: a daemon on a headless machine has no window
   * to record from, and a plugin asking there gets
   * {@link pluginAudioCaptureUnavailable} instead of a call that hangs.
   */
  captureAudioClip?: (args: {
    pluginId: string;
    label: string;
    maxDurationMs?: number;
  }) => Promise<PluginAudioClip>;
  /**
   * Show a notification for `ade.notifications.post`.
   *
   * Supplied late like the rest of this bag because the two things that can
   * show one — the push publisher and an attached desktop — are both built well
   * after the host. The RATE LIMIT is not the supplier's job: it is applied
   * here, before this is called, so every route into notifications counts
   * against one ceiling rather than each supplier keeping its own.
   */
  postNotification?: (args: {
    pluginId: string;
    label: string;
    title: string;
    body?: string;
    target: PluginNotificationTargetRequest;
  }) => Promise<PluginNotificationResult>;
  /**
   * The Electron-only SDK verbs, when a desktop is attached to lend them.
   *
   * Absent reads as `desktop_unavailable`, which is a refusal a plugin can act
   * on: unlike a missing scheduler, a missing desktop can appear later.
   */
  desktopHost?: {
    readClipboard: () => Promise<string>;
    writeClipboard: (text: string) => Promise<void>;
    pickFile: (options: PluginFilePickerOptions) => Promise<string>;
  };
};

export type PluginHostService = {
  attachProject(binding: PluginProjectBinding): { detach(): void };
  /** Supply (or replace) the machine identity. Merged over what is already set. */
  setMachineContext(context: PluginMachineContext): void;
  /** The `plugin` action-domain service, scoped to one project (null = machine). */
  domainService(projectId: string | null): PluginDomainService;
  /**
   * A plugin's install directory, for an installed AND enabled plugin only.
   *
   * Null-returning rather than throwing: the caller is the `ade-plugin://`
   * protocol handler, where "no such plugin" and "disabled plugin" are ordinary
   * answers that both come out as a 404. Enabled is part of the question on
   * purpose — disabling a plugin has to close its pages, not leave a live origin
   * serving its files with nothing in the UI to show for it.
   */
  rootFor(pluginId: string): string | null;
  /**
   * Write one collection row on a plugin's behalf, for the webview bridge.
   *
   * Not a `plugin` domain action: `PLUGIN_DOMAIN_ACTIONS` is closed and mirrored
   * by the RPC schema and iOS's allowlist, so a write action there would let any
   * client write any plugin's rows. This is reachable only from a guest whose
   * plugin id the host derived from its own origin, and it applies the same
   * declared-collection rule `pluginSdkServer.ts` applies to a plugin's child.
   */
  writeCollection(args: { pluginId: string; collection: string; key: string; value: unknown }): void;
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

/** Case variants a plugin may ship its readme under, in the order tried. */
const PLUGIN_README_FILES = ["README.md", "readme.md", "Readme.md"] as const;

/** Bytes of a readme served to the UI. Past this it is a document, not a page. */
const PLUGIN_README_MAX_BYTES = 256 * 1024;

function readPluginReadme(pluginRoot: string): string | null {
  for (const name of PLUGIN_README_FILES) {
    try {
      const target = path.join(pluginRoot, name);
      const stats = fs.statSync(target);
      if (!stats.isFile()) continue;
      if (stats.size > PLUGIN_README_MAX_BYTES) {
        return `${fs.readFileSync(target, "utf8").slice(0, PLUGIN_README_MAX_BYTES)}\n\n…`;
      }
      return fs.readFileSync(target, "utf8");
    } catch {
      // Missing or unreadable: try the next spelling, then report none.
    }
  }
  return null;
}

/**
 * Parse `plugin.json` from a directory the machine can already read.
 *
 * Null for anything else — a URL, a missing path, an unparseable manifest.
 * Deliberately quiet: this answers "can I show you what this adds before you
 * install it", and "no" is a normal answer, not an error.
 */
function readManifestFromDirectory(source: string): PluginManifest | null {
  try {
    const resolved = path.resolve(source);
    const raw = fs.readFileSync(path.join(resolved, "plugin.json"), "utf8");
    const parsed = parsePluginManifestJson(raw);
    return parsed.manifest;
  } catch {
    return null;
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
      ...(surface.icon ? { icon: surface.icon } : {}),
      // Passed through, not interpreted: the extraction pilot gates a builtin
      // tab on this, and a summary that drops it makes the gate impossible.
      ...(surface.builtin ? { builtin: surface.builtin } : {}),
    })),
    // Present only when the manifest declares tokens: the renderer's theme
    // engine treats a non-null `theme` as "this plugin can be applied as one".
    theme: manifest?.theme ? { displayName: manifest.displayName, tokens: manifest.theme.tokens } : null,
    disabledContributions: installed.record.disabledContributions ?? [],
    cli: manifest?.cli ?? [],
    // Engine registrations ride the summary so the rule builder, the search
    // palette and the keybinding matrix can each see every plugin at once.
    automationTriggers: manifest?.automationTriggers ?? [],
    automationSteps: manifest?.automationSteps ?? [],
    searchProviders: manifest?.searchProviders ?? [],
    keybindings: manifest?.keybindings ?? [],
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

function createHost(args: PluginHostServiceArgs): PluginHostService {
  const { logger } = args;
  let machine: PluginMachineContext = {
    ...(args.localMachineKey ? { localMachineKey: args.localMachineKey } : {}),
    ...(args.listAccountMachines ? { listAccountMachines: args.listAccountMachines } : {}),
    ...(args.reportInstall ? { reportInstall: args.reportInstall } : {}),
  };
  /**
   * The directory client, built on first use.
   *
   * Lazy because most sessions never open the Marketplace, and constructing it
   * resolves a cache path under the machine ADE directory — work a session that
   * only runs an installed plugin should not pay for.
   */
  let registryService: PluginRegistryService | null = null;
  const registry = (): PluginRegistryService => {
    registryService ??= createPluginRegistryService({ logger });
    return registryService;
  };
  const installs: PluginInstallService = createPluginInstallService({
    logger,
    ...(args.pluginsRoot ? { pluginsRoot: args.pluginsRoot } : {}),
    adeVersion: args.adeVersion ?? null,
    /**
     * The install service verifies against the directory's digest, so it needs
     * an answer CONFIRMED on this call — not the cache.
     *
     * The cache is usually cold: it holds an index for six hours and only if
     * someone opened the Marketplace, so reading it would report "no checksum
     * published" for a plugin the directory does vouch for, and an official
     * install would go through unverified with nothing said. A digest that
     * never left the machine also proves nothing about what the directory
     * currently vouches for. The install path pays one revalidating request and
     * decides for itself what an unreachable directory means.
     */
    resolveRegistryEntry: (pluginId: string) => registry().resolveEntryForVerification(pluginId),
    // Read through the mutable context, not captured at construction: the ping
    // target is wired later in bootstrap than the host is built.
    reportInstall: (install) => machine.reportInstall?.(install),
    // Forward reference to a `const` declared further down in this function:
    // safe because the callback only runs once an install actually reaches
    // the rename step, by which point `stopSupervisor` is long since defined
    // — the same pattern `setPluginInstallService`'s `runtimeStatus` below
    // already relies on for `supervisors`.
    beforeReplace: (pluginId: string) => stopSupervisor(pluginId),
  });
  const secrets: PluginSecretStore = createPluginSecretStore();
  /**
   * The two per-plugin ledgers that live beside the install registry.
   *
   * Both are machine-scoped and both outlive any project, which is why they sit
   * next to `config.json` rather than in a project database: a notification
   * budget that reset when the user switched projects would not be a budget,
   * and a schedule is a claim on THIS machine's clock regardless of what is
   * open.
   */
  const notificationLimiter = createPluginNotificationLimiter({
    filePath: path.join(installs.root, PLUGIN_NOTIFICATION_USAGE_FILE),
    logger,
  });
  const schedules = createPluginScheduleService({
    filePath: path.join(installs.root, PLUGIN_SCHEDULES_FILE),
    logger,
    // Routed through the domain service rather than straight at a supervisor so
    // a schedule firing is indistinguishable from any other invoke: it starts a
    // stopped child, refuses a disabled plugin, and is bounded by the same
    // timeout.
    invoke: async ({ pluginId, action, args: invokeArgs }) => (
      await domainService(null).invoke({ pluginId, action, args: invokeArgs })
    ),
  });
  schedules.start();
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
  /**
   * Free everything an uninstalled plugin left behind that the registry
   * delete alone does not reach: its rows in every attached project, and its
   * machine-scoped secrets. Shared by the local `uninstall` action and the
   * remote-command adapter's `afterChange`, so a peer's uninstall cleans up
   * exactly as thoroughly as one run from this desktop's own UI.
   */
  const cleanupUninstalledPluginData = async (pluginId: string): Promise<void> => {
    // Rows outlive the install otherwise: `plugin_collections` is keyed by
    // plugin id and nothing else would ever collect them.
    for (const attached of projects.values()) {
      try {
        attached.data.removePluginData(pluginId);
      } catch (error) {
        logger.warn("plugin.data_cleanup_failed", {
          pluginId,
          projectId: attached.binding.projectId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // The automation ingress log this plugin's firings wrote. Same reasoning
    // as `plugin_collections` above — rows keyed by a plugin nothing else
    // collects — and the key is the event key's `<pluginId>:` prefix, which is
    // how `dispatchIngressTrigger` stamps ownership onto a row whose `source`
    // column says only "plugin".
    //
    // What is deliberately NOT swept here: the user's automation RULES. A rule
    // is authored content that lives in `ade.yaml`, not host state — deleting
    // one on uninstall would destroy work the user can no longer see to
    // recover, and a reinstall would not bring it back. The rule survives; its
    // step refuses with the catalog sentence naming the missing plugin, and the
    // builder renders it attributed and unavailable.
    for (const attached of projects.values()) {
      try {
        // No LIKE escaping: a plugin id is `[a-z][a-z0-9-]*` by manifest
        // pattern, so it can hold none of `%`, `_` or `\`.
        attached.binding.db.run(
          `delete from automation_ingress_events where source = 'plugin' and event_key like ?`,
          [`${pluginId}:%`],
        );
      } catch (error) {
        logger.warn("plugin.ingress_cleanup_failed", {
          pluginId,
          projectId: attached.binding.projectId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // Secrets are machine-scoped, so no project cleanup would ever reach
    // them: an uninstalled plugin's tokens would sit in the credential
    // store with nothing left that knows their names.
    try {
      await secrets.removeAll(pluginId);
    } catch (error) {
      logger.warn("plugin.secret_cleanup_failed", {
        pluginId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Schedules, which are the one thing here that keeps ACTING after the
    // plugin is gone. Rows and secrets left behind are inert clutter; a
    // surviving schedule wakes a plugin that is no longer installed, on a
    // timer the user has no surface left to cancel it from. This is why plugin
    // schedules are owned rather than borrowed — a chat cron a plugin created
    // through `actions.invoke` carries no owner and could not be found here.
    try {
      const removed = schedules.removeAllForPlugin(pluginId);
      if (removed > 0) logger.info("plugin.schedules_removed_on_uninstall", { pluginId, removed });
    } catch (error) {
      logger.warn("plugin.schedule_cleanup_failed", {
        pluginId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // The notification counters, so a reinstall starts with a clean allowance
    // rather than inheriting a day the previous install spent. Not a security
    // boundary — a plugin that could uninstall itself could already do worse —
    // just correctness: the ledger should not name plugins that are not here.
    try {
      notificationLimiter.forget(pluginId);
    } catch (error) {
      logger.warn("plugin.notification_usage_cleanup_failed", {
        pluginId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // The account link the plugin owned, if it owned one. Deliberately last:
    // it is the only step a user could be surprised by, and it must not be able
    // to strand the data and secret cleanup above if it throws.
    try {
      await machine.disconnectAccountsForPlugin?.(pluginId);
    } catch (error) {
      logger.warn("plugin.account_disconnect_failed", {
        pluginId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  // The sync layer resolves this handle at call time to answer `plugins.*` from
  // another machine; `dispose()` clears it, because a stale handle answering
  // after teardown is worse than "plugins are unavailable on this computer".
  setPluginInstallService(createPluginInstallServiceAdapter({
    install: installs,
    onChanged: publishPresence,
    // Live child state, so a peer (the web client especially) sees a contained
    // or crashed plugin as dead rather than falling back to "none". Absent
    // without this, and a guess from `enabled` would put a green dot on a
    // crashed plugin.
    runtimeStatus: (pluginId) => supervisors.get(pluginId)?.status() ?? null,
    // A remote "install graph" names a directory entry; only the directory maps
    // that to a repository. The cached index answers when it can, and a refresh
    // is attempted once before giving up, because a machine that has never
    // opened the Marketplace has no cache to answer from.
    resolveRegistrySource: async (pluginId, version) => {
      const find = (result: { entries: { pluginId: string; source: string; version: string }[] } | null) =>
        result?.entries.find((entry) => entry.pluginId === pluginId) ?? null;
      const entry = find(registry().readCachedIndex()) ?? find(await registry().fetchIndex({ refresh: true }));
      if (!entry) return null;
      // The version is a tag on the entry's repository; an entry that does not
      // publish the asked-for version still installs from its default ref.
      return { source: entry.source, ref: version && version !== entry.version ? version : null };
    },
    // Remote install/enable/disable/uninstall used to touch only the install
    // REGISTRY: nothing stopped the old child, no codeless plugin's panels
    // were seeded, and an uninstall left the child running with its data and
    // secrets intact. This runs the same lifecycle the local action below
    // does, keyed by what changed.
    afterChange: async (pluginId, kind) => {
      if (kind === "uninstall") {
        await stopSupervisor(pluginId);
        await cleanupUninstalledPluginData(pluginId);
        return;
      }
      if (kind === "install") {
        await stopSupervisor(pluginId);
        reconcile({ replacePanelsFor: pluginId });
        return;
      }
      // enable / disable: no code changed, just whether it should be running.
      reconcile();
    },
  }));
  // Every plugin tap from a phone lands here: `plugins.invoke` resolves this at
  // call time and runs the same domain path the desktop's `plugin.invoke` does,
  // so a handler cannot behave differently depending on which device asked.
  setPluginActionInvoker(async (invokeArgs) => domainService(null).invoke(invokeArgs));
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

  /** Any attached project, for callers with no reason to prefer one. */
  const anyProject = (): AttachedProject | null => projects.values().next().value ?? null;

  /**
   * One message for "there is nowhere to put plugin data", shared by both
   * resolvers below so a plugin cannot get two different explanations for the
   * same condition depending on which call it made.
   */
  const requireAttached = (attached: AttachedProject | null): AttachedProject => {
    if (!attached) {
      throw new PluginSdkError("internal_error", "No project is open, so plugin data is unavailable.");
    }
    return attached;
  };

  const resolveProject = (pluginId: string): AttachedProject | null => {
    const preferred = activeProjectByPlugin.get(pluginId);
    if (preferred) {
      const attached = projects.get(preferred);
      if (attached) return attached;
    }
    return anyProject();
  };

  const requireProject = (pluginId: string): AttachedProject => requireAttached(resolveProject(pluginId));

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

  const buildSupervisor = args.createSupervisor ?? createPluginChildSupervisor;

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
        requireProject(pluginId).binding.invokeAdeAction(domain, action, actionArgs, {
          pluginId,
          displayName: manifest.displayName ?? null,
        }),
      readConfig: () => configFor(pluginId, manifest),
      // Read through `machine` at call time rather than captured here: a
      // supervisor outlives the desktop that lends it a microphone, and a
      // captured `undefined` would keep refusing captures long after one
      // attached.
      captureAudioClip: (captureArgs) => {
        const capture = machine.captureAudioClip;
        if (!capture) return Promise.reject(pluginAudioCaptureUnavailable());
        return capture(captureArgs);
      },
      // The rate limit sits HERE rather than inside whatever ends up showing
      // the notification: `machine.postNotification` fans out to a phone push
      // and a desktop notification, and a ceiling applied on the far side of
      // that fan-out would count one post twice or not at all. Reserving first
      // also means a plugin over its budget never reaches the relay.
      postNotification: async (notifyArgs) => {
        const post = machine.postNotification;
        if (!post) throw pluginNotificationUnavailable();
        notificationLimiter.reserve(notifyArgs.pluginId);
        try {
          return await post(notifyArgs);
        } catch (error) {
          // Refunded, so a machine with nowhere to deliver does not spend the
          // plugin's daily budget on failures and then report the wrong reason
          // for the sixth one.
          notificationLimiter.release(notifyArgs.pluginId);
          throw error;
        }
      },
      schedules,
      // Resolved at call time through `requireProject`, never captured: which
      // project a plugin's calls belong to changes as projects attach and
      // detach, and a captured binding would keep firing triggers into a
      // project the user has closed.
      emitAutomationTrigger: async (emitArgs) => {
        const emit = requireProject(emitArgs.pluginId).binding.emitAutomationTrigger;
        if (!emit) throw pluginAutomationsUnavailable();
        await emit(emitArgs);
      },
      // Read through `machine` at call time, not captured: a supervisor
      // outlives the desktop that lends it these, and a captured `undefined`
      // would keep refusing long after one attached.
      desktopHost: {
        readClipboard: () => {
          const host = machine.desktopHost;
          if (!host) return Promise.reject(pluginDesktopUnavailable());
          return host.readClipboard();
        },
        writeClipboard: (text) => {
          const host = machine.desktopHost;
          if (!host) return Promise.reject(pluginDesktopUnavailable());
          return host.writeClipboard(text);
        },
        pickFile: (options) => {
          const host = machine.desktopHost;
          if (!host) return Promise.reject(pluginDesktopUnavailable());
          return host.pickFile(options);
        },
      },
    });
    const supervisor = buildSupervisor({
      pluginId,
      pluginRoot: installed.root,
      manifest,
      logger,
      config: configFor(pluginId, manifest),
      // `events.subscribe` is answered here rather than by the SDK server: it
      // writes fan-out state, which lives with the queue that reads it. See
      // `applyEventSubscription`.
      // `async` so a refusal becomes a rejection the supervisor can answer with
      // a `sdkResult` error frame; a synchronous throw here would escape the
      // frame handler and leave the child's request unanswered forever.
      onSdkCall: async (method, params) => (
        method === "events.subscribe"
          ? applyEventSubscription(pluginId, params)
          : sdkServer.handle(method, params)
      ),
    });
    supervisors.set(pluginId, supervisor);
    return supervisor;
  };

  /**
   * Drop a plugin's running child.
   *
   * Every caller that replaces what a child is running — a settings write, an
   * upgrade, a reload, an uninstall — has to do this first, and the supervisor
   * is removed from the map BEFORE the await so a concurrent `invoke` cannot
   * pick up the one that is on its way out.
   */
  const stopSupervisor = async (pluginId: string): Promise<void> => {
    const supervisor = supervisors.get(pluginId);
    if (!supervisor) return;
    supervisors.delete(pluginId);
    // The child's listeners die with it, and the next one re-registers from
    // `activate`. Anything still queued for it is telemetry for a process that
    // no longer exists.
    hookSubscriptions.delete(pluginId);
    hookQueues.delete(pluginId);
    await supervisor.dispose();
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

  /**
   * Read a panel's declared schema from the plugin's own tree.
   *
   * The manifest parser already refuses a path that escapes the plugin, and
   * this re-checks the resolved path anyway — the same belt-and-braces the
   * skills roots get, because this one is read from a directory a third party
   * wrote. Unreadable or unparseable reads as "no declared schema", which is
   * the honest answer: the plugin ships a panel it cannot render.
   */
  const readDeclaredPanelSchema = (pluginRoot: string, schemaFile: string): unknown => {
    const resolved = path.resolve(pluginRoot, schemaFile);
    if (resolved !== pluginRoot && !resolved.startsWith(`${pluginRoot}${path.sep}`)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(resolved, "utf8")) as unknown;
    } catch {
      return undefined;
    }
  };

  /**
   * Materialize the panels a manifest DECLARES, so a plugin that ships no code
   * still renders.
   *
   * `plugin_panels` is the only thing any client reads — desktop, phone, TUI
   * and web all render the row, never the manifest — so before this a declared
   * `schemaFile` was never read by anything and every codeless plugin (themes,
   * static panels) opened onto "this plugin hasn't published this view yet".
   * The one pilot that worked around it did so by shipping an entry point whose
   * only job was to re-publish its own JSON on a retry loop.
   *
   * `replace` is false for a plain bind: a running plugin's live panel content
   * outranks its shipped default, and clobbering it on every project attach
   * would blank a populated view until the child republished. It is true when
   * the code on disk just changed (install, reload) — the declared schema is
   * then genuinely newer than whatever the previous version published.
   */
  const seedDeclaredPanels = (installed: PluginInstalledPlugin, replace: boolean): void => {
    const manifest = installed.manifest;
    if (!manifest || !installed.record.enabled) return;
    const pluginId = installed.record.pluginId;
    for (const panel of manifest.panels) {
      if (!panel.schemaFile) continue;
      const schema = readDeclaredPanelSchema(installed.root, panel.schemaFile);
      if (schema === undefined) continue;
      const surface = manifest.surfaces.find((entry) => entry.panelId === panel.id);
      // A panel no surface names is reachable only by a client that asks for it
      // directly, so nothing here decides it is desktop-only.
      const mobile = surface ? pluginPanelShowsOnMobile(surface) : true;
      const declared = {
        ...(panel.title ? { title: panel.title } : {}),
        ...(panel.icon ? { icon: panel.icon } : {}),
        ...(surface ? { surface: surface.id } : {}),
        mobile,
      };
      for (const attached of projects.values()) {
        try {
          const existing = replace ? null : attached.data.readPanel(pluginId, panel.id);
          if (existing) {
            // The row's CONTENT belongs to the plugin, and a plain convergence
            // pass must not clobber it. `mobile` is not content: it is the
            // host's answer, and it moves when the manifest changes it or when
            // a new ADE resolves it differently. A codeless plugin never
            // republishes, so a stale answer here would be permanent — the flag
            // is rewritten onto the schema the row already holds instead.
            const stored = isRecord(existing.schema) ? existing.schema : null;
            if (!stored || stored.mobile === mobile) continue;
            attached.data.updatePanel(pluginId, panel.id, {
              ...declared,
              schema: existing.schema,
              vocabVersion: existing.vocabVersion,
            });
            continue;
          }
          // Through the store, so the budget writer sees this row exactly as it
          // sees a `panels.update` from the plugin itself.
          attached.data.updatePanel(pluginId, panel.id, {
            ...declared,
            schema,
            vocabVersion: manifest.vocabVersion,
          });
        } catch (error) {
          logger.warn("plugin.panel_seed_failed", {
            pluginId,
            panelId: panel.id,
            projectId: attached.binding.projectId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  };

  /** Start a plugin without making the caller wait on — or fail with — it. */
  const startQuietly = (supervisor: PluginChildSupervisor): void => {
    void supervisor.start().catch((error: unknown) => {
      logger.warn("plugin.autostart_failed", {
        pluginId: supervisor.pluginId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  /**
   * Bring running state in line with installed state.
   *
   * Two halves, and the second one is what makes a plugin visible at all:
   * supervisors for plugins that were disabled, removed or reloaded are
   * dropped, and every enabled plugin is then STARTED and has its declared
   * panels seeded. Nothing else starts a plugin except an explicit `invoke`, so
   * without this an installed plugin sat idle — no panels, no contributions,
   * nothing on any surface — until someone happened to invoke one of its
   * actions.
   *
   * `replacePanelsFor` names the ONE plugin whose code just changed, never a
   * blanket "replace everything": `reconcile` runs on install, and it also
   * runs a plain convergence pass over EVERY installed plugin (reload, enable,
   * project attach). A boolean here would clobber every OTHER plugin's live
   * panel content with its shipped default on somebody else's install — a
   * plugin that had published real data would flash back to its manifest
   * defaults because a second, unrelated plugin was installed.
   */
  const reconcile = (options?: { replacePanelsFor?: string }): void => {
    const installed = new Map(installs.list().map((plugin) => [plugin.record.pluginId, plugin]));
    for (const [pluginId, supervisor] of [...supervisors]) {
      const plugin = installed.get(pluginId);
      if (plugin && plugin.record.enabled && plugin.manifest && pluginHasRuntimeEntry(plugin.manifest)) {
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
    if (disposed) return;
    for (const plugin of installed.values()) {
      if (!plugin.record.enabled || !plugin.manifest) continue;
      seedDeclaredPanels(plugin, options?.replacePanelsFor === plugin.record.pluginId);
      if (!pluginHasRuntimeEntry(plugin.manifest)) continue;
      startQuietly(ensureSupervisor(plugin));
    }
  };

  /**
   * The tail every install-state change shares: bring running state in line,
   * tell the other machines, and answer with the plugin as it now is.
   */
  const applyInstallChange = (
    installed: PluginInstalledPlugin,
    options?: { replacePanelsFor?: string },
  ): PluginSummary => {
    reconcile(options);
    publishPresence();
    return toSummary(installed, runtimeStateFor(installed));
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
    const scopedProject = (): AttachedProject | null => (
      projectId ? projects.get(projectId) ?? null : anyProject()
    );
    const requireScopedProject = (): AttachedProject => requireAttached(scopedProject());
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
        // The per-contribution toggle has to hold HERE, not only where the
        // contribution is drawn. A menu that hides a disabled item stops one
        // route to the action; every other client, the phone, the CLI and a
        // stale renderer all reach this method directly, so a toggle enforced
        // only in the menu is a suggestion. See `pluginActionIsFullyDisabled`
        // for why a single disabled contribution is not enough to refuse.
        if (pluginActionIsFullyDisabled(
          installed.manifest,
          installed.record.disabledContributions,
          action,
        )) {
          throw new PluginSdkError(
            "not_permitted",
            `"${action}" is turned off for ${installed.manifest.displayName || pluginId} in its plugin settings.`,
          );
        }
        if (projectId) activeProjectByPlugin.set(pluginId, projectId);
        const supervisor = ensureSupervisor(installed);
        // Clamped again rather than trusted from the caller: this service is
        // also reached from the phone and the CLI, which do not go through the
        // desktop's preload normalizer.
        const timeoutMs = clampPluginInvokeTimeoutMs(invokeArgs.timeoutMs);
        return await supervisor.invoke(
          action,
          {
            ...(invokeArgs.args ?? {}),
            ...(invokeArgs.argv ? { argv: invokeArgs.argv } : {}),
          },
          timeoutMs ? { timeoutMs } : undefined,
        );
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

      async marketplaceIndex(indexArgs): Promise<PluginMarketplaceIndex | null> {
        const result = await registry().fetchIndex(indexArgs?.refresh ? { refresh: true } : {});
        if (!result) return null;
        return { entries: result.entries, fetchedAt: result.fetchedAt, origin: result.origin };
      },

      async repoStars(starsArgs): Promise<number | null> {
        // The registry owns the URL check, the day-long cache and the rate-limit
        // degradation; there is deliberately nothing to add here. Null reaches
        // the client unchanged and is drawn as "unknown", never as zero.
        return registry().fetchRepoStars(starsArgs.repo);
      },

      async presence(): Promise<PluginPresenceMachineRow[]> {
        const attached = scopedProject();
        // No project database means no synced rows to read. Empty reads as
        // "this machine only", which is what the UI should show.
        if (!attached) return [];
        let localKey: string | null = null;
        try {
          localKey = machine.localMachineKey?.() ?? null;
        } catch {
          localKey = null;
        }
        const directory = new Map<string, { label?: string | null; online?: boolean }>();
        try {
          for (const entry of (await machine.listAccountMachines?.()) ?? []) {
            directory.set(entry.machineKey, { label: entry.label, online: entry.online });
          }
        } catch {
          // An unavailable directory costs names and reachability, not rows.
        }
        return readAllPluginPresence(attached.binding.db).map((row): PluginPresenceMachineRow => {
          const isThisMachine = localKey !== null && row.machineKey === localKey;
          const known = directory.get(row.machineKey);
          return {
            machineKey: row.machineKey,
            // Never invented: without a directory the key IS the name, which
            // reads as unfamiliar rather than as the wrong computer.
            machineName: known?.label?.trim() || (isThisMachine ? "This computer" : row.machineKey),
            pluginId: row.pluginId,
            version: row.version || null,
            enabled: row.enabled,
            // The machine answering is by definition reachable from itself.
            online: isThisMachine ? true : known?.online === true,
            isThisMachine,
          };
        });
      },

      async listContributions(contributionArgs): Promise<PluginContributionRecord[]> {
        const surfaceInput = requireId(contributionArgs?.surface, "surface");
        // Every socket a manifest declares is already restricted to
        // `PLUGIN_SURFACE_IDS` by the manifest parser, so an unrecognized
        // `surface` here can never match one and `declared` would end up
        // empty anyway — but that is an accident of the filter below, not a
        // guarantee this function makes. Checking directly is what makes it one.
        if (!isPluginSurfaceId(surfaceInput)) return [];
        const surface = surfaceInput;
        const attached = scopedProject();
        if (!attached) return [];
        // Manifest sockets are the join: the table stores a socket KIND, and
        // which surface that kind renders on is per-plugin manifest detail.
        // Built once per call rather than per row — a Lanes list asks for this
        // on every render, and a plugin declares a handful of sockets.
        //
        // The key joins plugin id, socket kind and SOCKET ID on NULs, which none
        // of them can contain, so no triple can ever collide into one entry.
        // Written as the ESCAPE, never as a literal NUL byte: a source file
        // holding one is binary to git, which stops diffing it and hides every
        // later change to this function.
        //
        // Keying on the socket id is what makes two declarations of one kind
        // independent. Keyed on `pluginId + kind` alone, a plugin declaring two
        // badges on Lanes collapsed to whichever it declared LAST, and every
        // published badge row was then stamped with that arbitrary winner's
        // `socketId` and its `enabled` flag — so the per-contribution toggle for
        // one badge could hide the other's rows, and the phone (which resolves
        // per declaration) disagreed with this machine about what was on screen.
        const declared = new Map<string, { socketId: string; enabled: boolean }>();
        // The unambiguous case, kept apart: a row naming no socket id can only
        // be resolved when its kind was declared exactly ONCE. Set to null the
        // moment a second declaration of that kind lands, which is what lets the
        // row loop tell "ambiguous" apart from "never declared".
        const soleByKind = new Map<string, { socketId: string; enabled: boolean } | null>();
        for (const installed of installs.list()) {
          if (!installed.record.enabled || !installed.manifest) continue;
          const off = new Set(installed.record.disabledContributions ?? []);
          for (const socket of installed.manifest.sockets) {
            if (socket.surface !== surface) continue;
            const declaration = { socketId: socket.id, enabled: !off.has(socket.id) };
            declared.set(
              `${installed.record.pluginId}\u0000${socket.socket}\u0000${socket.id}`,
              declaration,
            );
            const kindKey = `${installed.record.pluginId}\u0000${socket.socket}`;
            soleByKind.set(kindKey, soleByKind.has(kindKey) ? null : declaration);
          }
        }
        if (declared.size === 0) return [];
        // Warned once per (plugin, kind), not once per row: a surface asks for
        // this on every render and a plugin may publish hundreds of rows, so an
        // un-deduped warning would be the loudest thing in the log.
        const warnedAmbiguous = new Set<string>();
        const rows = readPluginContributions(attached.binding.db, {
          entityKind: contributionArgs.entityKind ?? null,
          entityIds: contributionArgs.entityIds ?? null,
        });
        const results: PluginContributionRecord[] = [];
        for (const row of rows) {
          // Parsed BEFORE the declaration join, because the payload is what
          // names the declaration: a row carrying `id` is addressed to one
          // specific socket the plugin declared, and joining on the kind alone
          // would throw that away before reading it.
          let payload: unknown = null;
          try {
            payload = JSON.parse(row.payloadJson) as unknown;
          } catch {
            payload = null;
          }
          const declaredId = isRecord(payload) && typeof payload.id === "string"
            ? payload.id.trim()
            : "";
          const kindKey = `${row.pluginId}\u0000${row.socket}`;
          let match: { socketId: string; enabled: boolean } | undefined;
          if (declaredId) {
            // Addressed: it resolves to that declaration or to nothing. A row
            // naming a socket id the plugin no longer declares is stale, and
            // adopting a different one would move it to a slot its author never
            // chose.
            match = declared.get(`${kindKey}\u0000${declaredId}`);
          } else {
            const sole = soleByKind.get(kindKey);
            // `null` means the plugin declared this kind more than once, so
            // there is no non-arbitrary answer. Left unmatched deliberately —
            // guessing is what produced the bug this branch fixes — and the
            // author is told, because only they can add the id.
            if (sole === null && !warnedAmbiguous.has(kindKey)) {
              warnedAmbiguous.add(kindKey);
              logger.warn("plugin.contribution_id_ambiguous", {
                pluginId: row.pluginId,
                socket: row.socket,
                surface,
                entityKind: row.entityKind,
                reason: "published_row_has_no_id_and_kind_is_declared_more_than_once",
              });
            }
            match = sole ?? undefined;
          }
          // Disabled plugins, switched-off sockets and rows left behind by a
          // plugin that stopped declaring a socket all drop out here, so no
          // caller has to re-derive any of it.
          if (!match || !match.enabled) continue;
          // `row.socket` matching a `declared` key already implies it is one
          // of `PLUGIN_SOCKET_KINDS` -- `declared`'s keys come from a parsed
          // manifest, which only ever carries those -- but `entityKind` has
          // no such indirect guarantee: it comes straight off the row with
          // nothing upstream restricting it to the closed union. A row from a
          // future entity kind this build predates, or a corrupted one, is
          // dropped rather than handed to a renderer as a value it has no
          // case for.
          if (!isPluginEntityKind(row.entityKind) || !isPluginSocketKind(row.socket)) continue;
          results.push({
            entityKind: row.entityKind,
            entityId: row.entityId,
            pluginId: row.pluginId,
            socket: row.socket,
            surface,
            socketId: match.socketId,
            payload,
            updatedAt: row.updatedAt || null,
          });
        }
        return results;
      },

      async getManifest(manifestArgs): Promise<PluginManifest | null> {
        return installs.get(requireId(manifestArgs?.pluginId, "pluginId"))?.manifest ?? null;
      },

      async openLogs(logArgs): Promise<PluginLogEntry[]> {
        const pluginId = requireId(logArgs?.pluginId, "pluginId");
        requireInstalled(pluginId);
        // The ring buffer lives on the supervisor, so a plugin that has never
        // started has no lines rather than an error — "nothing logged yet" is
        // the honest answer for an idle plugin.
        return supervisors.get(pluginId)?.logs() ?? [];
      },

      async getReadme(readmeArgs): Promise<string | null> {
        const installed = installs.get(requireId(readmeArgs?.pluginId, "pluginId"));
        if (!installed) return null;
        return readPluginReadme(installed.root);
      },

      async inspectSource(inspectArgs): Promise<PluginSourceInspection | null> {
        const source = requireId(inspectArgs?.source, "source").trim();
        // A local directory (or an already-installed plugin's root) can be read
        // here and now. A remote source is reported as itself with no manifest:
        // fetching one would mean cloning, and inspecting must never be the
        // step that puts code on the machine.
        const local = readManifestFromDirectory(source);
        return { source, manifest: local };
      },

      async setContributionEnabled(contributionArgs): Promise<PluginSummary> {
        const pluginId = requireId(contributionArgs?.pluginId, "pluginId");
        const socketId = requireId(contributionArgs?.socketId, "socketId");
        requireInstalled(pluginId);
        const installed = installs.setContributionEnabled(
          pluginId,
          socketId,
          contributionArgs.enabled !== false,
        );
        return toSummary(installed, runtimeStateFor(installed));
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
        // old values until it is replaced. `reconcile` then brings it back with
        // the values the user just typed — a plugin that stayed stopped after a
        // settings change would read as the change having broken it.
        await stopSupervisor(pluginId);
        reconcile();
        return detailFor(requireInstalled(pluginId));
      },

      async install(installArgs) {
        // The stop-before-rename that used to live here only ever worked for a
        // local-directory source, because that was the only kind whose plugin
        // id `pluginHostService` could learn before `installs.install` ran —
        // a git source reveals its id only after cloning. `installs.install`
        // now runs the same stop for every source kind itself, through
        // `beforeReplace` (wired below), between parsing the manifest and
        // renaming the directory into place.
        let installed: PluginInstalledPlugin;
        try {
          installed = await installs.install(installArgs);
        } catch (error) {
          // A failed install (bad manifest, unsupported ADE version, checksum
          // mismatch) can still have stopped the plugin's OLD child via
          // `beforeReplace` before it failed. Reconcile so a plugin that
          // failed to upgrade comes back up on whatever code is still on disk
          // rather than sitting stopped with nothing to explain why.
          reconcile();
          throw error;
        }
        // Unconditional, not "only if this install learned a different id than
        // it stopped before renaming": a supervisor for the installed id must
        // not survive past this point regardless of how it got here — whether
        // `beforeReplace` already stopped it, or a concurrent call (another
        // `invoke`, another `reconcile`) resurrected one in the window while
        // this install was staging. `stopSupervisor` is a no-op if none runs.
        await stopSupervisor(installed.record.pluginId);
        return applyInstallChange(installed, { replacePanelsFor: installed.record.pluginId });
      },

      async uninstall(uninstallArgs) {
        await stopSupervisor(uninstallArgs.pluginId);
        const result = installs.uninstall(uninstallArgs.pluginId);
        await cleanupUninstalledPluginData(uninstallArgs.pluginId);
        publishPresence();
        return result;
      },

      async enable(enableArgs) {
        return applyInstallChange(installs.setEnabled(enableArgs.pluginId, true));
      },

      async disable(disableArgs) {
        return applyInstallChange(installs.setEnabled(disableArgs.pluginId, false));
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
        await stopSupervisor(reloadArgs.pluginId);
        const before = installs.get(reloadArgs.pluginId)?.record.version ?? null;
        const installed = installs.reload(reloadArgs.pluginId);
        // The point of a reload is to run what is on disk NOW, panels included:
        // `ade plugin dev` edits a panel schema and expects the surface to
        // follow, so the declared schema replaces what the last run published.
        reconcile({ replacePanelsFor: reloadArgs.pluginId });
        // Only a version change is news for presence; the `ade plugin dev` loop
        // reloads constantly and republishing every time would be pure noise.
        if (installed.record.version !== before) publishPresence();
        return toSummary(installed, runtimeStateFor(installed));
      },
    };
  };

  /**
   * Install changes, delivered to running plugins as `sdk.events`.
   *
   * `events.on` is part of the documented SDK surface and the child already
   * dispatches `event` frames — nothing ever SENT one, so every listener a
   * plugin registered was dead. Coalesced because an install emits per plugin
   * and a `plugin install` of a package that replaces another produces a burst;
   * a plugin wants "the install set moved, re-read it", not one wake per row.
   */
  const PLUGIN_EVENT_COALESCE_MS = 250;
  /** Ids one payload carries. Past this the plugin should re-read the roster. */
  const PLUGIN_EVENT_MAX_IDS = 50;
  const pendingInstallIds = new Set<string>();
  let installEventTimer: ReturnType<typeof setTimeout> | null = null;

  const flushInstallEvent = (): void => {
    installEventTimer = null;
    const pending = [...pendingInstallIds];
    // Truncating silently used to mean a plugin that read only `ids` never
    // learned about the rest of a burst past the cap — the truncation was
    // invisible on the wire. `overflow` says so explicitly, so a listener
    // that only trusts `ids` at least knows it is trusting a partial list.
    const overflow = pending.length > PLUGIN_EVENT_MAX_IDS;
    const ids = pending.slice(0, PLUGIN_EVENT_MAX_IDS);
    pendingInstallIds.clear();
    for (const [pluginId, supervisor] of supervisors) {
      // Only a running child has an open stdin; `send` refuses the rest, and
      // one that is still starting reads its state at activation anyway.
      if (supervisor.status() !== "running") continue;
      supervisor.send({
        type: "event",
        payload: {
          event: "install.changed",
          ids,
          projectId: resolveProject(pluginId)?.binding.projectId ?? null,
          ...(overflow ? { overflow: true as const } : {}),
        },
      });
    }
  };

  const unsubscribePluginChanges = subscribeToPluginChanges((event) => {
    if (disposed) return;
    // A child that just (re)started has forgotten every listener it registered
    // and will register them again from `activate`. Dropping the host's copy
    // here is what keeps a crash-restart loop from leaving a plugin subscribed
    // to hooks its new process has no listener for — deliveries nobody reads,
    // charged to every turn on the machine.
    if (event.kind === "status" && event.pluginId && event.status !== "running") {
      hookSubscriptions.delete(event.pluginId);
      hookQueues.delete(event.pluginId);
      return;
    }
    if (event.kind !== "installs") return;
    if (event.pluginId) pendingInstallIds.add(event.pluginId);
    if (installEventTimer) return;
    installEventTimer = setTimeout(flushInstallEvent, PLUGIN_EVENT_COALESCE_MS);
    installEventTimer.unref?.();
  });

  /**
   * Runtime hooks (`turn.start`, `turn.end`, `tool.before`), delivered to the
   * children that asked for them.
   *
   * Three properties, and every one of them is a requirement rather than a
   * tuning choice:
   *
   * 1. **Only to subscribers.** `tool.before` fires dozens of times in a single
   *    turn, and a machine can run several turns at once. Broadcasting them the
   *    way install events are broadcast would charge every running plugin one
   *    NDJSON line per tool call in every chat, to feed listeners that mostly
   *    do not exist. `events.subscribe` is what the child sends when
   *    `ade.events.on` registers the first listener for a kind, and a plugin
   *    that never asks is never written to.
   * 2. **Off the emitter's stack.** The bus is called from inside the chat
   *    service's commit path. Queueing here and writing on a later tick means
   *    the turn loop never pays for a `stdin.write`, however many children are
   *    running.
   * 3. **Drops, never backpressures.** A child that has stopped reading its
   *    stdin — wedged in a synchronous loop, stopped at a debugger — would
   *    otherwise grow the pipe's buffer without limit, because `write` keeps
   *    accepting data long after the far end stopped taking it. Past
   *    {@link PLUGIN_RUNTIME_HOOK_QUEUE_MAX} queued frames, or on the first
   *    `write` that reports the buffer full, this plugin's queue is discarded
   *    and the count logged. Losing a plugin's telemetry is the correct trade
   *    against holding the user's turns hostage to it, and observe-only is
   *    exactly the tier where that trade is safe to make.
   */
  const PLUGIN_RUNTIME_HOOK_QUEUE_MAX = 256;
  /** Per plugin: which hook kinds its current child registered a listener for. */
  const hookSubscriptions = new Map<string, Set<PluginRuntimeHookName>>();
  const hookQueues = new Map<string, { frames: PluginRuntimeHookPayload[]; dropped: number }>();
  let hookFlushTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Record what a child listens for.
   *
   * Handled in the host rather than in `pluginSdkServer` because the answer is
   * fan-out state — it belongs beside the queue that reads it, not beside the
   * collections and secrets the SDK server owns. An unknown event name is
   * refused rather than ignored: a plugin that typo'd a kind would otherwise
   * subscribe successfully and wait forever for an event that does not exist.
   */
  const applyEventSubscription = (pluginId: string, params: Record<string, unknown>): null => {
    const event = params.event;
    if (!isPluginEventName(event)) {
      throw new PluginSdkError("invalid_args", `Unknown event name: ${String(event)}`);
    }
    // The change events are broadcast to every running child and always have
    // been; recording them costs nothing and keeps the child's `events.on` free
    // of a per-kind special case, but only the hooks are filtered on the way
    // out. Narrowing the change events to subscribers would be a behaviour
    // change for shipped plugins, and it is not this one.
    if (!isPluginRuntimeHookName(event)) return null;
    const subscribed = params.subscribed !== false;
    const existing = hookSubscriptions.get(pluginId);
    if (subscribed) {
      if (existing) existing.add(event);
      else hookSubscriptions.set(pluginId, new Set<PluginRuntimeHookName>([event]));
      return null;
    }
    if (!existing) return null;
    existing.delete(event);
    if (!existing.size) hookSubscriptions.delete(pluginId);
    return null;
  };

  const flushRuntimeHooks = (): void => {
    hookFlushTimer = null;
    for (const [pluginId, queue] of [...hookQueues]) {
      hookQueues.delete(pluginId);
      const supervisor = supervisors.get(pluginId);
      // No child to tell. Not a drop worth logging: the plugin was not running,
      // so nothing it asked for was lost — it never saw the turn at all.
      if (!supervisor || supervisor.status() !== "running") continue;
      for (let index = 0; index < queue.frames.length; index += 1) {
        if (supervisor.send({ type: "event", payload: queue.frames[index]! })) continue;
        // `write` returned false: the child is not draining. Stop here rather
        // than queueing more into a buffer nobody is emptying. THIS frame was
        // accepted into that buffer and will arrive if the child ever reads
        // again, so the drop count starts after it — an over-reported count in
        // this log would send whoever reads it looking for a bug that is not
        // there.
        queue.dropped += queue.frames.length - index - 1;
        break;
      }
      if (queue.dropped > 0) {
        logger.warn("plugin.runtime_hooks_dropped", { pluginId, dropped: queue.dropped });
      }
    }
  };

  const queueRuntimeHook = (pluginId: string, payload: PluginRuntimeHookPayload): void => {
    let queue = hookQueues.get(pluginId);
    if (!queue) {
      queue = { frames: [], dropped: 0 };
      hookQueues.set(pluginId, queue);
    }
    if (queue.frames.length >= PLUGIN_RUNTIME_HOOK_QUEUE_MAX) {
      queue.dropped += 1;
      return;
    }
    queue.frames.push(payload);
    if (hookFlushTimer) return;
    hookFlushTimer = setTimeout(flushRuntimeHooks, 0);
    hookFlushTimer.unref?.();
  };

  /**
   * The turn's project, as the plugin surface spells it.
   *
   * Resolved from the checkout the chat service reported against this host's
   * own bindings, because those are the two ends of the same fact and only the
   * host holds both. A turn in a project nothing is bound to answers null
   * rather than borrowing whichever project the plugin happens to be scoped to
   * — a hook that named the wrong project would be worse than one that named
   * none.
   */
  const projectIdForRoot = (projectRoot: string | null): string | null => {
    if (!projectRoot) return null;
    for (const attached of projects.values()) {
      if (attached.binding.projectRoot === projectRoot) return attached.binding.projectId;
    }
    return null;
  };

  const toRuntimeHookPayload = (
    emission: PluginRuntimeHookEmission,
    projectId: string | null,
  ): PluginRuntimeHookPayload | null => {
    const base = { sessionId: emission.sessionId, projectId, runtime: emission.runtime };
    switch (emission.event) {
      case "turn.start":
        return { ...base, event: "turn.start", ...(emission.model ? { model: emission.model } : {}) };
      case "turn.end":
        return {
          ...base,
          event: "turn.end",
          outcome: emission.outcome ?? "completed",
          ...(emission.durationMs != null ? { durationMs: emission.durationMs } : {}),
        };
      case "tool.before":
        return emission.toolName
          ? { ...base, event: "tool.before", toolName: emission.toolName }
          : null;
    }
  };

  const unsubscribeRuntimeHooks = subscribeToPluginRuntimeHooks((emission) => {
    if (disposed || !hookSubscriptions.size) return;
    let payload: PluginRuntimeHookPayload | null = null;
    for (const [pluginId, kinds] of hookSubscriptions) {
      if (!kinds.has(emission.event)) continue;
      // Built once, on the first interested plugin, and never at all when none
      // is — the common case for `tool.before` on a machine whose plugins only
      // watch turn boundaries.
      payload ??= toRuntimeHookPayload(emission, projectIdForRoot(emission.projectRoot));
      if (!payload) return;
      queueRuntimeHook(pluginId, payload);
    }
  });

  const storeFor = (binding: PluginProjectBinding): PluginDataStore => createPluginDataStore({
    db: binding.db,
    ...(binding.onPluginDataChanged ? { onCollectionChanged: binding.onPluginDataChanged } : {}),
  });

  return {
    setMachineContext(context) {
      machine = { ...machine, ...context };
    },

    attachProject(binding) {
      const existing = projects.get(binding.projectId);
      if (existing) {
        existing.attachCount += 1;
        // Rebind: a project reopened after a runtime restart carries a new db
        // handle, and holding the closed one would throw on the next write.
        existing.binding = binding;
        existing.data = storeFor(binding);
      } else {
        projects.set(binding.projectId, {
          binding,
          data: storeFor(binding),
          attachCount: 1,
        });
      }
      // The first project to bind is what makes plugin data writable at all, so
      // this is where enabled plugins start and declared panels materialize.
      // Both are idempotent, so a second project binding costs a no-op pass.
      reconcile();
      return { detach: () => detachProject(binding.projectId) };
    },
    domainService,
    rootFor(pluginId) {
      const installed = installs.get(pluginId);
      if (!installed || !installed.record.enabled) return null;
      return installed.root;
    },
    writeCollection({ pluginId, collection, key, value }) {
      const installed = requireInstalled(pluginId);
      if (!installed.record.enabled) {
        throw new PluginSdkError("plugin_disabled", `Plugin "${pluginId}" is disabled.`);
      }
      const declared = installed.manifest?.collections ?? {};
      if (!Object.prototype.hasOwnProperty.call(declared, assertPluginCollectionName(collection))) {
        throw new PluginSdkError(
          "not_permitted",
          `Collection "${collection}" is not declared in ${pluginId}'s manifest.`,
        );
      }
      // The data store re-encodes and re-checks every budget inside its own
      // transaction — that check is the guarantee, and this path deliberately
      // adds none of its own so a page and a child cannot be held to different
      // ceilings for the same row.
      requireProject(pluginId).data.putCollection(
        pluginId,
        collection,
        assertPluginCollectionKey(key),
        value,
      );
    },
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
      unsubscribePluginChanges();
      unsubscribeRuntimeHooks();
      if (installEventTimer) {
        clearTimeout(installEventTimer);
        installEventTimer = null;
      }
      if (hookFlushTimer) {
        clearTimeout(hookFlushTimer);
        hookFlushTimer = null;
      }
      hookSubscriptions.clear();
      hookQueues.clear();
      setPluginInstallService(null);
      setPluginActionInvoker(null);
      // Before the children go: a timer that fired during teardown would call
      // `invoke` on a supervisor map that is about to be cleared, and start a
      // child the host has no way left to stop.
      schedules.dispose();
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
export function getSharedPluginHostService(args: PluginHostServiceArgs): PluginHostService {
  if (!sharedHost) sharedHost = createHost(args);
  return sharedHost;
}

/**
 * Tear the machine-scoped host down: every child is asked to stop (so a
 * plugin's `deactivate` actually runs) before the process goes away.
 *
 * The daemon's own shutdown path calls this alongside the other machine-scoped
 * singletons; tests call it between cases.
 */
export async function disposeSharedPluginHostService(): Promise<void> {
  const host = sharedHost;
  sharedHost = null;
  await host?.dispose();
}
