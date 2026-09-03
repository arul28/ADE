/**
 * The renderer's view of `window.ade.plugins.*`.
 *
 * Wave A owns the preload namespace itself. This module owns the UI's ACCESS to
 * it — one place that reads the namespace, degrades when it is absent, and says
 * what this host is allowed to offer. The shapes themselves live in
 * `shared/plugins/sdk.ts` and are re-exported below under the names the UI uses.
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

import { isPluginsUnavailable } from "../../shared/plugins/sdk";
import type { PluginEntityKind, PluginSurfaceId } from "../../shared/plugins/sockets";

/**
 * The wire shapes live in `shared/plugins/sdk.ts` and are re-exported here under
 * the names the UI has always used. Declaring them here was what forced the
 * PRELOAD to import the renderer to describe its own namespace — a layering
 * inversion `contextBridge.exposeInMainWorld`'s `any` signature hid, so nothing
 * checked that what preload publishes matches what the UI calls.
 */
export type {
  PluginClientRuntimeStatus as PluginRuntimeStatus,
  PluginClientTabDescriptor as PluginTabDescriptor,
  PluginClientInstalled as InstalledPlugin,
  PluginClientCollectionRow as PluginCollectionRow,
  PluginClientChangeEvent as PluginChangeEvent,
  PluginPanelRecord,
} from "../../shared/plugins/sdk";

import type {
  PluginClientChangeEvent as PluginChangeEvent,
  PluginClientCollectionRow as PluginCollectionRow,
  PluginClientInstalled as InstalledPlugin,
  PluginPanelRecord,
} from "../../shared/plugins/sdk";

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

export type {
  PluginClientMarketplaceIndex as MarketplaceIndexPayload,
  PluginClientPresenceRow as PluginPresenceRow,
  PluginClientUsageRow as PluginUsageRow,
  PluginClientInstallRequest as PluginInstallRequest,
  PluginClientInstallResult as PluginInstallResult,
  PluginClientSourceInspection as PluginSourceInspection,
  PluginWebhookIngressStatus,
} from "../../shared/plugins/sdk";

import type {
  PluginWebhookIngressStatus,
  PluginClientInstallRequest as PluginInstallRequest,
  PluginClientInstallResult as PluginInstallResult,
  PluginClientMarketplaceIndex as MarketplaceIndexPayload,
  PluginClientPresenceRow as PluginPresenceRow,
  PluginClientSourceInspection as PluginSourceInspection,
  PluginClientUsageRow as PluginUsageRow,
} from "../../shared/plugins/sdk";

type PluginBridge = {
  list?: () => Promise<InstalledPlugin[]>;
  getPanel?: (input: { pluginId: string; panelId: string }) => Promise<PluginPanelRecord | null>;
  getCollection?: (input: {
    pluginId: string;
    /**
     * The panel whose schema binds this collection.
     *
     * Carried even though the desktop host reads collections by name and
     * ignores it: the web transport has no collection read at all and serves
     * these rows out of the panel snapshot it already holds, so the panel is
     * the only key that identifies WHICH rows were asked for. Optional in the
     * type because an older host publishes a bridge without it.
     */
    panelId?: string;
    collection: string;
    keyPrefix?: string;
    limit?: number;
  }) => Promise<PluginCollectionRow[]>;
  invoke?: (input: {
    pluginId: string;
    action: string;
    args?: Record<string, unknown>;
    /** Per-call round-trip budget. A host too old to read it ignores the key. */
    timeoutMs?: number;
  }) => Promise<unknown>;
  restart?: (input: { pluginId: string }) => Promise<void>;
  openLogs?: (input: { pluginId: string }) => Promise<void>;
  onChanged?: (listener: (event: PluginChangeEvent) => void) => (() => void) | void;

  /* Marketplace — every member optional; see the block comment above. */
  marketplaceIndex?: (input?: { refresh?: boolean }) => Promise<MarketplaceIndexPayload | null>;
  /** A repository's live star count. Null is "unknown", never zero stars. */
  repoStars?: (input: { repo: string }) => Promise<number | null>;
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
  /**
   * Webhook ingress health. Absent on a host that drains no webhooks, which is
   * a real answer and not a failure — see {@link readPluginWebhookIngress}.
   */
  webhookIngress?: (input?: { pluginId?: string }) => Promise<unknown>;
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
  /**
   * Host-joined dynamic contributions for one surface. Static manifest sockets
   * say a plugin CAN badge a lane; these rows say what it says about lane 7 now.
   */
  listContributions?: (input: {
    surface: string;
    entityKind?: string;
    entityIds?: string[];
  }) => Promise<unknown>;
  /**
   * Whether this host can install and enable on a machine OTHER than this one.
   *
   * A plain value the preload sets, not a shape probe. Inferring it from
   * `install` + `presence` being callable said "yes" on a host whose install
   * refuses every `machineKey` outright, so the Marketplace offered a button
   * that could only ever fail. Absent means the same as false — an older host
   * that does not publish it cannot be assumed to have the arm.
   */
  remoteInstall?: boolean;
};

function bridge(): PluginBridge | null {
  if (typeof window === "undefined") return null;
  // The preload namespace is `plugins`, PLURAL, and that is the only one any
  // ADE build publishes. The singular `plugin` is the RPC action DOMAIN, not a
  // window namespace; it is read here only as tolerance for a host that ever
  // published it, because the failure mode of a name mismatch is an entire UI
  // that renders empty states and never says why.
  //
  // Read through `unknown` deliberately. The host's own declared type is the
  // full contract; this module's type is the SUBSET the UI depends on, every
  // member optional, so the renderer keeps compiling against a host that has
  // fewer of them. Structurally asserting one onto the other would couple the
  // two and defeat that.
  const ade = (window as unknown as { ade?: Record<string, unknown> }).ade;
  return ((ade?.plugin ?? ade?.plugins) as PluginBridge | null | undefined) ?? null;
}

/**
 * Whether this host answers for plugins at all.
 *
 * Two ways it can be no, and both have to count. The namespace can be absent —
 * an older host, or the hosted web client. Or the namespace can be present and
 * the machine behind it have no plugin host, which is the desktop's normal state
 * before a project runtime binds: every call then answers the typed
 * `plugins_unavailable`. Reporting the second case as "available" is what put
 * install buttons on a machine-level Marketplace that could only ever fail.
 */
export function pluginsAvailable(): boolean {
  return bridge() !== null && !hostReportedUnavailable;
}

/**
 * Latched by the first typed `plugins_unavailable` any call answers with.
 *
 * A latch rather than a per-call flag because the capability probes are
 * synchronous — the UI asks what it may offer while rendering, and the only
 * evidence available by then is what an earlier call already learned. A
 * successful list clears it, so binding a runtime restores the buttons without
 * anyone having to remember to.
 */
let hostReportedUnavailable = false;

/** Note a typed unavailability and say whether that is what happened. */
function noteUnavailable(error: unknown): boolean {
  if (!isPluginsUnavailable(error)) return false;
  hostReportedUnavailable = true;
  return true;
}

/** Test seam, and the reset a surface makes when a project runtime binds. */
export function resetPluginBridgeAvailability(): void {
  hostReportedUnavailable = false;
}

/** Why a load produced no answer the registry may commit. */
export type InstalledPluginsLoadFailure =
  /** The host answered the typed `plugins_unavailable` — no plugin host yet. */
  | "unavailable"
  /** The call rejected, or answered something that is not a list. */
  | "error";

/**
 * One installed-plugins load, with "it failed" kept apart from "there are none".
 *
 * {@link listInstalledPlugins} collapses the two, which is right for a caller
 * asking one question about one plugin — a failed probe and an absent plugin
 * both mean "do not offer it". It is wrong for the REGISTRY: committing a
 * failed load as an empty registry showed "0 installed" in the Marketplace with
 * four plugins installed, and dropped the user's plugin theme to the built-in
 * palette, until an unrelated install event happened to force a re-fetch.
 */
export type InstalledPluginsLoad =
  | { ok: true; plugins: InstalledPlugin[] }
  | { ok: false; reason: InstalledPluginsLoadFailure };

/**
 * Installed plugins on this machine, or why the answer is not trustworthy.
 *
 * A host with no `plugins` namespace at all resolves as a confirmed EMPTY, not
 * a failure: an older host and the hosted web client publish no namespace and
 * never will within this session, so there is nothing a retry could reach, and
 * every plugin surface is already gated off by {@link pluginsAvailable}.
 */
export async function loadInstalledPlugins(): Promise<InstalledPluginsLoad> {
  const plugins = bridge()?.list;
  if (!plugins) return { ok: true, plugins: [] };
  try {
    const result = await plugins();
    if (!Array.isArray(result)) return { ok: false, reason: "error" };
    hostReportedUnavailable = false;
    return { ok: true, plugins: result };
  } catch (error) {
    return { ok: false, reason: noteUnavailable(error) ? "unavailable" : "error" };
  }
}

/** Installed plugins on this machine. Empty on a host with no plugin support. */
export async function listInstalledPlugins(): Promise<InstalledPlugin[]> {
  const load = await loadInstalledPlugins();
  return load.ok ? load.plugins : [];
}

export async function readPluginPanel(
  pluginId: string,
  panelId: string,
): Promise<PluginPanelRecord | null> {
  const getPanel = bridge()?.getPanel;
  if (!getPanel) return null;
  return (await getPanel({ pluginId, panelId })) ?? null;
}

/**
 * Rows of one collection, for one panel.
 *
 * `panelId` is required rather than optional, and it is required HERE rather
 * than only in the transport that needs it. Every caller reads a collection
 * because a panel's schema bound it, so the panel is always in hand; making it
 * a parameter is what stops a future caller from omitting the one key the web
 * transport has to answer by.
 */
export async function readPluginCollection(
  pluginId: string,
  panelId: string,
  collection: string,
  options: { keyPrefix?: string; limit?: number } = {},
): Promise<PluginCollectionRow[]> {
  const getCollection = bridge()?.getCollection;
  if (!getCollection) return [];
  const result = await getCollection({ pluginId, panelId, collection, ...options });
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
  options?: { timeoutMs?: number },
): Promise<unknown> {
  const invoke = bridge()?.invoke;
  if (!invoke) throw new Error("This build has no plugin support.");
  // `timeoutMs` rides beside `args`, never inside it — see `PluginDomainService`.
  // Omitted entirely when unset, so a host too old to read it receives byte-for
  // -byte what it always did rather than an extra key it has to decide about.
  return invoke({
    pluginId,
    action,
    ...(args ? { args } : {}),
    ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
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
  /** Webhook ingress health can be read, so the page can show relay URLs. */
  webhookIngress: boolean;
  /** A source can be read before installing, so the modal can list what it adds. */
  inspect: boolean;
};

export const NO_PLUGIN_MARKETPLACE_CAPABILITIES: PluginMarketplaceCapabilities = {
  browse: false,
  install: false,
  uninstall: false,
  enable: false,
  machines: false,
  remoteInstall: false,
  config: false,
  contributions: false,
  usage: false,
  webhookIngress: false,
  inspect: false,
};

export function pluginMarketplaceCapabilities(): PluginMarketplaceCapabilities {
  const plugins = bridge();
  // A published member proves the CALL exists, not that anything is behind it.
  // Once the host has answered `plugins_unavailable`, every member is still
  // there and every one still fails, so the probes have to stop believing them.
  if (hostReportedUnavailable) return NO_PLUGIN_MARKETPLACE_CAPABILITIES;
  return {
    browse: typeof plugins?.marketplaceIndex === "function",
    install: typeof plugins?.install === "function",
    uninstall: typeof plugins?.uninstall === "function",
    enable: typeof plugins?.setEnabled === "function"
      || (typeof plugins?.enable === "function" && typeof plugins?.disable === "function"),
    machines: typeof plugins?.presence === "function",
    // Not inferred from `install` + `presence`: see the marker's own note.
    remoteInstall: plugins?.remoteInstall === true,
    // A real config read or write, never `invoke`. The two look
    // interchangeable and are not: `invoke`'s `action` names a handler the
    // PLUGIN registered, so `config.get`/`config.set` sent through it reach the
    // plugin's own child process rather than the store the settings form edits.
    // The desktop preload publishes `getConfig`/`setConfig`, so the difference
    // never showed there; the hosted web client publishes `invoke` alone, and
    // with `invoke` counted here it would offer a settings form whose writes
    // land somewhere else entirely — or throw, on the overwhelmingly common
    // plugin that registers no handler by that name.
    config: typeof plugins?.getConfig === "function"
      || typeof plugins?.get === "function",
    contributions: typeof plugins?.setContributionEnabled === "function",
    usage: typeof plugins?.usageSummary === "function",
    webhookIngress: typeof plugins?.webhookIngress === "function",
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
  } catch (error) {
    noteUnavailable(error);
    return null;
  }
}

/**
 * Whether this host can answer for a repository's stars at all.
 *
 * A member-presence probe, the same idiom {@link pluginMarketplaceCapabilities}
 * uses and for the same reason: a published member proves the CALL exists, and
 * a host that never published one cannot be asked. Kept OUT of the capabilities
 * record deliberately — that record gates affordances the reader can press, and
 * a star count is a decoration whose absence is a quieter card rather than a
 * missing button.
 */
export function pluginRepoStarsSupported(): boolean {
  if (hostReportedUnavailable) return false;
  return typeof bridge()?.repoStars === "function";
}

/**
 * A repository's live star count, or null when this machine cannot say.
 *
 * Null covers every way that can happen — no host member, a rate-limited
 * GitHub, a URL that is not a repository — and they are one answer on purpose:
 * the Marketplace draws a count or it draws nothing, and it has no useful
 * different thing to say about which of those it was. It never throws: a
 * decoration must not be able to take a page down with it.
 */
export async function fetchPluginRepoStars(repo: string): Promise<number | null> {
  const repoStars = bridge()?.repoStars;
  if (!repoStars) return null;
  try {
    const stars = await repoStars({ repo });
    return typeof stars === "number" && Number.isFinite(stars) ? stars : null;
  } catch (error) {
    noteUnavailable(error);
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
  } catch (error) {
    noteUnavailable(error);
    return [];
  }
}

/**
 * Usage rows for the budget meters. Empty on a host that meters nothing.
 *
 * The preload normalizes the host's `{entries, budgets}` rollup into flat rows
 * before it crosses, so this reads one shape. It used to fold both here as
 * well — a second normalizer for a shape that never arrives, which is worse
 * than no normalizer: it made the flat path look optional.
 */
export async function readPluginUsage(pluginId?: string): Promise<PluginUsageRow[]> {
  const usageSummary = bridge()?.usageSummary;
  if (!usageSummary) return [];
  try {
    const result = await usageSummary(pluginId ? { pluginId } : {});
    return Array.isArray(result) ? (result as PluginUsageRow[]) : [];
  } catch (error) {
    noteUnavailable(error);
    return [];
  }
}

/**
 * Webhook ingress health for one plugin, or for every plugin that declares a
 * channel.
 *
 * Empty — never a throw — on a host that drains no webhooks or cannot reach the
 * drain. The rail that reads this omits itself in that case rather than drawing
 * "no webhooks arrive" over a host that never looked.
 */
export async function readPluginWebhookIngress(
  pluginId?: string,
): Promise<PluginWebhookIngressStatus[]> {
  const webhookIngress = bridge()?.webhookIngress;
  if (!webhookIngress) return [];
  try {
    const rows = await webhookIngress(pluginId ? { pluginId } : {});
    return Array.isArray(rows) ? (rows as PluginWebhookIngressStatus[]) : [];
  } catch (error) {
    noteUnavailable(error);
    return [];
  }
}

/**
 * Dynamic per-entity contributions for one surface, still unparsed.
 *
 * Rows are normalized by the socket layer, which owns their shape; this only
 * gets them across the boundary. Empty — never a throw — when the host cannot
 * join them, because a surface with no dynamic contributions is a quieter tab
 * rather than a broken one.
 */
export async function readPluginContributionRows(input: {
  surface: PluginSurfaceId;
  entityKind?: PluginEntityKind;
  entityIds?: readonly string[];
}): Promise<unknown[]> {
  const listContributions = bridge()?.listContributions;
  if (!listContributions) return [];
  try {
    const rows = await listContributions({
      surface: input.surface,
      ...(input.entityKind ? { entityKind: input.entityKind } : {}),
      ...(input.entityIds && input.entityIds.length > 0 ? { entityIds: [...input.entityIds] } : {}),
    });
    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    noteUnavailable(error);
    return [];
  }
}

/**
 * The installed manifest, still unparsed. Null when absent or unreadable.
 *
 * A THROW from `getManifest` is not the same fact as an absent manifest, and
 * this used to answer null for both. On a cold launch the plugin host lives in
 * the daemon and has not bound yet, so the first read refuses with a typed
 * `plugins_unavailable` — and the socket layer banked that null as "this plugin
 * declares nothing", which drew an empty top bar until the next relaunch. So a
 * refusal falls through to `plugins.get`, whose detail record carries the same
 * manifest by another route, and only a host that answers nothing at all
 * yields null.
 */
export async function readPluginManifest(pluginId: string): Promise<unknown | null> {
  const plugins = bridge();
  let refused = false;
  if (plugins?.getManifest) {
    try {
      return (await plugins.getManifest({ pluginId })) ?? null;
    } catch (error) {
      noteUnavailable(error);
      refused = true;
    }
  }
  if (plugins?.get && (refused || !plugins.getManifest)) {
    try {
      const detail = await plugins.get({ pluginId });
      if (detail && typeof detail === "object") {
        return (detail as { manifest?: unknown }).manifest ?? null;
      }
    } catch (error) {
      noteUnavailable(error);
      return null;
    }
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
