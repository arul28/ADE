#!/usr/bin/env node
/**
 * Copy every official plugin's built page into the iOS app bundle.
 *
 * A plugin page normally reaches a phone over the sync file channel: the phone
 * asks for a manifest, downloads the hashes it lacks, and caches the result. A
 * bundled page is that same cache entry, shipped inside the app — which is what
 * makes a fresh install draw a real page before it has ever reached a machine.
 *
 * The output is deliberately the SAME shape `PluginPageAssetStore` reads for a
 * downloaded entry, with one difference: a downloaded entry stores files under
 * their SHA-256 in `blobs/`, and a bundled one stores them under their own
 * relative paths, because a build phase copies files and not blobs. The store
 * knows which is which from the entry's `source`.
 *
 * ## Why the revision is zero
 *
 * A downloaded entry's revision is the machine registry's `updatedAt` in
 * milliseconds — a large, growing number. The phone breaks a version tie on
 * that revision, so a bundled entry must never carry a number that could win
 * against a genuinely newer download of the same version. A content hash would:
 * it is unordered, and roughly half of them would sort above any real
 * timestamp. Zero is the only value that is always the LOWEST, so at equal
 * versions the machine's own copy wins, and the bundled copy is used exactly
 * when it should be — when nothing has been downloaded yet, or when the bundle
 * ships a newer version than the machine holds.
 *
 * Determinism comes from the file list instead, which is fully content-derived:
 * same dist in, byte-identical `manifest.json` out.
 *
 * Idempotent: a second run with an unchanged dist writes nothing. Files the
 * plugin no longer ships are deleted, and so is the whole directory of a plugin
 * that no longer has a page.
 *
 * Run it with `npm run sync:plugin-pages`, and BEFORE any iOS archive — the
 * bundle is an iOS app resource, so a stale copy ships silently.
 *
 * `--strict` turns every warning into a failure. Each warning this script emits
 * is about a plugin that DECLARES a `webview` surface and whose page could not
 * be bundled — unbuilt, served from the plugin root, or missing its own entry
 * file — so on a release runner they are all the same fact: the archive would
 * ship without a page the plugin says it has, and the phone would silently fall
 * back to the vocabulary panel with nothing anywhere saying why.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDir, "..");

/** The manifest inside a bundled entry. Written last, as the store expects. */
export const BUNDLED_MANIFEST_FILE = "manifest.json";

/**
 * The revision every bundled entry carries. See the module header — this is a
 * correctness constant, not a placeholder.
 */
export const BUNDLED_REVISION = 0;

/**
 * Files kept in the bundle root that are not a plugin's page.
 *
 * The README explains the directory to whoever opens it next, and a stale-file
 * sweep that did not know about it would delete it on the first run.
 */
const BUNDLE_ROOT_KEEP = new Set(["README.md", ".gitkeep"]);

/** Never copied into an app bundle, whatever a plugin's dist happens to hold. */
const IGNORED_NAMES = new Set([".DS_Store", ".git", "node_modules"]);

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * The first `webview` surface's `entryHtml`, or null.
 *
 * Read off the raw manifest rather than through the desktop parser, because
 * this script is plain Node with no TypeScript build step. The values it cares
 * about are re-validated below, so a manifest the parser would have refused
 * still cannot produce an escape here.
 */
function webviewEntryHtml(manifest) {
  const surfaces = Array.isArray(manifest?.surfaces) ? manifest.surfaces : [];
  for (const surface of surfaces) {
    if (surface?.kind !== "webview") continue;
    const entry = typeof surface.entryHtml === "string" ? surface.entryHtml.trim() : "";
    if (entry) return entry;
  }
  return null;
}

/** Every file under `dir`, as paths relative to it, forward-slashed and sorted. */
function listFiles(dir, prefix = "") {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (IGNORED_NAMES.has(entry.name)) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    // Symlinks are skipped rather than followed: following one would either
    // leave the dist — copying whatever it points at into a signed app bundle —
    // or duplicate a file already in the list under a second name.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      found.push(...listFiles(path.join(dir, entry.name), relative));
      continue;
    }
    if (entry.isFile()) found.push(relative);
  }
  return found.sort();
}

/**
 * Which plugins ship a page, and where its assets live.
 *
 * A plugin whose `entryHtml` sits at its own root is SKIPPED with a warning,
 * matching what the sync channel refuses (`pluginPageAssets.ts`): the asset root
 * would be the whole install directory, and bundling that would put the
 * plugin's source into the app.
 */
export function discoverPluginPages(repoRoot, warn = () => {}) {
  const pluginsRoot = path.join(repoRoot, "plugins");
  let names;
  try {
    names = fs.readdirSync(pluginsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }

  const found = [];
  for (const name of names) {
    const manifestPath = path.join(pluginsRoot, name, "plugin.json");
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }
    const entryHtml = webviewEntryHtml(manifest);
    if (!entryHtml) continue;

    const pluginId = typeof manifest.name === "string" ? manifest.name : name;
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(pluginId)) {
      warn(`skipping ${name}: "${pluginId}" is not a valid plugin id`);
      continue;
    }
    const version = typeof manifest.version === "string" ? manifest.version : "";
    if (!version) {
      warn(`skipping ${pluginId}: plugin.json has no version`);
      continue;
    }

    const normalized = entryHtml.replace(/\\/g, "/").replace(/^\/+/, "");
    if (normalized.split("/").includes("..")) {
      warn(`skipping ${pluginId}: entryHtml "${entryHtml}" escapes the plugin`);
      continue;
    }
    const slash = normalized.lastIndexOf("/");
    if (slash === -1) {
      warn(
        `skipping ${pluginId}: entryHtml "${entryHtml}" sits at the plugin root. `
          + "Move the built page into a subdirectory (for example \"dist/\").",
      );
      continue;
    }

    const assetRoot = path.join(pluginsRoot, name, normalized.slice(0, slash));
    if (!fs.existsSync(assetRoot) || !fs.statSync(assetRoot).isDirectory()) {
      warn(`skipping ${pluginId}: ${path.relative(repoRoot, assetRoot)} does not exist — build the page first`);
      continue;
    }

    found.push({ pluginId, version, assetRoot, entry: normalized.slice(slash + 1) });
  }
  return found;
}

/**
 * Write one plugin's bundled entry, and report what changed.
 *
 * Files are compared by content before being written, so an unchanged dist
 * leaves every mtime alone — which is what stops a no-op sync from invalidating
 * an incremental Xcode build.
 */
function syncOnePlugin(page, bundleRoot) {
  const target = path.join(bundleRoot, page.pluginId);
  fs.mkdirSync(target, { recursive: true });

  const relativePaths = listFiles(page.assetRoot);
  const files = [];
  let written = 0;

  for (const relative of relativePaths) {
    const source = path.join(page.assetRoot, ...relative.split("/"));
    const buffer = fs.readFileSync(source);
    files.push({ path: relative, bytes: buffer.byteLength, sha256: sha256(buffer) });

    const destination = path.join(target, ...relative.split("/"));
    let existing = null;
    try {
      existing = fs.readFileSync(destination);
    } catch {
      existing = null;
    }
    if (existing && existing.equals(buffer)) continue;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, buffer);
    written += 1;
  }

  const manifest = {
    pluginId: page.pluginId,
    version: page.version,
    revision: BUNDLED_REVISION,
    entry: page.entry,
    files,
  };
  // Stale sweep BEFORE the manifest is written, so an interrupted run leaves an
  // entry whose manifest still describes files that are all present.
  const removed = removeStale(target, new Set([...relativePaths, BUNDLED_MANIFEST_FILE]));

  const encoded = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestPath = path.join(target, BUNDLED_MANIFEST_FILE);
  let manifestChanged = true;
  try {
    manifestChanged = fs.readFileSync(manifestPath, "utf8") !== encoded;
  } catch {
    manifestChanged = true;
  }
  if (manifestChanged) fs.writeFileSync(manifestPath, encoded);

  const missingEntry = !files.some((file) => file.path === page.entry);
  return { pluginId: page.pluginId, files: files.length, written, removed, manifestChanged, missingEntry };
}

/** Delete anything under `dir` the new file list does not name. Returns the count. */
function removeStale(dir, keep, prefix = "") {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removed += removeStale(absolute, keep, relative);
      // An emptied directory goes too: an empty folder in an app bundle is a
      // resource nothing reads and a diff nobody can explain.
      if (fs.readdirSync(absolute).length === 0) fs.rmSync(absolute, { recursive: true });
      continue;
    }
    if (keep.has(relative)) continue;
    fs.rmSync(absolute, { force: true });
    removed += 1;
  }
  return removed;
}

/**
 * Sync every plugin page into the iOS bundle directory.
 *
 * Pure of `process`: the roots are arguments so the test drives a throwaway
 * tree, and the caller decides what to do with the report.
 */
export function syncBundledPluginPages(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const bundleRoot = options.bundleRoot
    ?? path.join(repoRoot, "apps", "ios", "ADE", "Resources", "BundledPluginPages");
  const warn = options.warn ?? (() => {});

  fs.mkdirSync(bundleRoot, { recursive: true });
  const pages = discoverPluginPages(repoRoot, warn);
  const results = pages.map((page) => syncOnePlugin(page, bundleRoot));

  // A plugin that no longer ships a page loses its whole directory, so an
  // uninstalled or un-pathed plugin cannot keep serving a page from the bundle.
  const expected = new Set(pages.map((page) => page.pluginId));
  let removedPlugins = 0;
  for (const entry of fs.readdirSync(bundleRoot, { withFileTypes: true })) {
    if (BUNDLE_ROOT_KEEP.has(entry.name)) continue;
    if (entry.isDirectory() && expected.has(entry.name)) continue;
    fs.rmSync(path.join(bundleRoot, entry.name), { recursive: true, force: true });
    removedPlugins += 1;
  }

  for (const result of results) {
    if (result.missingEntry) {
      warn(`${result.pluginId}: the manifest's entry file is not in the dist — the phone will fall back to the panel`);
    }
  }

  return { bundleRoot, plugins: results, removedPlugins };
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const strict = process.argv.slice(2).includes("--strict");
  const warnings = [];
  const report = syncBundledPluginPages({
    warn: (message) => {
      warnings.push(message);
      console.warn(`sync-bundled-plugin-pages: ${message}`);
    },
  });
  if (report.plugins.length === 0) {
    console.log("sync-bundled-plugin-pages: no plugin ships a built page yet.");
  }
  for (const plugin of report.plugins) {
    const bytes = plugin.written === 0 && !plugin.manifestChanged ? "unchanged" : `${plugin.written} written`;
    console.log(
      `sync-bundled-plugin-pages: ${plugin.pluginId} — ${plugin.files} files, ${bytes}, ${plugin.removed} stale removed`,
    );
  }
  if (report.removedPlugins > 0) {
    console.log(`sync-bundled-plugin-pages: removed ${report.removedPlugins} stale plugin directories`);
  }
  if (strict && warnings.length > 0) {
    console.error(
      `sync-bundled-plugin-pages: --strict — ${warnings.length} plugin page(s) could not be bundled. `
        + "Build the pages before archiving.",
    );
    process.exit(1);
  }
}
