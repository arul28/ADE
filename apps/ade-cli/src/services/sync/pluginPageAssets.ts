/**
 * The plugin page bytes, over the sync file channel.
 *
 * A plugin page is HTML the plugin ships. The desktop serves it from the
 * install directory over `ade-plugin://<pluginId>/…`; a phone has no install
 * directory, so it fetches the same tree over sync and serves it from a local
 * cache under the same origin. This module is the host half of that fetch.
 *
 * Two actions, deliberately split:
 *
 * 1. `plugin.pageAssets.manifest` lists every file with its size and SHA-256.
 *    The phone diffs that list against what it already holds and asks for
 *    nothing it has. A page that did not change costs one round trip.
 * 2. `plugin.pageAssets.read` returns ONE file, and the caller must name the
 *    hash it expects. A mismatch is a refusal, not a body: the phone caches by
 *    hash, so a file that changed between the manifest and the read would be
 *    stored under the wrong key and served forever.
 *
 * The containment rule is the one the desktop protocol handler already
 * enforces, restated here because this reaches a different process: every path
 * resolves inside the plugin's own asset directory with symlinks followed, an
 * escape is refused, and a plugin that is not installed and enabled has no
 * assets at all. `resolvePathWithinRoot` is the same guard `readArtifact` uses.
 *
 * Deliberately free of the sync host: everything here is a pure function of a
 * plugins root and a plugin id, so it is tested without a socket.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isValidPluginId, parsePluginManifest } from "../../../../desktop/src/shared/plugins/manifest";
import { readPluginInstallRecords, resolvePluginsRoot } from "../../../../desktop/src/main/services/plugins/pluginRegistryFile";
import { resolvePathWithinRoot } from "../../../../desktop/src/main/services/shared/utils";

/**
 * Largest single page asset this channel serves.
 *
 * The same ceiling `readArtifact` applies, and for the same reason: one sync
 * frame carries the whole file base64-encoded, so a file above this would
 * exceed the frame budget rather than arrive slowly.
 */
export const PLUGIN_PAGE_ASSET_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Largest manifest this channel builds.
 *
 * The install cap already bounds a plugin's tree at 5,000 files, so this is
 * only the walk's own guard: a directory that somehow grew past it stops the
 * walk with an error instead of building a list nothing can send.
 */
export const PLUGIN_PAGE_ASSET_MAX_FILES = 5_000;

/** The directory served when a plugin declares no `webview` surface. */
export const PLUGIN_PAGE_ASSET_DEFAULT_DIR = "dist";

/** The manifest file at the root of every plugin install. */
const PLUGIN_MANIFEST_FILE = "plugin.json";

export type PluginPageAssetEntry = {
  /** Forward-slashed, relative to the asset root. Never absolute. */
  path: string;
  bytes: number;
  sha256: string;
};

export type PluginPageAssetsManifest = {
  pluginId: string;
  version: string;
  /**
   * Changes whenever the install changed without the version changing.
   *
   * Derived from the registry's `updatedAt`, so it is the same number for every
   * reader and survives a host restart — a counter held in memory would reset
   * and let a phone keep a stale cache entry that looks current.
   */
  revision: number;
  /**
   * The HTML the phone loads, relative to the asset root.
   *
   * Carried here because the phone has no other copy of the manifest's
   * `entryHtml`: the install list it already receives does not include it, and
   * guessing `index.html` would be wrong for any plugin that ships more than
   * one page.
   */
  entry: string;
  files: PluginPageAssetEntry[];
};

export type PluginPageAssetBlob = {
  path: string;
  bytes: number;
  sha256: string;
  /** Base64, always. A page asset is as often a font as it is a script. */
  contentBase64: string;
};

export type PluginPageAssetsDeps = {
  /** `<machine adeDir>/plugins`. Injected so a test needs no machine layout. */
  pluginsRoot?: string;
  env?: NodeJS.ProcessEnv;
};

function pluginsRootFor(deps: PluginPageAssetsDeps): string {
  // Resolved per call, never captured: the channel defaults that decide whether
  // this machine's ADE directory is `.ade`, `.ade-beta` or `.ade-alpha` are
  // applied during launch, and a root read at module load would be the Stable
  // one on every channel.
  return deps.pluginsRoot?.trim() || resolvePluginsRoot(deps.env ?? process.env);
}

/**
 * Where a plugin's page assets live, plus the two numbers that key a cache.
 *
 * Throws rather than returning null: every caller is answering a peer request,
 * and the peer needs the reason. "Not installed" and "disabled" deliberately
 * read the same, the way the desktop protocol's 404 does — which one it is, is
 * not something a remote client should be able to probe.
 */
export function resolvePluginPageAssetRoot(
  pluginId: string,
  deps: PluginPageAssetsDeps = {},
): { root: string; version: string; revision: number; entry: string } {
  if (!isValidPluginId(pluginId)) {
    throw new Error("Plugin page assets require a valid plugin id.");
  }
  const pluginsRoot = pluginsRootFor(deps);
  const record = readPluginInstallRecords(pluginsRoot).get(pluginId);
  if (!record || !record.enabled) {
    throw new Error(`Plugin "${pluginId}" has no page assets on this machine.`);
  }

  const installDir = path.join(pluginsRoot, pluginId);
  let installReal: string;
  try {
    installReal = fs.realpathSync(installDir);
  } catch {
    throw new Error(`Plugin "${pluginId}" has no page assets on this machine.`);
  }

  const entryHtml = readWebviewEntryHtml(installReal);
  // `dist/` is the fallback rather than the install root: a plugin with no
  // declared page still has a conventional build output, and serving the whole
  // install directory instead would publish its source and its node_modules.
  const relativeRoot = entryHtml ? posixDirname(entryHtml) : PLUGIN_PAGE_ASSET_DEFAULT_DIR;
  const entry = entryHtml ? posixBasename(entryHtml) : "index.html";
  // The one place this channel is deliberately narrower than the desktop
  // protocol, which serves the whole install directory. A phone DOWNLOADS what
  // it is offered, so an entry at the plugin root would put the plugin's source
  // and its `node_modules` on the wire — thousands of files nobody asked for,
  // over a mobile connection. Refused with the fix in the sentence rather than
  // silently served.
  if (!relativeRoot) {
    throw new Error(
      `Plugin "${pluginId}" serves its page from the plugin root. Move the built page into a subdirectory (for example "dist/") so the phone downloads only the page.`,
    );
  }

  let root: string;
  try {
    root = resolvePathWithinRoot(installReal, path.resolve(installReal, relativeRoot));
  } catch {
    throw new Error(`Plugin "${pluginId}" page assets resolve outside the plugin.`);
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(root);
  } catch {
    throw new Error(`Plugin "${pluginId}" has no page assets on this machine.`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Plugin "${pluginId}" has no page assets on this machine.`);
  }

  return { root, version: record.version, revision: revisionFor(record.updatedAt), entry };
}

/**
 * The registry timestamp as a cache-busting integer.
 *
 * Zero when the timestamp is unreadable, which is the safe direction: a phone
 * that sees revision 0 twice still compares the per-file hashes and re-downloads
 * anything that moved.
 */
function revisionFor(updatedAt: string): number {
  const parsed = Date.parse(updatedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function posixDirname(relative: string): string {
  const normalized = relative.replace(/\\/g, "/").replace(/^\/+/, "");
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? "" : normalized.slice(0, slash);
}

function posixBasename(relative: string): string {
  const normalized = relative.replace(/\\/g, "/").replace(/^\/+/, "");
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

/**
 * The first `webview` surface's `entryHtml`, or null.
 *
 * Parsed through the real manifest parser rather than read off the raw JSON, so
 * an `entryHtml` the parser refuses — absolute, escaping, not an `.html` file —
 * is refused here too. A manifest this build cannot read yields null and the
 * caller falls back to `dist/`.
 */
function readWebviewEntryHtml(installReal: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(installReal, PLUGIN_MANIFEST_FILE), "utf8");
  } catch {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = parsePluginManifest(decoded);
  if (!parsed.manifest) return null;
  const surface = parsed.manifest.surfaces.find(
    (candidate) => candidate.kind === "webview" && typeof candidate.entryHtml === "string" && candidate.entryHtml.length > 0,
  );
  return surface?.entryHtml ?? null;
}

/**
 * Every file under the asset root, hashed.
 *
 * Symlinks are skipped rather than followed. Following one would either leave
 * the root — which the per-file guard would refuse at read time, producing a
 * manifest entry the phone can never fetch — or duplicate a file already in the
 * list under a second name.
 */
export function buildPluginPageAssetsManifest(
  pluginId: string,
  deps: PluginPageAssetsDeps = {},
): PluginPageAssetsManifest {
  const { root, version, revision, entry } = resolvePluginPageAssetRoot(pluginId, deps);
  const files: PluginPageAssetEntry[] = [];
  walk(root, root, files);
  // Sorted so two hosts serving the same tree produce byte-identical manifests,
  // which is what lets the phone compare cheaply.
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { pluginId, version, revision, entry, files };
}

function walk(root: string, dir: string, out: PluginPageAssetEntry[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dirent of entries) {
    if (out.length >= PLUGIN_PAGE_ASSET_MAX_FILES) {
      throw new Error(`Plugin page assets exceed ${PLUGIN_PAGE_ASSET_MAX_FILES} files.`);
    }
    const absolute = path.join(dir, dirent.name);
    if (dirent.isSymbolicLink()) continue;
    if (dirent.isDirectory()) {
      walk(root, absolute, out);
      continue;
    }
    if (!dirent.isFile()) continue;
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(absolute);
    } catch {
      continue;
    }
    if (buffer.byteLength > PLUGIN_PAGE_ASSET_MAX_BYTES) continue;
    out.push({
      path: path.relative(root, absolute).split(path.sep).join("/"),
      bytes: buffer.byteLength,
      sha256: sha256Of(buffer),
    });
  }
}

function sha256Of(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * One page asset, refused unless it is still the file the caller asked for.
 *
 * The `sha256` argument is REQUIRED, and that is the point of the whole action:
 * the phone stores what comes back under that hash, so a host that answered
 * with different bytes would poison the cache in a way no later fetch repairs.
 */
export function readPluginPageAsset(
  request: { pluginId: string; path: string; sha256: string },
  deps: PluginPageAssetsDeps = {},
): PluginPageAssetBlob {
  const expected = typeof request.sha256 === "string" ? request.sha256.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error("Plugin page asset request requires a sha256 hash.");
  }
  const relative = typeof request.path === "string" ? request.path.trim() : "";
  if (!relative) {
    throw new Error("Plugin page asset request requires a path.");
  }
  // Written as the ESCAPE, never as a literal NUL byte: a source file holding
  // one is binary to git, which stops diffing it and hides every later change.
  if (relative.includes(" ")) {
    throw new Error("Plugin page asset path is invalid.");
  }
  if (path.isAbsolute(relative) || relative.startsWith("/") || relative.startsWith("\\") || /^[A-Za-z]:/.test(relative)) {
    throw new Error("Plugin page asset path must be relative to the plugin.");
  }

  const { root } = resolvePluginPageAssetRoot(request.pluginId, deps);
  let resolved: string;
  try {
    resolved = resolvePathWithinRoot(root, path.resolve(root, relative));
  } catch {
    throw new Error("Plugin page asset path escapes the plugin.");
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    throw new Error("Plugin page asset does not exist.");
  }
  if (!stats.isFile()) {
    throw new Error("Plugin page asset does not exist.");
  }
  if (stats.size > PLUGIN_PAGE_ASSET_MAX_BYTES) {
    throw new Error(
      `Plugin page asset is too large to sync (${stats.size} bytes; max ${PLUGIN_PAGE_ASSET_MAX_BYTES} bytes).`,
    );
  }

  const buffer = fs.readFileSync(resolved);
  const actual = sha256Of(buffer);
  if (actual !== expected) {
    throw new Error("Plugin page asset changed since the manifest was read.");
  }

  return {
    path: relative.replace(/\\/g, "/"),
    bytes: buffer.byteLength,
    sha256: actual,
    contentBase64: buffer.toString("base64"),
  };
}
