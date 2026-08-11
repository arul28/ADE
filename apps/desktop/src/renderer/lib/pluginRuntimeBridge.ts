/**
 * The renderer's view of `window.ade.plugins.*`.
 *
 * Wave A owns the preload namespace itself. This module owns the *shape* the UI
 * codes against, declared locally so the renderer compiles and degrades before
 * that namespace exists, and so the plugin surfaces have one place to look when
 * the contract moves.
 *
 * Two rules from the desktop recon are enforced here rather than at each call
 * site:
 *
 * - **Every call is optional-chained.** A missing namespace is the normal state
 *   on an older host and in the hosted web client, and it must read as "no
 *   plugins" rather than a thrown renderer error. `window.ade.plugins` may also
 *   be a null service while a project transition is in flight.
 * - **Read and write are separated.** `plugin.invoke` is MUTATING (design
 *   decision D19) and therefore throws during a project transition; the read
 *   calls do not. Callers that must not fail on a transition use the readers.
 */

import type { PluginThemeTokens } from "./pluginTheme";

/** Child-process health, as reported by the plugin host. */
export type PluginRuntimeStatus = "running" | "starting" | "stopped" | "crashed" | "none";

/** One `{"kind":"tab"}` surface from a plugin's manifest. */
export type PluginTabDescriptor = {
  id: string;
  title: string;
  panelId: string;
  /** Phosphor icon name; resolved through `pluginIcons.ts`, never rendered raw. */
  icon?: string | null;
  /**
   * Names a compiled-in tab this surface gates rather than renders — see
   * `PLUGIN_BUILTIN_SURFACE_IDS` in `shared/plugins/manifest.ts`. Absent on
   * every ordinary plugin tab, and absent from a host too old to report it, so
   * `builtinTabs.ts` treats its absence as "not a gate" and never as "hidden".
   */
  builtin?: string | null;
};

export type InstalledPlugin = {
  pluginId: string;
  displayName: string;
  version: string;
  enabled: boolean;
  icon: string | null;
  /** Hex accent from the manifest. Applied as a CSS variable, never inlined as a class. */
  accent: string | null;
  status: PluginRuntimeStatus;
  tabs: PluginTabDescriptor[];
  /** Present only for theme plugins. */
  theme: { displayName: string; tokens: PluginThemeTokens } | null;
  /**
   * Manifest socket ids the user has switched off. Absent means none are —
   * which is why it is a list of what is OFF: a plugin's contributions are on
   * by default, and an absent field must not read as "everything is disabled".
   */
  disabledContributions?: readonly string[];
  /** Drives the nav dot. Off unless the plugin asks for attention. */
  attention?: boolean;
};

export type PluginPanelRecord = {
  pluginId: string;
  panelId: string;
  title: string | null;
  /** Opaque versioned JSON — parsed by `shared/plugins/vocabulary.ts`, never here. */
  schema: unknown;
  vocabVersion: number;
  updatedAt: string | null;
};

export type PluginCollectionRow = {
  key: string;
  value: unknown;
};

/** What changed, so a subscriber can decide whether it needs to refetch. */
export type PluginChangeEvent = {
  /**
   * Mirrors `main/services/plugins/pluginEvents.ts`'s `PluginChangeKind`.
   *
   * The daemon may send a kind this build has never heard of — the union is
   * open in practice and grows without a renderer release. Consumers must treat
   * an unrecognized kind as "refetch everything for this plugin" rather than
   * dropping it, which is what `pluginChangeAffects` in the socket module does.
   */
  kind: "installs" | "panels" | "collections" | "contributions" | "status";
  pluginId?: string;
  panelId?: string;
  collection?: string;
};

/* ── Marketplace ────────────────────────────────────────────────────────────
 *
 * Everything below this line is the Marketplace's half of the contract. It is
 * separated because the two halves fail differently: a host with no directory
 * access still runs its installed plugins perfectly well, so a missing
 * marketplace member is "browsing is unavailable", not "plugins are broken".
 * The readers therefore return empty/null rather than throwing, and the UI asks
 * the capability probes below what it is allowed to offer instead of finding
 * out by pressing a button.
 */

/** One entry as the directory publishes it. Shape-checked in `marketplaceModel`. */
export type MarketplaceIndexPayload = {
  entries: unknown[];
  /** When the index was fetched. Null when it came from a cold cache. */
  fetchedAt: string | null;
  /** Whether these bytes came off the network or out of the etag cache. */
  origin: "network" | "cache";
};

/** A plugin's install state on one machine in the account. */
export type PluginPresenceRow = {
  machineKey: string;
  machineName: string;
  pluginId: string;
  version: string | null;
  enabled: boolean;
  /** False for a machine that is in the directory but not reachable now. */
  online: boolean;
  /**
   * Set by the host on rows for the machine this renderer runs on. The renderer
   * cannot work this out from the rows alone, and guessing wrong shows someone
   * another machine's install state as their own.
   */
  isThisMachine: boolean;
};

/** Storage and wire usage for one plugin, against its writer-enforced budget. */
export type PluginUsageRow = {
  pluginId: string;
  collectionBytes: number;
  collectionBudgetBytes: number;
  rows: number;
  rowBudget: number;
  /** Bytes this plugin put on the sync wire in the last 24h, when metered. */
  /** Cumulative sync bytes attributed to this plugin. Null when unmetered. */
  syncBytesTotal: number | null;
};

export type PluginInstallRequest = {
  /** Git URL or directory path. The one field an install always has. */
  source: string;
  /** Known ahead of time for a directory entry; absent for install-from-URL. */
  pluginId?: string;
  version?: string;
  /** Install on another machine instead of this one. */
  machineKey?: string;
};

export type PluginInstallResult = {
  pluginId: string;
  version: string;
  displayName: string;
};

/** What the host learned by reading a source before installing it. */
export type PluginSourceInspection = {
  source: string;
  /** Raw manifest object — parsed by `shared/plugins/manifest.ts`, never here. */
  manifest: unknown;
};

type PluginBridge = {
  list?: () => Promise<InstalledPlugin[]>;
  getPanel?: (input: { pluginId: string; panelId: string }) => Promise<PluginPanelRecord | null>;
  getCollection?: (input: {
    pluginId: string;
    collection: string;
    keyPrefix?: string;
    limit?: number;
  }) => Promise<PluginCollectionRow[]>;
  invoke?: (input: {
    pluginId: string;
    action: string;
    args?: Record<string, unknown>;
  }) => Promise<unknown>;
  restart?: (input: { pluginId: string }) => Promise<void>;
  openLogs?: (input: { pluginId: string }) => Promise<void>;
  onChanged?: (listener: (event: PluginChangeEvent) => void) => (() => void) | void;

  /* Marketplace — every member optional; see the block comment above. */
  marketplaceIndex?: (input?: { refresh?: boolean }) => Promise<MarketplaceIndexPayload | null>;
  inspectSource?: (input: { source: string }) => Promise<PluginSourceInspection | null>;
  install?: (input: PluginInstallRequest) => Promise<PluginInstallResult>;
  uninstall?: (input: { pluginId: string; machineKey?: string }) => Promise<unknown>;
  setEnabled?: (input: { pluginId: string; enabled: boolean; machineKey?: string }) => Promise<void>;
  /** The host's split form of `setEnabled`; either pair satisfies the UI. */
  enable?: (input: { pluginId: string }) => Promise<unknown>;
  disable?: (input: { pluginId: string }) => Promise<unknown>;
  /** Re-read the manifest and restart the child; the host's form of `restart`. */
  reload?: (input: { pluginId: string }) => Promise<unknown>;
  presence?: () => Promise<PluginPresenceRow[]>;
  /**
   * Usage, in either the flat per-plugin form or the host's
   * `{entries, budgets}` rollup. {@link readPluginUsage} normalizes both, so
   * neither side has to move first.
   */
  usageSummary?: (input?: { pluginId?: string }) => Promise<unknown>;
  getManifest?: (input: { pluginId: string }) => Promise<unknown | null>;
  /** Full detail record; the fallback source for manifest, config and readme. */
  get?: (input: { pluginId: string }) => Promise<unknown | null>;
  getReadme?: (input: { pluginId: string }) => Promise<string | null>;
  getConfig?: (input: { pluginId: string }) => Promise<Record<string, unknown>>;
  /**
   * A PATCH over the plugin's settings — keys absent from `values` keep what
   * they had. The UI writes one key at a time; the patch shape is the host's,
   * and matching it exactly matters more than convenience here, because a
   * mis-shaped argument to a structurally-typed IPC call does not fail, it
   * silently saves nothing.
   */
  setConfig?: (input: {
    pluginId: string;
    values: Record<string, string | number | boolean | null>;
  }) => Promise<unknown>;
  setContributionEnabled?: (input: {
    pluginId: string;
    socketId: string;
    enabled: boolean;
  }) => Promise<void>;
};

function bridge(): PluginBridge | null {
  if (typeof window === "undefined") return null;
  // The preload namespace is `plugin` (it mirrors the single `plugin` action
  // domain, D1). `plugins` is accepted as well so this module keeps working
  // either way rather than silently reporting "no plugin support" — the failure
  // mode of a name mismatch here is an entire UI that renders empty states and
  // never says why.
  //
  // Read through `unknown` deliberately. The host's own declared type is the
  // full contract; this module's type is the SUBSET the UI depends on, every
  // member optional, so the renderer keeps compiling against a host that has
  // fewer of them. Structurally asserting one onto the other would couple the
  // two and defeat that.
  const ade = (window as unknown as { ade?: Record<string, unknown> }).ade;
  return ((ade?.plugin ?? ade?.plugins) as PluginBridge | null | undefined) ?? null;
}

/** True when this host exposes a plugin surface at all. */
export function pluginsAvailable(): boolean {
  return bridge() !== null;
}

/** Installed plugins on this machine. Empty on a host with no plugin support. */
export async function listInstalledPlugins(): Promise<InstalledPlugin[]> {
  const plugins = bridge()?.list;
  if (!plugins) return [];
  try {
    const result = await plugins();
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

export async function readPluginPanel(
  pluginId: string,
  panelId: string,
): Promise<PluginPanelRecord | null> {
  const getPanel = bridge()?.getPanel;
  if (!getPanel) return null;
  return (await getPanel({ pluginId, panelId })) ?? null;
}

export async function readPluginCollection(
  pluginId: string,
  collection: string,
  options: { keyPrefix?: string; limit?: number } = {},
): Promise<PluginCollectionRow[]> {
  const getCollection = bridge()?.getCollection;
  if (!getCollection) return [];
  const result = await getCollection({ pluginId, collection, ...options });
  return Array.isArray(result) ? result : [];
}

/**
 * Dispatch a plugin action. MUTATING — this is the one call in the module that
 * is expected to reject, and callers surface the rejection rather than swallow
 * it: a button that silently does nothing is the failure mode this contract
 * exists to avoid.
 */
export async function invokePluginAction(
  pluginId: string,
  action: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  const invoke = bridge()?.invoke;
  if (!invoke) throw new Error("This build has no plugin support.");
  return invoke({ pluginId, action, ...(args ? { args } : {}) });
}

export async function restartPlugin(pluginId: string): Promise<void> {
  const plugins = bridge();
  // `reload` is the host's name for the same operation — re-read the manifest
  // and restart the child.
  const restart = plugins?.restart ?? plugins?.reload;
  if (!restart) throw new Error("This build has no plugin support.");
  await restart({ pluginId });
}

export async function openPluginLogs(pluginId: string): Promise<void> {
  const openLogs = bridge()?.openLogs;
  if (!openLogs) throw new Error("This build has no plugin support.");
  await openLogs({ pluginId });
}

/* ── Marketplace calls ──────────────────────────────────────────────────── */

/** What this host lets the Marketplace offer. Read once per render, not per button. */
export type PluginMarketplaceCapabilities = {
  /** The directory can be fetched. False → the bundled index is all there is. */
  browse: boolean;
  install: boolean;
  uninstall: boolean;
  enable: boolean;
  /** Presence for other machines is published. False → single-machine view. */
  machines: boolean;
  /** Installing/enabling on a machine other than this one. */
  remoteInstall: boolean;
  config: boolean;
  contributions: boolean;
  usage: boolean;
  /** A source can be read before installing, so the modal can list what it adds. */
  inspect: boolean;
};

export function pluginMarketplaceCapabilities(): PluginMarketplaceCapabilities {
  const plugins = bridge();
  return {
    browse: typeof plugins?.marketplaceIndex === "function",
    install: typeof plugins?.install === "function",
    uninstall: typeof plugins?.uninstall === "function",
    enable: typeof plugins?.setEnabled === "function"
      || (typeof plugins?.enable === "function" && typeof plugins?.disable === "function"),
    machines: typeof plugins?.presence === "function",
    // Remote install rides the same two calls; the host decides per machine
    // whether it is permitted, and rejects if not.
    remoteInstall: typeof plugins?.install === "function" && typeof plugins?.presence === "function",
    config: typeof plugins?.getConfig === "function"
      || typeof plugins?.get === "function"
      || typeof plugins?.invoke === "function",
    contributions: typeof plugins?.setContributionEnabled === "function",
    usage: typeof plugins?.usageSummary === "function",
    inspect: typeof plugins?.inspectSource === "function",
  };
}

/**
 * Fetch the plugin directory.
 *
 * Returns null — not an empty index — when the directory could not be read, so
 * the Marketplace can say "showing the built-in list, refresh unavailable"
 * instead of "there are no plugins", which would be a lie.
 */
export async function fetchMarketplaceIndex(
  options: { refresh?: boolean } = {},
): Promise<MarketplaceIndexPayload | null> {
  const marketplaceIndex = bridge()?.marketplaceIndex;
  if (!marketplaceIndex) return null;
  try {
    const result = await marketplaceIndex(options.refresh ? { refresh: true } : {});
    if (!result || !Array.isArray(result.entries)) return null;
    return result;
  } catch {
    return null;
  }
}

/** Read a source's manifest before installing it. Null when unsupported. */
export async function inspectPluginSource(source: string): Promise<PluginSourceInspection | null> {
  const inspectSource = bridge()?.inspectSource;
  if (!inspectSource) return null;
  return (await inspectSource({ source })) ?? null;
}

/** MUTATING. Rejects loudly — an install that silently does nothing is the failure to avoid. */
export async function installPlugin(request: PluginInstallRequest): Promise<PluginInstallResult> {
  const install = bridge()?.install;
  if (!install) throw new Error("This build can’t install plugins.");
  return install(request);
}

export async function uninstallPlugin(pluginId: string, machineKey?: string): Promise<void> {
  const uninstall = bridge()?.uninstall;
  if (!uninstall) throw new Error("This build can’t remove plugins.");
  await uninstall({ pluginId, ...(machineKey ? { machineKey } : {}) });
}

export async function setPluginEnabled(
  pluginId: string,
  enabled: boolean,
  machineKey?: string,
): Promise<void> {
  const plugins = bridge();
  if (plugins?.setEnabled) {
    await plugins.setEnabled({ pluginId, enabled, ...(machineKey ? { machineKey } : {}) });
    return;
  }
  // The split `enable`/`disable` pair is machine-local by construction. Failing
  // loudly for a remote machine is the point: quietly toggling the plugin HERE
  // when the reader pressed the button on another machine's row is the worst
  // available outcome.
  if (machineKey) throw new Error("This build can only turn plugins on or off on this machine.");
  const call = enabled ? plugins?.enable : plugins?.disable;
  if (!call) throw new Error("This build can’t turn plugins on or off.");
  await call({ pluginId });
}

/** Per-machine install state. Empty on a host that publishes no presence. */
export async function readPluginPresence(): Promise<PluginPresenceRow[]> {
  const presence = bridge()?.presence;
  if (!presence) return [];
  try {
    const rows = await presence();
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/**
 * Usage rows, from whichever shape the host publishes.
 *
 * The host's rollup carries budgets once, beside a list of per-plugin counts;
 * the UI wants used-and-budget together per plugin. Folding the two here rather
 * than in the rail means the meter has one shape to render and the host is free
 * to keep its own.
 */
export async function readPluginUsage(pluginId?: string): Promise<PluginUsageRow[]> {
  const usageSummary = bridge()?.usageSummary;
  if (!usageSummary) return [];
  try {
    const result = await usageSummary(pluginId ? { pluginId } : {});
    if (Array.isArray(result)) return result as PluginUsageRow[];
    if (!result || typeof result !== "object") return [];
    const rollup = result as {
      entries?: unknown;
      budgets?: { collectionBytesPerPlugin?: number; collectionRowsPerPlugin?: number };
    };
    if (!Array.isArray(rollup.entries)) return [];
    const collectionBudgetBytes = rollup.budgets?.collectionBytesPerPlugin ?? 0;
    const rowBudget = rollup.budgets?.collectionRowsPerPlugin ?? 0;
    return rollup.entries.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const row = entry as {
        pluginId?: unknown;
        collectionBytes?: unknown;
        collectionRows?: unknown;
        syncBytesOut?: unknown;
        syncBytesIn?: unknown;
      };
      if (typeof row.pluginId !== "string") return [];
      const syncOut = typeof row.syncBytesOut === "number" ? row.syncBytesOut : null;
      const syncIn = typeof row.syncBytesIn === "number" ? row.syncBytesIn : null;
      return [{
        pluginId: row.pluginId,
        collectionBytes: typeof row.collectionBytes === "number" ? row.collectionBytes : 0,
        collectionBudgetBytes,
        rows: typeof row.collectionRows === "number" ? row.collectionRows : 0,
        rowBudget,
        syncBytesTotal: syncOut === null && syncIn === null ? null : (syncOut ?? 0) + (syncIn ?? 0),
      }];
    });
  } catch {
    return [];
  }
}

/** The installed manifest, still unparsed. Null when absent or unreadable. */
export async function readPluginManifest(pluginId: string): Promise<unknown | null> {
  const plugins = bridge();
  try {
    if (plugins?.getManifest) return (await plugins.getManifest({ pluginId })) ?? null;
    if (plugins?.get) {
      const detail = await plugins.get({ pluginId });
      if (detail && typeof detail === "object") {
        return (detail as { manifest?: unknown }).manifest ?? null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export async function readPluginReadme(pluginId: string): Promise<string | null> {
  const getReadme = bridge()?.getReadme;
  if (!getReadme) return null;
  try {
    const text = await getReadme({ pluginId });
    return typeof text === "string" && text.trim().length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * A plugin's settings values.
 *
 * Prefers the host's own accessor and falls back to the plugin's reserved
 * `config.get` action, so config still works on a host that routes everything
 * through the action domain. Read-only, so it degrades to `{}` rather than
 * throwing.
 */
export async function readPluginConfig(pluginId: string): Promise<Record<string, unknown>> {
  const plugins = bridge();
  try {
    if (plugins?.getConfig) {
      const values = await plugins.getConfig({ pluginId });
      return values && typeof values === "object" ? (values as Record<string, unknown>) : {};
    }
    if (plugins?.get) {
      const detail = await plugins.get({ pluginId });
      const config = detail && typeof detail === "object"
        ? (detail as { config?: unknown }).config
        : null;
      if (config && typeof config === "object") return config as Record<string, unknown>;
      return {};
    }
    if (plugins?.invoke) {
      const values = await plugins.invoke({ pluginId, action: "config.get" });
      return values && typeof values === "object" ? (values as Record<string, unknown>) : {};
    }
  } catch {
    return {};
  }
  return {};
}

/** MUTATING, and deliberately loud: settings that look saved but are not are worse than an error. */
export async function writePluginConfig(
  pluginId: string,
  key: string,
  value: string | number | boolean | null,
): Promise<void> {
  const plugins = bridge();
  if (plugins?.setConfig) {
    await plugins.setConfig({ pluginId, values: { [key]: value } });
    return;
  }
  if (plugins?.invoke) {
    await plugins.invoke({ pluginId, action: "config.set", args: { key, value } });
    return;
  }
  throw new Error("This build can’t save plugin settings.");
}

export async function setPluginContributionEnabled(
  pluginId: string,
  socketId: string,
  enabled: boolean,
): Promise<void> {
  const setContributionEnabled = bridge()?.setContributionEnabled;
  if (!setContributionEnabled) throw new Error("This build can’t change what a plugin adds.");
  await setContributionEnabled({ pluginId, socketId, enabled });
}

/**
 * Subscribe to host-side plugin changes. Returns an unsubscribe function that is
 * always safe to call, including when the host published no subscription at all.
 */
export function subscribeToPluginChanges(
  listener: (event: PluginChangeEvent) => void,
): () => void {
  const onChanged = bridge()?.onChanged;
  if (!onChanged) return () => {};
  try {
    const dispose = onChanged(listener);
    return typeof dispose === "function" ? dispose : () => {};
  } catch {
    return () => {};
  }
}
