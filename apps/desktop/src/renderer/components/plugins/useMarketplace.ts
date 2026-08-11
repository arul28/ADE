import React from "react";

import { useRootAppStore } from "../../state/appStore";
import {
  fetchMarketplaceIndex,
  pluginMarketplaceCapabilities,
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
  /** True only for the first load; a refresh keeps the current list on screen. */
  loading: boolean;
  refreshing: boolean;
  refresh: () => void;
  capabilities: PluginMarketplaceCapabilities;
};

export function useMarketplaceCatalogue(): MarketplaceCatalogue {
  const installed = useRootAppStore((state) => state.installedPlugins);
  const pluginsLoaded = useRootAppStore((state) => state.pluginsLoaded);

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

  return {
    listings: catalogue.listings,
    state: catalogue.state,
    loading: loading || !pluginsLoaded,
    refreshing,
    refresh: React.useCallback(() => setRefreshToken((token) => token + 1), []),
    capabilities,
  };
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
