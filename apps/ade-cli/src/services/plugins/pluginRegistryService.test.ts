import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PLUGIN_REGISTRY_INDEX_URL,
  PLUGIN_REGISTRY_CACHE_TTL_MS,
  PLUGIN_REGISTRY_STARS_TTL_MS,
  createPluginRegistryService,
  resolvePluginRegistryIndexUrl,
} from "./pluginRegistryService";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const INDEX_URL = "https://registry.example/index.json";

function indexBody(entries: Array<Record<string, unknown>>): string {
  return JSON.stringify({ version: 1, generatedAt: "2026-08-11T00:00:00.000Z", entries });
}

function entry(pluginId: string): Record<string, unknown> {
  return {
    pluginId,
    displayName: pluginId,
    description: "",
    author: "ADE",
    version: "1.0.0",
    repo: `https://github.com/ade-plugins/${pluginId}`,
  };
}

function jsonResponse(body: string, init: { status?: number; etag?: string } = {}): Response {
  const status = init.status ?? 200;
  // 304 is a null-body status: `new Response("", {status: 304})` THROWS, which
  // a stub that builds one turns into a rejected fetch — i.e. the offline path,
  // not the revalidation path. Every "treats 304 as current" case here was
  // silently testing the wrong branch until this passed null.
  return new Response(status === 304 || status === 204 ? null : body, {
    status,
    headers: init.etag ? { etag: init.etag } : {},
  });
}

describe("plugin registry service", () => {
  let cacheDir: string;
  let cachePath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-registry-"));
    cachePath = path.join(cacheDir, "plugins", ".index-cache.json");
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  const service = (fetchImpl: typeof fetch, now?: () => Date) =>
    createPluginRegistryService({
      logger,
      indexUrl: INDEX_URL,
      cachePath,
      env: {},
      fetchImpl,
      ...(now ? { now } : {}),
    });

  it("fetches, caches, and serves the cache inside the freshness window", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(indexBody([entry("graph")]), { etag: "v1" }));
    const registry = service(fetchImpl as unknown as typeof fetch);

    const first = await registry.fetchIndex();
    expect(first).toMatchObject({ origin: "network" });
    expect(first?.entries.map((row) => row.pluginId)).toEqual(["graph"]);
    expect(fs.existsSync(cachePath)).toBe(true);

    const second = await registry.fetchIndex();
    expect(second).toMatchObject({ origin: "cache" });
    // The whole point of the window: a second look costs no request at all.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("revalidates with the stored etag and treats 304 as current", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      return headers["if-none-match"] === "v1"
        ? jsonResponse("", { status: 304 })
        : jsonResponse(indexBody([entry("graph")]), { etag: "v1" });
    });
    const registry = service(fetchImpl as unknown as typeof fetch);

    await registry.fetchIndex();
    const revalidated = await registry.fetchIndex({ refresh: true });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(revalidated?.entries.map((row) => row.pluginId)).toEqual(["graph"]);
    // A 304 confirms the bytes rather than replacing them, so the index is still
    // served from cache — but it is now known-current, which is what the
    // Marketplace shows as its "as of" time.
    expect(revalidated?.origin).toBe("cache");
    expect(Date.parse(revalidated?.fetchedAt ?? "")).toBeGreaterThan(0);
  });

  it("refreshes once the freshness window has passed", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(indexBody([entry("graph")]), { etag: "v1" }));
    let clock = Date.parse("2026-08-11T00:00:00.000Z");
    const registry = service(fetchImpl as unknown as typeof fetch, () => new Date(clock));

    await registry.fetchIndex();
    clock += PLUGIN_REGISTRY_CACHE_TTL_MS + 1;
    await registry.fetchIndex();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("serves the last good index when the network is unreachable", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(indexBody([entry("graph")]), { etag: "v1" }))
      .mockRejectedValueOnce(new Error("offline"));
    const registry = service(fetchImpl as unknown as typeof fetch);

    await registry.fetchIndex();
    const offline = await registry.fetchIndex({ refresh: true });

    expect(offline).toMatchObject({ origin: "cache" });
    expect(offline?.entries.map((row) => row.pluginId)).toEqual(["graph"]);
  });

  it("returns null — never an empty directory — when there is nothing to show", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    // Null is what lets the Marketplace say "showing the built-in list"; an
    // empty array would render as "there are no plugins", which is a lie.
    expect(await service(fetchImpl as unknown as typeof fetch).fetchIndex()).toBeNull();
  });

  it("keeps the last good index when the directory publishes a broken one", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(indexBody([entry("graph")]), { etag: "v1" }))
      .mockResolvedValueOnce(jsonResponse("{ not json"));
    const registry = service(fetchImpl as unknown as typeof fetch);

    await registry.fetchIndex();
    const afterBadPublish = await registry.fetchIndex({ refresh: true });

    expect(afterBadPublish?.entries.map((row) => row.pluginId)).toEqual(["graph"]);
    expect(logger.warn).toHaveBeenCalledWith("plugin.registry_index_invalid", expect.anything());
  });

  it("refuses an oversized index instead of caching it", async () => {
    const oversized = `{"version":1,"entries":[],"padding":"${"x".repeat(3 * 1024 * 1024)}"}`;
    const fetchImpl = vi.fn(async () => jsonResponse(oversized));
    const registry = service(fetchImpl as unknown as typeof fetch);

    expect(await registry.fetchIndex()).toBeNull();
    expect(fs.existsSync(cachePath)).toBe(false);
  });

  it("refuses an oversized index by its declared length, before draining the body", async () => {
    let pulls = 0;
    const fetchImpl = vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new TextEncoder().encode("x".repeat(1024 * 1024)));
        },
      }),
      { headers: { "content-length": String(64 * 1024 * 1024) } },
    ));
    const registry = service(fetchImpl as unknown as typeof fetch);

    expect(await registry.fetchIndex()).toBeNull();
    // The defect this pins: `await response.text()` buffered the whole body and
    // THEN measured it, so the ceiling only ever refused something the machine
    // had already read into memory. One pull is the stream filling its own
    // one-chunk queue at construction; anything past that would be this code
    // reading a body it had already been told was too big.
    expect(pulls).toBeLessThanOrEqual(1);
    expect(logger.warn).toHaveBeenCalledWith("plugin.registry_index_too_large", expect.anything());
  });

  it("stops reading a body that passes the ceiling without declaring its length", async () => {
    let chunks = 0;
    const fetchImpl = vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          chunks += 1;
          controller.enqueue(new TextEncoder().encode("x".repeat(256 * 1024)));
        },
      }),
    ));
    const registry = service(fetchImpl as unknown as typeof fetch);

    expect(await registry.fetchIndex()).toBeNull();
    // 2 MiB ceiling at 256 KiB a chunk: it gives up shortly after crossing it
    // rather than reading whatever the server feels like sending.
    expect(chunks).toBeLessThanOrEqual(16);
  });

  describe("resolving an entry for checksum verification", () => {
    it("answers from a directory read confirmed on this call", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(indexBody([entry("graph")]), { etag: "v1" }));
      const registry = service(fetchImpl as unknown as typeof fetch);

      // Warm the cache first: the point is that the verification read does NOT
      // settle for it, because a digest that never left the machine proves
      // nothing about what the directory currently vouches for.
      await registry.fetchIndex();
      const read = await registry.resolveEntryForVerification("graph");

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(read).toMatchObject({ status: "entry" });
    });

    it("counts a 304 as confirmation — the bytes are current, that is the question", async () => {
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        return headers["if-none-match"] === "v1"
          ? jsonResponse("", { status: 304 })
          : jsonResponse(indexBody([entry("graph")]), { etag: "v1" });
      });
      const registry = service(fetchImpl as unknown as typeof fetch);

      await registry.fetchIndex();
      expect(await registry.resolveEntryForVerification("graph")).toMatchObject({ status: "entry" });
    });

    it("says a directory it could not reach is unreachable, never 'no checksum published'", async () => {
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(jsonResponse(indexBody([entry("graph")]), { etag: "v1" }))
        .mockRejectedValue(new Error("offline"));
      const registry = service(fetchImpl as unknown as typeof fetch);

      await registry.fetchIndex();
      // The cache still holds a good index — `fetchIndex` serves it, and that is
      // right for browsing. It is wrong for verification: "the directory does
      // not vouch for this version" and "nobody answered" are different facts,
      // and only the caller knows that the second one must refuse an official
      // install rather than install it unverified.
      expect(await registry.fetchIndex()).toMatchObject({ origin: "cache" });
      expect(await registry.resolveEntryForVerification("graph")).toEqual({ status: "unreachable" });
    });

    it("distinguishes a plugin the directory does not list from one it could not read", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(indexBody([entry("graph")])));
      const registry = service(fetchImpl as unknown as typeof fetch);

      expect(await registry.resolveEntryForVerification("nobody")).toEqual({ status: "absent" });
    });
  });

  describe("fetching a repository's star count", () => {
    const REPO = "https://github.com/arul28/ade-graph";

    const starsResponse = (stars: number, init: { etag?: string; status?: number } = {}) =>
      jsonResponse(JSON.stringify({ stargazers_count: stars }), init);

    it("refuses anything that is not a GitHub repository URL without asking anyone", async () => {
      const fetchImpl = vi.fn();
      const registry = service(fetchImpl as unknown as typeof fetch);

      for (const repo of [
        "",
        "not a url",
        "http://github.com/arul28/ade-graph",
        "https://gitlab.com/arul28/ade-graph",
        "https://github.com/arul28",
        "https://github.com/arul28/ade-graph/tree/main",
        "https://github.com/../ade-graph",
        "https://user:pw@github.com/arul28/ade-graph",
      ]) {
        expect(await registry.fetchRepoStars(repo)).toBeNull();
      }
      // The point is the zero: a rate-limit budget spent proving a URL is not a
      // repository is a budget the real repositories on the page no longer have.
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("fetches a count once and serves it from cache for the rest of the day", async () => {
      const fetchImpl = vi.fn(async () => starsResponse(128, { etag: "s1" }));
      let clock = Date.parse("2026-08-11T00:00:00.000Z");
      const registry = service(fetchImpl as unknown as typeof fetch, () => new Date(clock));

      expect(await registry.fetchRepoStars(REPO)).toBe(128);
      expect(fs.existsSync(path.join(cacheDir, "plugins", ".stars-cache.json"))).toBe(true);

      clock += 23 * 60 * 60 * 1000;
      expect(await registry.fetchRepoStars(REPO)).toBe(128);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("revalidates with the stored etag once the day is up and keeps the count on a 304", async () => {
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        return headers["if-none-match"] === "s1"
          ? starsResponse(0, { status: 304 })
          : starsResponse(128, { etag: "s1" });
      });
      let clock = Date.parse("2026-08-11T00:00:00.000Z");
      const registry = service(fetchImpl as unknown as typeof fetch, () => new Date(clock));

      await registry.fetchRepoStars(REPO);
      clock += PLUGIN_REGISTRY_STARS_TTL_MS + 1;
      // A 304 carries no body, so the only thing that can answer it is the count
      // the etag was issued for — and it is now current for another day.
      expect(await registry.fetchRepoStars(REPO)).toBe(128);
      expect(fetchImpl).toHaveBeenCalledTimes(2);

      clock += 1_000;
      expect(await registry.fetchRepoStars(REPO)).toBe(128);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("serves the cached count when GitHub rate limits the machine", async () => {
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(starsResponse(128, { etag: "s1" }))
        .mockResolvedValue(jsonResponse("{\"message\":\"API rate limit exceeded\"}", { status: 403 }));
      let clock = Date.parse("2026-08-11T00:00:00.000Z");
      const registry = service(fetchImpl as unknown as typeof fetch, () => new Date(clock));

      await registry.fetchRepoStars(REPO);
      clock += PLUGIN_REGISTRY_STARS_TTL_MS + 1;
      // 60 requests an hour per IP is the normal budget, so this is the expected
      // path rather than the exceptional one: the day-old count beats no count.
      expect(await registry.fetchRepoStars(REPO)).toBe(128);
    });

    it("answers null — never zero — when it is rate limited with nothing cached", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse("{\"message\":\"rate limited\"}", { status: 403 }));
      const registry = service(fetchImpl as unknown as typeof fetch);

      // Zero would be a claim about the repository. This call is never in a
      // position to make one it did not read.
      expect(await registry.fetchRepoStars(REPO)).toBeNull();
    });

    it("degrades to null when the network fails or the body is not a count", async () => {
      const offline = vi.fn(async () => {
        throw new Error("offline");
      });
      expect(await service(offline as unknown as typeof fetch).fetchRepoStars(REPO)).toBeNull();

      const garbage = vi.fn(async () => jsonResponse(JSON.stringify({ stargazers_count: "lots" })));
      expect(await service(garbage as unknown as typeof fetch).fetchRepoStars(REPO)).toBeNull();
    });
  });

  it("ignores a cache written for a different registry URL", async () => {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({
      version: 1,
      url: "https://somewhere-else.example/index.json",
      etag: "v1",
      fetchedAt: new Date().toISOString(),
      index: { version: 1, generatedAt: null, entries: [entry("stale")] },
    }));
    const fetchImpl = vi.fn(async () => jsonResponse(indexBody([entry("graph")])));
    const registry = service(fetchImpl as unknown as typeof fetch);

    const result = await registry.fetchIndex();
    expect(result?.entries.map((row) => row.pluginId)).toEqual(["graph"]);
  });

  it("drops a malformed cache file rather than failing the read", () => {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, "not json at all");
    const registry = service(vi.fn() as unknown as typeof fetch);
    expect(registry.readCachedIndex()).toBeNull();
  });

  it("falls back to the published URL for an override that is not fetchable safely", () => {
    expect(resolvePluginRegistryIndexUrl({}, undefined)).toBe(DEFAULT_PLUGIN_REGISTRY_INDEX_URL);
    expect(resolvePluginRegistryIndexUrl({}, "http://evil.example/index.json"))
      .toBe(DEFAULT_PLUGIN_REGISTRY_INDEX_URL);
    expect(resolvePluginRegistryIndexUrl({}, "https://user:pw@registry.example/index.json"))
      .toBe(DEFAULT_PLUGIN_REGISTRY_INDEX_URL);
    expect(resolvePluginRegistryIndexUrl({}, "not a url")).toBe(DEFAULT_PLUGIN_REGISTRY_INDEX_URL);
    // Loopback plaintext is the local-registry development loop.
    expect(resolvePluginRegistryIndexUrl({}, "http://127.0.0.1:8080/index.json"))
      .toBe("http://127.0.0.1:8080/index.json");
    expect(resolvePluginRegistryIndexUrl({ ADE_PLUGIN_REGISTRY_URL: INDEX_URL })).toBe(INDEX_URL);
  });
});
