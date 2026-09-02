"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { buildActivityPanel, buildCommitPanel, buildCommitsPanel } = require("../panels");
const { sampleCommit, sampleLane } = require("./support");

describe("history panels", () => {
  it("draws commits as a git-dag canvas bound to the commits collection", () => {
    const panel = buildCommitsPanel({ lanes: [sampleLane()] });
    assert.equal(panel.chrome.navActions[0].action, "openActivity");
    const canvas = panel.body.find((node) => node.component === "canvas");
    assert.equal(canvas.engine, "git-dag");
    assert.equal(canvas.bind.collection, "commits");
  });

  it("puts cherry-pick and revert on the commit detail", () => {
    const panel = buildCommitPanel({
      commit: { ...sampleCommit(), laneId: "lane-1" },
      message: "Fix the rail\n\nLonger body.",
    });
    const buttons = panel.body.flatMap((node) => node.children ?? []).filter((node) => node.component === "button");
    assert.ok(buttons.some((button) => button.onPress.action === "cherryPick"));
    assert.ok(buttons.some((button) => button.onPress.action === "revertCommit"));
  });

  it("filters activity by status and lane", () => {
    const panel = buildActivityPanel({ lanes: [sampleLane()] });
    const list = panel.body.find((node) => node.component === "list");
    assert.equal(list.bind.collection, "operations");
    assert.ok(list.bind.where.some((clause) => clause.field === "status"));
  });
});
