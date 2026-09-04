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

  it("never answers openWebview from a socket action", async () => {
    const sdk = createSdk({
      lanes: { list: async () => [] },
    });
    await plugin.activate(sdk);
    const named = new Set(
      MANIFEST.sockets.filter((socket) => socket.actionId).map((socket) => socket.actionId),
    );
    assert.ok(named.size >= 1, "no socket names an action");
    for (const actionId of named) {
      const result = await plugin.actions[actionId]({});
      assert.equal(
        result?.openWebview,
        undefined,
        `${actionId} answers openWebview instead of navigating to the rail tab`,
      );
      assert.equal(
        result?.navigate?.panelId,
        "commits",
        `${actionId} must navigate to the History tab, not open a second surface`,
      );
    }
  });

  /**
   * The compiled structure, asserted where it is declared.
   *
   * The page tier grew a second `activity` webview and a Work-rail pane the
   * compiled product never had, so History was reachable at three addresses
   * that each kept their own state. One tab, one palette row, and the panels
   * iOS and the terminal draw.
   */
  it("declares one webview surface, one palette row, and no work-rail pane", () => {
    const webviews = MANIFEST.surfaces.filter((surface) => surface.kind === "webview");
    assert.equal(webviews.length, 1);
    assert.equal(webviews[0].id, "commits");
    assert.equal(webviews[0].order, 55);
    assert.equal(webviews[0].mobile, false);
    assert.equal(webviews[0].entryHtml, "dist/index.html");

    assert.deepEqual(
      MANIFEST.sockets.map((socket) => socket.socket),
      ["command-palette-action"],
    );
    const palette = MANIFEST.sockets[0];
    assert.equal(palette.id, "palette-commits");
    assert.equal(palette.label, "Go to History");
    assert.equal(palette.actionId, "openCommits");
    // A palette row that declares a surface opens it as an overlay instead of
    // invoking. History is a tab, so the row must declare none.
    assert.equal(palette.webviewSurfaceId, undefined);

    assert.equal(MANIFEST.version, "2.0.2");
    assert.equal(MANIFEST.collections["ui-state"].sync, false);
  });

  /** iOS and the terminal draw panels, and every one of them is still here. */
  it("keeps the four vocabulary panels the phone and the terminal draw", () => {
    assert.deepEqual(
      MANIFEST.panels.map((panel) => panel.id),
      ["commits", "commit", "activity", "event"],
    );
  });
});
