"use strict";

const assert = require("node:assert/strict");
const { afterEach, describe, it } = require("node:test");

const plugin = require("../index");
const { createSdk, sampleCommit, sampleLane } = require("./support");

afterEach(async () => {
  await plugin.deactivate().catch(() => {});
});

/** The widest commit write this plugin makes: every lane it caps at, filled. */
const LANE_CAP = 8;
const COMMIT_LIMIT = 120;

function laneCommits(laneId, count) {
  return Array.from({ length: count }, (_, index) => sampleCommit({
    sha: `${laneId}-${String(index).padStart(4, "0")}`.padEnd(40, "0"),
    shortSha: `${laneId}${index}`,
    subject: `Commit ${index} on ${laneId}`,
  }));
}

describe("the commit collection sweep", () => {
  it("removes every stale row after a refresh that writes the widest set", async () => {
    // The bug this pins: the sweep listed 800 rows while one refresh wrote up
    // to 960. The 160 it never saw were never deleted, so a commit that left a
    // lane's recent history stayed on the panel for the life of the store.
    const lanes = Array.from({ length: LANE_CAP }, (_, index) => sampleLane({
      id: `lane-${index}`,
      name: `lane-${index}`,
    }));

    let perLane = COMMIT_LIMIT;
    const sdk = createSdk({
      lanes: { list: async () => lanes },
      git: {
        listRecentCommits: async (args) => laneCommits(args.laneId, perLane),
        listBranches: async () => [],
      },
    });

    await plugin.activate(sdk);
    const full = await sdk.collections.list("commits", { limit: 5_000 });
    assert.equal(full.length, LANE_CAP * COMMIT_LIMIT);

    // Every lane rewinds to one commit. Nothing else should survive.
    perLane = 1;
    await plugin.actions.refreshCommits();

    const remaining = await sdk.collections.list("commits", { limit: 5_000 });
    assert.equal(remaining.length, LANE_CAP);
    for (const row of remaining) {
      assert.match(row.value.subject, /^Commit 0 on lane-/);
    }
  });
});
