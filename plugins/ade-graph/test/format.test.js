"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { laneRow } = require("../format");
const { sampleLane } = require("./support");

describe("graph row shaping", () => {
  it("puts the lane id, branch and status on a canvas-ready row", () => {
    const row = laneRow(sampleLane({ status: "dirty" }));
    assert.equal(row.id, "lane-1");
    assert.equal(row.laneId, "lane-1");
    assert.equal(row.onPress.action, "openLane");
    assert.equal(row.badge.tone, "warning");
    assert.match(row.subtitle, /fix-login/);
  });

  it("drops a lane with no id rather than minting a blank row", () => {
    assert.equal(laneRow({ name: "nope" }), null);
  });
});
