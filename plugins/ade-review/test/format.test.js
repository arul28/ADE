"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { findingRow, runRow, statusTone, targetModeLabel } = require("../format");
const { sampleRun } = require("./support");

describe("review row shaping", () => {
  it("puts live runs on the active filter and completed ones on completed", () => {
    const live = runRow(sampleRun({ status: "running", summary: "Still going" }), 0);
    const done = runRow(sampleRun({ status: "completed" }), 1);
    assert.equal(live.status, "active");
    assert.equal(live.tone, "warning");
    assert.equal(done.status, "completed");
    assert.equal(done.onPress.action, "openRun");
  });

  it("drops a run with no id rather than minting a blank row", () => {
    assert.equal(runRow({ summary: "nope" }, 0), null);
  });

  it("dresses a finding with severity and the file:line subtitle", () => {
    const row = findingRow(sampleRun().findings[0]);
    assert.equal(row.badge.text, "HIGH");
    assert.match(row.subtitle, /src\/auth\.ts:42/);
    assert.equal(row.overflow[0].action, "acknowledgeFinding");
  });

  it("maps known target modes to the compiled labels", () => {
    assert.equal(targetModeLabel("working_tree"), "Uncommitted changes");
    assert.equal(statusTone("failed"), "danger");
  });
});
