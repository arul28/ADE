"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { buildGraphPanel, buildLanePanel } = require("../panels");
const { sampleLane } = require("./support");

describe("graph panels", () => {
  it("draws the workspace canvas bound to the lanes collection", () => {
    const panel = buildGraphPanel({ lanes: [sampleLane()] });
    const canvas = panel.body.find((node) => node.component === "canvas");
    assert.equal(canvas.engine, "workspace");
    assert.equal(canvas.bind.collection, "lanes");
    assert.equal(canvas.onSelect.action, "openLane");
  });

  it("puts lane fields on the detail panel", () => {
    const panel = buildLanePanel({ lane: sampleLane({ status: "dirty" }) });
    const kv = panel.body.find((node) => node.component === "keyValue");
    assert.ok(kv.items.some((item) => item.key === "Name" && item.value === "fix-login"));
    assert.ok(kv.items.some((item) => item.key === "Status"));
  });
});
