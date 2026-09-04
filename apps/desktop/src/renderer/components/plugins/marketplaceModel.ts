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
  describeManifestAdds,
  joinSurfaceNames,
  PLUGIN_SURFACE_LABELS,
} from "../../../shared/plugins/installDisclosure";
import {
  comparePluginVersions,
  isValidPluginId,
  isValidPluginVersion,
  pluginRailTabSurface,
  type PluginManifest,
} from "../../../shared/plugins/manifest";
import {
  parsePluginRegistryEntry,
  type PluginRegistryEntry,
  type PluginRegistryExtraDownload,
  type PluginRegistryLinks,
  type PluginRegistryMedia,
} from "../../../shared/plugins/registryIndex";
import { PLUGIN_SURFACE_IDS, type PluginSurfaceId } from "../../../shared/plugins/sockets";
import type { PluginThemeTokens } from "../../lib/pluginTheme";
import type { InstalledPlugin, PluginPresenceRow, PluginUsageRow } from "../../lib/pluginRuntimeBridge";

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
  /** Themes get their own view and their own detail rail. */
  isTheme: boolean;
  /**
   * What KIND of thing this is, for the gallery's two views and its type chips.
   *
   * Derived — never published. See {@link derivePluginKind} for the rule and
   * for why a catalogue entry is not allowed to name its own kind.
   */
  kind: MarketplacePluginKind;
  installs: number | null;
  stars: number | null;
  /**
   * What installing costs to download, in bytes, when the catalogue measured
   * it.
   *
   * Optional rather than `number | null`, and that is about who has an answer
   * rather than about convenience: a directory entry can carry a size, and a
   * plugin that ships INSIDE ADE downloads nothing at all, so the bundled index
   * has no field to fill. Both cases render the same — nothing — because a
   * plugin whose size is unknown and a plugin that costs nothing to fetch are
   * equally badly served by the string "0 B".
   */
  sizeBytes?: number | null;
  /** What the plugin fetches for itself later. Absent for nearly every plugin. */
  extraDownloads?: readonly PluginRegistryExtraDownload[];
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
/**
 * Re-exported rather than declared: the install approval card an agent raises
 * from `plugin.install` shows the same surface names, and it lives in the host
 * where this renderer module cannot be imported.
 */
export const SURFACE_LABELS = PLUGIN_SURFACE_LABELS;

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

/* ── Kind ───────────────────────────────────────────────────────────────── */

/**
 * What a plugin IS, in the four words the gallery sorts people by.
 *
 * A single flat list of plugins asks the reader to work out, one card at a
 * time, whether a package is a colour theme, a service they must sign in to, a
 * verb their agent gains, or a screen. Those four are not variations of one
 * thing — they are answered before anyone reads a description — so the gallery
 * splits on them.
 */
export type MarketplacePluginKind = "theme" | "integration" | "tool" | "view";

/** The kinds the Plugins view can be filtered by. Themes are their own view. */
export type MarketplaceTypeFilter = Exclude<MarketplacePluginKind, "theme">;

export const MARKETPLACE_TYPE_FILTERS: readonly MarketplaceTypeFilter[] = [
  "integration",
  "tool",
  "view",
];

export const MARKETPLACE_TYPE_LABELS: Record<MarketplaceTypeFilter, string> = {
  integration: "Integrations",
  tool: "Tools",
  view: "Views",
};

/**
 * Which of the four a listing is.
 *
 * Read off the MANIFEST rather than off a field the catalogue publishes, for
 * the same reason `official` is set from the registry's own curated file and
 * never from a manifest's self-description: a kind chip is a filing decision
 * ADE makes, and a package that could file itself would file itself wherever
 * traffic is. What the manifest declares is not a claim — it is the list of
 * things the host will actually let the plugin do.
 *
 * The rule, first match wins:
 *
 * 1. **theme** — it declares a palette. A theme adds nothing else, and lives in
 *    the other view.
 * 2. **integration** — it reaches outside this machine: a sign-in flow, an
 *    allowed host, a webhook channel, or a URL shape it claims. That is the
 *    fact a reader wants first, because it is the one with an account and a
 *    credential behind it.
 * 3. **tool** — it gives the agent verbs (`tools`), the CLI words, or
 *    automation steps, and it opens NO rail tab. The "no tab" half is what
 *    keeps the chip honest: nearly every plugin with a page also ships a couple
 *    of tools, and filing those under Tools would leave the chip meaning
 *    nothing.
 * 4. **view** — everything else: a page, a panel, a socket into a core surface.
 *
 * A directory entry carries no manifest (the crawler publishes a summary, not
 * the package), so it can only be split into theme and view. That is the
 * honest answer rather than a guess: it becomes exact the moment the entry's
 * manifest is read, which is at install.
 */
export function derivePluginKind(
  listing: Pick<MarketplaceListing, "manifest" | "isTheme">,
): MarketplacePluginKind {
  const manifest = listing.manifest;
  if (manifest ? manifest.theme !== undefined : listing.isTheme) return "theme";
  if (!manifest) return "view";

  const reachesOutside = (manifest.authSessions ?? []).length > 0
    || manifest.network !== undefined
    || manifest.webhookIngress.length > 0
    || (manifest.urlMatchers ?? []).length > 0;
  if (reachesOutside) return "integration";

  const carriesVerbs = manifest.tools.length > 0
    || manifest.cli.length > 0
    || manifest.automationSteps.length > 0;
  if (carriesVerbs && pluginRailTabSurface(manifest.surfaces) === null) return "tool";

  return "view";
}

/**
 * Re-derive `kind` after something changed the manifest under a listing.
 *
 * The merge is the one place that happens: a live entry that inherits the
 * bundled manifest goes from knowing nothing about itself to knowing
 * everything, and a listing carrying the kind it had BEFORE that would file a
 * sign-in flow under Views.
 */
export function withDerivedKind(listing: MarketplaceListing): MarketplaceListing {
  const kind = derivePluginKind(listing);
  return kind === listing.kind ? listing : { ...listing, kind };
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
    // A directory entry publishes no manifest, so this is theme-or-view. See
    // {@link derivePluginKind}.
    kind: entry.isTheme ? "theme" : "view",
    installs: entry.installs,
    stars: entry.stars,
    sizeBytes: entry.sizeBytes,
    extraDownloads: entry.extraDownloads,
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

/**
 * Whether the machine this page acts on answered for its own installed plugins.
 *
 * The Marketplace is a MACHINE-level page whose calls follow the project tab's
 * runtime, so "installed" means installed on THAT machine — the remote one when
 * the active project is bound to another machine. The registry read is the only
 * part of the page that can fail per machine, and it used to fail silently: the
 * page waited on a load that never settled and drew its skeleton forever, which
 * reads as a Marketplace that does not open.
 *
 * So the failure is a state with a sentence, not an absence.
 */
export type MarketplaceRegistryState =
  /** The machine answered. `installed` is fact. */
  | { kind: "ready" }
  /** Asked; the first answer has not arrived. */
  | { kind: "loading" }
  /** That machine runs no plugin host, and never will within this session. */
  | { kind: "unavailable" }
  /** The call rejected — an unreachable machine, or one with no `plugin` domain. */
  | { kind: "unreachable" };

/**
 * The one sentence the page says about a machine that did not answer.
 *
 * Pure, and separated from the component, because the wording is the whole
 * behaviour here: what a reader must never conclude is "this plugin is not
 * installed" from a machine that was never asked. Naming the machine is what
 * makes the difference between the two readings visible.
 *
 * Returns null while the answer is good or still coming — there is nothing
 * honest to say then, and a reassurance line is noise.
 */
export function describeMarketplaceRegistry(input: {
  state: MarketplaceRegistryState;
  /**
   * The machine the page acts on, when it is not this one. Null means the
   * calls are staying on this computer, so no name is needed to place them.
   */
  machineName: string | null;
}): string | null {
  const { state, machineName } = input;
  if (state.kind === "ready" || state.kind === "loading") return null;
  const machine = machineName?.trim() || null;
  if (state.kind === "unavailable") {
    return machine
      ? `${machine} doesn’t run plugins, so it can’t say what is installed there. This is the catalogue only.`
      : "Plugins aren’t available on this computer. This is the catalogue only.";
  }
  return machine
    ? `Can’t reach ${machine}, so what is installed there is unknown. This is the catalogue only.`
    : "This computer isn’t answering about plugins, so what is installed is unknown. This is the catalogue only.";
}

export type MergedCatalogue = {
  listings: MarketplaceListing[];
  state: MarketplaceIndexState;
};

/**
 * Choose between the bundled copy and the published entry for one plugin id.
 *
 * The higher version wins, and a tie goes to the directory. That is the whole
 * rule, and the reason for it is that "directory over bundled unconditionally"
 * is only right while the directory is ahead: a registry index generated before
 * the app shipped lists the same ids at OLDER versions pointing at older trees,
 * and letting it win turns the gallery into a downgrade button.
 *
 * A version that does not parse is treated as lower than one that does, so a
 * malformed entry can never take a real one's place.
 *
 * When bundled wins it keeps `origin: "bundled"` and its own install source —
 * the plugin id, which installs the copy inside the app — but inherits the
 * live entry's measured stats, so winning on version never costs the card its
 * install count or stars.
 *
 * When live wins it inherits the bundled manifest ONLY at equal versions. A
 * newer published version has a manifest nobody here has read, and the install
 * dialog's "read during install" line is the honest answer for it; showing the
 * older bundled manifest's Adds list would describe a package that is not the
 * one being installed.
 */
function chooseCatalogueListing(
  bundled: MarketplaceListing,
  live: MarketplaceListing,
): MarketplaceListing {
  const rank = (value: string): number => (isValidPluginVersion(value) ? 1 : 0);
  const bundledRank = rank(bundled.version);
  const liveRank = rank(live.version);
  const order = bundledRank !== liveRank
    ? bundledRank - liveRank
    : bundledRank === 0
      ? 0
      : comparePluginVersions(bundled.version, live.version);

  if (order > 0) {
    return {
      ...bundled,
      origin: "bundled",
      source: bundled.source,
      installs: live.installs ?? bundled.installs,
      stars: live.stars ?? bundled.stars,
      publishedAt: live.publishedAt ?? bundled.publishedAt,
    };
  }

  if (order === 0 && live.manifest === null && bundled.manifest !== null) {
    return { ...live, manifest: bundled.manifest };
  }
  return live;
}

/**
 * Fold the bundled index, the live directory, and what is installed into one
 * catalogue.
 *
 * For the same id the HIGHER VERSION wins, with a tie going to the directory —
 * a stale bundled description must never mask the published one, and an index
 * that predates this build must never mask what shipped inside it. See
 * {@link chooseCatalogueListing} for what each winner keeps.
 * Installed-but-unlisted plugins are appended as sideloaded listings so the
 * gallery accounts for everything on the machine.
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
  for (const listing of input.live ?? []) {
    const bundled = byId.get(listing.pluginId);
    // `withDerivedKind` because the choice can hand a live entry the bundled
    // manifest, which changes the answer to "what is this".
    byId.set(
      listing.pluginId,
      bundled ? withDerivedKind(chooseCatalogueListing(bundled, listing)) : listing,
    );
  }

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
    kind: plugin.theme !== null ? "theme" : "view",
    installs: null,
    stars: null,
    // Already on this machine, and nothing here knows what it weighed on the
    // way in. Absent, not zero.
    sizeBytes: null,
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
    kind: derivePluginKind({ manifest, isTheme: manifest.theme !== undefined }),
    installs: null,
    stars: null,
    // A manifest read off a source says what the plugin does, not what it
    // weighs — only the directory measures that.
    sizeBytes: null,
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

  return describeManifestAdds(manifest);
}

/* ── Filter, sort, search ───────────────────────────────────────────────── */

/**
 * The gallery's two views.
 *
 * Not a chip among chips. A theme and a plugin are shopped for differently — a
 * theme is judged by looking at it, a plugin by reading what it adds — so one
 * list that mixes them serves neither. Plugins is the default and EXCLUDES
 * themes, which is the change from the old "All" chip: ten colour packages sat
 * in front of every reader who had come to find an integration.
 */
export type MarketplaceView = "plugins" | "themes";

/**
 * The state filter. One at a time, because these overlap in ways that make a
 * multi-select meaningless: "Installed and Updates" is Updates, and "Official
 * and Community" is everything.
 */
export type MarketplaceState = "all" | "installed" | "updates" | "official" | "community";

export type MarketplaceSort = "installs" | "stars" | "new";
export type MarketplaceSortDir = "asc" | "desc";

export const MARKETPLACE_VIEWS: readonly MarketplaceView[] = ["plugins", "themes"];

export const MARKETPLACE_VIEW_LABELS: Record<MarketplaceView, string> = {
  plugins: "Plugins",
  themes: "Themes",
};

/** Every state except the "no filter" one, in the order the bar draws them. */
export const MARKETPLACE_STATES: readonly Exclude<MarketplaceState, "all">[] = [
  "installed",
  "updates",
  "official",
  "community",
];

export const MARKETPLACE_STATE_LABELS: Record<Exclude<MarketplaceState, "all">, string> = {
  installed: "Installed",
  updates: "Updates",
  official: "Official",
  community: "Community",
};

/**
 * Plugin ids present on this machine, in the shape the filters want.
 *
 * The installed set is not part of {@link MarketplaceQuery} because it is not
 * something the reader chose — it changes under them as installs land, and a
 * query that carried it would go stale the moment one did.
 */
export function installedPluginIds(installed: readonly InstalledPlugin[]): ReadonlySet<string> {
  return new Set(installed.map((plugin) => plugin.pluginId));
}

/**
 * What this machine has, in the two shapes the state filter asks about.
 *
 * "Updates" cannot be answered from ids alone — it is a version comparison
 * against the catalogue — so it is computed once here rather than per listing
 * per keystroke, and it is computed against the SAME `installStateFor` the row
 * badge uses, so the chip and the badge can never disagree.
 */
export type MarketplaceInstallIndex = {
  installed: ReadonlySet<string>;
  /** Installed here, and the catalogue offers something newer. */
  updatable: ReadonlySet<string>;
};

/**
 * The empty index.
 *
 * The default for every filter entry point, and deliberately empty rather than
 * permissive: a caller that forgets to pass what is installed must show an
 * empty Installed list, never the whole catalogue marked as installed.
 */
export const NO_MARKETPLACE_INSTALLS: MarketplaceInstallIndex = {
  installed: new Set<string>(),
  updatable: new Set<string>(),
};

export function marketplaceInstallIndex(
  listings: readonly MarketplaceListing[],
  installed: readonly InstalledPlugin[],
): MarketplaceInstallIndex {
  const updatable = new Set<string>();
  for (const listing of listings) {
    if (installStateFor(listing, installed).kind === "update") updatable.add(listing.pluginId);
  }
  return { installed: installedPluginIds(installed), updatable };
}

export type MarketplaceQuery = {
  search: string;
  /** Plugins or Themes. The one filter that changes what the page draws. */
  view: MarketplaceView;
  /** Type chips, multi-select: OR within the axis. Empty means every type. */
  types: readonly MarketplaceTypeFilter[];
  state: MarketplaceState;
  /** Facet: keep only listings that extend every selected surface. */
  surfaces: readonly PluginSurfaceId[];
  sort: MarketplaceSort;
  sortDir: MarketplaceSortDir;
};

export const DEFAULT_MARKETPLACE_QUERY: MarketplaceQuery = {
  search: "",
  view: "plugins",
  types: [],
  state: "all",
  surfaces: [],
  sort: "installs",
  sortDir: "desc",
};

/**
 * Whether anything is narrowing the list beyond the view's own definition.
 *
 * Drives the "Clear filters" affordance and the featured row, which is a
 * curated set and therefore wrong to show above a filtered list — it would read
 * as three results that ignored the filter.
 */
export function marketplaceFiltersActive(query: MarketplaceQuery): boolean {
  return query.types.length > 0
    || query.state !== "all"
    || query.surfaces.length > 0
    || query.search.trim().length > 0;
}

/**
 * Read a persisted query back.
 *
 * Tolerant in the same way every persisted blob in this app is: an unknown
 * value falls back to the default rather than being kept, because the shape
 * outlives the build that wrote it. `search` is deliberately NOT restored — a
 * search box that comes back full of last week's word looks like a Marketplace
 * with three plugins in it.
 */
export function normalizeMarketplaceQuery(value: unknown): MarketplaceQuery {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_MARKETPLACE_QUERY };
  }
  const record = value as Partial<MarketplaceQuery>;
  const types = Array.isArray(record.types)
    ? MARKETPLACE_TYPE_FILTERS.filter((type) => record.types!.includes(type))
    : [];
  const surfaces = Array.isArray(record.surfaces)
    ? PLUGIN_SURFACE_IDS.filter((surface) => record.surfaces!.includes(surface))
    : [];
  return {
    search: "",
    view: MARKETPLACE_VIEWS.includes(record.view as MarketplaceView)
      ? record.view as MarketplaceView
      : DEFAULT_MARKETPLACE_QUERY.view,
    types,
    state: record.state === "all" || MARKETPLACE_STATES.includes(record.state as never)
      ? record.state as MarketplaceState
      : DEFAULT_MARKETPLACE_QUERY.state,
    surfaces,
    sort: record.sort === "installs" || record.sort === "stars" || record.sort === "new"
      ? record.sort
      : DEFAULT_MARKETPLACE_QUERY.sort,
    sortDir: record.sortDir === "asc" ? "asc" : "desc",
  };
}

/** True when two queries would persist identically — search excluded. */
export function sameMarketplaceFilters(a: MarketplaceQuery, b: MarketplaceQuery): boolean {
  return a.view === b.view
    && a.state === b.state
    && a.sort === b.sort
    && a.sortDir === b.sortDir
    && a.types.length === b.types.length
    && a.types.every((type) => b.types.includes(type))
    && a.surfaces.length === b.surfaces.length
    && a.surfaces.every((surface) => b.surfaces.includes(surface));
}

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

/** The view split. Exactly one of the two claims every listing. */
export function matchesView(listing: MarketplaceListing, view: MarketplaceView): boolean {
  return view === "themes" ? listing.kind === "theme" : listing.kind !== "theme";
}

/** Type chips: OR within the axis, and an empty selection keeps everything. */
export function matchesTypes(
  listing: MarketplaceListing,
  types: readonly MarketplaceTypeFilter[],
): boolean {
  if (types.length === 0) return true;
  return types.some((type) => type === listing.kind);
}

export function matchesState(
  listing: MarketplaceListing,
  state: MarketplaceState,
  index: MarketplaceInstallIndex = NO_MARKETPLACE_INSTALLS,
): boolean {
  switch (state) {
    case "installed":
      return index.installed.has(listing.pluginId);
    case "updates":
      return index.updatable.has(listing.pluginId);
    case "official":
      return listing.official;
    case "community":
      return !listing.official;
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
function compareListings(
  a: MarketplaceListing,
  b: MarketplaceListing,
  sort: MarketplaceSort,
  dir: MarketplaceSortDir = "desc",
): number {
  const byName = a.displayName.localeCompare(b.displayName);
  const sign = dir === "asc" ? -1 : 1;
  if (sort === "new") {
    const left = a.publishedAt ? Date.parse(a.publishedAt) : null;
    const right = b.publishedAt ? Date.parse(b.publishedAt) : null;
    if (left === right) return byName;
    if (left === null) return 1;
    if (right === null) return -1;
    return (right - left) * sign;
  }
  const left = sort === "stars" ? a.stars : a.installs;
  const right = sort === "stars" ? b.stars : b.installs;
  if (left === right) return byName;
  if (left === null) return 1;
  if (right === null) return -1;
  return (right - left) * sign;
}

export function queryMarketplace(
  listings: readonly MarketplaceListing[],
  query: MarketplaceQuery,
  /** From {@link marketplaceInstallIndex}. Only the state filter reads it. */
  index: MarketplaceInstallIndex = NO_MARKETPLACE_INSTALLS,
): MarketplaceListing[] {
  const surfaces = query.surfaces;
  return listings
    .filter((listing) => matchesView(listing, query.view))
    .filter((listing) => matchesTypes(listing, query.types))
    .filter((listing) => matchesState(listing, query.state, index))
    .filter((listing) => surfaces.every((surface) => listing.surfaces.includes(surface)))
    .filter((listing) => matchesSearch(listing, query.search))
    .sort((a, b) => compareListings(a, b, query.sort, query.sortDir));
}

export type SurfaceFacet = { surface: PluginSurfaceId; label: string; total: number };

/**
 * Facet chips for the surfaces present in a catalogue.
 *
 * Counted against every axis EXCEPT the facet selection itself, so selecting a
 * facet cannot make the other facets vanish — the classic dead-end where a
 * filter bar can only ever be narrowed.
 */
export function deriveSurfaceFacets(
  listings: readonly MarketplaceListing[],
  query: MarketplaceQuery,
  index: MarketplaceInstallIndex = NO_MARKETPLACE_INSTALLS,
): SurfaceFacet[] {
  const scoped = listings
    .filter((listing) => matchesView(listing, query.view))
    .filter((listing) => matchesTypes(listing, query.types))
    .filter((listing) => matchesState(listing, query.state, index))
    .filter((listing) => matchesSearch(listing, query.search));
  return PLUGIN_SURFACE_IDS
    .map((surface) => ({
      surface,
      label: SURFACE_LABELS[surface],
      total: scoped.filter((listing) => listing.surfaces.includes(surface)).length,
    }))
    .filter((facet) => facet.total > 0);
}

export type TypeFacet = { type: MarketplaceTypeFilter; label: string; total: number };

/**
 * Counts for the type chips.
 *
 * Every chip is drawn whatever its count, unlike the surface facets: the three
 * types are the page's own vocabulary and a chip that disappears when it hits
 * zero teaches nobody what the axis is. A zero count is the answer, and it is
 * counted against the other axes but NOT against the type selection, so
 * selecting Integrations still shows how many Tools are one click away.
 */
export function deriveTypeFacets(
  listings: readonly MarketplaceListing[],
  query: MarketplaceQuery,
  index: MarketplaceInstallIndex = NO_MARKETPLACE_INSTALLS,
): TypeFacet[] {
  const surfaces = query.surfaces;
  const scoped = listings
    .filter((listing) => matchesView(listing, query.view))
    .filter((listing) => matchesState(listing, query.state, index))
    .filter((listing) => surfaces.every((surface) => listing.surfaces.includes(surface)))
    .filter((listing) => matchesSearch(listing, query.search));
  return MARKETPLACE_TYPE_FILTERS.map((type) => ({
    type,
    label: MARKETPLACE_TYPE_LABELS[type],
    total: scoped.filter((listing) => listing.kind === type).length,
  }));
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

/* ── Storage ────────────────────────────────────────────────────────────── */

/**
 * Whether a plugin has anywhere to put data — the gate on the storage section.
 *
 * Most plugins store nothing: a theme, a static panel, a manifest-only package
 * declares no collections and never will. A section reporting zeroes for those
 * is page furniture, and the reader has to work out that the zeroes are
 * structural rather than a plugin that has simply not written anything yet.
 *
 * The declaration is the real answer: `collections`, or a panel bound to a
 * vocabulary schema, which is how a panel-only plugin gets rows. Nonzero usage
 * is the belt — a plugin already holding data is described whatever its
 * manifest says, because the bytes exist and hiding them would be worse.
 */
export function pluginStoresData(
  manifest: PluginManifest | null,
  usage: PluginUsageRow | null,
): boolean {
  if (usage && (usage.collectionBytes > 0 || usage.rows > 0 || (usage.syncBytesTotal ?? 0) > 0)) {
    return true;
  }
  if (!manifest) return false;
  if (Object.keys(manifest.collections).length > 0) return true;
  return manifest.panels.some((panel) => Boolean(panel.schemaFile));
}

export type PluginStorageLevel = "healthy" | "nearly-full" | "full";

export type PluginStorageDetail = { label: string; value: string };

export type PluginStorageReport = {
  level: PluginStorageLevel;
  /** The one line shown before anything is expanded. */
  summary: string;
  /** The numbers, for the reader who went looking for them. */
  details: PluginStorageDetail[];
};

/** The share of a budget at which the section stops being quiet. */
const NEARLY_FULL_AT = 0.7;

/**
 * What the reader is told when the plugin is nowhere near its ceiling — which
 * is nearly always, so this is the line that has to earn its place. It says
 * what the plugin does with the space rather than how much is left, because a
 * number nobody needs to act on is a number that trains people to ignore the
 * section entirely.
 */
export const PLUGIN_STORAGE_REASSURANCE =
  "If it fills up, the plugin keeps working — it just can't save new synced data until it tidies up.";

function fillRatio(used: number, budget: number): number {
  // An unknown ceiling is not a full one: a host that reports no budget must
  // not paint every plugin red.
  return budget > 0 ? used / budget : 0;
}

/** `4,000` — grouped, because these are counts a person reads, not ids. */
function formatItems(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

/**
 * Storage, described rather than metered.
 *
 * Two budgets can each fill independently, so the level is the worse of them —
 * and, crucially, so is the number quoted when it starts to matter. Quoting
 * bytes while the item count is the thing running out would be a comfortable
 * number in place of the true one, which is the specific way a status line
 * loses the reader's trust. The healthy state names no number at all.
 */
export function describePluginStorage(usage: PluginUsageRow): PluginStorageReport {
  const bytes = fillRatio(usage.collectionBytes, usage.collectionBudgetBytes);
  const items = fillRatio(usage.rows, usage.rowBudget);
  const worst = Math.max(bytes, items);

  const pressure = bytes >= items
    ? `${formatBytes(usage.collectionBytes)} of ${formatBytes(usage.collectionBudgetBytes)}`
    : `${formatItems(usage.rows)} of ${formatItems(usage.rowBudget)} saved items`;

  const level: PluginStorageLevel = worst >= 1
    ? "full"
    : worst >= NEARLY_FULL_AT ? "nearly-full" : "healthy";

  const summary = level === "full"
    // Never "broken": a plugin at its ceiling still runs, still reads what it
    // already has, and still does everything that is not writing new rows.
    ? "Its synced space is full. It can't save new synced data until it frees some."
    : level === "nearly-full"
      ? `Its synced space is getting full (${pressure}).`
      : "Keeps a small amount of data in sync across your devices.";

  const details: PluginStorageDetail[] = [
    {
      label: "Space used",
      value: `${formatBytes(usage.collectionBytes)} of ${formatBytes(usage.collectionBudgetBytes)}`,
    },
    { label: "Saved items", value: `${formatItems(usage.rows)} of ${formatItems(usage.rowBudget)}` },
  ];
  // Null is unmetered, not zero. A host that cannot attribute sync bytes says
  // nothing rather than reporting a confident 0 B.
  if (usage.syncBytesTotal !== null) {
    details.push({ label: "Sent to your devices", value: formatBytes(usage.syncBytesTotal) });
  }

  return { level, summary, details };
}

/* ── Formatting ─────────────────────────────────────────────────────────── */

/** `1.2k`, `18` — or null, which callers render as nothing rather than `0`. */
export function formatCount(value: number | null): string | null {
  if (value === null) return null;
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

/**
 * Bytes, at the precision the figure deserves.
 *
 * The decimal is dropped past 100 and a GB tier exists because plugin downloads
 * put numbers through here that storage budgets never did: "141.0 MB" reads as
 * a precision nobody has about a repository size that is an estimate anyway,
 * and a speech model quoted as "2048.0 MB" reads as a bug.
 */
export function formatBytes(value: number): string {
  if (value < 1024) return `${Math.max(0, Math.round(value))} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  const megabytes = value / (1024 * 1024);
  if (megabytes < 1024) return `${megabytes.toFixed(megabytes < 100 ? 1 : 0)} MB`;
  return `${(megabytes / 1024).toFixed(1)} GB`;
}

/* ── Download size ──────────────────────────────────────────────────────── */

export type PluginDownloadReport = {
  /** `"4.2 MB"`, or null when nothing measured it. Never `"0 B"`. */
  size: string | null;
  /** One sentence per thing the plugin fetches later. Usually empty. */
  extras: string[];
};

/**
 * What installing this actually costs to fetch.
 *
 * Two figures rather than one total, and the split is the whole point: adding
 * them would produce a single honest-looking number that is wrong for everyone
 * who never triggers the feature that pulls the model down, and it would hide
 * the fact that the second download happens LATER — which is the part that
 * surprises people. So the package is quoted as the package, and anything the
 * plugin fetches for itself is quoted separately, in a sentence that says when.
 *
 * Both halves render as nothing when unknown. A Marketplace that prints "0 B"
 * for every plugin the directory has not measured teaches its readers that the
 * number means nothing, which costs the number on the entries that do have one.
 */
export function describePluginDownload(
  listing: Pick<MarketplaceListing, "sizeBytes" | "extraDownloads">,
): PluginDownloadReport {
  const bytes = listing.sizeBytes ?? null;
  return {
    size: bytes !== null && bytes > 0 ? formatBytes(bytes) : null,
    extras: (listing.extraDownloads ?? [])
      .filter((download) => download.bytes > 0)
      .map((download) =>
        `Downloads a further ${formatBytes(download.bytes)} (${download.label}) the first time you use it.`),
  };
}
