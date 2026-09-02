"use strict";

const assert = require("node:assert/strict");
const { afterEach, describe, it } = require("node:test");

const plugin = require("../index");
const { createSdk, sampleRun } = require("./support");

afterEach(async () => {
  await plugin.deactivate().catch(() => {});
});

describe("the review publish seam", () => {
  it("writes run rows from listRuns and the runs panel names that collection", async () => {
    const run = sampleRun();
    const sdk = createSdk({
      review: {
        listRuns: async () => [run],
        getRunDetail: async () => run,
      },
    });
    await plugin.activate(sdk);
    const panel = sdk.panelsMap.get("runs");
    const list = panel.body.find((node) => node.component === "list");
    assert.equal(list.bind.collection, "runs");
    const stored = await sdk.collections.list("runs");
    assert.equal(stored.length, 1);
    assert.equal(stored[0].value.runId, "run-1");
    assert.equal(stored[0].value.onPress.action, "openRun");
  });

  it("startRun uses the same target/config the compiled dialog sent, then opens the run", async () => {
    const calls = [];
    const sdk = createSdk({
      review: {
        listRuns: async () => [sampleRun()],
        listLaunchContext: async () => ({
          defaultLaneId: "lane-1",
          lanes: [{ id: "lane-1", name: "fix-login" }],
          recentCommitsByLane: {},
        }),
        startRun: async (args) => {
          calls.push(args);
          return { runId: "run-9" };
        },
        getRunDetail: async ({ runId }) => sampleRun({ id: runId }),
      },
    });
    await plugin.activate(sdk);
    const result = await plugin.actions.startRun({
      laneId: "lane-1",
      targetMode: "lane_diff",
      compareKind: "default_branch",
    });
    assert.equal(result.navigate.panelId, "run");
    assert.equal(calls[0].target.mode, "lane_diff");
    assert.equal(calls[0].config.publishBehavior, "local_only");
  });
});
