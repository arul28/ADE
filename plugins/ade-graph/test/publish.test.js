"use strict";

const assert = require("node:assert/strict");
const { afterEach, describe, it } = require("node:test");

const plugin = require("../index");
const { createSdk, sampleLane } = require("./support");

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
});
