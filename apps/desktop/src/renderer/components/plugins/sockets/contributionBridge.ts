/**
 * The socket taxonomy's host reads, normalized.
 *
 * Sockets need two things the tab/panel surfaces never did: every installed
 * plugin's *manifest* sockets (what a plugin says it adds, everywhere), and the
 * `plugin_contributions` rows a plugin publishes per entity (what it wants to
 * say about *this* lane, *this* PR). Both are read here, once per surface, and
 * joined in memory — the perf law is that a row never fetches.
 *
 * The namespace itself is `renderer/lib/pluginRuntimeBridge`'s business, and
 * this module goes through it rather than reaching for `window` again. What is
 * left here is the part that is genuinely the socket layer's: turning whatever
 * the host answered with into the two shapes `contributionModel` is allowed to
 * trust, and not asking for the same manifest twice.
 *
 * Nothing here throws on a missing namespace. A build with no plugin support is
 * the normal case on the hosted web client and on an older host, and it must
 * read as "no contributions", never as a broken Lanes tab.
 */

import { isRecord, oneOf, trimmed } from "../../../../shared/plugins/parse";
import type { PluginManifest } from "../../../../shared/plugins/manifest";
import {
  PLUGIN_ENTITY_KINDS,
  PLUGIN_SOCKET_KINDS,
  PLUGIN_SURFACE_IDS,
  type PluginEntityKind,
  type PluginSocketKind,
  type PluginSurfaceId,
} from "../../../../shared/plugins/sockets";
import {
  invokePluginAction,
  listInstalledPlugins,
  loadInstalledPlugins,
  readPluginContributionRows,
  readPluginManifest,
} from "../../../lib/pluginRuntimeBridge";

/** One installed plugin, as much of it as a socket surface needs. */
export type PluginSocketSource = {
  pluginId: string;
  displayName: string;
  enabled: boolean;
  accent: string | null;
  icon: string | null;
  /** Manifest socket ids the user switched off. Absent means none are. */
  disabledContributions: readonly string[];
  /** Raw manifest — parsed by `contributionModel`, never here. */
  manifest: unknown;
};

/** A `plugin_contributions` row, still unparsed. */
export type PluginContributionRow = {
  entityKind: PluginEntityKind;
  entityId: string;
  pluginId: string;
  socket: PluginSocketKind;
  /**
   * The manifest socket this row fills. Optional because an older host cannot
   * name it, but load-bearing where present: it is the row's identity for
   * ordering, for replacing the right declaration, and for honouring the
   * per-contribution toggle.
   */
  socketId?: string;
  /** The row's own surface. Absent on an older host; never guessed. */
  surface?: PluginSurfaceId;
  payload: unknown;
  updatedAt?: string | null;
};

/**
 * True when this build exposes a plugin namespace at all.
 *
 * Deliberately narrower than `pluginsAvailable`: this asks whether the host
 * publishes the namespace, not whether a project runtime is currently bound
 * behind it. A surface uses it to decide there is nothing to load; the built-in
 * tab gate uses it to decide whether an empty registry is a fact or an absence,
 * and neither question should flip when a runtime is mid-transition.
 */
export function pluginSocketsAvailable(): boolean {
  if (typeof window === "undefined") return false;
  // The namespace ADE publishes is `plugins`, PLURAL, and it is the only one
  // any build has. The singular `plugin` is the RPC action DOMAIN, not a window
  // key; it is read here only as tolerance for a host that ever published it,
  // and because the failure mode of a name mismatch is a UI that draws empty
  // states everywhere and never says why.
  const ade = (window as unknown as { ade?: Record<string, unknown> }).ade;
  return Boolean(ade?.plugin ?? ade?.plugins);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const entry of value) {
    const text = trimmed(entry);
    if (text) items.push(text);
  }
  return items;
}

/**
 * Manifests, kept for as long as the install set does not change.
 *
 * Every surface reveal re-reads the plugin list, and the list refreshes on
 * child-process health events too — which arrive whenever a plugin starts,
 * stops or crashes. Without this, each of those refetched every installed
 * plugin's manifest to discover it had not changed. The promise is cached
 * rather than the value so two surfaces revealing together share one read.
 */
const manifestCache = new Map<string, Promise<unknown>>();

function cachedManifest(pluginId: string): Promise<unknown> {
  const cached = manifestCache.get(pluginId);
  if (cached) return cached;
  const pending = readPluginManifest(pluginId);
  manifestCache.set(pluginId, pending);
  return pending;
}

/** Drop cached manifests. A manifest only changes across an install or a reload. */
export function clearPluginManifestCache(): void {
  manifestCache.clear();
}

/**
 * Every installed plugin plus its manifest, in one pass.
 *
 * The list includes plugins the user has switched OFF, and that is the shape
 * the socket layer wants: `contributionModel` drops a disabled plugin's
 * contributions itself, and it can only do that if `enabled` arrives. A list
 * pre-filtered by the host would hide the difference between "off" and "not
 * installed", which is also the difference between a contribution that should
 * come back when the switch flips and one that never existed.
 */
/**
 * {@link readPluginSocketSources}, keeping "the host could not answer" apart
 * from "the host answered, and there are none".
 *
 * The two are opposite facts and they used to arrive as the same empty array.
 * On a cold launch the plugin host lives in the daemon and is not bound yet, so
 * the first read refuses with a typed `plugins_unavailable` — which
 * `listInstalledPlugins` collapses to `[]`. The store above then committed that
 * as a settled, successful "no plugins" and stopped asking. Menu rows drawn
 * from a *cached* earlier read stayed on screen while the store believed there
 * was nothing to load, and nothing retried until an unrelated plugin event
 * happened to arrive.
 */
export async function loadPluginSocketSources(): Promise<
  { ok: true; sources: PluginSocketSource[] } | { ok: false }
> {
  const load = await loadInstalledPlugins();
  if (!load.ok) return { ok: false };
  return { ok: true, sources: await sourcesFromInstalled(load.plugins) };
}

export async function readPluginSocketSources(): Promise<PluginSocketSource[]> {
  return await sourcesFromInstalled(await listInstalledPlugins());
}

async function sourcesFromInstalled(installed: readonly unknown[]): Promise<PluginSocketSource[]> {
  const sources: Omit<PluginSocketSource, "manifest">[] = [];
  for (const entry of installed) {
    if (!isRecord(entry)) continue;
    const pluginId = trimmed(entry.pluginId);
    if (!pluginId) continue;
    sources.push({
      pluginId,
      displayName: trimmed(entry.displayName) ?? pluginId,
      enabled: entry.enabled !== false,
      accent: trimmed(entry.accent),
      icon: trimmed(entry.icon),
      disabledContributions: stringList(entry.disabledContributions),
    });
  }
  if (sources.length === 0) return [];
  const manifests = await Promise.all(sources.map((entry) => cachedManifest(entry.pluginId)));
  return sources.map((entry, index) => ({ ...entry, manifest: manifests[index] ?? null }));
}

/**
 * Dynamic per-entity contributions for a surface. Empty when unsupported.
 *
 * Every closed-list field is checked against its list rather than asserted. A
 * row naming a socket, entity kind or surface this build has never heard of is
 * dropped here, where "we do not know what this is" is still true, instead of
 * being carried through the model as a value it can only fail to match.
 */
export async function readSurfaceContributionRows(
  surface: PluginSurfaceId,
  entityKind?: PluginEntityKind,
): Promise<PluginContributionRow[]> {
  const raw = await readPluginContributionRows({
    surface,
    ...(entityKind ? { entityKind } : {}),
  });

  const rows: PluginContributionRow[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const pluginId = trimmed(entry.pluginId);
    const entityId = trimmed(entry.entityId);
    const rowEntityKind = oneOf(trimmed(entry.entityKind), PLUGIN_ENTITY_KINDS);
    const socket = oneOf(trimmed(entry.socket), PLUGIN_SOCKET_KINDS);
    if (!pluginId || !entityId || !rowEntityKind || !socket) continue;
    const socketId = trimmed(entry.socketId);
    const rowSurface = oneOf(trimmed(entry.surface), PLUGIN_SURFACE_IDS);
    rows.push({
      entityKind: rowEntityKind,
      entityId,
      pluginId,
      socket,
      ...(socketId ? { socketId } : {}),
      ...(rowSurface ? { surface: rowSurface } : {}),
      payload: entry.payload ?? entry.payload_json ?? null,
      updatedAt: trimmed(entry.updatedAt),
    });
  }
  return rows;
}

/**
 * Dispatch a socket's action.
 *
 * MUTATING, and deliberately loud: a toolbar button that silently does nothing
 * is the exact failure this taxonomy exists to make impossible. The typed
 * surface context rides along as `context` so the plugin knows which lane, PR or
 * file the click came from without the host handing it an internal model.
 */
export async function invokePluginSocketAction(
  pluginId: string,
  action: string,
  args: Record<string, unknown>,
  options?: { timeoutMs?: number },
): Promise<unknown> {
  return invokePluginAction(pluginId, action, args, options);
}

/** Narrowing helper shared by the model; kept here so the manifest cast is in one place. */
export function manifestOf(source: PluginSocketSource): PluginManifest | null {
  return isRecord(source.manifest) ? (source.manifest as unknown as PluginManifest) : null;
}
