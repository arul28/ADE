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
  invalidateRuntimeCatalogScope,
  isPersonalChatCatalogScopeKey,
  noteRuntimeCatalogScopePin,
  rememberRuntimeCatalog,
  reserveRuntimeCatalogScope,
  runtimeCatalogScopesForMachine,
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
  noteRuntimeCatalogScopePin(scopeKey, pin);
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

/**
 * Read one machine's catalog again after it went missing or out of date.
 *
 * Reads only: `agentChat.modelCatalog` is a declared read in every mode, so
 * none of this wakes a sleeping computer. With a provider, that provider is
 * probed again. Without one, the host answers from its cache and says whether
 * it is stale (a sign-in or an inventory change marks it); only then is the
 * full list rebuilt, and that request joins the rebuild the host already
 * started for the stale answer instead of running a second one.
 */
export async function refreshRuntimeCatalogScope(args: {
  scopeKey: string;
  pin?: OpenProjectBinding | null;
  refreshProvider?: AgentChatModelCatalogRefreshProvider;
}): Promise<SharedCatalogFetchResult> {
  const { scopeKey, pin, refreshProvider } = args;
  if (refreshProvider) {
    return await fetchSharedRuntimeCatalog({ scopeKey, mode: "force", refreshProvider, pin });
  }
  const first = await fetchSharedRuntimeCatalog({ scopeKey, mode: "refresh-stale", pin });
  if (first.status !== "ok" || first.catalog.stale !== true) return first;
  return await fetchSharedRuntimeCatalog({ scopeKey, mode: "force", pin });
}

/**
 * Something on one machine changed what its agents can run (a provider set
 * up, signed in, given a key). Mark every catalog this window holds for that
 * machine out of date, so the "@" menu, the picker and the effort control
 * look again, and re-read each one through the pin it was read with: a chat's
 * project copy on that computer has its own OpenCode inventory, so the
 * Settings page's machine pin alone would not reach it.
 */
export function refreshRuntimeCatalogsForMachine(
  pin: OpenProjectBinding | null | undefined,
  options?: { refreshProvider?: AgentChatModelCatalogRefreshProvider },
): Promise<void> {
  const scopes = runtimeCatalogScopesForMachine(pin);
  for (const scope of scopes) invalidateRuntimeCatalogScope(scope.scopeKey);
  return Promise.all(scopes.map((scope) => refreshRuntimeCatalogScope({
    scopeKey: scope.scopeKey,
    pin: scope.pin,
    ...(options?.refreshProvider ? { refreshProvider: options.refreshProvider } : {}),
  }))).then(() => undefined);
}
