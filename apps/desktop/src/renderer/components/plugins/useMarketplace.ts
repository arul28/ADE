import React from "react";

import { useRootAppStore } from "../../state/appStore";
import {
  fetchMarketplaceIndex,
  fetchPluginRepoStars,
  pluginMarketplaceCapabilities,
  pluginRepoStarsSupported,
  readPluginPresence,
  subscribeToPluginChanges,
  type PluginMarketplaceCapabilities,
  type PluginPresenceRow,
} from "../../lib/pluginRuntimeBridge";
import { MARKETPLACE_LOCAL_INDEX } from "./marketplaceLocalIndex";
import {
  mergeMarketplaceCatalogue,
  parseMarketplaceEntry,
  type MarketplaceIndexState,
  type MarketplaceListing,
  type MarketplaceRegistryState,
} from "./marketplaceModel";

/**
 * Marketplace data loading.
 *
 * The catalogue is three sources folded together — the bundled index, the live
 * directory, and the machine's own registry — and the fold itself is pure (see
 * `marketplaceModel`). This hook only owns the asynchrony: when to fetch, what
 * the intermediate states are called, and how a refresh differs from a first
 * load.
 *
 * The distinction that matters: a failed fetch is NOT an error state here. The
 * bundled index means the page always has content, so a fetch failure downgrades
 * the freshness label and nothing else. There is no spinner that can fail, and
 * no empty page behind a retry button.
 */

export type MarketplaceCatalogue = {
  listings: MarketplaceListing[];
  state: MarketplaceIndexState;
  /**
   * Whether the machine behind this page answered for its installed plugins.
   *
   * Separate from `state`, which is about the DIRECTORY. The two fail
   * independently: a machine that cannot be reached still has a catalogue to
   * browse, and a directory that cannot be fetched says nothing about the
   * machine. Reporting either as the other is what turned an unreachable
   * runtime into a page that never finished loading.
   */
  registry: MarketplaceRegistryState;
  /** True only for the first load; a refresh keeps the current list on screen. */
  loading: boolean;
  refreshing: boolean;
  refresh: () => void;
  capabilities: PluginMarketplaceCapabilities;
};

export function useMarketplaceCatalogue(): MarketplaceCatalogue {
  const installed = useRootAppStore((state) => state.installedPlugins);
  const pluginsLoaded = useRootAppStore((state) => state.pluginsLoaded);
  const pluginsLoadFailure = useRootAppStore((state) => state.pluginsLoadFailure);

  const [live, setLive] = React.useState<{
    listings: MarketplaceListing[];
    fetchedAt: string | null;
    origin: "network" | "cache";
  } | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [refreshToken, setRefreshToken] = React.useState(0);

  // Read once per mount: whether a host has these members cannot change while
  // the page is open, and re-probing per render would churn every memo below.
  const capabilities = React.useMemo(() => pluginMarketplaceCapabilities(), []);

  React.useEffect(() => {
    if (!capabilities.browse) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const isRefresh = refreshToken > 0;
    if (isRefresh) setRefreshing(true);

    void (async () => {
      const payload = await fetchMarketplaceIndex(isRefresh ? { refresh: true } : {});
      if (cancelled) return;
      if (payload) {
        setLive({
          listings: payload.entries
            .map((entry) => parseMarketplaceEntry(entry))
            .filter((entry): entry is MarketplaceListing => entry !== null),
          fetchedAt: payload.fetchedAt,
          origin: payload.origin,
        });
      } else if (!isRefresh) {
        // Keep whatever a previous successful fetch produced; only a cold
        // failure clears the live layer.
        setLive(null);
      }
      setLoading(false);
      setRefreshing(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [capabilities.browse, refreshToken]);

  const catalogue = React.useMemo(
    () => mergeMarketplaceCatalogue({
      bundled: MARKETPLACE_LOCAL_INDEX,
      live: live?.listings ?? null,
      installed,
      liveMeta: live ? { fetchedAt: live.fetchedAt, origin: live.origin } : null,
      browseSupported: capabilities.browse,
    }),
    [capabilities.browse, installed, live],
  );

  /**
   * The registry's own state, and the reason the page can finish loading.
   *
   * `pluginsLoaded` is only ever true for an answer the store TRUSTS, and the
   * registry retries a failed load forever on a backoff — correct for a boot
   * race, fatal as a loading gate. A page that waited on `pluginsLoaded` alone
   * showed its skeleton for as long as the machine stayed unreachable, which is
   * how a project bound to another machine read as a Marketplace that never
   * opened. A recorded failure settles the page instead, with a sentence.
   */
  const registry = React.useMemo<MarketplaceRegistryState>(() => {
    if (pluginsLoaded) return { kind: "ready" };
    if (pluginsLoadFailure === "unavailable") return { kind: "unavailable" };
    if (pluginsLoadFailure === "error") return { kind: "unreachable" };
    return { kind: "loading" };
  }, [pluginsLoadFailure, pluginsLoaded]);

  return {
    listings: catalogue.listings,
    state: catalogue.state,
    registry,
    loading: loading || registry.kind === "loading",
    refreshing,
    refresh: React.useCallback(() => setRefreshToken((token) => token + 1), []),
    capabilities,
  };
}

/**
 * The machine every plugin call on this page acts on, when it is not this one.
 *
 * The Marketplace is a machine-level route, but `window.ade.plugins` follows the
 * project tab's runtime — so with a project bound to another machine, "install"
 * installs THERE and "installed" lists what is there. The page has to be able to
 * say which machine that is: without the name, an unreachable runtime and an
 * empty machine are the same blank list.
 *
 * Null when the calls stay on this computer, which needs no name.
 */
export function useMarketplaceMachineName(): string | null {
  const binding = useRootAppStore((state) => state.projectBinding);
  if (binding?.kind !== "remote") return null;
  return binding.runtimeName || binding.displayName || null;
}

/* ── Stars ──────────────────────────────────────────────────────────────── */

/**
 * Star counts already asked for, for the life of this window.
 *
 * Module-level rather than component state because the gallery and the detail
 * page are two mounts of the same catalogue: without it, opening a plugin and
 * pressing Back asks GitHub about every row again. The host keeps a 24-hour
 * disk cache underneath this, so the only thing this map buys is not making
 * the round trip — but on an unauthenticated API budgeted at sixty requests an
 * hour, not making the round trip is the whole game.
 */
const starCache = new Map<string, number | null>();

/**
 * How many repositories one pass will ask about.
 *
 * The gallery can list hundreds. Sixty unauthenticated requests an hour is the
 * ceiling for the whole machine, so a page that spent them all on its first
 * scroll would leave nothing for the plugin someone actually opens. Featured
 * and top-of-list rows are the ones a reader looks at.
 */
const MAX_STAR_LOOKUPS_PER_PASS = 12;

/**
 * Live star counts, keyed by plugin id.
 *
 * The directory publishes `stars` at crawl time and that number is used as-is
 * when it is there; this only fills the gaps. A count that cannot be had stays
 * absent from the map, and the card draws nothing — which is the same thing it
 * does for a plugin nobody has ever counted, because they are the same fact.
 */
export function usePluginRepoStars(
  listings: readonly MarketplaceListing[],
): Map<string, number> {
  /* A snapshot of the module cache. The cache is what survives a remount; this
     is what makes a resolved lookup a render — the counts land outside React,
     so nothing in `listings` changes when one arrives. */
  const [answered, setAnswered] = React.useState<ReadonlyMap<string, number | null>>(
    () => new Map(starCache),
  );

  // The repos worth asking about: no published count, an https repo URL, and
  // not already answered. Sliced in list order, which is the order the gallery
  // already sorted them into.
  const pending = React.useMemo(() => {
    if (!pluginRepoStarsSupported()) return [] as { pluginId: string; repo: string }[];
    const rows: { pluginId: string; repo: string }[] = [];
    for (const listing of listings) {
      if (rows.length >= MAX_STAR_LOOKUPS_PER_PASS) break;
      if (listing.stars !== null) continue;
      const repo = listing.repo ?? listing.links?.repository ?? null;
      if (!repo || starCache.has(repo)) continue;
      rows.push({ pluginId: listing.pluginId, repo });
    }
    return rows;
  }, [listings]);

  React.useEffect(() => {
    if (pending.length === 0) return;
    let cancelled = false;
    void (async () => {
      // Sequential on purpose. These are decorations on a page that is already
      // drawn, and a burst of parallel requests to the same host is how a
      // rate limit gets spent in one second instead of one hour.
      for (const row of pending) {
        if (cancelled) return;
        if (starCache.has(row.repo)) continue;
        starCache.set(row.repo, await fetchPluginRepoStars(row.repo));
        if (cancelled) return;
        setAnswered(new Map(starCache));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pending]);

  return React.useMemo(() => {
    const stars = new Map<string, number>();
    for (const listing of listings) {
      if (listing.stars !== null) {
        stars.set(listing.pluginId, listing.stars);
        continue;
      }
      const repo = listing.repo ?? listing.links?.repository ?? null;
      const cached = repo ? answered.get(repo) : null;
      if (typeof cached === "number") stars.set(listing.pluginId, cached);
    }
    return stars;
  }, [answered, listings]);
}

/**
 * Per-machine presence for the coverage rail.
 *
 * Fetched on reveal and refreshed on the host's install events, never polled: a
 * coverage matrix is a snapshot of a slow-moving fact, and the one moment it
 * must be right — just after an install — is exactly when the host publishes a
 * change.
 */
export function usePluginPresence(active: boolean): {
  rows: PluginPresenceRow[];
  loading: boolean;
} {
  const [rows, setRows] = React.useState<PluginPresenceRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [token, setToken] = React.useState(0);

  React.useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void (async () => {
      const presence = await readPluginPresence();
      if (cancelled) return;
      setRows(presence);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [active, token]);

  React.useEffect(() => {
    if (!active) return;
    return subscribeToPluginChanges((event) => {
      if (event.kind !== "installs") return;
      setToken((value) => value + 1);
    });
  }, [active]);

  return { rows, loading };
}
