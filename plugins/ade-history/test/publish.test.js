"use strict";

const assert = require("node:assert/strict");
const { afterEach, describe, it } = require("node:test");

const plugin = require("../index");
const { createSdk, sampleCommit, sampleLane, sampleOperation } = require("./support");

afterEach(async () => {
  await plugin.deactivate().catch(() => {});
});

describe("the history publish seam", () => {
  it("writes commit rows from listRecentCommits and the commits panel names that canvas", async () => {
    const commit = sampleCommit();
    const sdk = createSdk({
      lanes: { list: async () => [sampleLane()] },
      git: {
        listRecentCommits: async () => [commit],
        listBranches: async () => [{ name: "HEAD", lastCommitSha: commit.sha }],
      },
    });
    await plugin.activate(sdk);
    const panel = sdk.panelsMap.get("commits");
    const canvas = panel.body.find((node) => node.component === "canvas");
    assert.equal(canvas.engine, "git-dag");
    assert.equal(canvas.bind.collection, "commits");
    const stored = await sdk.collections.list("commits");
    assert.equal(stored.length, 1);
    assert.equal(stored[0].value.sha, commit.sha);
    assert.equal(stored[0].value.onPress.action, "openCommit");
  });

  it("cherryPick uses the same git.cherryPickCommit the compiled menu sent", async () => {
    const calls = [];
    const commit = sampleCommit();
    const sdk = createSdk({
      lanes: { list: async () => [sampleLane()] },
      git: {
        listRecentCommits: async () => [commit],
        listBranches: async () => [],
        cherryPickCommit: async (args) => {
          calls.push(args);
          return { operationId: "op-9" };
        },
      },
    });
    await plugin.activate(sdk);
    const result = await plugin.actions.cherryPick({
      sha: commit.sha,
      laneId: "lane-1",
    });
    assert.equal(result.message, "Cherry-picked.");
    assert.equal(calls[0].commitSha, commit.sha);
    assert.equal(calls[0].laneId, "lane-1");
  });

  it("loads an operation into the event panel", async () => {
    const operation = sampleOperation();
    const sdk = createSdk({
      lanes: { list: async () => [sampleLane()] },
      operation: {
        list: async () => [operation],
        get: async ({ operationId }) => (operationId === operation.id ? operation : null),
      },
    });
    await plugin.activate(sdk);
    await plugin.actions.openActivity();
    const stored = await sdk.collections.list("operations");
    assert.equal(stored.length, 1);
    const opened = await plugin.actions.openEvent({ operationId: operation.id });
    assert.equal(opened.navigate.panelId, "event");
    const panel = sdk.panelsMap.get("event");
    assert.match(panel.title, /git commit/i);
  });
});
