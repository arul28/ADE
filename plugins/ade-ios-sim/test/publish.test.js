"use strict";

const assert = require("node:assert/strict");
const { afterEach, describe, it } = require("node:test");

const fs = require("node:fs");
const path = require("node:path");

const plugin = require("../index");
const { createSdk } = require("./support");

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "plugin.json"), "utf8"),
);

afterEach(async () => {
  await plugin.deactivate().catch(() => {});
});

describe("the simulator publish seam", () => {
  it("writes a status row from ios_simulator.getStatus and binds the fallback panel to it", async () => {
    const sdk = createSdk({
      actions: {
        invoke: async (domain, action) => {
          assert.equal(domain, "ios_simulator");
          assert.equal(action, "getStatus");
          return {
            supported: true,
            platform: "darwin",
            activeSession: { deviceName: "iPhone 16" },
          };
        },
      },
    });
    await plugin.activate(sdk);
    const panel = sdk.panelsMap.get("main");
    assert.equal(panel.title, "iOS Sim Control");
    const list = panel.body.find((node) => node.component === "list");
    assert.equal(list.bind.collection, "status");
    const stored = await sdk.collections.list("status");
    assert.equal(stored.length, 1);
    assert.equal(stored[0].value.live, "yes");
  });
});

describe("the manifest the page tier needs", () => {
  it("declares one webview surface, and no phone placement on it", () => {
    assert.equal(manifest.version, "2.0.1");
    assert.equal(manifest.displayName, "iOS Sim Control");
    assert.equal(manifest.surfaces.length, 1);
    const [surface] = manifest.surfaces;
    assert.equal(surface.kind, "webview");
    assert.equal(surface.id, "sim");
    assert.equal(surface.title, "iOS Sim Control");
    assert.equal(surface.entryHtml, "dist/index.html");
    assert.equal(surface.panelId, "main");
    // The page is reached through this plugin's own `work-rail-pane` socket,
    // exactly where the compiled simulator pane lived before it was a plugin.
    // Without this the webview also claims a tab in the main sidebar.
    assert.equal(surface.railTab, false);
    assert.equal(surface.mobile, false);
  });

  it("names both sockets iOS Sim Control and points them at that surface", () => {
    const pane = manifest.sockets.find((entry) => entry.id === "sim-pane");
    const palette = manifest.sockets.find((entry) => entry.id === "palette-sim");
    assert.equal(pane.label, "iOS Sim Control");
    assert.equal(pane.webviewSurfaceId, "sim");
    assert.equal(pane.panelId, "main");
    assert.equal(palette.label, "iOS Sim Control");
    assert.equal(palette.webviewSurfaceId, "sim");
  });

  it("ships the built page the surface names", () => {
    const entry = path.join(__dirname, "..", manifest.surfaces[0].entryHtml);
    assert.ok(fs.existsSync(entry), `${manifest.surfaces[0].entryHtml} is not committed`);
    const html = fs.readFileSync(entry, "utf8");
    assert.match(html, /src="\.\/assets\//);
    assert.doesNotMatch(html, /crossorigin/);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/);
  });
});
