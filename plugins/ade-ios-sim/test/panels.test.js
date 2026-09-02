"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { buildMainPanel } = require("../panels");

describe("simulator panels", () => {
  it("draws the simulator canvas bound to the status collection", () => {
    const panel = buildMainPanel({ status: { supported: true, platform: "darwin" } });
    const canvas = panel.body.find((node) => node.component === "canvas");
    assert.equal(canvas.engine, "simulator");
    assert.equal(canvas.bind.collection, "status");
  });
});
