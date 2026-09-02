"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { commitRow, githubCommitUrl, operationRow, validateBranchName } = require("../format");
const { sampleCommit, sampleOperation } = require("./support");

describe("history row shaping", () => {
  it("puts the SHA, parents and subject on a canvas-ready commit row", () => {
    const row = commitRow(sampleCommit(), "lane-1");
    assert.equal(row.sha, sampleCommit().sha);
    assert.equal(row.parents.length, 1);
    assert.equal(row.onPress.action, "openCommit");
    assert.equal(row.laneId, "lane-1");
    assert.equal(row.actions[0].action, "copySha");
  });

  it("drops a commit with no SHA rather than minting a blank row", () => {
    assert.equal(commitRow({ subject: "nope" }, "lane-1"), null);
  });

  it("dresses an operation with a status chip the activity list can filter", () => {
    const row = operationRow(sampleOperation({ status: "failed" }));
    assert.equal(row.status, "failed");
    assert.equal(row.tone, "danger");
    assert.equal(row.onPress.action, "openEvent");
  });

  it("builds a GitHub commit URL from the same remotes the compiled page used", () => {
    assert.equal(
      githubCommitUrl("git@github.com:ade/app.git", "abc"),
      "https://github.com/ade/app/commit/abc",
    );
    assert.equal(githubCommitUrl("https://example.com/repo.git", "abc"), null);
  });

  it("refuses a branch name git would refuse", () => {
    assert.equal(validateBranchName("feature/ok"), null);
    assert.match(validateBranchName("has space"), /spaces/);
  });
});
