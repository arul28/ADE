"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { buildLaunchPanel, buildRunPanel, buildRunsPanel } = require("../panels");
const { sampleRun } = require("./support");

describe("review panels", () => {
  it("puts Launch and Learnings on the runs chrome", () => {
    const panel = buildRunsPanel({ hasRuns: true, counts: { active: 1 } });
    assert.equal(panel.chrome.navActions[0].action, "openLaunch");
    assert.equal(panel.chrome.navActions[1].action, "openLearnings");
    const list = panel.body.find((node) => node.component === "list");
    assert.equal(list.bind.collection, "runs");
  });

  it("draws an empty-state when a run is missing", () => {
    const panel = buildRunPanel({});
    const empty = panel.body.find((node) => node.component === "emptyState");
    assert.equal(empty.action.onPress.action, "openRuns");
  });

  it("binds findings to the selected run's key prefix", () => {
    const panel = buildRunPanel({ run: sampleRun() });
    const list = panel.body.find((node) => node.component === "list");
    assert.equal(list.bind.keyPrefix, "finding:run-1:");
  });

  it("locks a PR launch onto auto_publish and pr mode", () => {
    const panel = buildLaunchPanel({
      lanes: [{ id: "lane-1", name: "fix-login" }],
      form: { targetMode: "pr", laneId: "lane-1", prId: "pr-9", publishBehavior: "auto_publish" },
    });
    const form = panel.body.find((node) => node.component === "form");
    assert.equal(form.submit.onPress.action, "startRun");
    assert.ok(form.fields.some((field) => field.id === "prId"));
    assert.ok(form.fields.every((field) => field.id !== "targetMode"));
  });
});
