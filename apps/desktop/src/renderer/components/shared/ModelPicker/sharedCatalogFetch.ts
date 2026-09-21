/**
 * One catalog fetch, de-duplicated across every surface in the window.
 *
 * The composer's picker and the Custom preset wizard both read the same runtime
 * catalog, and both must claim the same bucket, build the same request key, and
 * drop a response that lands after its bucket was evicted. That protocol lived
 * twice — once in `ModelPicker.tsx` and once in the wizard's model module — and
 * two hand-built copies of one concurrency protocol drift. It lives here now,
 * and both callers add only their own side effects on top of the result.
 *
 * This module sits beside `modelCatalog` and `runtimeCatalogCache` rather than
 * inside either: `modelCatalog` already imports `runtimeCatalogCache`, so
 * putting the fetch in the cache would close an import cycle.
 */

import type { AgentChatModelCatalogRefreshProvider } from "../../../../shared/types";
import type { OpenProjectBinding } from "../../../../shared/types";
import { requestModelCatalog } from "./modelCatalog";
import {
  clearRuntimeCatalogRequest,
  getRuntimeCatalogRequest,
  isPersonalChatCatalogScopeKey,
  rememberRuntimeCatalog,
  reserveRuntimeCatalogScope,
  setRuntimeCatalogRequest,
  type SharedCatalogFetchResult,
} from "./runtimeCatalogCache";

export type { SharedCatalogFetchResult };

export type SharedCatalogFetchArgs = {
  scopeKey: string;
  mode: "cached" | "refresh-stale" | "force";
  refreshProvider?: AgentChatModelCatalogRefreshProvider;
  cursorSource?: "cli" | "sdk";
  pin?: OpenProjectBinding | null;
};

/** The host bridge this scope reads through, or null when the host has none. */
function catalogBridgeAvailable(scopeKey: string): boolean {
  if (isPersonalChatCatalogScopeKey(scopeKey)) {
    return typeof window.ade?.personalChats?.call === "function";
  }
  return typeof window.ade?.agentChat?.modelCatalog === "function";
}

/**
 * Fetch the catalog for one scope, sharing an in-flight request.
 *
 * A caller that arrives while another caller's request is open awaits that one
 * instead of starting a second. The bucket is claimed before the await, so a
 * response for an evicted bucket is dropped by `rememberRuntimeCatalog` rather
 * than resurrecting it.
 */
export async function fetchSharedRuntimeCatalog(
  args: SharedCatalogFetchArgs,
): Promise<SharedCatalogFetchResult> {
  const { scopeKey, mode, refreshProvider, cursorSource, pin } = args;
  if (!catalogBridgeAvailable(scopeKey)) return { status: "unavailable" };

  const requestKey = `${scopeKey}|${mode}:${refreshProvider ?? "all"}:${cursorSource ?? "all"}`;
  const existing = getRuntimeCatalogRequest(requestKey);
  if (existing) return await existing;

  const scopeSerial = reserveRuntimeCatalogScope(scopeKey);
  const fetchArgs = {
    mode,
    ...(refreshProvider ? { refreshProvider } : {}),
    ...(cursorSource ? { cursorSource } : {}),
  };
  const request: Promise<SharedCatalogFetchResult> = (async () => {
    try {
      const next = await requestModelCatalog(fetchArgs, {
        catalogScopeKey: scopeKey,
        ...(pin ? { pin } : {}),
      });
      const visible = rememberRuntimeCatalog(next, { ...fetchArgs, scopeKey, scopeSerial });
      return { status: "ok", catalog: visible };
    } catch {
      return { status: "error" };
    }
  })();
  setRuntimeCatalogRequest(requestKey, request);
  void request.finally(() => {
    clearRuntimeCatalogRequest(requestKey, request);
  });
  return await request;
}
