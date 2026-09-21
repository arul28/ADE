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
/**
 * Whether this render will fetch — the one condition, shared by the initial
 * state and the effect.
 *
 * The initial value matters as much as the effect's. React runs effects after
 * paint, so a hook that starts at `loading: false` tells its caller the list is
 * settled for one frame. A caller that decides between a select and a text box
 * on that answer paints the wrong control and then swaps it, which is the seam
 * this hook exists to close.
 */
function willFetchCatalog(
  enabled: boolean,
  family: ProviderFamily | null,
  scopeKey: string,
  cursorSource?: "cli" | "sdk",
): boolean {
  if (!enabled) return false;
  if (typeof window.ade?.agentChat?.modelCatalog !== "function") return false;
  const shared = getSharedRuntimeCatalog(scopeKey);
  if (!shared) return true;
  const refreshProvider = family ? refreshProviderForFamily(family) : null;
  if (!refreshProvider) return false;
  const flavor = refreshProvider === "cursor" ? cursorSource : undefined;
  return !runtimeCatalogProviderIsFresh(refreshProvider, flavor, scopeKey);
}

export function useRuntimeCatalogForFamily(
  enabled: boolean,
  family: ProviderFamily | null,
  scopeKey: string = DEFAULT_RUNTIME_CATALOG_SCOPE,
  /**
   * Which Cursor source to enumerate. A surface that starts chats must say
   * `"sdk"`: Cursor reports a union of SDK-capable and CLI-only models, and a
   * chat session rejects a CLI-only one.
   */
  cursorSource?: "cli" | "sdk",
): { catalog: AgentChatModelCatalog | null; loading: boolean } {
  const [catalog, setCatalog] = useState<AgentChatModelCatalog | null>(
    () => getSharedRuntimeCatalog(scopeKey),
  );
  const [loading, setLoading] = useState(() => willFetchCatalog(enabled, family, scopeKey, cursorSource));

  // Re-arm during render, not in the effect. React runs effects after paint,
  // so on the render that first sees a new family the flag would still belong
  // to the previous one — and a caller choosing between a select and a text
  // box reads it on exactly that render. Deriving it on every render instead
  // would be worse: a provider the host never marks fresh would pin it true
  // forever. This is React's documented adjust-state-on-prop-change pattern.
  const inputs = `${enabled}\u0000${family ?? ""}\u0000${scopeKey}\u0000${cursorSource ?? ""}`;
  const [previousInputs, setPreviousInputs] = useState(inputs);
  if (inputs !== previousInputs) {
    setPreviousInputs(inputs);
    setLoading(willFetchCatalog(enabled, family, scopeKey, cursorSource));
  }

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
    if (!willFetchCatalog(enabled, family, scopeKey, cursorSource)) {
      setLoading(false);
      return;
    }

    // Only a Cursor refresh carries a flavor, the same rule the composer's
    // picker follows.
    const cursorFlavor = refreshProvider === "cursor" ? cursorSource : undefined;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const load = async (mode: "cached" | "refresh-stale" | "force") => {
        const result = await fetchSharedRuntimeCatalog({
          scopeKey,
          mode,
          ...(mode === "cached" || !refreshProvider ? {} : { refreshProvider }),
          ...(cursorFlavor ? { cursorSource: cursorFlavor } : {}),
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
        if (cached && runtimeCatalogProviderIsFresh(refreshProvider, cursorFlavor, scopeKey)) return;

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
  }, [cursorSource, enabled, family, scopeKey]);

  return { catalog, loading };
}
