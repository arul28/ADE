"use strict";

const assert = require("node:assert/strict");
const { afterEach, describe, it } = require("node:test");

const plugin = require("../index");
const { createSdk } = require("./support");

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
