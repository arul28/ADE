/**
 * A plugin's built page, from the connected host's disk into this browser.
 *
 * The hosted web client has no `ade-plugin://` protocol and no install
 * directory: the bytes of a `webview` surface live on the machine ADE is
 * running on, and the only pipe to them is the sync socket. So the flow is the
 * one the phone uses — a manifest of `{path, bytes, sha256}`, then the files
 * this client is missing — and the result is parked in Cache Storage under a
 * name that carries the plugin's version AND revision.
 *
 * Why Cache Storage rather than a module-level `Map`:
 *
 * - It survives a reload, and a plugin page is several hundred kilobytes of
 *   JavaScript that would otherwise be re-fetched over a relay socket every
 *   time the reader opens the tab.
 * - Each entry is a real `Response`, so the `Content-Type` this module decided
 *   is stored WITH the bytes. The service worker that serves the guest frame is
 *   then a pass-through and cannot disagree with this file about what a `.js`
 *   is — there is only one MIME table in the client, and it is here.
 *
 * Nothing in this module trusts the host's answer. A path that escapes the
 * page root, a file over the per-file ceiling, a tree over the total ceiling,
 * or an extension outside the closed map is dropped, and the page loads without
 * it or does not load at all. The bytes are plugin-authored and the host is a
 * machine the reader paired with, which is exactly the pairing where "it came
 * from our own host" is not a reason to skip the check.
 */

import type {
  WebPluginPageManifest,
  WebPluginPageManifestEntry,
} from "../adapter/plugins";

/**
 * The extension → media type map, closed.
 *
 * Closed rather than derived, and the reason is `X-Content-Type-Options:
 * nosniff` sitting beside it: with sniffing off, the type this table names is
 * the only thing the browser will treat the bytes as. An unknown extension is
 * therefore dropped from the page rather than served as
 * `application/octet-stream` — a plugin shipping a file type ADE has not
 * thought about should see it missing while it is being added, not have it
 * silently become a download.
 *
 * `text/javascript` for both `.js` and `.mjs` because a module script refused
 * for its MIME type is the single most confusing way for a page to fail: the
 * frame is blank and the reason is one line in a console the reader cannot see.
 */
export const PLUGIN_PAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

/** Ceilings, matching the install-time caps in the page tier spec. */
export const PLUGIN_PAGE_MAX_FILES = 5_000;
export const PLUGIN_PAGE_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const PLUGIN_PAGE_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** The Cache Storage name prefix every plugin page cache starts with. */
export const PLUGIN_PAGE_CACHE_PREFIX = "ade-plugin-pages";

/** The header each cached file carries its content hash in. */
const SHA_HEADER = "x-ade-sha256";

export type PluginPageVersionKey = string;

/** `<version>-<revision>` — the half of the cache name that changes on a rebuild. */
export function pluginPageVersionKey(manifest: { version: string; revision: number }): PluginPageVersionKey {
  return `${manifest.version}-${manifest.revision}`;
}

/**
 * `ade-plugin-pages/<pluginId>/<version>-<revision>`.
 *
 * The revision is in the NAME rather than in a stored field because that is
 * what makes a rebuild a different cache instead of a cache to invalidate: the
 * new one fills while the old one still answers, and the old one is deleted
 * only once the new page is assembled. A dev loop that rebuilds mid-render
 * therefore never serves half of two builds.
 */
export function pluginPageCacheName(pluginId: string, versionKey: PluginPageVersionKey): string {
  return `${PLUGIN_PAGE_CACHE_PREFIX}/${pluginId}/${versionKey}`;
}

/** True for a cache this module owns for `pluginId`. */
export function isPluginPageCacheName(name: string, pluginId: string): boolean {
  return name.startsWith(`${PLUGIN_PAGE_CACHE_PREFIX}/${pluginId}/`);
}

/**
 * A page-relative path, or null when it escapes the page root.
 *
 * The host resolves its own containment against the install directory, and this
 * is the client's independent one: the path also becomes a URL under the guest
 * base and a key in the file map the guest resolves imports against, so a `..`
 * that survived here would let one plugin's page name another's file.
 */
export function normalizePluginPagePath(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.includes("\0") || raw.includes("\\")) return null;
  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return null;
    segments.push(segment);
  }
  if (segments.length === 0) return null;
  return segments.join("/");
}

/** The media type for a path, or null when the extension is outside the map. */
export function pluginPageMimeType(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return PLUGIN_PAGE_MIME_TYPES[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** One file of an assembled page, ready to hand to the guest. */
export type PluginPageFile = { path: string; mime: string; bytes: Uint8Array };

/** Everything the guest needs to draw one page. */
export type PluginPageBundle = {
  pluginId: string;
  version: string;
  revision: number;
  versionKey: PluginPageVersionKey;
  /** The manifest-relative entry html, normalized. */
  entry: string;
  files: PluginPageFile[];
};

/** What a sync attempt did, for the caller's diagnostics and the tests. */
export type PluginPageSyncStats = {
  /** Files already in the cache at the right hash. */
  reused: number;
  /** Files fetched from the host this time. */
  fetched: number;
  /** Files the manifest named that this client refused. See the caps above. */
  skipped: number;
};

export type PluginPageAssetSource = {
  manifest: (input: { pluginId: string }) => Promise<WebPluginPageManifest | null>;
  read: (input: { pluginId: string; path: string }) => Promise<{ base64: string } | null>;
};

/**
 * Decode base64 without `Buffer`. `atob` is the browser's, and the bytes are
 * copied out one char code at a time because `atob` answers a binary string.
 */
export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * The files this client must fetch, given a manifest and what the cache holds.
 *
 * Split out from the fetching so the diff itself is a pure function: "the
 * cache already has this exact sha256" is the whole reason a second open of a
 * plugin tab costs one round trip instead of two hundred, and it is worth being
 * able to test without a Cache Storage.
 */
export function planPluginPageFetch(
  manifest: WebPluginPageManifest,
  cached: ReadonlyMap<string, string>,
): { fetch: WebPluginPageManifestEntry[]; reuse: WebPluginPageManifestEntry[]; skipped: WebPluginPageManifestEntry[] } {
  const fetchList: WebPluginPageManifestEntry[] = [];
  const reuse: WebPluginPageManifestEntry[] = [];
  const skipped: WebPluginPageManifestEntry[] = [];
  let total = 0;
  for (const entry of manifest.files) {
    const path = normalizePluginPagePath(entry.path);
    const overFile = entry.bytes > PLUGIN_PAGE_MAX_FILE_BYTES;
    const unknownType = path ? pluginPageMimeType(path) === null : true;
    const overCount = fetchList.length + reuse.length >= PLUGIN_PAGE_MAX_FILES;
    const overTotal = total + entry.bytes > PLUGIN_PAGE_MAX_TOTAL_BYTES;
    if (!path || overFile || unknownType || overCount || overTotal) {
      skipped.push(entry);
      continue;
    }
    total += entry.bytes;
    const normalized: WebPluginPageManifestEntry = { ...entry, path };
    if (cached.get(path) === entry.sha256) reuse.push(normalized);
    else fetchList.push(normalized);
  }
  return { fetch: fetchList, reuse, skipped };
}

/**
 * The entry html a page is drawn from.
 *
 * `index.html` at the root by convention, and the FIRST html file otherwise, so
 * a plugin whose Vite build emits `page.html` still opens. A tree with no html
 * at all has no page and is refused by the caller.
 */
export function resolvePluginPageEntry(paths: readonly string[], preferred?: string | null): string | null {
  const normalizedPreferred = preferred ? normalizePluginPagePath(preferred) : null;
  if (normalizedPreferred && paths.includes(normalizedPreferred)) return normalizedPreferred;
  if (paths.includes("index.html")) return "index.html";
  return paths.find((path) => path.endsWith(".html")) ?? null;
}

/**
 * Fill the cache for one plugin page and answer the assembled bundle.
 *
 * Old caches for the same plugin are deleted only AFTER the new one is
 * complete: the delete is the last thing that happens, so a fetch that fails
 * halfway leaves the reader with the build they already had rather than with
 * nothing.
 */
export async function loadPluginPageBundle(input: {
  pluginId: string;
  entryHtml?: string | null;
  source: PluginPageAssetSource;
  caches: CacheStorage;
  /** The guest URL space, from {@link pluginPageBaseUrl}. */
  base: string;
}): Promise<{ bundle: PluginPageBundle; stats: PluginPageSyncStats }> {
  const { pluginId, source, caches: cacheStorage, base } = input;
  const manifest = await source.manifest({ pluginId });
  if (!manifest) throw new Error("This computer can’t serve that plugin’s page.");
  const versionKey = pluginPageVersionKey(manifest);
  const cacheName = pluginPageCacheName(pluginId, versionKey);
  const cache = await cacheStorage.open(cacheName);

  const cachedHashes = new Map<string, string>();
  for (const request of await cache.keys()) {
    const response = await cache.match(request);
    const sha = response?.headers.get(SHA_HEADER);
    const path = pathFromGuestUrl(base, request.url);
    if (sha && path) cachedHashes.set(path, sha);
  }

  const plan = planPluginPageFetch(manifest, cachedHashes);
  for (const entry of plan.fetch) {
    const file = await source.read({ pluginId, path: entry.path });
    if (!file) throw new Error("This computer couldn’t read that plugin’s page.");
    const bytes = decodeBase64(file.base64);
    // The host said how big the file is and then sent it. A disagreement is not
    // something to paper over with the larger of the two numbers: it means the
    // manifest this client planned against is not the tree it received.
    if (bytes.byteLength > PLUGIN_PAGE_MAX_FILE_BYTES) {
      throw new Error("That plugin’s page is too large to open here.");
    }
    const mime = pluginPageMimeType(entry.path);
    if (!mime) continue;
    await cache.put(
      guestFileUrl(base, pluginId, versionKey, entry.path),
      new Response(bytes as BlobPart, {
        headers: {
          "content-type": mime,
          "x-content-type-options": "nosniff",
          [SHA_HEADER]: entry.sha256,
          "cache-control": "no-store",
        },
      }),
    );
  }

  const files: PluginPageFile[] = [];
  for (const entry of [...plan.reuse, ...plan.fetch]) {
    const response = await cache.match(guestFileUrl(base, pluginId, versionKey, entry.path));
    if (!response) continue;
    const mime = pluginPageMimeType(entry.path);
    if (!mime) continue;
    files.push({ path: entry.path, mime, bytes: new Uint8Array(await response.arrayBuffer()) });
  }

  const entry = resolvePluginPageEntry(files.map((file) => file.path), input.entryHtml ?? null);
  if (!entry) throw new Error("That plugin’s page has no entry file.");

  // Last, and only now. See the doc comment.
  for (const name of await cacheStorage.keys()) {
    if (isPluginPageCacheName(name, pluginId) && name !== cacheName) await cacheStorage.delete(name);
  }

  return {
    bundle: {
      pluginId,
      version: manifest.version,
      revision: manifest.revision,
      versionKey,
      entry,
      files,
    },
    stats: { reused: plan.reuse.length, fetched: plan.fetch.length, skipped: plan.skipped.length },
  };
}

// ---------------------------------------------------------------------------
// The guest's URL space
// ---------------------------------------------------------------------------

/**
 * The base every guest URL hangs off, derived from the service worker's own
 * script URL rather than written as a literal.
 *
 * A service worker may only control paths at or below the directory it was
 * served from, unless the response carries `Service-Worker-Allowed`. Deriving
 * the base from the script URL means the guest space is inside the default
 * scope on every deployment the client has — the hashed `/assets/` path a
 * production build emits, and the source path the dev server serves — with no
 * header to keep in step and nothing to configure.
 */
export function pluginPageBaseUrl(serviceWorkerUrl: string): string {
  return new URL("./plugin-pages/", serviceWorkerUrl).toString();
}

/** `<base><pluginId>/<versionKey>/<path>` — one absolute URL per page file. */
export function guestFileUrl(
  base: string,
  pluginId: string,
  versionKey: PluginPageVersionKey,
  path: string,
): string {
  return new URL(`${encodeURIComponent(pluginId)}/${encodeURIComponent(versionKey)}/${path}`, base).toString();
}

/** The page-relative path a guest URL names, or null when it is not one. */
export function pathFromGuestUrl(base: string, url: string): string | null {
  if (!url.startsWith(base)) return null;
  const rest = url.slice(base.length).split("?")[0] ?? "";
  const segments = rest.split("/");
  // <pluginId>/<versionKey>/<path…>
  if (segments.length < 3) return null;
  return normalizePluginPagePath(segments.slice(2).join("/"));
}
