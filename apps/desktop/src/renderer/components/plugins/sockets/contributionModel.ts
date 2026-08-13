/**
 * Deriving what a surface renders, as pure functions.
 *
 * Everything that decides *which* contribution appears *where* lives here, with
 * no React and no host calls, so the taxonomy's rules are testable without
 * mounting a Lanes tab: manifest sockets become contributions, dynamic rows
 * override the plugin's static declaration for the entity they belong to, the
 * result is ordered by the host's rule and capped, and a malformed payload is
 * dropped rather than half-rendered.
 *
 * The merge rule is the one judgement call worth stating outright: a dynamic
 * `plugin_contributions` row REPLACES the manifest socket it fills, matched on
 * `pluginId + socketId`, for that entity only. A manifest badge is a
 * declaration ("I badge lanes"); the row is the value for this lane. Rendering
 * both would show a placeholder next to the real thing and burn one of the two
 * visible badge slots doing it — but replacing per *plugin* rather than per
 * socket would silently delete the declarations a plugin had not filled in yet.
 */

import type { PluginManifestSocket } from "../../../../shared/plugins/manifest";
import {
  PLUGIN_CONTRIBUTIONS_PER_SLOT_LIMIT,
  comparePluginContributions,
  parsePluginContributionPayload,
  type PluginContribution,
  type PluginEntityContribution,
  type PluginEntityKind,
  type PluginSocketKind,
  type PluginSurfaceId,
} from "../../../../shared/plugins/sockets";
import {
  pluginContributionKeyForContext,
  type PluginSurfaceContext,
} from "../../../../shared/plugins/context";
import { manifestOf, type PluginContributionRow, type PluginSocketSource } from "./contributionBridge";

/** A plugin's identity, carried alongside its contributions for rendering. */
export type PluginSocketIdentity = {
  pluginId: string;
  displayName: string;
  accent: string | null;
  icon: string | null;
};

export type SurfaceContributionSet = {
  /** Manifest-declared contributions for this surface, already validated. */
  staticContributions: readonly PluginContribution[];
  /**
   * Per-entity rows published by plugins, already validated and indexed by
   * {@link entityCacheKey}.
   *
   * Indexed rather than kept flat because every row on the surface asks for its
   * own entity's contributions, once per socket it mounts. A scan of the whole
   * list per ask is O(rows × contributions) on a tab that stays mounted; the
   * index makes each ask a lookup, and it is built once with the set.
   */
  dynamicByEntity: ReadonlyMap<string, readonly PluginEntityContribution[]>;
  identities: ReadonlyMap<string, PluginSocketIdentity>;
  /**
   * Filter keys each entity carries, keyed by {@link entityCacheKey}.
   *
   * This is how a contributed filter chip actually filters: a plugin declares a
   * chip with a `filterKey`, and tags the entities that belong to it by putting
   * the same key on the contributions it publishes for them. Without it a chip
   * would be a button that selects and does nothing, which is worse than no
   * chip at all.
   */
  filterKeysByEntity: ReadonlyMap<string, ReadonlySet<string>>;
};

export const EMPTY_CONTRIBUTION_SET: SurfaceContributionSet = {
  staticContributions: [],
  dynamicByEntity: new Map(),
  identities: new Map(),
  filterKeysByEntity: new Map(),
};

/** Composite key for the per-entity maps. NUL separates: neither half can contain it. */
export function entityCacheKey(entityKind: PluginEntityKind, entityId: string): string {
  return `${entityKind}\u0000${entityId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Build the payload a manifest socket implies, then validate it.
 *
 * The manifest speaks in one flat shape (`label`, `icon`, `actionId`,
 * `panelId`…); the socket contract speaks in a payload per kind. This is the
 * one place that translation happens, and it deliberately goes back through
 * {@link parsePluginContributionPayload} rather than trusting itself — a
 * manifest that parsed but implies a payload with no label is still a
 * contribution that must not render.
 */
export function payloadFromManifestSocket(socket: PluginManifestSocket): unknown {
  switch (socket.socket) {
    case "toolbar-action":
    case "composer-action":
      return { label: socket.label, icon: socket.icon, actionId: socket.actionId };
    case "row-badge":
      // A manifest badge has no value of its own — it is the declaration a
      // dynamic row later fills in. Rendering it as a neutral label keeps a
      // plugin that never publishes rows honest rather than invisible.
      return { text: socket.label, tone: "neutral", icon: socket.icon };
    case "row-menu-item":
      return { label: socket.label, icon: socket.icon, actionId: socket.actionId };
    case "detail-section":
      return { panelId: socket.panelId, title: socket.label };
    case "empty-state":
      return { title: socket.label, actionId: socket.actionId, actionLabel: socket.label };
    case "filter-chip":
      return { label: socket.label, filterKey: socket.filterKey ?? socket.id };
    case "file-viewer":
      return { panelId: socket.panelId, extensions: socket.extensions };
    default:
      return null;
  }
}

/** Manifest sockets for one plugin, as validated contributions. */
export function contributionsFromSource(source: PluginSocketSource): PluginContribution[] {
  if (!source.enabled) return [];
  const manifest = manifestOf(source);
  if (!manifest || !Array.isArray(manifest.sockets)) return [];
  const disabled = new Set(source.disabledContributions);

  const contributions: PluginContribution[] = [];
  for (const socket of manifest.sockets) {
    if (!socket || typeof socket !== "object") continue;
    if (disabled.has(socket.id)) continue;
    const payload = parsePluginContributionPayload(socket.socket, payloadFromManifestSocket(socket));
    if (!payload) continue;
    contributions.push({
      pluginId: source.pluginId,
      socket: socket.socket,
      surface: socket.surface,
      id: socket.id,
      ...(typeof socket.order === "number" ? { order: socket.order } : {}),
      payload,
    });
  }
  return contributions;
}

/**
 * Dynamic rows as validated contributions.
 *
 * Three things are dropped here rather than downstream:
 *
 * - **Rows from a plugin that is not installed or is disabled.** Contribution
 *   rows sync between machines and outlive an uninstall elsewhere; a badge from
 *   a plugin you removed is a ghost.
 * - **Rows filling a manifest socket the user switched off.** `socketId` names
 *   that socket, and `disabledContributions` lists the ones turned off. Without
 *   this the per-contribution toggle would hide a plugin's *declared* badge and
 *   leave its published one on screen — a switch that visibly does nothing.
 * - **Rows for another surface.** The row states its own `surface`; a caller
 *   reading for Lanes must not be handed a PR row because both are keyed by
 *   entity rather than by tab.
 */
export function contributionsFromRows(
  rows: readonly PluginContributionRow[],
  surface: PluginSurfaceId,
  sources: readonly PluginSocketSource[],
): PluginEntityContribution[] {
  const disabledByPlugin = new Map<string, ReadonlySet<string>>();
  for (const source of sources) {
    if (!source.enabled) continue;
    disabledByPlugin.set(source.pluginId, new Set(source.disabledContributions));
  }

  const contributions: PluginEntityContribution[] = [];
  for (const row of rows) {
    const disabled = disabledByPlugin.get(row.pluginId);
    if (!disabled) continue;
    // An older host omits `surface`; only reject a row that names a different one.
    if (row.surface && row.surface !== surface) continue;
    const payload = parsePluginContributionPayload(row.socket, row.payload);
    if (!payload) continue;
    const raw = isRecord(row.payload) ? row.payload : {};
    // Identity, in order of authority: the manifest socket the row fills, an id
    // the payload carries, then the socket kind — the last only holds one
    // contribution per plugin, which is all an older host could express.
    const id = row.socketId?.trim()
      || (typeof raw.id === "string" && raw.id.trim().length > 0 ? raw.id.trim() : row.socket);
    if (disabled.has(id)) continue;
    contributions.push({
      pluginId: row.pluginId,
      socket: row.socket,
      surface,
      id,
      ...(typeof raw.order === "number" && Number.isFinite(raw.order) ? { order: raw.order } : {}),
      payload,
      entityKind: row.entityKind,
      entityId: row.entityId,
      updatedAt: row.updatedAt ?? "",
    });
  }
  return contributions;
}

/** Everything a surface needs, assembled once per reveal. */
export function buildContributionSet(
  sources: readonly PluginSocketSource[],
  rows: readonly PluginContributionRow[],
  surface: PluginSurfaceId,
): SurfaceContributionSet {
  const enabled = sources.filter((source) => source.enabled);
  const identities = new Map<string, PluginSocketIdentity>();
  const staticContributions: PluginContribution[] = [];
  for (const source of enabled) {
    identities.set(source.pluginId, {
      pluginId: source.pluginId,
      displayName: source.displayName,
      accent: source.accent,
      icon: source.icon,
    });
    for (const contribution of contributionsFromSource(source)) {
      if (contribution.surface === surface) staticContributions.push(contribution);
    }
  }
  const knownPluginIds = new Set(identities.keys());

  const filterKeysByEntity = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!knownPluginIds.has(row.pluginId)) continue;
    if (row.surface && row.surface !== surface) continue;
    const payload = isRecord(row.payload) ? row.payload : null;
    const filterKey = payload && typeof payload.filterKey === "string" ? payload.filterKey.trim() : "";
    if (!filterKey) continue;
    const key = entityCacheKey(row.entityKind, row.entityId);
    const existing = filterKeysByEntity.get(key);
    if (existing) existing.add(filterKey);
    else filterKeysByEntity.set(key, new Set([filterKey]));
  }

  const dynamicByEntity = new Map<string, PluginEntityContribution[]>();
  for (const contribution of contributionsFromRows(rows, surface, enabled)) {
    const key = entityCacheKey(contribution.entityKind, contribution.entityId);
    const existing = dynamicByEntity.get(key);
    if (existing) existing.push(contribution);
    else dynamicByEntity.set(key, [contribution]);
  }

  return {
    staticContributions,
    dynamicByEntity,
    identities,
    filterKeysByEntity,
  };
}

/**
 * Whether an entity survives the selected plugin filter chips.
 *
 * No selection means no filtering — a surface calls this unconditionally, and
 * an empty selection must never hide rows.
 */
export function entityMatchesPluginFilters(
  set: SurfaceContributionSet,
  context: PluginSurfaceContext,
  selectedKeys: readonly string[],
): boolean {
  if (selectedKeys.length === 0) return true;
  const key = pluginContributionKeyForContext(context);
  if (!key) return true;
  const keys = set.filterKeysByEntity.get(entityCacheKey(key.entityKind, key.entityId));
  if (!keys) return false;
  return selectedKeys.some((selected) => keys.has(selected));
}

/** Cap per plugin per slot, preserving the host's order within each plugin. */
function capPerPlugin(contributions: readonly PluginContribution[]): PluginContribution[] {
  const counts = new Map<string, number>();
  const kept: PluginContribution[] = [];
  for (const contribution of contributions) {
    const seen = counts.get(contribution.pluginId) ?? 0;
    if (seen >= PLUGIN_CONTRIBUTIONS_PER_SLOT_LIMIT) continue;
    counts.set(contribution.pluginId, seen + 1);
    kept.push(contribution);
  }
  return kept;
}

/**
 * The contributions one socket renders, for one entity or for the surface.
 *
 * `context` narrows dynamic rows to the entity in hand; pass a surface-only
 * context (or none) for toolbars, chips and empty states, which have no subject
 * and therefore read static contributions only.
 */
export function selectContributions<K extends PluginSocketKind>(
  set: SurfaceContributionSet,
  socket: K,
  context?: PluginSurfaceContext | null,
): PluginContribution<K>[] {
  const key = context ? pluginContributionKeyForContext(context) : null;
  const forEntity = key ? set.dynamicByEntity.get(entityCacheKey(key.entityKind, key.entityId)) : null;
  const dynamic = forEntity ? forEntity.filter((entry) => entry.socket === socket) : [];
  // A dynamic row replaces the manifest socket it fills, matched on
  // `pluginId + id`. Matching on the plugin alone meant a plugin declaring two
  // badges and publishing one for this entity lost the other's declaration.
  //
  // A row from a host too old to name the socket keeps the coarser rule and
  // replaces everything that plugin declared for this socket kind — that host
  // can only express one contribution per plugin per socket anyway, and the
  // alternative is rendering its published badge next to the placeholder the
  // badge exists to fill in. `contributionsFromRows` marks those rows by
  // falling their id back to the socket kind.
  const overriddenIds = new Set<string>();
  const overriddenPlugins = new Set<string>();
  for (const entry of dynamic) {
    if (entry.id === entry.socket) overriddenPlugins.add(entry.pluginId);
    else overriddenIds.add(`${entry.pluginId} ${entry.id}`);
  }
  const statics = set.staticContributions.filter(
    (entry) => entry.socket === socket
      && !overriddenPlugins.has(entry.pluginId)
      && !overriddenIds.has(`${entry.pluginId} ${entry.id}`),
  );
  const merged = [...statics, ...dynamic].sort(comparePluginContributions);
  return capPerPlugin(merged) as PluginContribution<K>[];
}

/**
 * A context's identity, for memo dependencies.
 *
 * Contexts are rebuilt from row data on every render, so their object identity
 * says nothing; what a memo has to key on is the entity they name. Derived from
 * {@link pluginContributionKeyForContext} rather than switching on `kind` again,
 * because that switch had been written three times and the three had drifted
 * into three different answers for a surface-only context.
 *
 * A surface-only context collapses to one key on purpose. It selects no dynamic
 * rows at all — {@link selectContributions} already reads statics only for it —
 * and every caller keys on the surface separately, so the toolbar, chip and
 * empty-state sockets keep rendering exactly what they rendered before.
 */
export function pluginContextMemoKey(context: PluginSurfaceContext | null): string {
  if (!context) return "";
  const key = pluginContributionKeyForContext(context);
  return key ? `${key.entityKind}:${key.entityId}` : "surface";
}

/** Stable React key for a contribution. Real identity, never an array index. */
export function contributionKey(contribution: PluginContribution): string {
  return `${contribution.pluginId}\u0000${contribution.socket}\u0000${contribution.id}`;
}

/* ── Menu entries ───────────────────────────────────────────────────────── */

/**
 * A contributed context-menu row.
 *
 * Structurally a `LaneMenuAction` (`lanes/laneContextMenuItems`), because Lanes
 * already had the only good pattern for this and standardising on it means the
 * Lanes menu consumes plugin entries with no adapter at all.
 *
 * `danger` is the plugin asking for the product's own destructive styling, and
 * a red row that is not visibly a plugin's reads as ADE's. It is carried here
 * and honoured by `pluginContextMenuItems`, which draws it only alongside the
 * attribution it emits in the same breath; a renderer that draws neither is
 * also consistent.
 */
export type PluginMenuEntry = {
  kind: "action";
  key: string;
  label: string;
  onSelect: () => void;
  dataTour?: string;
  icon?: string;
  danger?: boolean;
};

/**
 * Build the menu rows for a surface + entity.
 *
 * `invoke` is injected rather than imported so this stays a pure function: the
 * tests assert what a menu contains and what a click asks for, without a host.
 */
export function buildPluginMenuEntries(options: {
  set: SurfaceContributionSet;
  surface: PluginSurfaceId;
  context: PluginSurfaceContext;
  invoke: (pluginId: string, actionId: string, context: PluginSurfaceContext) => void;
  onClose?: () => void;
}): PluginMenuEntry[] {
  const { set, surface, context, invoke, onClose } = options;
  return selectContributions(set, "row-menu-item", context)
    // A set is built for one surface, but nothing stops a caller passing the
    // wrong one, and the result would be another tab's entries wearing this
    // tab's name. Cheap to check, and the check is the only thing that makes
    // `surface` mean something here.
    .filter((contribution) => contribution.surface === surface)
    .map((contribution) => ({
    kind: "action" as const,
    key: contributionKey(contribution),
    label: contribution.payload.label,
    dataTour: `plugin:${surface}.row-menu-item`,
    ...(contribution.payload.icon ? { icon: contribution.payload.icon } : {}),
    ...(contribution.payload.danger ? { danger: true } : {}),
    onSelect: () => {
      onClose?.();
      invoke(contribution.pluginId, contribution.payload.actionId, context);
    },
  }));
}

/* ── File viewers ───────────────────────────────────────────────────────── */

export type PluginViewerRegistration = {
  pluginId: string;
  panelId: string;
  displayName: string;
  extensions: readonly string[];
};

/** File-viewer registrations from every enabled plugin's manifest. */
export function pluginViewerRegistrations(
  sources: readonly PluginSocketSource[],
): PluginViewerRegistration[] {
  const registrations: PluginViewerRegistration[] = [];
  for (const source of sources) {
    for (const contribution of contributionsFromSource(source)) {
      if (contribution.socket !== "file-viewer") continue;
      const payload = contribution.payload as { panelId: string; extensions: string[] };
      registrations.push({
        pluginId: source.pluginId,
        panelId: payload.panelId,
        displayName: source.displayName,
        extensions: payload.extensions,
      });
    }
  }
  return registrations;
}

/**
 * The `ViewerKind` a plugin viewer occupies.
 *
 * Encoded rather than looked up because the kind is PERSISTED in the editor
 * session: a reopened workbench must be able to say which plugin owned a tab
 * without consulting a registry that may no longer contain it.
 */
export function pluginViewerKind(pluginId: string, panelId: string): `plugin:${string}` {
  return `plugin:${pluginId}:${panelId}`;
}

export function parsePluginViewerKind(
  kind: string,
): { pluginId: string; panelId: string } | null {
  if (!kind.startsWith("plugin:")) return null;
  const rest = kind.slice("plugin:".length);
  const separator = rest.indexOf(":");
  if (separator <= 0 || separator === rest.length - 1) return null;
  return { pluginId: rest.slice(0, separator), panelId: rest.slice(separator + 1) };
}

/**
 * The plugin viewer claiming an extension, if any.
 *
 * Order is first-registration-wins among plugins, and plugins only get asked
 * after every built-in viewer has declined — see `resolveViewerKind`.
 */
export function matchPluginViewer(
  registrations: readonly PluginViewerRegistration[],
  extension: string,
): PluginViewerRegistration | null {
  const normalized = extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
  return registrations.find((entry) => entry.extensions.includes(normalized)) ?? null;
}

/* ── Change routing ─────────────────────────────────────────────────────── */

/** The two reads a socket surface makes, each invalidated by different events. */
export type PluginReadKind = "sources" | "contributions";

/**
 * Kinds that invalidate each read.
 *
 * `installs` invalidates both: a new plugin may have rows waiting, and a
 * removed one's rows must stop rendering. `status` is child-process health —
 * it changes whether a plugin is *running*, which the registry reports, but not
 * what it has already published. `panels` and `collections` are the panel
 * host's business and move no contribution.
 */
const INVALIDATED_BY: Record<PluginReadKind, ReadonlySet<string>> = {
  sources: new Set(["installs", "status"]),
  contributions: new Set(["installs", "contributions"]),
};

const KNOWN_PLUGIN_CHANGE_KINDS: ReadonlySet<string> = new Set([
  "installs",
  "panels",
  "collections",
  "contributions",
  "status",
]);

/**
 * Whether a change event should invalidate one of the two reads.
 *
 * An **unrecognized** kind invalidates both, deliberately. The daemon's kind
 * list grows without a renderer release, and the failure modes are not
 * symmetric: refetching twice for an event we did not need costs one round trip,
 * while ignoring a kind we have not learned about yet leaves a stale badge on
 * screen with nothing to correct it. This mirrors the contract documented in
 * `main/services/plugins/pluginEvents.ts`.
 */
export function pluginChangeAffects(read: PluginReadKind, kind: string): boolean {
  if (!KNOWN_PLUGIN_CHANGE_KINDS.has(kind)) return true;
  return INVALIDATED_BY[read].has(kind);
}

/** Which surface a contributed entity kind belongs to, for the dynamic read. */
export const SURFACE_ENTITY_KIND: Record<PluginSurfaceId, PluginEntityKind> = {
  work: "session",
  lanes: "lane",
  files: "file",
  prs: "pr",
  automations: "automation",
  cto: "surface",
};
