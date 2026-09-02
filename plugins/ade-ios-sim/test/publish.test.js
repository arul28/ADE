"use strict";

const assert = require("node:assert/strict");
const { afterEach, describe, it } = require("node:test");

const plugin = require("../index");
const { createSdk } = require("./support");

afterEach(async () => {
  await plugin.deactivate().catch(() => {});
});

describe("the simulator publish seam", () => {
  it("writes a status row from ios_simulator.getStatus and names the host canvas", async () => {
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
    const canvas = panel.body.find((node) => node.component === "canvas");
    assert.equal(canvas.engine, "simulator");
    const stored = await sdk.collections.list("status");
    assert.equal(stored.length, 1);
    assert.equal(stored[0].value.live, "yes");
  });
});
