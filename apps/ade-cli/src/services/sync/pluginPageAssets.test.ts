/**
 * The plugin page asset channel.
 *
 * Every test builds a real plugins root on disk, because the whole contract is
 * about the filesystem: which directory a plugin's page lives in, whether a
 * path escapes it, and whether the bytes still hash to what the manifest said.
 * A mocked `fs` would prove none of that.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildPluginPageAssetsManifest,
  PLUGIN_PAGE_ASSET_MAX_BYTES,
  readPluginPageAsset,
  resolvePluginPageAssetRoot,
} from "./pluginPageAssets";

let pluginsRoot = "";

function sha256(text: string | Buffer): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function writeRegistry(entries: Record<string, { version: string; enabled: boolean; updatedAt?: string }>): void {
  const plugins: Record<string, unknown> = {};
  for (const [pluginId, entry] of Object.entries(entries)) {
    plugins[pluginId] = {
      pluginId,
      version: entry.version,
      enabled: entry.enabled,
      source: { kind: "builtin" },
      installedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: entry.updatedAt ?? "2026-02-02T00:00:00.000Z",
    };
  }
  fs.writeFileSync(path.join(pluginsRoot, "state.json"), JSON.stringify({ version: 2, plugins }));
}

function writeManifest(pluginId: string, surfaces: Record<string, unknown>[]): void {
  fs.writeFileSync(
    path.join(pluginsRoot, pluginId, "plugin.json"),
    JSON.stringify({
      name: pluginId,
      version: "1.0.0",
      displayName: "Demo",
      description: "A demo plugin",
      vocabVersion: 1,
      surfaces,
      panels: [{ id: "main", title: "Main" }],
    }),
  );
}

function writeFile(relative: string, contents: string): void {
  const absolute = path.join(pluginsRoot, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, contents);
}

beforeEach(() => {
  pluginsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-pages-"));
  fs.mkdirSync(path.join(pluginsRoot, "demo-plugin"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(pluginsRoot, { recursive: true, force: true });
});

describe("resolvePluginPageAssetRoot", () => {
  it("serves the directory holding the manifest's webview entryHtml", () => {
    writeRegistry({ "demo-plugin": { version: "1.2.3", enabled: true } });
    writeManifest("demo-plugin", [
      { kind: "webview", id: "browser", title: "Browser", panelId: "main", entryHtml: "page/index.html" },
    ]);
    writeFile("demo-plugin/page/index.html", "<html></html>");

    const resolved = resolvePluginPageAssetRoot("demo-plugin", { pluginsRoot });

    expect(resolved.root).toBe(fs.realpathSync(path.join(pluginsRoot, "demo-plugin", "page")));
    expect(resolved.entry).toBe("index.html");
    expect(resolved.version).toBe("1.2.3");
    expect(resolved.revision).toBe(Date.parse("2026-02-02T00:00:00.000Z"));
  });

  it("falls back to dist/ when the plugin declares no webview surface", () => {
    writeRegistry({ "demo-plugin": { version: "1.0.0", enabled: true } });
    writeManifest("demo-plugin", [{ kind: "tab", id: "t", title: "T", panelId: "main" }]);
    writeFile("demo-plugin/dist/index.html", "<html></html>");

    const resolved = resolvePluginPageAssetRoot("demo-plugin", { pluginsRoot });

    expect(resolved.root).toBe(fs.realpathSync(path.join(pluginsRoot, "demo-plugin", "dist")));
    expect(resolved.entry).toBe("index.html");
  });

  it("refuses a plugin the registry does not list", () => {
    writeRegistry({});
    expect(() => resolvePluginPageAssetRoot("demo-plugin", { pluginsRoot })).toThrow(/no page assets/);
  });

  it("refuses a disabled plugin the same way it refuses a missing one", () => {
    writeRegistry({ "demo-plugin": { version: "1.0.0", enabled: false } });
    writeManifest("demo-plugin", [
      { kind: "webview", id: "browser", title: "Browser", panelId: "main", entryHtml: "page/index.html" },
    ]);
    writeFile("demo-plugin/page/index.html", "<html></html>");

    expect(() => resolvePluginPageAssetRoot("demo-plugin", { pluginsRoot })).toThrow(/no page assets/);
  });

  it("refuses a page served from the plugin root rather than shipping the source tree", () => {
    writeRegistry({ "demo-plugin": { version: "1.0.0", enabled: true } });
    writeManifest("demo-plugin", [
      { kind: "webview", id: "browser", title: "Browser", panelId: "main", entryHtml: "index.html" },
    ]);
    writeFile("demo-plugin/index.html", "<html></html>");
    writeFile("demo-plugin/node_modules/big/index.js", "module.exports = 1");

    expect(() => resolvePluginPageAssetRoot("demo-plugin", { pluginsRoot })).toThrow(/subdirectory/);
  });

  it("refuses an invalid plugin id before it touches the filesystem", () => {
    expect(() => resolvePluginPageAssetRoot("../escape", { pluginsRoot })).toThrow(/valid plugin id/);
  });

  it("revisions move when the install is updated without a version bump", () => {
    writeRegistry({ "demo-plugin": { version: "1.0.0", enabled: true, updatedAt: "2026-03-03T00:00:00.000Z" } });
    writeManifest("demo-plugin", [{ kind: "tab", id: "t", title: "T", panelId: "main" }]);
    writeFile("demo-plugin/dist/index.html", "<html></html>");
    const first = resolvePluginPageAssetRoot("demo-plugin", { pluginsRoot });

    writeRegistry({ "demo-plugin": { version: "1.0.0", enabled: true, updatedAt: "2026-04-04T00:00:00.000Z" } });
    const second = resolvePluginPageAssetRoot("demo-plugin", { pluginsRoot });

    expect(second.version).toBe(first.version);
    expect(second.revision).toBeGreaterThan(first.revision);
  });
});

describe("buildPluginPageAssetsManifest", () => {
  beforeEach(() => {
    writeRegistry({ "demo-plugin": { version: "1.0.0", enabled: true } });
    writeManifest("demo-plugin", [
      { kind: "webview", id: "browser", title: "Browser", panelId: "main", entryHtml: "dist/app.html" },
    ]);
  });

  it("lists every file with its size and hash, sorted", () => {
    writeFile("demo-plugin/dist/app.html", "<html>page</html>");
    writeFile("demo-plugin/dist/assets/app.js", "console.log(1)");
    writeFile("demo-plugin/dist/assets/app.css", "body{}");

    const manifest = buildPluginPageAssetsManifest("demo-plugin", { pluginsRoot });

    expect(manifest.entry).toBe("app.html");
    expect(manifest.files.map((file) => file.path)).toEqual([
      "app.html",
      "assets/app.css",
      "assets/app.js",
    ]);
    const html = manifest.files.find((file) => file.path === "app.html");
    expect(html?.bytes).toBe(Buffer.byteLength("<html>page</html>"));
    expect(html?.sha256).toBe(sha256("<html>page</html>"));
  });

  it("never lists a file outside the asset root", () => {
    writeFile("demo-plugin/dist/app.html", "<html></html>");
    writeFile("demo-plugin/secret.txt", "token");

    const manifest = buildPluginPageAssetsManifest("demo-plugin", { pluginsRoot });

    expect(manifest.files.map((file) => file.path)).toEqual(["app.html"]);
  });

  it("skips a symlink rather than following it out of the plugin", () => {
    writeFile("demo-plugin/dist/app.html", "<html></html>");
    const outside = path.join(pluginsRoot, "outside.txt");
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(outside, path.join(pluginsRoot, "demo-plugin", "dist", "link.txt"));

    const manifest = buildPluginPageAssetsManifest("demo-plugin", { pluginsRoot });

    expect(manifest.files.map((file) => file.path)).toEqual(["app.html"]);
  });
});

describe("readPluginPageAsset", () => {
  beforeEach(() => {
    writeRegistry({ "demo-plugin": { version: "1.0.0", enabled: true } });
    writeManifest("demo-plugin", [
      { kind: "webview", id: "browser", title: "Browser", panelId: "main", entryHtml: "dist/index.html" },
    ]);
    writeFile("demo-plugin/dist/index.html", "<html>hello</html>");
  });

  it("returns the file as base64 when the hash matches", () => {
    const blob = readPluginPageAsset(
      { pluginId: "demo-plugin", path: "index.html", sha256: sha256("<html>hello</html>") },
      { pluginsRoot },
    );

    expect(Buffer.from(blob.contentBase64, "base64").toString("utf8")).toBe("<html>hello</html>");
    expect(blob.bytes).toBe(Buffer.byteLength("<html>hello</html>"));
  });

  it("refuses when the file changed since the manifest was read", () => {
    expect(() =>
      readPluginPageAsset(
        { pluginId: "demo-plugin", path: "index.html", sha256: sha256("<html>stale</html>") },
        { pluginsRoot },
      ),
    ).toThrow(/changed since the manifest/);
  });

  it("refuses a hash that is not a sha256", () => {
    expect(() =>
      readPluginPageAsset({ pluginId: "demo-plugin", path: "index.html", sha256: "nope" }, { pluginsRoot }),
    ).toThrow(/requires a sha256/);
  });

  it("refuses a traversal out of the asset root", () => {
    writeFile("demo-plugin/plugin-secret.txt", "token");
    expect(() =>
      readPluginPageAsset(
        { pluginId: "demo-plugin", path: "../plugin-secret.txt", sha256: sha256("token") },
        { pluginsRoot },
      ),
    ).toThrow(/escapes the plugin/);
  });

  it("refuses an absolute path", () => {
    expect(() =>
      readPluginPageAsset(
        { pluginId: "demo-plugin", path: "/etc/hosts", sha256: sha256("x").replace(/./g, "a") },
        { pluginsRoot },
      ),
    ).toThrow(/must be relative/);
  });

  it("refuses a symlink that points out of the asset root", () => {
    const outside = path.join(pluginsRoot, "outside.txt");
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(outside, path.join(pluginsRoot, "demo-plugin", "dist", "link.txt"));

    expect(() =>
      readPluginPageAsset(
        { pluginId: "demo-plugin", path: "link.txt", sha256: sha256("outside") },
        { pluginsRoot },
      ),
    ).toThrow(/escapes the plugin/);
  });

  it("refuses a directory", () => {
    fs.mkdirSync(path.join(pluginsRoot, "demo-plugin", "dist", "assets"), { recursive: true });
    expect(() =>
      readPluginPageAsset(
        { pluginId: "demo-plugin", path: "assets", sha256: sha256("x").padEnd(64, "0").slice(0, 64) },
        { pluginsRoot },
      ),
    ).toThrow(/does not exist/);
  });

  it("refuses a file above the per-file ceiling", () => {
    const big = Buffer.alloc(PLUGIN_PAGE_ASSET_MAX_BYTES + 1, 0x61);
    fs.writeFileSync(path.join(pluginsRoot, "demo-plugin", "dist", "big.bin"), big);

    expect(() =>
      readPluginPageAsset(
        { pluginId: "demo-plugin", path: "big.bin", sha256: sha256(big) },
        { pluginsRoot },
      ),
    ).toThrow(/too large to sync/);
  });

  it("refuses a disabled plugin", () => {
    writeRegistry({ "demo-plugin": { version: "1.0.0", enabled: false } });
    expect(() =>
      readPluginPageAsset(
        { pluginId: "demo-plugin", path: "index.html", sha256: sha256("<html>hello</html>") },
        { pluginsRoot },
      ),
    ).toThrow(/no page assets/);
  });
});
