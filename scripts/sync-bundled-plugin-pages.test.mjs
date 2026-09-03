import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BUNDLED_MANIFEST_FILE,
  BUNDLED_REVISION,
  discoverPluginPages,
  syncBundledPluginPages,
} from "./sync-bundled-plugin-pages.mjs";

/**
 * Every test builds a throwaway repo on disk, because the whole contract is the
 * filesystem: what the bundle looks like after a run, after a second run with
 * nothing changed, and after a file disappears from a plugin's dist.
 */
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-pages-"));
  return {
    root,
    bundleRoot: path.join(root, "apps", "ios", "ADE", "Resources", "BundledPluginPages"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function writePlugin(root, pluginId, options) {
  const dir = path.join(root, "plugins", pluginId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "plugin.json"),
    JSON.stringify({
      name: pluginId,
      version: options.version ?? "1.0.0",
      displayName: pluginId,
      description: "test",
      vocabVersion: 1,
      surfaces: options.entryHtml
        ? [{ kind: "webview", id: "page", title: "Page", panelId: "main", entryHtml: options.entryHtml }]
        : [{ kind: "tab", id: "t", title: "T", panelId: "main" }],
      panels: [{ id: "main", title: "Main" }],
    }),
  );
  for (const [relative, body] of Object.entries(options.files ?? {})) {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
}

function readManifest(bundleRoot, pluginId) {
  return JSON.parse(fs.readFileSync(path.join(bundleRoot, pluginId, BUNDLED_MANIFEST_FILE), "utf8"));
}

function sha256(text) {
  return crypto.createHash("sha256").update(Buffer.from(text)).digest("hex");
}

test("writes a manifest in the shape PluginPageAssetStore reads", (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  writePlugin(repo.root, "ade-linear", {
    version: "2.0.0",
    entryHtml: "dist/index.html",
    files: {
      "dist/index.html": "<html>page</html>",
      "dist/assets/app.js": "console.log(1)",
      "dist/fonts/Geist.woff2": "FONT",
    },
  });

  const report = syncBundledPluginPages({ repoRoot: repo.root, bundleRoot: repo.bundleRoot });
  const manifest = readManifest(repo.bundleRoot, "ade-linear");

  assert.equal(report.plugins.length, 1);
  assert.equal(manifest.pluginId, "ade-linear");
  assert.equal(manifest.version, "2.0.0");
  assert.equal(manifest.revision, BUNDLED_REVISION);
  assert.equal(manifest.entry, "index.html");
  assert.deepEqual(manifest.files.map((file) => file.path), [
    "assets/app.js",
    "fonts/Geist.woff2",
    "index.html",
  ]);
  const html = manifest.files.find((file) => file.path === "index.html");
  assert.equal(html.bytes, Buffer.byteLength("<html>page</html>"));
  assert.equal(html.sha256, sha256("<html>page</html>"));
});

test("lays the files out by path, not by hash", (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  writePlugin(repo.root, "ade-linear", {
    entryHtml: "dist/index.html",
    files: { "dist/index.html": "<html></html>", "dist/assets/app.css": "body{}" },
  });

  syncBundledPluginPages({ repoRoot: repo.root, bundleRoot: repo.bundleRoot });

  const entry = path.join(repo.bundleRoot, "ade-linear");
  assert.equal(fs.readFileSync(path.join(entry, "index.html"), "utf8"), "<html></html>");
  assert.equal(fs.readFileSync(path.join(entry, "assets", "app.css"), "utf8"), "body{}");
  assert.ok(!fs.existsSync(path.join(entry, "blobs")), "a bundled entry has no blobs directory");
});

/// A second run with an unchanged dist must not touch a byte: a rewritten file
/// moves its mtime and invalidates an incremental Xcode build for nothing.
test("a second run with an unchanged dist writes nothing", (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  writePlugin(repo.root, "ade-linear", {
    entryHtml: "dist/index.html",
    files: { "dist/index.html": "<html></html>" },
  });

  syncBundledPluginPages({ repoRoot: repo.root, bundleRoot: repo.bundleRoot });
  const before = fs.statSync(path.join(repo.bundleRoot, "ade-linear", "index.html")).mtimeMs;
  const second = syncBundledPluginPages({ repoRoot: repo.root, bundleRoot: repo.bundleRoot });
  const after = fs.statSync(path.join(repo.bundleRoot, "ade-linear", "index.html")).mtimeMs;

  assert.equal(second.plugins[0].written, 0);
  assert.equal(second.plugins[0].manifestChanged, false);
  assert.equal(second.plugins[0].removed, 0);
  assert.equal(before, after);
});

test("deletes a file the plugin stopped shipping", (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  writePlugin(repo.root, "ade-linear", {
    entryHtml: "dist/index.html",
    files: { "dist/index.html": "<html></html>", "dist/assets/old.js": "gone soon" },
  });
  syncBundledPluginPages({ repoRoot: repo.root, bundleRoot: repo.bundleRoot });
  assert.ok(fs.existsSync(path.join(repo.bundleRoot, "ade-linear", "assets", "old.js")));

  fs.rmSync(path.join(repo.root, "plugins", "ade-linear", "dist", "assets", "old.js"));
  const report = syncBundledPluginPages({ repoRoot: repo.root, bundleRoot: repo.bundleRoot });

  assert.equal(report.plugins[0].removed, 1);
  assert.ok(!fs.existsSync(path.join(repo.bundleRoot, "ade-linear", "assets", "old.js")));
  assert.ok(!fs.existsSync(path.join(repo.bundleRoot, "ade-linear", "assets")), "an emptied directory goes too");
  assert.deepEqual(readManifest(repo.bundleRoot, "ade-linear").files.map((f) => f.path), ["index.html"]);
});

test("deletes the whole directory of a plugin that no longer ships a page", (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  writePlugin(repo.root, "ade-linear", {
    entryHtml: "dist/index.html",
    files: { "dist/index.html": "<html></html>" },
  });
  syncBundledPluginPages({ repoRoot: repo.root, bundleRoot: repo.bundleRoot });

  // The plugin drops its webview surface. Its bundled page must go with it, or
  // the phone keeps serving a page the plugin no longer declares.
  writePlugin(repo.root, "ade-linear", { entryHtml: null });
  const report = syncBundledPluginPages({ repoRoot: repo.root, bundleRoot: repo.bundleRoot });

  assert.equal(report.plugins.length, 0);
  assert.equal(report.removedPlugins, 1);
  assert.ok(!fs.existsSync(path.join(repo.bundleRoot, "ade-linear")));
});

test("keeps the README that explains the directory", (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  fs.mkdirSync(repo.bundleRoot, { recursive: true });
  fs.writeFileSync(path.join(repo.bundleRoot, "README.md"), "# Bundled plugin pages\n");

  syncBundledPluginPages({ repoRoot: repo.root, bundleRoot: repo.bundleRoot });

  assert.ok(fs.existsSync(path.join(repo.bundleRoot, "README.md")));
});

/// The same refusal the sync channel makes: the asset root would be the whole
/// plugin directory, and bundling that would put its source into the app.
test("skips a plugin whose page sits at the plugin root", (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const warnings = [];
  writePlugin(repo.root, "ade-linear", {
    entryHtml: "index.html",
    files: { "index.html": "<html></html>", "linearApi.js": "source" },
  });

  const report = syncBundledPluginPages({
    repoRoot: repo.root,
    bundleRoot: repo.bundleRoot,
    warn: (message) => warnings.push(message),
  });

  assert.equal(report.plugins.length, 0);
  assert.match(warnings.join("\n"), /subdirectory/);
  assert.ok(!fs.existsSync(path.join(repo.bundleRoot, "ade-linear")));
});

test("skips a plugin whose page has not been built", (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const warnings = [];
  writePlugin(repo.root, "ade-linear", { entryHtml: "dist/index.html" });

  const report = syncBundledPluginPages({
    repoRoot: repo.root,
    bundleRoot: repo.bundleRoot,
    warn: (message) => warnings.push(message),
  });

  assert.equal(report.plugins.length, 0);
  assert.match(warnings.join("\n"), /build the page first/);
});

test("warns when the entry file is missing from the dist", (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const warnings = [];
  writePlugin(repo.root, "ade-linear", {
    entryHtml: "dist/index.html",
    files: { "dist/assets/app.js": "console.log(1)" },
  });

  syncBundledPluginPages({
    repoRoot: repo.root,
    bundleRoot: repo.bundleRoot,
    warn: (message) => warnings.push(message),
  });

  assert.match(warnings.join("\n"), /entry file is not in the dist/);
});

test("finds only plugins that declare a webview surface", (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  writePlugin(repo.root, "ade-linear", {
    entryHtml: "dist/index.html",
    files: { "dist/index.html": "<html></html>" },
  });
  writePlugin(repo.root, "ade-voice", { entryHtml: null });

  const pages = discoverPluginPages(repo.root);

  assert.deepEqual(pages.map((page) => page.pluginId), ["ade-linear"]);
  assert.equal(pages[0].entry, "index.html");
});
