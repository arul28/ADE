import fs from "node:fs";
import path from "node:path";

import { GITHUB_REST_API_VERSION } from "../../../../desktop/src/main/services/github/githubApiVersion";
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
  "https://raw.githubusercontent.com/arul28/ade-plugins-registry/main/index.json";

/**
 * How long a cached index is served without asking. Long, on purpose: the
 * directory is a discovery aid, an entry going stale for a few hours costs
 * nothing, and every refresh is a request some machine somewhere pays for. An
 * explicit `refresh` from the UI bypasses it.
 */
export const PLUGIN_REGISTRY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const CACHE_FILE = ".index-cache.json";
const FETCH_TIMEOUT_MS = 15_000;

/**
 * How long a repository's star count is served without asking again.
 *
 * A day, because the unauthenticated GitHub API allows 60 requests an hour per
 * IP and a Marketplace page can name a dozen repositories. A star count that is
 * a few hours out of date is indistinguishable from a fresh one to a reader
 * deciding whether to install something; a count that is MISSING because the
 * page spent its whole hourly budget on the first scroll is not.
 */
export const PLUGIN_REGISTRY_STARS_TTL_MS = 24 * 60 * 60 * 1000;

const STARS_CACHE_FILE = ".stars-cache.json";

/**
 * Repositories the stars cache keeps. The file is machine-scoped and lives as
 * long as the machine does, so without a ceiling every repository the reader
 * ever browsed would stay in it forever. Evicting the least recently confirmed
 * entry is the right eviction here: the entries that matter are the ones some
 * surface still asks about, and those are exactly the ones being refreshed.
 */
const STARS_CACHE_MAX_REPOS = 200;

/** A repository record is a few KiB. The ceiling is for a server that lies. */
const STARS_MAX_BYTES = 64 * 1024;

/** Owner and repository name: an identifier, never a path. */
const GITHUB_REPO_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Read a response body, giving up the moment it passes the ceiling.
 *
 * `await response.text()` buffers the WHOLE body before anything can check its
 * size, which makes the ceiling a check on a string that is already in memory —
 * a directory (or anything answering on its URL) could hand a machine gigabytes
 * and be refused only after it had all been read. The declared length is
 * checked first because a well-behaved server makes the refusal free; the
 * streamed cap is what covers a server that declares nothing or lies.
 *
 * Returns null when the body is too large. Falls back to `text()` only when the
 * response exposes no stream — the cap still applies, it is just applied late.
 */
async function readBodyWithin(response: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers?.get?.("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return null;

  const body = response.body as ReadableStream<Uint8Array> | null | undefined;
  if (!body || typeof body.getReader !== "function") {
    const text = await response.text();
    return text.length > maxBytes ? null : text;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) return null;
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    // Releases the connection whether the read finished or was abandoned.
    try {
      await reader.cancel();
    } catch {
      // A stream that is already done rejects cancel on some runtimes.
    }
  }
}

export type PluginRegistryFetchResult = {
  entries: PluginRegistryEntry[];
  /** When the index was last confirmed current — a 304 counts. */
  fetchedAt: string | null;
  origin: "network" | "cache";
  /**
   * True when THIS call reached the directory and it answered — a 200 with a
   * new body, or a 304 confirming the bytes already held. False when the answer
   * came out of the cache without asking, or after the network failed.
   *
   * `origin` cannot carry this: a revalidated index is still served from cache
   * and reads `"cache"`, which is right for "where did these bytes come from"
   * and wrong for "is this current". The difference matters exactly once, and
   * it matters a lot — see {@link PluginRegistryService.resolveEntryForVerification}.
   */
  confirmed: boolean;
};

/**
 * What the directory says about one plugin, for a caller that must not proceed
 * on a guess.
 *
 * Three answers, deliberately distinct. `absent` means the directory answered
 * and does not list this plugin; `unreachable` means nobody answered, which is
 * NOT the same thing and must never be read as "no checksum published".
 */
export type PluginRegistryEntryRead =
  | { status: "entry"; entry: PluginRegistryEntry }
  | { status: "absent" }
  | { status: "unreachable" };

type PluginRegistryCacheFile = {
  version: 1;
  url: string;
  etag: string | null;
  /** When the bytes were last confirmed current (200 or 304). */
  fetchedAt: string;
  index: PluginRegistryIndex;
};

/**
 * One repository's star count as this machine last saw it.
 *
 * `etag` is kept beside the count rather than instead of it: a 304 carries no
 * body, so the only way to answer a revalidated read is to still hold the
 * number the etag was issued for.
 */
type PluginStarsCacheEntry = {
  stars: number;
  etag: string | null;
  /** When the count was last confirmed current. A 304 counts. */
  fetchedAt: string;
};

type PluginStarsCacheFile = {
  version: 1;
  /** Keyed `<owner>/<name>`, the same slug the API path is built from. */
  repos: Record<string, PluginStarsCacheEntry>;
};

export type PluginRegistryService = {
  readonly indexUrl: string;
  readonly cachePath: string;
  /** `<machine adeDir>/plugins/.stars-cache.json`, beside the index cache. */
  readonly starsCachePath: string;
  /**
   * The directory. `refresh` skips the freshness window and revalidates.
   * Returns null only when there is no cache and the network did not answer.
   */
  fetchIndex(options?: { refresh?: boolean }): Promise<PluginRegistryFetchResult | null>;
  /** The cached index without touching the network. Null when cold. */
  readCachedIndex(): PluginRegistryFetchResult | null;
  /**
   * One plugin's entry, confirmed against the directory on this call.
   *
   * For the install path's checksum gate, and the reason it does not just read
   * the cache: the digest is a tamper check on the directory's claim, so an
   * answer that never left the machine proves nothing about it. A cold cache
   * would say "no checksum published" for a plugin the directory does vouch
   * for, which turns "verify official installs" into "verify official installs
   * on machines that happen to have browsed the Marketplace recently".
   *
   * Answering `unreachable` rather than falling back to the cache is what lets
   * the caller decide — the honest choice for an OFFICIAL plugin is to refuse
   * the install, and only the caller knows the plugin is official.
   */
  resolveEntryForVerification(pluginId: string): Promise<PluginRegistryEntryRead>;
  /**
   * How many stars a plugin's repository has, or null when nobody can say.
   *
   * A directory entry publishes a `stars` figure, but it is only as fresh as
   * the last crawl — a plugin that got attention this week reads as unnoticed
   * until the crawler runs again. This is the live read that fixes that, and
   * everything about it is shaped by ONE fact: the unauthenticated GitHub API
   * allows 60 requests an hour per IP, so being rate limited is the NORMAL
   * outcome for a machine that browses the Marketplace, not a fault.
   *
   * What follows from that:
   *
   * - **Null is an ordinary answer.** It means "not known here", and every
   *   caller must draw it as an absent count rather than as zero stars or as an
   *   error. Zero would be a claim about the repository; this function is never
   *   in a position to make one it did not read.
   * - **It never throws, and never fails a caller.** An install path or a page
   *   render that asked for a decoration must not be able to fail because
   *   GitHub declined to answer. Rate limits, 404s, timeouts and garbage bodies
   *   all degrade the same way: the cached count when one is held, else null.
   * - **A day of cache, held on disk.** See {@link PLUGIN_REGISTRY_STARS_TTL_MS}.
   *
   * `repo` is a repository URL exactly as the index publishes it. Anything that
   * is not an `https://github.com/<owner>/<name>` URL is refused WITHOUT a
   * request: the entry is third-party data, and it names the host this function
   * is willing to ask.
   */
  fetchRepoStars(repo: string): Promise<number | null>;
  /** Drop the cache. Used by `ade plugin` troubleshooting, not by the UI. */
  clearCache(): void;
};

/** `<machine adeDir>/plugins/.index-cache.json` — machine-scoped, like installs. */
export function resolvePluginRegistryCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveMachineAdeLayout(env).adeDir, "plugins", CACHE_FILE);
}

/** `<machine adeDir>/plugins/.stars-cache.json` — beside the index cache. */
export function resolvePluginStarsCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveMachineAdeLayout(env).adeDir, "plugins", STARS_CACHE_FILE);
}

/**
 * `<owner>/<name>` for a GitHub repository URL, or null for anything else.
 *
 * Deliberately narrow. The URL comes out of a published index, which is
 * third-party data, and the only safe thing to do with third-party data that is
 * about to be interpolated into a request path is to prove it is two
 * identifiers first. `.` and `..` pass the character class and are rejected by
 * name — they are the traversal that would turn `/repos/<slug>` into some other
 * endpoint entirely.
 */
function parseGithubRepoSlug(repo: unknown): string | null {
  if (typeof repo !== "string" || repo.trim().length === 0) return null;
  let url: URL;
  try {
    url = new URL(repo.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return null;

  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 2) return null;
  const owner = segments[0] ?? "";
  // A clone URL is the same repository written differently; the API path is not
  // spelled with the suffix.
  const name = (segments[1] ?? "").replace(/\.git$/i, "");
  for (const segment of [owner, name]) {
    if (!GITHUB_REPO_SEGMENT_PATTERN.test(segment)) return null;
    if (segment === "." || segment === "..") return null;
  }
  return `${owner}/${name}`;
}

/**
 * The stars cache as it reads on disk, entry by entry.
 *
 * A row that does not parse is dropped rather than failing the file: the cost
 * of one unreadable row is one extra request, and the cost of failing the file
 * is every count on the page disappearing because one of them was corrupt.
 */
function readStarsCacheFile(cachePath: string): PluginStarsCacheFile {
  const empty: PluginStarsCacheFile = { version: 1, repos: {} };
  let raw: string;
  try {
    raw = fs.readFileSync(cachePath, "utf8");
  } catch {
    return empty;
  }
  const parsed = safeJsonParse<Partial<PluginStarsCacheFile> | null>(raw, null);
  if (!parsed || parsed.version !== 1 || !parsed.repos || typeof parsed.repos !== "object") return empty;

  const repos: Record<string, PluginStarsCacheEntry> = {};
  for (const [slug, value] of Object.entries(parsed.repos as Record<string, unknown>)) {
    const row = value as Partial<PluginStarsCacheEntry> | null;
    if (!row || typeof row !== "object") continue;
    if (typeof row.stars !== "number" || !Number.isFinite(row.stars) || row.stars < 0) continue;
    if (typeof row.fetchedAt !== "string" || Number.isNaN(Date.parse(row.fetchedAt))) continue;
    repos[slug] = {
      stars: row.stars,
      etag: typeof row.etag === "string" && row.etag.length > 0 ? row.etag : null,
      fetchedAt: row.fetchedAt,
    };
  }
  return { version: 1, repos };
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
  // Derived from the index cache's directory rather than resolved separately,
  // so an injected `cachePath` (a test, a sandboxed machine layout) moves BOTH
  // caches. Two files that are meant to sit together must not be able to end up
  // on different disks because one of them read the environment again.
  const starsCachePath = path.join(path.dirname(cachePath), STARS_CACHE_FILE);
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

  /**
   * Store one repository's count, evicting the least recently confirmed entries
   * once the file passes its ceiling.
   *
   * Written whole rather than merged in place because the file is re-read on
   * every call: two surfaces reading stars at once would otherwise take turns
   * clobbering each other's row, and the cost of losing one is a request, not
   * data. Write failures are swallowed for the same reason `writeCache` does —
   * a machine with no writable ADE directory still gets its star counts, it
   * just pays for them again tomorrow.
   */
  const writeStarsCache = (file: PluginStarsCacheFile): void => {
    const slugs = Object.keys(file.repos);
    if (slugs.length > STARS_CACHE_MAX_REPOS) {
      const oldestFirst = slugs.sort(
        (left, right) =>
          Date.parse(file.repos[left]?.fetchedAt ?? "") - Date.parse(file.repos[right]?.fetchedAt ?? ""),
      );
      for (const slug of oldestFirst.slice(0, slugs.length - STARS_CACHE_MAX_REPOS)) {
        delete file.repos[slug];
      }
    }
    try {
      fs.mkdirSync(path.dirname(starsCachePath), { recursive: true });
      writeTextAtomic(starsCachePath, `${JSON.stringify(file, null, 2)}\n`);
    } catch (error) {
      args.logger.debug("plugin.registry_stars_cache_write_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const toResult = (
    index: PluginRegistryIndex,
    fetchedAt: string,
    origin: "network" | "cache",
    confirmed = false,
  ): PluginRegistryFetchResult => ({ entries: index.entries, fetchedAt, origin, confirmed });

  const readCachedIndex = (): PluginRegistryFetchResult | null => {
    const cached = readCacheFile(cachePath, indexUrl);
    return cached ? toResult(cached.index, cached.fetchedAt, "cache") : null;
  };

  const service: PluginRegistryService = {
    indexUrl,
    cachePath,
    starsCachePath,
    readCachedIndex,

    async resolveEntryForVerification(pluginId: string): Promise<PluginRegistryEntryRead> {
      let result: PluginRegistryFetchResult | null = null;
      try {
        result = await service.fetchIndex({ refresh: true });
      } catch {
        // `fetchIndex` handles its own failures; this is belt and braces so a
        // verification read can never throw into an install.
        result = null;
      }
      if (!result?.confirmed) return { status: "unreachable" };
      const entry = result.entries.find((row) => row.pluginId === pluginId);
      return entry ? { status: "entry", entry } : { status: "absent" };
    },
    async fetchRepoStars(repo: string): Promise<number | null> {
      const slug = parseGithubRepoSlug(repo);
      // Refused before any request: a URL this function will not ask about
      // costs nothing, and a rate-limit budget spent proving that is a budget
      // the real repositories on the page no longer have.
      if (!slug) return null;

      const cache = readStarsCacheFile(starsCachePath);
      const held = cache.repos[slug] ?? null;
      const ageMs = held ? now().getTime() - Date.parse(held.fetchedAt) : Number.POSITIVE_INFINITY;
      if (held && ageMs >= 0 && ageMs < PLUGIN_REGISTRY_STARS_TTL_MS) return held.stars;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const fetchImpl = args.fetchImpl ?? fetch;
        const headers: Record<string, string> = {
          accept: "application/vnd.github+json",
          "x-github-api-version": GITHUB_REST_API_VERSION,
        };
        // A conditional request that answers 304 does not count against the
        // unauthenticated hourly limit, which is what lets a long-lived machine
        // keep every count current without ever running out of budget.
        if (held?.etag) headers["if-none-match"] = held.etag;
        const response = await fetchImpl(`https://api.github.com/repos/${slug}`, {
          headers,
          signal: controller.signal,
        });

        if (response.status === 304 && held) {
          cache.repos[slug] = { ...held, fetchedAt: now().toISOString() };
          writeStarsCache(cache);
          return held.stars;
        }
        if (!response.ok) {
          // 403 and 429 are the rate limit, 404 is a repository that moved or
          // went private, and none of them is this machine's fault. Debug, not
          // warn: a log line per plugin per hour would be noise that says
          // nothing an operator can act on.
          args.logger.debug("plugin.registry_stars_rejected", { slug, status: response.status });
          return held?.stars ?? null;
        }

        const body = await readBodyWithin(response, STARS_MAX_BYTES);
        if (body === null) {
          args.logger.debug("plugin.registry_stars_too_large", { slug, maxBytes: STARS_MAX_BYTES });
          return held?.stars ?? null;
        }
        const decoded = safeJsonParse<{ stargazers_count?: unknown } | null>(body, null);
        const stars = decoded?.stargazers_count;
        if (typeof stars !== "number" || !Number.isFinite(stars) || stars < 0) {
          args.logger.debug("plugin.registry_stars_unreadable", { slug });
          return held?.stars ?? null;
        }

        const count = Math.round(stars);
        cache.repos[slug] = {
          stars: count,
          etag: response.headers?.get?.("etag") ?? null,
          fetchedAt: now().toISOString(),
        };
        writeStarsCache(cache);
        return count;
      } catch (error) {
        // A timeout, a DNS failure, or an abort. The cached count is the best
        // answer available and is better than none; null when there is none.
        args.logger.debug("plugin.registry_stars_failed", {
          slug,
          message: error instanceof Error ? error.message : String(error),
        });
        return held?.stars ?? null;
      } finally {
        clearTimeout(timer);
      }
    },

    clearCache(): void {
      try {
        fs.rmSync(cachePath, { force: true });
        // The star counts are the same cache from a troubleshooter's point of
        // view — "clear the cache" that leaves a day-old count behind would
        // answer the next report of a wrong number with the wrong number.
        fs.rmSync(starsCachePath, { force: true });
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
          return toResult(cached.index, fetchedAt, "cache", true);
        }
        if (!response.ok) {
          args.logger.debug("plugin.registry_fetch_rejected", { status: response.status });
          return cached ? toResult(cached.index, cached.fetchedAt, "cache") : null;
        }

        const body = await readBodyWithin(response, PLUGIN_REGISTRY_LIMITS.maxBytes);
        if (body === null) {
          args.logger.warn("plugin.registry_index_too_large", {
            maxBytes: PLUGIN_REGISTRY_LIMITS.maxBytes,
            declared: response.headers?.get?.("content-length") ?? null,
          });
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
        return toResult(parsed.index, fetchedAt, "network", true);
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

  return service;
}
