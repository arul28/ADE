"use strict";

const assert = require("node:assert/strict");
const { afterEach, describe, it } = require("node:test");

const plugin = require("../index");
const { createSdk } = require("./support");

afterEach(async () => {
  await plugin.deactivate().catch(() => {});
});

describe("the electron control publish seam", () => {
  it("writes a status row from app_control.getStatus and names the host canvas", async () => {
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
    const canvas = panel.body.find((node) => node.component === "canvas");
    assert.equal(canvas.engine, "electron-control");
    const stored = await sdk.collections.list("status");
    assert.equal(stored.length, 1);
    assert.equal(stored[0].value.live, "yes");
  });
});
