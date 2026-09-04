"use strict";

const assert = require("node:assert/strict");
const { afterEach, describe, it } = require("node:test");

const plugin = require("../index");
const { createSdk, sampleCommit, sampleLane, sampleOperation } = require("./support");
const fs = require("node:fs");
const path = require("node:path");

const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "plugin.json"), "utf8"),
);

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

  it("pageCommitGraph fans out listRecentCommits and listBranches as one answer", async () => {
    const commit = sampleCommit();
    const sdk = createSdk({
      lanes: { list: async () => [sampleLane()] },
      git: {
        listRecentCommits: async () => [commit],
        listBranches: async () => [{ name: "HEAD", lastCommitSha: commit.sha }],
      },
    });
    await plugin.activate(sdk);
    const graph = await plugin.actions.pageCommitGraph({ laneId: "lane-1", limit: 50 });
    assert.equal(graph.commits.length, 1);
    assert.equal(graph.commits[0].sha, commit.sha);
    assert.equal(graph.branches[0].name, "HEAD");
  });

  it("never answers openWebview from a socket that already declares its surface", async () => {
    const sdk = createSdk({
      lanes: { list: async () => [] },
    });
    await plugin.activate(sdk);
    const declaring = new Set(
      MANIFEST.sockets
        .filter((socket) => socket.webviewSurfaceId && socket.actionId)
        .map((socket) => socket.actionId),
    );
    assert.ok(declaring.size >= 1, "no page-declaring socket names an action");
    for (const actionId of declaring) {
      const result = await plugin.actions[actionId]({});
      assert.equal(
        result?.openWebview,
        undefined,
        `${actionId} answers openWebview beside a socket that declares its surface`,
      );
    }
  });

  it("keeps webviews off the phone and names History surfaces on palette and pane sockets", () => {
    for (const surface of MANIFEST.surfaces) {
      if (surface.kind === "webview") {
        assert.equal(surface.mobile, false, `${surface.id} must not set mobile: true`);
        assert.equal(surface.entryHtml, "dist/index.html");
      }
    }
    const paletteCommits = MANIFEST.sockets.find((socket) => socket.id === "palette-commits");
    const paletteActivity = MANIFEST.sockets.find((socket) => socket.id === "palette-activity");
    const pane = MANIFEST.sockets.find((socket) => socket.id === "commits-pane");
    assert.equal(paletteCommits.webviewSurfaceId, "commits");
    assert.equal(paletteCommits.actionId, "openCommits");
    assert.equal(paletteActivity.webviewSurfaceId, "activity");
    assert.equal(paletteActivity.actionId, "openActivity");
    assert.equal(pane.webviewSurfaceId, "commits");
    assert.equal(MANIFEST.version, "2.0.1");
    assert.equal(MANIFEST.collections["ui-state"].sync, false);
  });
});
