import { useCallback, useSyncExternalStore } from "react";
import { runtimeCatalogScopeVersion, subscribeRuntimeCatalog } from "./runtimeCatalogCache";

/**
 * The change version of one machine's runtime catalog bucket. It moves when
 * any surface loads that bucket or something invalidates it, so a memo keyed
 * on it re-derives model rows no matter which surface did the load.
 */
export function useRuntimeCatalogVersion(scopeKey: string): number {
  const subscribe = useCallback(
    (onChange: () => void) => subscribeRuntimeCatalog((changed) => {
      if (changed === scopeKey) onChange();
    }),
    [scopeKey],
  );
  const getSnapshot = useCallback(() => runtimeCatalogScopeVersion(scopeKey), [scopeKey]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
