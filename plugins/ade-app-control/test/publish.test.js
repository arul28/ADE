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

describe("the electron control publish seam", () => {
  it("writes a status row from app_control.getStatus and binds the fallback panel to it", async () => {
    const sdk = createSdk({
      actions: {
        invoke: async (domain, action) => {
          assert.equal(domain, "app_control");
          assert.equal(action, "getStatus");
          return {
            supported: true,
            activeSession: { title: "ADE desktop" },
          };
        },
      },
    });
    await plugin.activate(sdk);
    const panel = sdk.panelsMap.get("main");
    const list = panel.body.find((node) => node.component === "list");
    assert.equal(list.bind.collection, "status");
    assert.ok(!panel.body.some((node) => node.component === "canvas"));
    const stored = await sdk.collections.list("status");
    assert.equal(stored.length, 1);
    assert.equal(stored[0].value.live, "yes");
  });
});

describe("the manifest the page tier needs", () => {
  it("declares one webview surface, and no phone placement on it", () => {
    assert.equal(manifest.version, "2.0.0");
    assert.equal(manifest.surfaces.length, 1);
    const [surface] = manifest.surfaces;
    assert.deepEqual(surface, {
      kind: "webview",
      id: "control",
      title: "Electron Control",
      icon: "desktop",
      entryHtml: "dist/index.html",
      panelId: "main",
      // `parseSurfaces` forbids `true` on a webview and warns when one asks —
      // and a warning is a gate failure for an official package. Saying `false`
      // out loud is also the honest answer: no phone is the computer the
      // Electron app is running on.
      mobile: false,
    });
  });

  it("points both sockets at that surface while keeping their panel fallback", () => {
    for (const id of ["control-pane", "palette-control"]) {
      const socket = manifest.sockets.find((entry) => entry.id === id);
      assert.ok(socket, `${id} is missing`);
      assert.equal(socket.webviewSurfaceId, "control");
    }
    // `panelId` stays REQUIRED on the rail pane: the terminal and any host with
    // no page draw it, so naming a page must never take the panel away.
    const pane = manifest.sockets.find((entry) => entry.id === "control-pane");
    assert.equal(pane.panelId, "main");
    const palette = manifest.sockets.find((entry) => entry.id === "palette-control");
    assert.equal(palette.actionId, "openControl");
  });

  it("ships the built page the surface names", () => {
    const entry = path.join(__dirname, "..", manifest.surfaces[0].entryHtml);
    assert.ok(fs.existsSync(entry), `${manifest.surfaces[0].entryHtml} is not committed`);
    const html = fs.readFileSync(entry, "utf8");
    // Relative asset paths (`base: "./"`) and no inline script: the guest loads
    // from `ade-plugin://ade-app-control/dist/index.html` under a policy of
    // `script-src 'self'`.
    assert.match(html, /src="\.\/assets\//);
    assert.doesNotMatch(html, /crossorigin/);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/);
  });

  it("declares the collection the page's launch form is remembered in", () => {
    // Not `sync`, deliberately: a launch command and a CDP port describe a
    // process on ONE machine, and syncing them would arrive on a second as a
    // command that does not exist there.
    assert.equal(manifest.collections["ui-state"].sync, false);
  });
});
