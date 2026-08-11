import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PLUGIN_REGISTRY_INDEX_URL,
  PLUGIN_REGISTRY_CACHE_TTL_MS,
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
  return new Response(body, {
    status: init.status ?? 200,
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
