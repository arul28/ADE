/**
 * React state over the runtime model catalog for one provider family.
 *
 * The composer's picker owns a catalog through its own large component. A
 * smaller surface — the Custom preset wizard's model select — needs the same
 * list and nothing else, so it gets this hook instead of a copy of the
 * picker's loading ladder. It lives beside the folder's other hooks
 * (`useProviderAuthStatus`, `useModelFavorites`, `useModelRecents`) because
 * "React state over the runtime catalog" is this folder's job, not the
 * settings folder's.
 */

import { useEffect, useState } from "react";
import type { AgentChatModelCatalog } from "../../../../shared/types";
import type { ProviderFamily } from "../../../../shared/modelRegistry";
import { fetchSharedRuntimeCatalog } from "./sharedCatalogFetch";
import {
  DEFAULT_RUNTIME_CATALOG_SCOPE,
  getSharedRuntimeCatalog,
  refreshProviderForFamily,
  runtimeCatalogProviderIsFresh,
} from "./runtimeCatalogCache";

/**
 * The live catalog for one family, fetched only while it is needed.
 *
 * `enabled` is the caller's "this control is on screen and a source is picked"
 * condition, so a wizard sitting on another step costs nothing. Families the
 * host enumerates at run time (Cursor, OpenCode, Pi, the ACP CLIs) get the same
 * cached → refresh-stale → force ladder the composer's provider rail performs;
 * the rest are satisfied by whatever the shared bucket already holds.
 */
export function useRuntimeCatalogForFamily(
  enabled: boolean,
  family: ProviderFamily | null,
  scopeKey: string = DEFAULT_RUNTIME_CATALOG_SCOPE,
): { catalog: AgentChatModelCatalog | null; loading: boolean } {
  const [catalog, setCatalog] = useState<AgentChatModelCatalog | null>(
    () => getSharedRuntimeCatalog(scopeKey),
  );
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Every exit path settles the flag. An early return that left it set was
    // how the select came back from another step still reading "Loading
    // models…" over a list that had already arrived.
    if (!enabled) {
      setLoading(false);
      return;
    }

    const refreshProvider = family ? refreshProviderForFamily(family) : null;
    const shared = getSharedRuntimeCatalog(scopeKey);
    if (shared) setCatalog(shared);
    const alreadyFresh = Boolean(shared)
      && (!refreshProvider || runtimeCatalogProviderIsFresh(refreshProvider, undefined, scopeKey));
    if (alreadyFresh) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    void (async () => {
      const load = async (mode: "cached" | "refresh-stale" | "force") => {
        const result = await fetchSharedRuntimeCatalog({
          scopeKey,
          mode,
          ...(mode === "cached" || !refreshProvider ? {} : { refreshProvider }),
        });
        return result.status === "ok" ? result.catalog : null;
      };
      try {
        // A warm bucket is already in `catalog`; only a cold one needs the
        // cached round trip. The picker short-circuits the same way.
        const cached = shared ?? await load("cached");
        if (cancelled) return;
        if (cached) setCatalog(cached);
        if (!refreshProvider) return;
        if (cached && runtimeCatalogProviderIsFresh(refreshProvider, undefined, scopeKey)) return;

        const refreshed = await load("refresh-stale");
        if (cancelled) return;
        if (refreshed) setCatalog(refreshed);
        if (refreshed?.stale !== true) return;

        const forced = await load("force");
        if (cancelled || !forced) return;
        setCatalog(forced);
      } finally {
        // Only the run that is still current may settle the flag. A cancelled
        // run resolving late would otherwise clear the loading state of the
        // run that replaced it, and the select would read "No models reported
        // yet" over a list still arriving. The cleanup below covers the
        // cancelled case itself.
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      setLoading(false);
    };
  }, [enabled, family, scopeKey]);

  return { catalog, loading };
}
