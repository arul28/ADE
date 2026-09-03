/* @vitest-environment jsdom */
// @vitest-environment-options {"url":"https://app.ade-app.dev/"}

import { describe, expect, it } from "vitest";

import {
  guestFileUrl,
  loadPluginPageBundle,
  normalizePluginPagePath,
  pathFromGuestUrl,
  planPluginPageFetch,
  pluginPageBaseUrl,
  pluginPageCacheName,
  pluginPageMimeType,
  resolvePluginPageEntry,
  PLUGIN_PAGE_MAX_FILE_BYTES,
} from "../pageAssets";
import type { WebPluginPageManifest } from "../../adapter/plugins";

const BASE = pluginPageBaseUrl("https://app.ade-app.dev/assets/pluginPageServiceWorker-abc.js");

/**
 * A Cache Storage that behaves like the browser's for the two things this
 * module uses it for: exact-URL matching, and a named-cache registry it can
 * enumerate and delete from.
 */
function fakeCaches(): CacheStorage & { store: Map<string, Map<string, Response>> } {
  const store = new Map<string, Map<string, Response>>();
  const open = async (name: string): Promise<Cache> => {
    const entries = store.get(name) ?? new Map<string, Response>();
    store.set(name, entries);
    const url = (request: RequestInfo | URL): string =>
      typeof request === "string" ? request : request instanceof Request ? request.url : String(request);
    return {
      async put(request: RequestInfo | URL, response: Response) {
        entries.set(url(request), response);
      },
      async match(request: RequestInfo | URL) {
        const found = entries.get(url(request));
        return found ? found.clone() : undefined;
      },
      async keys() {
        return [...entries.keys()].map((href) => new Request(href));
      },
    } as unknown as Cache;
  };
  return {
    store,
    open,
    async keys() {
      return [...store.keys()];
    },
    async delete(name: string) {
      return store.delete(name);
    },
    async match() {
      return undefined;
    },
    async has(name: string) {
      return store.has(name);
    },
  } as unknown as CacheStorage & { store: Map<string, Map<string, Response>> };
}

function base64(text: string): string {
  return btoa(text);
}

describe("plugin page paths", () => {
  it("refuses a path that escapes the page root", () => {
    expect(normalizePluginPagePath("assets/app.js")).toBe("assets/app.js");
    expect(normalizePluginPagePath("./assets/../app.js")).toBeNull();
    expect(normalizePluginPagePath("../secrets.env")).toBeNull();
    expect(normalizePluginPagePath("a\\b.js")).toBeNull();
    expect(normalizePluginPagePath("")).toBeNull();
  });

  it("serves only the media types in the closed map", () => {
    expect(pluginPageMimeType("app.js")).toBe("text/javascript; charset=utf-8");
    expect(pluginPageMimeType("index.html")).toBe("text/html; charset=utf-8");
    // No extension outside the table gets a type, and the caller drops the file
    // rather than serving it under a guessed one.
    expect(pluginPageMimeType("run.sh")).toBeNull();
    expect(pluginPageMimeType("Makefile")).toBeNull();
  });

  it("round-trips a page path through the guest URL space", () => {
    const url = guestFileUrl(BASE, "ade-linear", "1.2.0-3", "assets/app.js");
    expect(url).toBe(`${BASE}ade-linear/1.2.0-3/assets/app.js`);
    expect(pathFromGuestUrl(BASE, url)).toBe("assets/app.js");
    expect(pathFromGuestUrl(BASE, "https://app.ade-app.dev/other")).toBeNull();
  });

  it("prefers index.html, then the plugin's declared entry", () => {
    expect(resolvePluginPageEntry(["page.html", "index.html"])).toBe("index.html");
    expect(resolvePluginPageEntry(["page.html", "index.html"], "page.html")).toBe("page.html");
    expect(resolvePluginPageEntry(["assets/app.js"])).toBeNull();
  });
});

describe("planPluginPageFetch", () => {
  const manifest: WebPluginPageManifest = {
    version: "1.0.0",
    revision: 1,
    files: [
      { path: "index.html", bytes: 100, sha256: "aaa" },
      { path: "assets/app.js", bytes: 200, sha256: "bbb" },
      { path: "assets/style.css", bytes: 50, sha256: "ccc" },
    ],
  };

  it("fetches only the files whose hash moved", () => {
    const plan = planPluginPageFetch(manifest, new Map([["index.html", "aaa"], ["assets/app.js", "OLD"]]));
    expect(plan.reuse.map((entry) => entry.path)).toEqual(["index.html"]);
    expect(plan.fetch.map((entry) => entry.path)).toEqual(["assets/app.js", "assets/style.css"]);
    expect(plan.skipped).toEqual([]);
  });

  it("skips a file over the per-file ceiling, an unknown type, and an escaping path", () => {
    const plan = planPluginPageFetch(
      {
        version: "1.0.0",
        revision: 1,
        files: [
          { path: "huge.js", bytes: PLUGIN_PAGE_MAX_FILE_BYTES + 1, sha256: "a" },
          { path: "run.sh", bytes: 10, sha256: "b" },
          { path: "../escape.js", bytes: 10, sha256: "c" },
          { path: "ok.js", bytes: 10, sha256: "d" },
        ],
      },
      new Map(),
    );
    expect(plan.fetch.map((entry) => entry.path)).toEqual(["ok.js"]);
    expect(plan.skipped.map((entry) => entry.path)).toEqual(["huge.js", "run.sh", "../escape.js"]);
  });
});

describe("loadPluginPageBundle", () => {
  const manifest: WebPluginPageManifest = {
    version: "2.0.0",
    revision: 4,
    files: [
      { path: "index.html", bytes: 5, sha256: "h-index" },
      { path: "app.js", bytes: 5, sha256: "h-app" },
    ],
  };

  it("caches every file under the version key and answers the bundle", async () => {
    const caches = fakeCaches();
    const reads: string[] = [];
    const { bundle, stats } = await loadPluginPageBundle({
      pluginId: "ade-linear",
      source: {
        manifest: async () => manifest,
        read: async ({ path }) => {
          reads.push(path);
          return { base64: base64(path === "index.html" ? "<html></html>" : "export{}") };
        },
      },
      caches,
      base: BASE,
    });

    expect(stats).toEqual({ reused: 0, fetched: 2, skipped: 0 });
    expect(reads.sort()).toEqual(["app.js", "index.html"]);
    expect(bundle.entry).toBe("index.html");
    expect(bundle.versionKey).toBe("2.0.0-4");
    expect(caches.store.has(pluginPageCacheName("ade-linear", "2.0.0-4"))).toBe(true);
    expect(bundle.files.map((file) => file.path).sort()).toEqual(["app.js", "index.html"]);
    expect(new TextDecoder().decode(bundle.files.find((file) => file.path === "app.js")?.bytes)).toBe("export{}");
  });

  it("re-reads nothing on a second load and deletes the previous build's cache", async () => {
    const caches = fakeCaches();
    const source = {
      manifest: async () => manifest,
      read: async () => ({ base64: base64("x") }),
    };
    await loadPluginPageBundle({ pluginId: "p", source, caches, base: BASE });

    let reads = 0;
    const second = await loadPluginPageBundle({
      pluginId: "p",
      source: {
        manifest: async () => manifest,
        read: async () => {
          reads += 1;
          return { base64: base64("x") };
        },
      },
      caches,
      base: BASE,
    });
    expect(reads).toBe(0);
    expect(second.stats.reused).toBe(2);

    // A rebuild moves the revision, which is a NEW cache; the old one is
    // deleted only once the new page is complete.
    await loadPluginPageBundle({
      pluginId: "p",
      source: { manifest: async () => ({ ...manifest, revision: 5 }), read: async () => ({ base64: base64("x") }) },
      caches,
      base: BASE,
    });
    expect([...caches.store.keys()]).toEqual([pluginPageCacheName("p", "2.0.0-5")]);
  });

  it("refuses a page whose tree has no html", async () => {
    await expect(
      loadPluginPageBundle({
        pluginId: "p",
        source: {
          manifest: async () => ({ version: "1", revision: 0, files: [{ path: "app.js", bytes: 2, sha256: "s" }] }),
          read: async () => ({ base64: base64("x") }),
        },
        caches: fakeCaches(),
        base: BASE,
      }),
    ).rejects.toThrow(/no entry file/);
  });

  it("refuses when the host cannot serve the page at all", async () => {
    await expect(
      loadPluginPageBundle({
        pluginId: "p",
        source: { manifest: async () => null, read: async () => null },
        caches: fakeCaches(),
        base: BASE,
      }),
    ).rejects.toThrow(/can’t serve/);
  });
});
