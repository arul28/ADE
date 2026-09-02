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
  readPluginContributionEntityTag,
  type PluginContribution,
  type PluginEntityContribution,
  type PluginEntityKind,
  type PluginSocketKind,
  type PluginSurfaceId,
} from "../../../../shared/plugins/sockets";
import {
  parsePluginTabContributionEntityId,
  pluginContributionKeyForContext,
  pluginSurfaceContributionKey,
  pluginTabContributionKey,
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
  /**
   * Which surface this set describes.
   *
   * Carried on the set rather than threaded through every caller because
   * {@link selectContributions} needs it to look up the surface's OWN dynamic
   * rows, and its `context` argument cannot supply it: a toolbar passes no
   * context at all. Absent only on {@link EMPTY_CONTRIBUTION_SET}, which holds
   * no rows for it to key.
   */
  surface?: PluginSurfaceId;
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
    // Four kinds, one arm, because they are four chromes over one
    // contribution: a labelled button that invokes an action. The parser folds
    // them into a single case too (`sockets.ts`), and the two files agreeing on
    // that is the point — a mapping that split them here would be claiming a
    // difference the contract does not have.
    //
    // `menu` and `color` are passed through raw and re-validated by the parser,
    // like every other field here: the manifest parser already capped, bounded
    // and contrast-checked them, and this mapping deliberately trusts nothing
    // it is handed.
    case "toolbar-action":
    case "composer-action":
    case "chat-header-action":
    case "command-palette-action":
      return {
        label: socket.label,
        icon: socket.icon,
        actionId: socket.actionId,
        ...(socket.menu ? { menu: socket.menu } : {}),
        ...(socket.color ? { color: socket.color } : {}),
        ...(socket.ownsSend === true ? { ownsSend: true } : {}),
      };
    case "row-badge":
      // A manifest badge has no value of its own — it is the declaration a
      // dynamic row later fills in, and {@link selectContributions} never draws
      // it. The payload is still built, because the declaration is what a
      // published row is matched against for override and ordering.
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
    // A chat card's manifest `label` is the card's own title only when the
    // emitted card did not supply one; the card is the thing with chronology,
    // so its title wins. What the declaration is FOR is naming which panel the
    // plugin may draw in a transcript at all.
    case "chat-card":
      return { panelId: socket.panelId, title: socket.label, icon: socket.icon };
    // `command` arrives already normalized (one leading slash stripped, trimmed,
    // lowercased) and is refused at manifest parse when malformed, so it is
    // passed through rather than re-normalized here — two normalizers would be
    // two chances to disagree about what `"/Fix"` means.
    //
    // `description` falls back to `label` for plugins written before the field
    // existed, which put their menu line there. This mirrors the host's own
    // mapping in `main/services/chat/pluginSlashCommands.ts` EXACTLY, on
    // purpose: the two feed the same command menu from different sides, and a
    // renderer that resolved the subtitle differently would show one thing in
    // the composer and another in `getSlashCommands`.
    case "slash-command":
      return {
        command: socket.command,
        actionId: socket.actionId,
        description: socket.description ?? socket.label,
        argumentHint: socket.argumentHint,
        icon: socket.icon,
      };
    // `section` names the settings page that hosts this. Opaque rather than a
    // union — settings page ids are ADE's own furniture and they move, so a
    // plugin naming one this build has never heard of lands in the generic
    // Plugins area instead of failing to parse.
    case "settings-section":
      return { panelId: socket.panelId, title: socket.label, section: socket.section };
    // The rail and the drawer are the same contribution wearing different
    // chrome — see `PluginPanelHostPayload` — so moving between them is a
    // one-word manifest edit and nothing here has to change.
    case "work-rail-pane":
    case "drawer-tab":
      return { label: socket.label, panelId: socket.panelId, icon: socket.icon };
    // Like a row badge, a manifest activity entry is the declaration a dynamic
    // row fills in: neutral tone, because a static entry cannot know whether
    // the thing it describes currently needs anyone. `actionLabel` is left off
    // rather than defaulted to the label, which would print the title twice.
    case "activity-entry":
      return { title: socket.label, tone: "neutral", actionId: socket.actionId };
    // A declaration, exactly like a row badge: the node's subject is the lane
    // the row is published against, and the manifest has no lane. `edges` is
    // absent for the same reason — an edge needs two endpoints and a
    // declaration has neither.
    case "graph-node":
      return { label: socket.label, tone: "neutral", icon: socket.icon, actionId: socket.actionId };
    // `dialog` rides the payload rather than being implied by the surface:
    // create-lane and manage-lane are both `lanes`, and a section that could
    // not tell them apart would be wrong on one of them every time.
    case "dialog-section":
      return { dialog: socket.dialog, panelId: socket.panelId, title: socket.label };
    default: {
      /**
       * Exhaustive on purpose.
       *
       * A kind with no arm here parses in the manifest, installs clean, passes
       * every socket test, and contributes NOTHING — with nothing anywhere
       * telling the plugin author why. That is the exact failure
       * `PLUGIN_SOCKET_REQUIREMENTS` was written to prevent one layer up, and
       * it is how eight kinds shipped renderable but undeclarable. The `never`
       * makes the eighteenth kind a compile error in this file rather than a
       * silent hole in someone else's surface.
       */
      const unhandled: never = socket.socket;
      void unhandled;
      return null;
    }
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
    // The three cross-kind fields in ONE read. They are not part of any kind's
    // payload shape — they describe the row's placement and identity — so the
    // per-kind parser above cannot answer for them, and each one this file
    // probed by hand was a field the writer had silently stripped.
    const tag = readPluginContributionEntityTag(row.payload);
    // Identity, in order of authority: the manifest socket the row fills, an id
    // the payload carries, then the socket kind — the last only holds one
    // contribution per plugin, which is all an older host could express.
    //
    // The payload id comes through the shared reader, which re-applies the
    // writer's 64-char ceiling. The probe this replaced did not, so a row from
    // a host with a different ceiling could seat an unbounded id here and then
    // fail to match the bounded one `disabledContributions` and the declaration
    // join are keyed on.
    const id = row.socketId?.trim() || tag.id || row.socket;
    if (disabled.has(id)) continue;
    contributions.push({
      pluginId: row.pluginId,
      socket: row.socket,
      surface,
      id,
      // `order` is placement, not payload. It reached here off the raw record
      // until the writer started carrying it, which meant every PUBLISHED
      // contribution had no order and sorted last, while static manifest ones
      // — which never pass through that parser — ordered correctly. One merged
      // list, two halves disagreeing about whether ordering worked at all.
      ...(tag.order !== undefined ? { order: tag.order } : {}),
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
    // Read through the shared helper rather than probing the payload here.
    // `row.payload` is `unknown` by design — it is plugin-authored JSON off IPC
    // or sync — so the writer's type never reaches this line and a hand-rolled
    // `typeof payload.filterKey === "string"` is not something a compiler
    // checks. Three surfaces each grew their own copy of that probe and all
    // three were reading a field the writer had stripped.
    const { filterKey } = readPluginContributionEntityTag(row.payload);
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
    surface,
    staticContributions,
    dynamicByEntity,
    identities,
    filterKeysByEntity,
  };
}

/**
 * The entity kinds a surface must read dynamic rows for.
 *
 * Two, not one. A surface carries its own entity kind — `lane` for Lanes, `pr`
 * for PRs — and that is what the read asked for, so a row published against the
 * TAB itself (`entityKind: "surface"`, `entityId: <surface>`) was fetched by
 * nobody. That is not a corner case: a plugin can only reach a client with no
 * manifest feed by publishing, so the phone receives `toolbar-action`,
 * `empty-state`, `filter-chip` and `file-viewer` as surface-keyed rows, and the
 * same plugin lit up on iOS and stayed dark on desktop.
 *
 * Deduplicated, because three surfaces (`cto`, `app`, `settings`) have no rows
 * of their own and already ARE `surface` — asking twice there would fetch the
 * same rows twice and render every contribution on them doubled.
 */
export function surfaceContributionEntityKinds(
  surface: PluginSurfaceId,
): readonly PluginEntityKind[] {
  const own = SURFACE_ENTITY_KIND[surface];
  return own === "surface" ? [own] : [own, "surface"];
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

/**
 * Kinds whose manifest entry RESERVES a slot instead of filling one.
 *
 * Every other kind is a control the plugin owns — a button, a section, a chip —
 * and drawing it from the manifest is how a plugin that publishes nothing still
 * appears. These two are not that: each is a per-entity VALUE, and a manifest
 * declaration has no entity. Drawing a declared `row-badge` put the same chip on
 * every row of the surface forever; the journal plugin's `"0"` on all six lanes
 * is what that looked like to a user. A declared `graph-node` is the same
 * mistake with a bigger footprint — one identical card beside every lane on the
 * canvas.
 *
 * The declaration still counts. It is what the install sheet describes, what
 * `listContributions` joins a published row against, and what the per-contribution
 * switch turns off — it just reserves the slot rather than filling it.
 */
const DECLARATION_ONLY_SOCKETS: ReadonlySet<PluginSocketKind> = new Set([
  "row-badge",
  "graph-node",
]);

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
 * of their own and read the SURFACE's rows instead.
 *
 * The two lookups are exclusive on purpose. An entity context reads that
 * entity's rows and not the surface's, because a row addressed to the tab is
 * about the tab: folding it in here would print a plugin's toolbar
 * contribution onto every lane on the list. A subject-less context reads the
 * surface's rows and nothing else, which is the case this function used to
 * answer with an empty array.
 *
 * The surface key comes from {@link pluginSurfaceContributionKey}, NOT from
 * {@link pluginContributionKeyForContext}. The two answer different questions
 * and giving the latter a surface answer breaks a different caller — see the
 * note on `entityMatchesPluginFilters`.
 */
export function selectContributions<K extends PluginSocketKind>(
  set: SurfaceContributionSet,
  socket: K,
  context?: PluginSurfaceContext | null,
): PluginContribution<K>[] {
  const entityKey = context ? pluginContributionKeyForContext(context) : null;
  // A surface-only context names its own surface; a caller that passed none is
  // asking about the set's surface, which is the same answer.
  const surfaceId = context?.kind === "surface" ? context.surface : set.surface;
  const key = entityKey ?? (surfaceId ? pluginSurfaceContributionKey(surfaceId) : null);
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
  // A DECLARED badge draws nothing, and neither does a declared graph node —
  // see {@link DECLARATION_ONLY_SOCKETS}.
  //
  // Dropped BEFORE the per-plugin cap rather than filtered after: a placeholder
  // counted against the cap would take a slot a real published row needed.
  const statics = DECLARATION_ONLY_SOCKETS.has(socket) ? [] : set.staticContributions.filter(
    (entry) => entry.socket === socket
      && !overriddenPlugins.has(entry.pluginId)
      && !overriddenIds.has(`${entry.pluginId} ${entry.id}`),
  );
  const merged = [...statics, ...dynamic].sort(comparePluginContributions);
  return capPerPlugin(merged) as PluginContribution<K>[];
}

/**
 * How many badges a plugin tab may show on the rail. One: a count, not a strip.
 *
 * Row badges stay at {@link PLUGIN_CONTRIBUTIONS_PER_SLOT_LIMIT} / the visible
 * row cap of 2. A rail icon is 20px and cannot host a second chip.
 */
export const PLUGIN_TAB_BADGE_VISIBLE_LIMIT = 1;

/**
 * The one `row-badge` a plugin published for its own rail tab, or null.
 *
 * Reads the plugin-tab entity (`<pluginId>/<tabSurfaceId>`), keeps only rows
 * that plugin owns, and takes the first after the host's order. A second
 * plugin publishing against the same address does not appear on this tab.
 */
export function selectPluginTabBadge(
  set: SurfaceContributionSet,
  pluginId: string,
  tabSurfaceId: string,
): PluginContribution<"row-badge"> | null {
  const address = pluginTabContributionKey(pluginId, tabSurfaceId).entityId;
  const badges = selectContributions(set, "row-badge", {
    kind: "plugin-tab",
    pluginId,
    surfaceId: tabSurfaceId,
  }).filter((entry) => entry.pluginId === pluginId && addressesPluginTab(entry, address));
  // Sliced rather than indexed, so the cap is the constant that documents it.
  return badges.slice(0, PLUGIN_TAB_BADGE_VISIBLE_LIMIT)[0] ?? null;
}

/**
 * Is this row published against the tab's own address?
 *
 * Re-read rather than trusted. A row's `entityId` is data another machine
 * wrote, and `"<pluginId>/<surfaceId>"` — exactly one slash — is the whole
 * reason a tab badge cannot be confused with a contribution on one of ADE's own
 * surfaces. Checking the shape where the pill is CHOSEN, and not only where it
 * is published, is what makes {@link parsePluginTabContributionEntityId} part
 * of the real path instead of a function only a test calls.
 *
 * A contribution with no entity at all is a declaration, and declarations do
 * not reach this kind — `selectContributions` drops static `row-badge` entries
 * — so it can only arrive from a caller that built one by hand.
 */
function addressesPluginTab(entry: PluginContribution<"row-badge">, address: string): boolean {
  const entityId = (entry as Partial<PluginEntityContribution>).entityId;
  if (entityId === undefined) return true;
  const parsed = parsePluginTabContributionEntityId(entityId);
  return parsed !== null && `${parsed.pluginId}/${parsed.surfaceId}` === address;
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
 * A surface-only context collapses to one key on purpose. It now DOES select
 * dynamic rows — the surface's own — but which rows those are is decided by the
 * set, and the set is already per surface: `derivedSetFor` hands a different
 * object to each one, so a memo keyed on `set` plus this string cannot serve
 * Lanes' surface rows to PRs.
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
  // The subject-less surfaces: the CTO thread, the window chrome (palette,
  // activity pane) and a settings section all contribute against the surface
  // itself, so a dynamic row for one is keyed by `surface` and nothing narrower.
  cto: "surface",
  app: "surface",
  settings: "surface",
};
