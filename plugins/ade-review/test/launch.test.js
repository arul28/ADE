"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { buildTargetConfig, readLaunchForm, validationMessage } = require("../launch");

describe("reading the launch form", () => {
  it("reads the compiled dialog's fields", () => {
    const form = readLaunchForm({
      laneId: "lane-7",
      targetMode: "commit_range",
      baseCommit: "aaa",
      headCommit: "bbb",
      modelId: "openai/gpt-5.6-sol",
      reasoningEffort: "high",
      fastMode: true,
      publishBehavior: "local_only",
    });
    assert.equal(form.laneId, "lane-7");
    assert.equal(form.targetMode, "commit_range");
    assert.equal(form.fastMode, true);
    assert.equal(form.reasoningEffort, "high");
    const payload = buildTargetConfig(form);
    assert.equal(payload.target.mode, "commit_range");
    assert.equal(payload.config.selectionMode, "selected_commits");
  });

  it("treats a PR toolbar press as pr mode with auto_publish", () => {
    const form = readLaunchForm({
      context: { kind: "pr", id: "pr-9", laneId: "lane-1", number: 42 },
    });
    assert.equal(form.targetMode, "pr");
    assert.equal(form.prId, "pr-9");
    assert.equal(form.laneId, "lane-1");
    assert.equal(form.publishBehavior, "auto_publish");
    const payload = buildTargetConfig(form);
    assert.deepEqual(payload.target, { mode: "pr", laneId: "lane-1", prId: "pr-9" });
  });

  it("asks for a lane checkout when a PR press has no lane", () => {
    assert.match(
      validationMessage(readLaunchForm({
        context: { kind: "pr", id: "pr-9", number: 42 },
      })),
      /Open this pull request as a lane/,
    );
  });

  it("refuses a commit range with no SHAs", () => {
    assert.match(
      validationMessage(readLaunchForm({ laneId: "lane-1", targetMode: "commit_range" })),
      /earlier commit/,
    );
  });

  it("refuses a launch with no lane", () => {
    assert.match(validationMessage(readLaunchForm({})), /Choose a lane/);
  });
});
