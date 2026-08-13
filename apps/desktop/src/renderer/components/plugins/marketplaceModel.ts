/**
 * The Marketplace's data model — pure functions only, no React.
 *
 * Everything the gallery and the detail page show is derived here: what the
 * catalogue contains, which entries a filter keeps, what order they sit in,
 * what a plugin adds, and which machines have it. Keeping it separate is not
 * tidiness — these are the parts with real edge cases (a directory entry that
 * disagrees with what is installed, a plugin installed from a URL that no
 * directory has ever heard of, a version that is newer locally than in the
 * index), and they are only testable if no component owns them.
 *
 * Three rules run through the whole file:
 *
 * 1. **Installed beats indexed.** The machine's own registry is the truth about
 *    what is installed and at what version; the directory is the truth about
 *    what EXISTS. Where they disagree the merge keeps both facts rather than
 *    picking one, because "installed 1.2.0, directory has 1.3.0" is an update
 *    prompt, not a conflict.
 * 2. **Unknown numbers stay unknown.** `installs` and `stars` are `null` when
 *    nobody has published them, and null never renders as `0`. A bundled entry
 *    with invented popularity would make the whole directory untrustworthy.
 * 3. **Nothing is dropped silently.** A plugin installed from outside any
 *    directory still appears in the gallery (as a sideloaded listing), because
 *    a Marketplace that cannot see half of what is installed is worse than no
 *    Marketplace.
 */

import {
  comparePluginVersions,
  isValidPluginId,
  isValidPluginVersion,
  type PluginManifest,
} from "../../../shared/plugins/manifest";
import {
  parsePluginRegistryEntry,
  type PluginRegistryEntry,
  type PluginRegistryLinks,
  type PluginRegistryMedia,
} from "../../../shared/plugins/registryIndex";
import { PLUGIN_SURFACE_IDS, type PluginSurfaceId } from "../../../shared/plugins/sockets";
import type { PluginThemeTokens } from "../../lib/pluginTheme";
import type { InstalledPlugin, PluginPresenceRow } from "../../lib/pluginRuntimeBridge";

/* ── Listing ────────────────────────────────────────────────────────────── */

/** Where a listing's facts came from. Drives the honesty of the stats row. */
export type MarketplaceListingOrigin = "directory" | "bundled" | "installed";

export type MarketplaceListing = {
  pluginId: string;
  displayName: string;
  author: string;
  /** One line. Longer text belongs in the readme. */
  description: string;
  /** The version the catalogue offers — not necessarily the installed one. */
  version: string;
  icon: string | null;
  accent: string | null;
  /** A published image tile. Null for everything the app draws a glyph for. */
  iconUrl: string | null;
  /**
   * The canonical repository page, when the catalogue knows one.
   *
   * Distinct from `source`, which is what an install clones — they are the same
   * URL today, and the star button and the author link both need the one that
   * means "this project's page" rather than "where the bytes come from".
   */
  repo: string | null;
  /** Screenshots and clips for the detail page. Empty for most plugins. */
  media: PluginRegistryMedia[];
  /** Named links for the resources rail. Null when nothing published any. */
  links: PluginRegistryLinks | null;
  official: boolean;
  featured: boolean;
  /** Themes get their own chip and their own detail rail. */
  isTheme: boolean;
  installs: number | null;
  stars: number | null;
  /** ISO. Sorts "New"; null sorts last. */
  publishedAt: string | null;
  /** Git URL or local path. Empty for a listing with no installable source. */
  source: string;
  changelogUrl: string | null;
  readme: string | null;
  /** Full manifest when the catalogue published one — the best "Adds" source. */
  manifest: PluginManifest | null;
  /** Fallback "Adds" lines for a catalogue entry with no manifest. */
  addsSummary: string[];
  /** Core surfaces this plugin extends, for the facet chips. */
  surfaces: PluginSurfaceId[];
  themeTokens: PluginThemeTokens | null;
  origin: MarketplaceListingOrigin;
};

/** Presentation-facing surface names. Sentence case, product vocabulary. */
export const SURFACE_LABELS: Record<PluginSurfaceId, string> = {
  work: "Work",
  lanes: "Lanes",
  files: "Files",
  prs: "PRs",
  automations: "Automations",
  cto: "CTO",
};

/* ── Directory entries ──────────────────────────────────────────────────── */

/**
 * Surfaces a manifest touches, de-duplicated and in canonical order.
 *
 * Canonical order rather than declaration order so two plugins that extend the
 * same surfaces produce the same facet string, which is what lets the gallery
 * group them.
 */
export function surfacesFromManifest(manifest: PluginManifest | null): PluginSurfaceId[] {
  if (!manifest) return [];
  const present = new Set(manifest.sockets.map((socket) => socket.surface));
  return PLUGIN_SURFACE_IDS.filter((surface) => present.has(surface));
}

/**
 * Turn a validated directory entry into a listing.
 *
 * The wire shape and its validation belong to `shared/plugins/registryIndex.ts`
 * — that is where the URL safety rules, the length caps and the checksum
 * handling live, and re-deriving any of them here would mean the gallery
 * eventually trusts something the registry contract does not. This function is
 * only the presentation adapter.
 *
 * Directory entries carry no manifest: the crawler publishes a summary, not the
 * plugin. So `manifest` stays null and the "Adds" list falls back to the
 * entry's own `adds` lines, which {@link describePluginAdds} labels
 * accordingly.
 */
export function listingFromRegistryEntry(entry: PluginRegistryEntry): MarketplaceListing {
  return {
    pluginId: entry.pluginId,
    displayName: entry.displayName,
    author: entry.author,
    description: entry.description,
    version: entry.version,
    icon: entry.icon,
    accent: entry.accent,
    iconUrl: entry.iconUrl,
    repo: entry.repo,
    media: entry.media,
    links: entry.links,
    official: entry.official,
    featured: entry.featured,
    isTheme: entry.isTheme,
    installs: entry.installs,
    stars: entry.stars,
    publishedAt: entry.publishedAt ?? entry.updatedAt,
    source: entry.source,
    changelogUrl: entry.changelogUrl,
    readme: entry.readme,
    manifest: null,
    addsSummary: entry.adds,
    surfaces: entry.surfaces,
    themeTokens: null,
    origin: "directory",
  };
}

/**
 * Read one directory entry, dropping it if the registry contract refuses it.
 *
 * Tolerant by design: the directory is built by a scheduled job over
 * third-party repositories, so a malformed entry is a routine event and must
 * cost exactly that entry, never the page.
 */
export function parseMarketplaceEntry(raw: unknown): MarketplaceListing | null {
  const parsed = parsePluginRegistryEntry(raw);
  return "entry" in parsed ? listingFromRegistryEntry(parsed.entry) : null;
}

/* ── Merge ──────────────────────────────────────────────────────────────── */

/** Why the gallery is showing what it is showing. Rendered verbatim, so it is honest. */
export type MarketplaceIndexState =
  | { kind: "live"; fetchedAt: string | null; origin: "network" | "cache" }
  /** The host can fetch, but this attempt failed. Bundled entries are showing. */
  | { kind: "stale" }
  /** This host has no directory access at all. */
  | { kind: "unsupported" };

export type MergedCatalogue = {
  listings: MarketplaceListing[];
  state: MarketplaceIndexState;
};

/**
 * Fold the bundled index, the live directory, and what is installed into one
 * catalogue.
 *
 * Precedence is directory over bundled for the same id — a shipped entry is a
 * floor, not a ceiling, and a stale bundled description should never mask the
 * published one. Installed-but-unlisted plugins are appended as sideloaded
 * listings so the gallery accounts for everything on the machine.
 */
export function mergeMarketplaceCatalogue(input: {
  bundled: readonly MarketplaceListing[];
  live: readonly MarketplaceListing[] | null;
  installed: readonly InstalledPlugin[];
  liveMeta?: { fetchedAt: string | null; origin: "network" | "cache" } | null;
  /** False when the host exposes no directory member at all. */
  browseSupported?: boolean;
}): MergedCatalogue {
  const byId = new Map<string, MarketplaceListing>();
  for (const listing of input.bundled) byId.set(listing.pluginId, { ...listing, origin: "bundled" });
  for (const listing of input.live ?? []) byId.set(listing.pluginId, listing);

  for (const plugin of input.installed) {
    if (byId.has(plugin.pluginId)) continue;
    byId.set(plugin.pluginId, listingFromInstalled(plugin));
  }

  const state: MarketplaceIndexState = input.browseSupported === false
    ? { kind: "unsupported" }
    : input.live
      ? {
        kind: "live",
        fetchedAt: input.liveMeta?.fetchedAt ?? null,
        origin: input.liveMeta?.origin ?? "network",
      }
      : { kind: "stale" };

  return { listings: [...byId.values()], state };
}

/**
 * A listing for a plugin that is installed but appears in no directory.
 *
 * It carries `origin: "installed"` so the UI can say where it came from instead
 * of implying the directory vouches for it, and no stats at all — there are
 * none to know.
 */
export function listingFromInstalled(plugin: InstalledPlugin): MarketplaceListing {
  return {
    pluginId: plugin.pluginId,
    displayName: plugin.displayName,
    author: "Installed directly",
    description: "",
    version: plugin.version,
    icon: plugin.icon,
    accent: plugin.accent,
    iconUrl: null,
    repo: null,
    media: [],
    links: null,
    official: false,
    featured: false,
    isTheme: plugin.theme !== null,
    installs: null,
    stars: null,
    publishedAt: null,
    source: "",
    changelogUrl: null,
    readme: null,
    manifest: null,
    addsSummary: [],
    surfaces: [],
    themeTokens: plugin.theme?.tokens ?? null,
    origin: "installed",
  };
}

/**
 * A listing for a manifest read straight off a source, before anything is
 * installed. Used by install-from-URL so the modal can show the real "Adds"
 * list instead of a promise to look later.
 */
export function listingFromManifest(manifest: PluginManifest, source: string): MarketplaceListing {
  return {
    pluginId: manifest.name,
    displayName: manifest.displayName,
    author: "From this source",
    description: manifest.description,
    version: manifest.version,
    icon: manifest.icon ?? null,
    accent: manifest.accent ?? null,
    iconUrl: null,
    repo: null,
    media: [],
    links: null,
    // `official` in a manifest is the author's claim about themselves. Only the
    // directory can vouch for it, so a manifest read off an arbitrary URL never
    // earns the badge here.
    official: false,
    featured: false,
    isTheme: manifest.theme !== undefined,
    installs: null,
    stars: null,
    publishedAt: null,
    source,
    changelogUrl: null,
    readme: null,
    manifest,
    addsSummary: [],
    surfaces: surfacesFromManifest(manifest),
    themeTokens: manifest.theme?.tokens ?? null,
    origin: "installed",
  };
}

/* ── Install state ──────────────────────────────────────────────────────── */

export type ListingInstallState =
  | { kind: "available" }
  | { kind: "installed"; version: string }
  | { kind: "disabled"; version: string }
  /** Installed, and the catalogue offers something newer. */
  | { kind: "update"; version: string; available: string };

export function installStateFor(
  listing: MarketplaceListing,
  installed: readonly InstalledPlugin[],
): ListingInstallState {
  const match = installed.find((plugin) => plugin.pluginId === listing.pluginId);
  if (!match) return { kind: "available" };
  const newer = listing.version
    && isValidPluginVersion(match.version)
    && comparePluginVersions(listing.version, match.version) > 0;
  if (newer) return { kind: "update", version: match.version, available: listing.version };
  if (!match.enabled) return { kind: "disabled", version: match.version };
  return { kind: "installed", version: match.version };
}

/* ── Adds ───────────────────────────────────────────────────────────────── */

function joinSurfaceNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The "Adds:" lines — the one part of the install modal that is load-bearing
 * for trust, since it is the reader's only preview of what changes.
 *
 * Derived from the manifest when there is one so the list cannot flatter the
 * plugin: it counts what the plugin actually declared. A catalogue entry with
 * no manifest falls back to its own summary, which the modal labels as coming
 * from the directory rather than from the plugin.
 */
export function describePluginAdds(listing: MarketplaceListing): string[] {
  const manifest = listing.manifest;
  if (!manifest) {
    if (listing.addsSummary.length > 0) return listing.addsSummary;
    // No manifest and no summary is the normal case for a crawled community
    // entry: the crawler publishes the FACTS a plugin declares and stopped
    // publishing prose, because its wording was a second copy of this modal's
    // and the two had drifted apart. The facts still say something worth
    // reading, and a blank "Adds" list on the one screen that exists to say
    // what changes is the worst possible answer.
    const lines: string[] = [];
    if (listing.isTheme) lines.push("A colour theme");
    if (listing.surfaces.length > 0) {
      lines.push(`Adds to ${joinSurfaceNames(listing.surfaces.map((surface) => SURFACE_LABELS[surface]))}`);
    }
    return lines;
  }

  const lines: string[] = [];
  const tabs = manifest.surfaces.filter((surface) => surface.kind === "tab");
  const panes = manifest.surfaces.filter((surface) => surface.kind === "pane");
  const webviews = manifest.surfaces.filter((surface) => surface.kind === "webview");
  for (const tab of tabs) lines.push(`${tab.title} tab`);
  for (const pane of panes) lines.push(`${pane.title} pane`);
  // Said on the line itself rather than as a chip somewhere else on the page:
  // this is the reader's one preview of what installing changes, and "this tab
  // only works on my computer" is exactly the kind of thing they should not
  // have to go looking for.
  for (const webview of webviews) lines.push(`${webview.title} tab — desktop only, custom UI`);

  const bySurface = new Map<PluginSurfaceId, number>();
  for (const socket of manifest.sockets) {
    bySurface.set(socket.surface, (bySurface.get(socket.surface) ?? 0) + 1);
  }
  for (const surface of PLUGIN_SURFACE_IDS) {
    const total = bySurface.get(surface);
    if (!total) continue;
    lines.push(total === 1
      ? `One addition to ${SURFACE_LABELS[surface]}`
      : `${total} additions to ${SURFACE_LABELS[surface]}`);
  }

  if (manifest.cli.length > 0) {
    lines.push(`Terminal commands: ${manifest.cli.map((word) => `ade ${manifest.name} ${word}`).join(", ")}`);
  }
  if (manifest.skills.length > 0) {
    lines.push(manifest.skills.length === 1
      ? "One agent skill"
      : `${manifest.skills.length} agent skills`);
  }
  if (manifest.theme) lines.push("A colour theme");
  if (Object.keys(manifest.collections).length > 0) {
    const synced = Object.values(manifest.collections).filter((collection) => collection.sync).length;
    lines.push(synced > 0 ? "Stores data, and syncs it to your other devices" : "Stores data on this machine");
  }
  if (manifest.entry) lines.push("Runs code on this machine");
  return lines;
}

/* ── Filter, sort, search ───────────────────────────────────────────────── */

export type MarketplaceChip = "all" | "installed" | "official" | "featured" | "themes";
export type MarketplaceSort = "installs" | "stars" | "new";

/**
 * Plugin ids present on this machine, in the shape the chip filter wants.
 *
 * The installed set is not part of {@link MarketplaceQuery} because it is not
 * something the reader chose — it changes under them as installs land, and a
 * query that carried it would go stale the moment one did.
 */
export function installedPluginIds(installed: readonly InstalledPlugin[]): ReadonlySet<string> {
  return new Set(installed.map((plugin) => plugin.pluginId));
}

const NO_INSTALLS: ReadonlySet<string> = new Set<string>();

export type MarketplaceQuery = {
  search: string;
  chip: MarketplaceChip;
  /** Facet: keep only listings that extend every selected surface. */
  surfaces: readonly PluginSurfaceId[];
  sort: MarketplaceSort;
};

export const DEFAULT_MARKETPLACE_QUERY: MarketplaceQuery = {
  search: "",
  chip: "all",
  surfaces: [],
  sort: "installs",
};

function matchesSearch(listing: MarketplaceListing, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (needle.length === 0) return true;
  const haystack = [
    listing.displayName,
    listing.pluginId,
    listing.author,
    listing.description,
  ].join(" ").toLowerCase();
  // Every word must appear somewhere: "theme dark" should find a dark theme,
  // not everything that mentions either word.
  return needle.split(/\s+/).every((word) => haystack.includes(word));
}

function matchesChip(
  listing: MarketplaceListing,
  chip: MarketplaceChip,
  installed: ReadonlySet<string>,
): boolean {
  switch (chip) {
    case "installed":
      return installed.has(listing.pluginId);
    case "official":
      return listing.official;
    case "featured":
      return listing.featured;
    case "themes":
      return listing.isTheme;
    case "all":
    default:
      return true;
  }
}

/**
 * Sort comparator.
 *
 * Null counts sort AFTER every known count rather than as zero — a plugin
 * nobody has published numbers for is unranked, not unpopular. Ties and
 * unranked entries fall back to name so the order is stable across renders.
 */
function compareListings(a: MarketplaceListing, b: MarketplaceListing, sort: MarketplaceSort): number {
  const byName = a.displayName.localeCompare(b.displayName);
  if (sort === "new") {
    const left = a.publishedAt ? Date.parse(a.publishedAt) : null;
    const right = b.publishedAt ? Date.parse(b.publishedAt) : null;
    if (left === right) return byName;
    if (left === null) return 1;
    if (right === null) return -1;
    return right - left;
  }
  const left = sort === "stars" ? a.stars : a.installs;
  const right = sort === "stars" ? b.stars : b.installs;
  if (left === right) return byName;
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left;
}

export function queryMarketplace(
  listings: readonly MarketplaceListing[],
  query: MarketplaceQuery,
  /** From {@link installedPluginIds}. Only the "installed" chip reads it. */
  installed: ReadonlySet<string> = NO_INSTALLS,
): MarketplaceListing[] {
  const surfaces = query.surfaces;
  return listings
    .filter((listing) => matchesChip(listing, query.chip, installed))
    .filter((listing) => surfaces.every((surface) => listing.surfaces.includes(surface)))
    .filter((listing) => matchesSearch(listing, query.search))
    .sort((a, b) => compareListings(a, b, query.sort));
}

export type SurfaceFacet = { surface: PluginSurfaceId; label: string; total: number };

/**
 * Facet chips for the surfaces present in a catalogue.
 *
 * Counted against the chip/search-filtered set but NOT against the facet
 * selection itself, so selecting a facet cannot make the other facets vanish —
 * the classic dead-end where a filter bar can only ever be narrowed.
 */
export function deriveSurfaceFacets(
  listings: readonly MarketplaceListing[],
  query: MarketplaceQuery,
  installed: ReadonlySet<string> = NO_INSTALLS,
): SurfaceFacet[] {
  const scoped = listings
    .filter((listing) => matchesChip(listing, query.chip, installed))
    .filter((listing) => matchesSearch(listing, query.search));
  return PLUGIN_SURFACE_IDS
    .map((surface) => ({
      surface,
      label: SURFACE_LABELS[surface],
      total: scoped.filter((listing) => listing.surfaces.includes(surface)).length,
    }))
    .filter((facet) => facet.total > 0);
}

export function featuredListings(listings: readonly MarketplaceListing[]): MarketplaceListing[] {
  return listings
    .filter((listing) => listing.featured)
    .sort((a, b) => compareListings(a, b, "installs"))
    .slice(0, 3);
}

/* ── Machine coverage ───────────────────────────────────────────────────── */

export type CoverageState = "installed" | "disabled" | "outdated" | "missing" | "unknown";

export type MachineCoverageRow = {
  machineKey: string;
  machineName: string;
  isThisMachine: boolean;
  online: boolean;
  state: CoverageState;
  version: string | null;
};

/**
 * One row per machine in the account, for a single plugin.
 *
 * This machine's row comes from the local registry, never from presence: a
 * presence table is a synced cache and can lag its own machine by a round
 * trip, and a coverage matrix that tells you your own machine does not have
 * something you just installed destroys trust in the whole rail.
 *
 * An offline machine reports `unknown` rather than `missing` for the same
 * reason — absence of a presence row is absence of information.
 */
export function deriveMachineCoverage(input: {
  pluginId: string;
  /** The catalogue version, for the outdated comparison. Null skips it. */
  catalogueVersion: string | null;
  presence: readonly PluginPresenceRow[];
  installed: readonly InstalledPlugin[];
  thisMachineKey: string | null;
  thisMachineName?: string;
}): MachineCoverageRow[] {
  const local = input.installed.find((plugin) => plugin.pluginId === input.pluginId) ?? null;
  const machines = new Map<string, { name: string; online: boolean }>();
  for (const row of input.presence) {
    const existing = machines.get(row.machineKey);
    machines.set(row.machineKey, {
      name: row.machineName || existing?.name || row.machineKey,
      online: row.online || existing?.online || false,
    });
  }
  if (input.thisMachineKey && !machines.has(input.thisMachineKey)) {
    machines.set(input.thisMachineKey, { name: input.thisMachineName ?? "This machine", online: true });
  }

  // A host that publishes no presence at all still has one machine: this one.
  if (machines.size === 0) {
    machines.set("local", { name: input.thisMachineName ?? "This machine", online: true });
  }

  const rows: MachineCoverageRow[] = [];
  for (const [machineKey, machine] of machines) {
    const isThisMachine = machineKey === (input.thisMachineKey ?? "local");
    const presenceRow = input.presence.find((row) =>
      row.machineKey === machineKey && row.pluginId === input.pluginId) ?? null;

    const version = isThisMachine ? (local?.version ?? null) : (presenceRow?.version ?? null);
    const enabled = isThisMachine ? (local?.enabled ?? false) : (presenceRow?.enabled ?? false);
    const present = isThisMachine ? local !== null : presenceRow !== null;

    let state: CoverageState;
    if (present) {
      const outdated = input.catalogueVersion
        && version
        && isValidPluginVersion(version)
        && comparePluginVersions(input.catalogueVersion, version) > 0;
      state = outdated ? "outdated" : enabled ? "installed" : "disabled";
    } else if (!isThisMachine && !machine.online) {
      state = "unknown";
    } else {
      state = "missing";
    }

    rows.push({
      machineKey,
      machineName: machine.name,
      isThisMachine,
      online: isThisMachine ? true : machine.online,
      state,
      version,
    });
  }

  // This machine first, then reachable machines, then the rest by name — the
  // order someone scanning for "where is it missing" reads in.
  return rows.sort((a, b) => {
    if (a.isThisMachine !== b.isThisMachine) return a.isThisMachine ? -1 : 1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    return a.machineName.localeCompare(b.machineName);
  });
}

/**
 * How many machines have the plugin, for the gallery's coverage dots. Machines
 * whose state is unknown count as neither present nor absent.
 */
export function coverageSummary(rows: readonly MachineCoverageRow[]): {
  present: number;
  total: number;
  unknown: number;
} {
  const known = rows.filter((row) => row.state !== "unknown");
  return {
    present: known.filter((row) => row.state === "installed" || row.state === "outdated").length,
    total: known.length,
    unknown: rows.length - known.length,
  };
}

/* ── Route ──────────────────────────────────────────────────────────────── */

/**
 * The Marketplace's own route parser.
 *
 * The page is mounted directly by the app shell rather than through a `Route`
 * element (machine-level surfaces are conditionally rendered, see `App.tsx`),
 * so there is no `useParams` to read. Parsing the path here keeps that a
 * detail of this module and gives the gallery/detail switch a pure test.
 */
export function marketplaceRouteFromPath(pathname: string): { pluginId: string | null } {
  const match = /^\/marketplace\/([^/?#]+)/.exec(pathname);
  if (!match) return { pluginId: null };
  let pluginId: string;
  try {
    pluginId = decodeURIComponent(match[1]!);
  } catch {
    // A malformed escape (`%zz`) throws. A bad link should land on the gallery,
    // not take the route out from under the page that was about to render it.
    return { pluginId: null };
  }
  return { pluginId: isValidPluginId(pluginId) ? pluginId : null };
}

/* ── Source ─────────────────────────────────────────────────────────────── */

export type PluginSourceDisplay = {
  /** Short enough to sit on one line beside a plugin name. */
  text: string;
  /** Non-null only when a browser can actually open it. */
  url: string | null;
};

/**
 * Where a plugin comes from, in a form someone can read before approving it.
 *
 * The `url` half is what stops the dead "View source" button: a plugin
 * installed from a folder on this machine has no page to open, so a control
 * that says it will open one is a lie. Callers show the text either way and the
 * link only when there is one.
 */
export function describePluginSource(source: string): PluginSourceDisplay | null {
  const value = source.trim();
  if (!value) return null;

  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
      return { text: path ? `${url.host}/${path}` : url.host, url: value };
    } catch {
      return { text: value, url: null };
    }
  }

  // A bare plugin id is the bundled package: no scheme, no separator, nothing
  // to fetch. It is what a bundled listing installs from, so it has to read as
  // a fact rather than as a mystery folder name.
  const isBundledId: boolean = isValidPluginId(value);
  if (isBundledId) return { text: "Included with ADE", url: null };

  // `git@host:owner/repo.git` — a real source, but not one a browser opens.
  const scp = /^[^@\s]+@([^:\s]+):(.+)$/.exec(value);
  if (scp) return { text: `${scp[1]}/${scp[2]!.replace(/\.git$/i, "")}`, url: null };

  // A local path. Both separators, because a Windows path is the common case
  // for a plugin someone is building on their own machine.
  const parts = value.split(/[\\/]/).filter(Boolean);
  const tail = parts.slice(-2).join("/");
  return { text: parts.length > 2 ? `…/${tail}` : value, url: null };
}

/**
 * The author's page, when the catalogue points at somewhere a person lives.
 *
 * Derived from the repository URL rather than from the author name, because a
 * name is text an entry writes about itself and an owner path is a place. A
 * plugin with no repository gets no link, which is the honest answer for
 * something installed from a folder.
 */
export function pluginAuthorUrl(listing: MarketplaceListing): string | null {
  const repo = listing.repo ?? listing.links?.repository ?? null;
  if (!repo) return null;
  let url: URL;
  try {
    url = new URL(repo);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const owner = url.pathname.split("/").filter(Boolean)[0];
  return owner ? `${url.origin}/${owner}` : null;
}

export type PluginResourceLink = { label: string; url: string };

/**
 * The resources rail: every link the catalogue published, labelled.
 *
 * Order is fixed and is a reading order, not the entry's: source first because
 * it is the one that answers "what am I about to run", then the rest. The
 * install source is appended only when it is somewhere else — a plugin whose
 * repository IS its source should not get the same URL under two labels.
 */
export function describePluginResources(listing: MarketplaceListing): PluginResourceLink[] {
  const links = listing.links;
  const seen = new Set<string>();
  const rail: PluginResourceLink[] = [];
  const add = (label: string, url: string | null | undefined) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    rail.push({ label, url });
  };

  add("View source", listing.repo ?? links?.repository ?? null);
  add("Homepage", links?.homepage);
  add("Documentation", links?.docs);
  add("Changelog", links?.changelog ?? listing.changelogUrl);
  add("Licence", links?.license);
  add("Install source", describePluginSource(listing.source)?.url ?? null);
  return rail;
}

/* ── Formatting ─────────────────────────────────────────────────────────── */

/** `1.2k`, `18` — or null, which callers render as nothing rather than `0`. */
export function formatCount(value: number | null): string | null {
  if (value === null) return null;
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${Math.max(0, Math.round(value))} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
