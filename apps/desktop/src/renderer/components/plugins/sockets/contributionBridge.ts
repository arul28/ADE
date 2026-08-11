/**
 * The socket taxonomy's host reads.
 *
 * Sockets need two things the tab/panel surfaces never did: every installed
 * plugin's *manifest* sockets (what a plugin says it adds, everywhere), and the
 * `plugin_contributions` rows a plugin publishes per entity (what it wants to
 * say about *this* lane, *this* PR). Both are read here, once per surface, and
 * joined in memory — the perf law is that a row never fetches.
 *
 * Every call is optional-chained twice over, because two plugin namespaces
 * exist in this build and a socket surface must render on a host that has
 * neither:
 *
 * - `window.ade.plugin` is the Wave A action domain (`PluginDomainService`):
 *   `list`, `get`, `invoke`. This is the namespace the desktop host actually
 *   publishes today, so it is tried first.
 * - `window.ade.plugins` is the richer surface `pluginRuntimeBridge` codes
 *   against (panels, collections, marketplace). Where it exists it is preferred
 *   for the calls it answers better, and it is the only place a host-joined
 *   contributions reader can appear.
 *
 * Nothing here throws on a missing namespace. A build with no plugin support is
 * the normal case on the hosted web client and on an older host, and it must
 * read as "no contributions", never as a broken Lanes tab.
 */

import type { PluginManifest } from "../../../../shared/plugins/manifest";
import type {
  PluginEntityKind,
  PluginSocketKind,
  PluginSurfaceId,
} from "../../../../shared/plugins/sockets";

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

type PluginDomainBridge = {
  list?: (args?: { includeDisabled?: boolean }) => Promise<unknown>;
  get?: (args: { pluginId: string }) => Promise<unknown>;
  invoke?: (args: {
    pluginId: string;
    action: string;
    args?: Record<string, unknown>;
  }) => Promise<unknown>;
};

type PluginsBridge = {
  list?: () => Promise<unknown>;
  getManifest?: (args: { pluginId: string }) => Promise<unknown>;
  invoke?: (args: {
    pluginId: string;
    action: string;
    args?: Record<string, unknown>;
  }) => Promise<unknown>;
  /**
   * Host-joined contributions for one surface. Optional because no host
   * publishes it yet: until one does, static manifest sockets are the whole
   * taxonomy and dynamic per-entity contributions are simply absent, which is a
   * quieter UI rather than a broken one.
   */
  listContributions?: (args: {
    surface: PluginSurfaceId;
    entityKind?: PluginEntityKind;
  }) => Promise<unknown>;
};

type AdeWindow = Window & {
  ade?: {
    plugin?: PluginDomainBridge | null;
    plugins?: PluginsBridge | null;
  };
};

function domainBridge(): PluginDomainBridge | null {
  if (typeof window === "undefined") return null;
  return (window as AdeWindow).ade?.plugin ?? null;
}

function pluginsBridge(): PluginsBridge | null {
  if (typeof window === "undefined") return null;
  return (window as AdeWindow).ade?.plugins ?? null;
}

/** True when this build exposes any plugin namespace at all. */
export function pluginSocketsAvailable(): boolean {
  return domainBridge() !== null || pluginsBridge() !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

/**
 * Installed plugins, from whichever namespace answers.
 *
 * A disabled plugin is dropped here rather than downstream: its contributions
 * are not "hidden", they do not exist, and carrying them through the model just
 * to filter them at render is how a disabled plugin ends up in a "+N" count.
 */
async function listInstalledSources(): Promise<
  { pluginId: string; displayName: string; enabled: boolean; accent: string | null; icon: string | null; disabledContributions: string[] }[]
> {
  const read = async (): Promise<unknown> => {
    const domain = domainBridge()?.list;
    if (domain) return domain({ includeDisabled: false });
    const plugins = pluginsBridge()?.list;
    return plugins ? plugins() : null;
  };

  let raw: unknown;
  try {
    raw = await read();
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const sources = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const pluginId = stringOrNull(entry.pluginId);
    if (!pluginId) continue;
    sources.push({
      pluginId,
      displayName: stringOrNull(entry.displayName) ?? pluginId,
      // Absent `enabled` means an older summary shape, and the host already
      // filtered disabled plugins out of the list it answered with.
      enabled: entry.enabled !== false,
      accent: stringOrNull(entry.accent),
      icon: stringOrNull(entry.icon),
      disabledContributions: stringList(entry.disabledContributions),
    });
  }
  return sources;
}

/** One plugin's manifest, from whichever namespace answers. Null when unreadable. */
async function readManifest(pluginId: string): Promise<unknown> {
  try {
    const getManifest = pluginsBridge()?.getManifest;
    if (getManifest) {
      const manifest = await getManifest({ pluginId });
      if (manifest) return manifest;
    }
    const get = domainBridge()?.get;
    if (get) {
      const detail = await get({ pluginId });
      if (isRecord(detail)) return detail.manifest ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Every enabled plugin plus its manifest, in one pass.
 *
 * Manifests are read in parallel and only for plugins the host reports as
 * installed, so this is one round trip per installed plugin per surface reveal
 * — not per row, and not per render.
 */
export async function readPluginSocketSources(): Promise<PluginSocketSource[]> {
  const installed = await listInstalledSources();
  if (installed.length === 0) return [];
  const manifests = await Promise.all(installed.map((entry) => readManifest(entry.pluginId)));
  return installed.map((entry, index) => ({
    ...entry,
    manifest: manifests[index] ?? null,
  }));
}

/** Dynamic per-entity contributions for a surface. Empty when unsupported. */
export async function readSurfaceContributionRows(
  surface: PluginSurfaceId,
  entityKind?: PluginEntityKind,
): Promise<PluginContributionRow[]> {
  const listContributions = pluginsBridge()?.listContributions;
  if (!listContributions) return [];
  let raw: unknown;
  try {
    raw = await listContributions({ surface, ...(entityKind ? { entityKind } : {}) });
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const rows: PluginContributionRow[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const pluginId = stringOrNull(entry.pluginId);
    const entityId = stringOrNull(entry.entityId);
    const entityKindValue = stringOrNull(entry.entityKind);
    const socket = stringOrNull(entry.socket);
    if (!pluginId || !entityId || !entityKindValue || !socket) continue;
    const socketId = stringOrNull(entry.socketId);
    const rowSurface = stringOrNull(entry.surface);
    rows.push({
      entityKind: entityKindValue as PluginEntityKind,
      entityId,
      pluginId,
      socket: socket as PluginSocketKind,
      ...(socketId ? { socketId } : {}),
      ...(rowSurface ? { surface: rowSurface as PluginSurfaceId } : {}),
      payload: entry.payload ?? entry.payload_json ?? null,
      updatedAt: stringOrNull(entry.updatedAt),
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
): Promise<unknown> {
  const domain = domainBridge()?.invoke;
  if (domain) return domain({ pluginId, action, args });
  const plugins = pluginsBridge()?.invoke;
  if (plugins) return plugins({ pluginId, action, args });
  throw new Error("This build has no plugin support.");
}

/** Narrowing helper shared by the model; kept here so the manifest cast is in one place. */
export function manifestOf(source: PluginSocketSource): PluginManifest | null {
  return isRecord(source.manifest) ? (source.manifest as unknown as PluginManifest) : null;
}
