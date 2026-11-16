import type { CloudInstance } from "./contract";
import type { CloudProvider } from "./provider";
import { logCloud } from "./store";

/**
 * The provider's instance list for `GET /cloud/instances`, kept a few seconds
 * in this colo's Cache API: every open dashboard and machine list polls it,
 * and the provider answers the whole workspace each time. A named cache under
 * a host nobody can request, so no incoming request can read it.
 *
 * `fresh` skips the cache: the caller passes it when the account's rows
 * changed inside the cache's lifetime (a create, a reservation in flight, a
 * start or a sleep this Worker recorded), so the read that follows a create
 * always sees the new computer. Outside Workers (tests) there is no cache.
 */

const CACHE_NAME = "ade-cloud-provider";
const CACHE_URL = "https://ade-cloud-cache.invalid/provider/instances-v1";
/** How long a list is kept, in seconds. */
export const INSTANCE_LIST_TTL_S = 5;

async function openCache(): Promise<Cache | null> {
  if (typeof caches === "undefined") return null;
  return caches.open(CACHE_NAME).catch(() => null);
}

export async function listInstancesCached(provider: Pick<CloudProvider, "listInstances">, fresh: boolean): Promise<CloudInstance[]> {
  const cache = await openCache();
  if (cache && !fresh) {
    const hit = await cache.match(CACHE_URL).catch(() => undefined);
    if (hit) {
      const list = await hit.json().catch(() => null) as CloudInstance[] | null;
      if (Array.isArray(list)) return list;
    }
  }
  const list = await provider.listInstances();
  if (cache) {
    await cache.put(CACHE_URL, new Response(JSON.stringify(list), {
      headers: { "content-type": "application/json", "cache-control": `max-age=${INSTANCE_LIST_TTL_S}` },
    })).catch((error: unknown) => {
      logCloud("cloud.instance_list_cache_put_failed", { message: error instanceof Error ? error.name : "unknown" });
    });
  }
  return list;
}
