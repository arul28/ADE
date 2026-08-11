import fs from "node:fs";
import path from "node:path";

import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import { safeJsonParse, writeTextAtomic } from "../../../../desktop/src/main/services/shared/utils";
import {
  PLUGIN_REGISTRY_LIMITS,
  parsePluginRegistryIndex,
  type PluginRegistryEntry,
  type PluginRegistryIndex,
} from "../../../../desktop/src/shared/plugins/registryIndex";
import { resolveMachineAdeLayout } from "../projects/machineLayout";

/**
 * The plugin directory, as this machine sees it.
 *
 * The directory is a static `index.json` in a public repository, rebuilt by a
 * scheduled crawler (design decision D16). That is a deliberately cheap design,
 * and this service is what makes it behave like a product feature rather than a
 * file download:
 *
 * - **Offline is a state, not an error.** Every read path answers with the last
 *   good index when the network is unavailable, and `null` only when there has
 *   never been one. The Marketplace draws the bundled list in that case and says
 *   so; it must never claim there are no plugins.
 * - **The cache is conditional.** An etag turns the common refresh into a 304
 *   with no body, which is what keeps a directory that every install polls from
 *   costing anything at all.
 * - **Validation happens before caching.** A malformed index never reaches disk,
 *   so one bad crawl cannot leave every machine holding a poisoned file. The
 *   parse is entry-by-entry (see `registryIndex.ts`), so one bad plugin costs
 *   its own row.
 */

/** Where the published index lives. Overridable for development and testing. */
export const DEFAULT_PLUGIN_REGISTRY_INDEX_URL =
  "https://raw.githubusercontent.com/ade-plugins/ade-plugins-registry/main/index.json";

/**
 * How long a cached index is served without asking. Long, on purpose: the
 * directory is a discovery aid, an entry going stale for a few hours costs
 * nothing, and every refresh is a request some machine somewhere pays for. An
 * explicit `refresh` from the UI bypasses it.
 */
export const PLUGIN_REGISTRY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const CACHE_FILE = ".index-cache.json";
const FETCH_TIMEOUT_MS = 15_000;

export type PluginRegistryFetchResult = {
  entries: PluginRegistryEntry[];
  /** When the index was last confirmed current — a 304 counts. */
  fetchedAt: string | null;
  origin: "network" | "cache";
};

type PluginRegistryCacheFile = {
  version: 1;
  url: string;
  etag: string | null;
  /** When the bytes were last confirmed current (200 or 304). */
  fetchedAt: string;
  index: PluginRegistryIndex;
};

export type PluginRegistryService = {
  readonly indexUrl: string;
  readonly cachePath: string;
  /**
   * The directory. `refresh` skips the freshness window and revalidates.
   * Returns null only when there is no cache and the network did not answer.
   */
  fetchIndex(options?: { refresh?: boolean }): Promise<PluginRegistryFetchResult | null>;
  /** The cached index without touching the network. Null when cold. */
  readCachedIndex(): PluginRegistryFetchResult | null;
  /** Drop the cache. Used by `ade plugin` troubleshooting, not by the UI. */
  clearCache(): void;
};

/** `<machine adeDir>/plugins/.index-cache.json` — machine-scoped, like installs. */
export function resolvePluginRegistryCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveMachineAdeLayout(env).adeDir, "plugins", CACHE_FILE);
}

/**
 * The index URL, guarded.
 *
 * `https` in every real configuration; plaintext is permitted only against a
 * loopback host, which is how `ade plugin` is developed against a local copy of
 * the registry. Anything else falls back to the published URL rather than
 * failing, because an unusable override should degrade the directory, not
 * remove it.
 */
export function resolvePluginRegistryIndexUrl(
  env: NodeJS.ProcessEnv = process.env,
  override?: string,
): string {
  const raw = (override ?? env.ADE_PLUGIN_REGISTRY_URL ?? "").trim();
  if (!raw) return DEFAULT_PLUGIN_REGISTRY_INDEX_URL;
  try {
    const url = new URL(raw);
    if (url.username || url.password) return DEFAULT_PLUGIN_REGISTRY_INDEX_URL;
    if (url.protocol === "https:") return url.toString();
    const loopback = url.hostname === "localhost"
      || url.hostname === "127.0.0.1"
      || url.hostname === "[::1]";
    if (url.protocol === "http:" && loopback) return url.toString();
  } catch {
    return DEFAULT_PLUGIN_REGISTRY_INDEX_URL;
  }
  return DEFAULT_PLUGIN_REGISTRY_INDEX_URL;
}

function readCacheFile(cachePath: string, url: string): PluginRegistryCacheFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(cachePath, "utf8");
  } catch {
    return null;
  }
  const parsed = safeJsonParse<Partial<PluginRegistryCacheFile> | null>(raw, null);
  if (!parsed || parsed.version !== 1) return null;
  // A cache keyed to a different URL is not this directory's cache. Serving it
  // would let a stale override leak into the default configuration.
  if (parsed.url !== url) return null;
  if (typeof parsed.fetchedAt !== "string" || Number.isNaN(Date.parse(parsed.fetchedAt))) return null;
  const result = parsePluginRegistryIndex(parsed.index);
  if (!result.index) return null;
  return {
    version: 1,
    url,
    etag: typeof parsed.etag === "string" && parsed.etag.length > 0 ? parsed.etag : null,
    fetchedAt: parsed.fetchedAt,
    index: result.index,
  };
}

export function createPluginRegistryService(args: {
  logger: Logger;
  indexUrl?: string;
  cachePath?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): PluginRegistryService {
  const env = args.env ?? process.env;
  const indexUrl = resolvePluginRegistryIndexUrl(env, args.indexUrl);
  const cachePath = args.cachePath ?? resolvePluginRegistryCachePath(env);
  const now = args.now ?? (() => new Date());

  const writeCache = (file: PluginRegistryCacheFile): void => {
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      writeTextAtomic(cachePath, `${JSON.stringify(file, null, 2)}\n`);
    } catch (error) {
      // A machine with no writable ADE directory still browses the directory;
      // it just pays for the fetch every time.
      args.logger.debug("plugin.registry_cache_write_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const toResult = (
    index: PluginRegistryIndex,
    fetchedAt: string,
    origin: "network" | "cache",
  ): PluginRegistryFetchResult => ({ entries: index.entries, fetchedAt, origin });

  const readCachedIndex = (): PluginRegistryFetchResult | null => {
    const cached = readCacheFile(cachePath, indexUrl);
    return cached ? toResult(cached.index, cached.fetchedAt, "cache") : null;
  };

  return {
    indexUrl,
    cachePath,
    readCachedIndex,
    clearCache(): void {
      try {
        fs.rmSync(cachePath, { force: true });
      } catch {
        // Nothing depends on the file being gone; the next fetch overwrites it.
      }
    },

    async fetchIndex(options: { refresh?: boolean } = {}): Promise<PluginRegistryFetchResult | null> {
      const cached = readCacheFile(cachePath, indexUrl);
      const ageMs = cached ? now().getTime() - Date.parse(cached.fetchedAt) : Number.POSITIVE_INFINITY;
      if (cached && !options.refresh && ageMs >= 0 && ageMs < PLUGIN_REGISTRY_CACHE_TTL_MS) {
        return toResult(cached.index, cached.fetchedAt, "cache");
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const fetchImpl = args.fetchImpl ?? fetch;
        const headers: Record<string, string> = { accept: "application/json" };
        if (cached?.etag) headers["if-none-match"] = cached.etag;
        const response = await fetchImpl(indexUrl, { headers, signal: controller.signal });

        if (response.status === 304 && cached) {
          // Confirmed current with no body — the cheap path, and the reason the
          // freshness window can be short without costing bandwidth.
          const fetchedAt = now().toISOString();
          writeCache({ ...cached, fetchedAt });
          return toResult(cached.index, fetchedAt, "cache");
        }
        if (!response.ok) {
          args.logger.debug("plugin.registry_fetch_rejected", { status: response.status });
          return cached ? toResult(cached.index, cached.fetchedAt, "cache") : null;
        }

        const body = await response.text();
        if (body.length > PLUGIN_REGISTRY_LIMITS.maxBytes) {
          args.logger.warn("plugin.registry_index_too_large", { bytes: body.length });
          return cached ? toResult(cached.index, cached.fetchedAt, "cache") : null;
        }
        const decoded = safeJsonParse<unknown>(body, null);
        const parsed = parsePluginRegistryIndex(decoded);
        if (!parsed.index) {
          // Keep serving the last good index. A directory that publishes a bad
          // build must not be able to blank every Marketplace that fetches it.
          args.logger.warn("plugin.registry_index_invalid", { errors: parsed.errors.slice(0, 3) });
          return cached ? toResult(cached.index, cached.fetchedAt, "cache") : null;
        }
        if (parsed.warnings.length > 0) {
          args.logger.debug("plugin.registry_entries_dropped", {
            dropped: parsed.warnings.length,
            examples: parsed.warnings.slice(0, 3),
          });
        }

        const fetchedAt = now().toISOString();
        writeCache({
          version: 1,
          url: indexUrl,
          etag: response.headers.get("etag"),
          fetchedAt,
          index: parsed.index,
        });
        return toResult(parsed.index, fetchedAt, "network");
      } catch (error) {
        args.logger.debug("plugin.registry_fetch_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        return cached ? toResult(cached.index, cached.fetchedAt, "cache") : null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
