"use strict";

const assert = require("node:assert/strict");
const { afterEach, describe, it } = require("node:test");

const fs = require("node:fs");
const path = require("node:path");

const plugin = require("../index");
const { createSdk, sampleLane } = require("./support");

const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "plugin.json"), "utf8"),
);

afterEach(async () => {
  await plugin.deactivate().catch(() => {});
});

describe("the graph publish seam", () => {
  it("writes lane rows from sdk.lanes.list and the graph panel names the workspace canvas", async () => {
    const lane = sampleLane();
    const sdk = createSdk({
      lanes: { list: async () => [lane], get: async () => lane },
    });
    await plugin.activate(sdk);
    const panel = sdk.panelsMap.get("graph");
    const canvas = panel.body.find((node) => node.component === "canvas");
    assert.equal(canvas.engine, "workspace");
    assert.equal(canvas.bind.collection, "lanes");
    const stored = await sdk.collections.list("lanes");
    assert.equal(stored.length, 1);
    assert.equal(stored[0].value.onPress.action, "openLane");
    assert.equal(stored[0].value.id, lane.id);
  });

  it("loads a lane into the detail panel", async () => {
    const lane = sampleLane();
    const sdk = createSdk({
      lanes: {
        list: async () => [lane],
        get: async (laneId) => (laneId === lane.id ? lane : null),
      },
    });
    await plugin.activate(sdk);
    const opened = await plugin.actions.openLane({ laneId: lane.id });
    assert.equal(opened.navigate.panelId, "lane");
    const panel = sdk.panelsMap.get("lane");
    assert.match(panel.title, /fix-login/i);
  });

  it("never answers openWebview from a socket that already declares its surface", async () => {
    const sdk = createSdk({
      lanes: { list: async () => [], get: async () => null },
    });
    await plugin.activate(sdk);
    const declaring = new Set(
      MANIFEST.sockets
        .filter((socket) => socket.webviewSurfaceId && socket.actionId)
        .map((socket) => socket.actionId),
    );
    assert.ok(declaring.size >= 1, "no page-declaring socket names an action");
    for (const actionId of declaring) {
      const result = await plugin.actions[actionId]({});
      assert.equal(
        result?.openWebview,
        undefined,
        `${actionId} answers openWebview beside a socket that declares its surface`,
      );
    }
  });

  it("keeps webviews off the phone and names the graph surface on the palette", () => {
    for (const surface of MANIFEST.surfaces) {
      if (surface.kind === "webview") {
        assert.equal(surface.mobile, false, `${surface.id} must not set mobile: true`);
        assert.equal(surface.entryHtml, "dist/index.html");
      }
    }
    const palette = MANIFEST.sockets.find((socket) => socket.id === "palette-graph");
    assert.equal(palette.webviewSurfaceId, "graph");
    assert.equal(palette.actionId, "openGraph");
    assert.equal(MANIFEST.version, "2.0.1");
  });
});
