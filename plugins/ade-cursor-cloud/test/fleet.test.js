"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  assembleFleet,
  createOriginCache,
  fleetRow,
  fleetRowKey,
  groupFleet,
  laneOptions,
  mapWithConcurrency,
  pickBranch,
} = require("../fleet");
const { fleetDisplayStatus, formatAge, formatCost, statusTone } = require("../format");

const ORIGIN = "https://github.com/acme/app";

function agent(id, extra = {}) {
  return {
    id,
    name: `agent ${id}`,
    status: "ACTIVE",
    repos: [{ url: ORIGIN }],
    createdAt: "2026-08-26T10:00:00.000Z",
    updatedAt: "2026-08-26T10:00:00.000Z",
    ...extra,
  };
}

function api(overrides = {}) {
  return {
    listAgentsPaged: async () => [],
    listRuns: async () => ({ items: [] }),
    ...overrides,
  };
}

function deps(overrides = {}) {
  return {
    api: api(),
    listLanes: async () => [],
    listSessionLinks: async () => [],
    originCache: createOriginCache(async () => ORIGIN),
    ...overrides,
  };
}

describe("scoping the fleet to this project", () => {
  it("keeps an agent whose repo IS this project's origin", async () => {
    const result = await assembleFleet(deps({ api: api({ listAgentsPaged: async () => [agent("a1")] }) }));
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].matchedBy, "repo");
  });

  it("keeps an agent a chat here owns even when the repo does not match", async () => {
    const result = await assembleFleet(deps({
      api: api({ listAgentsPaged: async () => [agent("a1", { repos: [{ url: "https://github.com/other/thing" }] })] }),
      listSessionLinks: async () => [{ agentId: "a1", sessionId: "s1", laneId: "lane-1", laneName: "Lane one" }],
    }));
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].matchedBy, "session");
    assert.equal(result.items[0].ownership.sessionId, "s1");
  });

  it("drops an agent that is neither owned here nor in this repo", async () => {
    const result = await assembleFleet(deps({
      api: api({ listAgentsPaged: async () => [agent("a1", { repos: [{ url: "https://github.com/other/thing" }] })] }),
    }));
    assert.equal(result.items.length, 0);
  });

  it("hides archived agents but still counts them", async () => {
    const result = await assembleFleet(deps({
      api: api({ listAgentsPaged: async () => [agent("a1"), agent("a2", { status: "ARCHIVED" })] }),
    }));
    assert.equal(result.items.length, 1);
    assert.equal(result.archivedCount, 1);
  });
});

describe("enriching a row", () => {
  it("reads the latest run for a live agent only", async () => {
    const asked = [];
    const result = await assembleFleet(deps({
      api: api({
        listAgentsPaged: async () => [
          agent("live", { status: "RUNNING" }),
          agent("done", { status: "FINISHED" }),
        ],
        listRuns: async (agentId) => {
          asked.push(agentId);
          return { items: [{ id: "r1", status: "RUNNING", git: { branches: [{ repoUrl: ORIGIN, branch: "ade/fix" }] } }] };
        },
      }),
    }));

    // A finished agent's list row is already complete, and enriching it would
    // cost one request per row for nothing.
    assert.deepEqual(asked, ["live"]);
    const live = result.items.find((entry) => entry.agent.agentId === "live");
    assert.equal(live.runStatus, "running");
    assert.equal(live.branch, "ade/fix");
  });

  it("enriches Cursor's ACTIVE list status, which is a live run", async () => {
    const asked = [];
    const result = await assembleFleet(deps({
      api: api({
        listAgentsPaged: async () => [agent("live")],
        listRuns: async (agentId) => {
          asked.push(agentId);
          return { items: [{ id: "r1", status: "RUNNING", git: { branches: [{ repoUrl: ORIGIN, branch: "ade/fix" }] } }] };
        },
      }),
    }));
    assert.deepEqual(asked, ["live"]);
    assert.equal(result.items[0].runStatus, "running");
    assert.equal(result.items[0].branch, "ade/fix");
  });

  it("survives an agent whose run cannot be read", async () => {
    const result = await assembleFleet(deps({
      api: api({
        listAgentsPaged: async () => [agent("a1", { status: "RUNNING" })],
        listRuns: async () => { throw new Error("cursor is down"); },
      }),
    }));
    // One thinner row, not a thrown fleet.
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].branch, null);
  });

  it("never shows a branch that landed in somebody else's repo", () => {
    const run = {
      git: {
        branches: [
          { repoUrl: "https://github.com/other/thing", branch: "their/branch" },
          { repoUrl: ORIGIN, branch: "our/branch" },
        ],
      },
    };
    assert.equal(pickBranch(run, "github.com/acme/app").branch, "our/branch");
  });
});

describe("the origin cache", () => {
  it("probes once inside its window and caches a failure too", async () => {
    let probes = 0;
    const cache = createOriginCache(async () => {
      probes += 1;
      throw new Error("no remote");
    }, 60_000);

    assert.equal(await cache.key(1_000), "");
    assert.equal(await cache.key(2_000), "");
    // A failed probe retried on every row would spawn a git process per agent.
    assert.equal(probes, 1);

    assert.equal(await cache.key(90_000), "");
    assert.equal(probes, 2);
  });
});

describe("concurrency", () => {
  it("runs at most `limit` at once and swallows one item's failure", async () => {
    let live = 0;
    let peak = 0;
    const seen = [];
    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (item) => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 1));
      live -= 1;
      if (item === 3) throw new Error("boom");
      seen.push(item);
    });
    assert.ok(peak <= 2, `peak was ${peak}`);
    assert.deepEqual(seen.sort(), [1, 2, 4, 5, 6]);
  });
});

describe("one row is one list item", () => {
  const entry = {
    agent: {
      agentId: "bc_9f2a1234567890",
      name: "Fix the flaky sync test",
      summary: "",
      archived: false,
      status: "running",
      createdAt: Date.parse("2026-08-26T10:00:00.000Z"),
      lastModified: Date.parse("2026-08-26T10:00:00.000Z"),
      repos: [ORIGIN],
      webUrl: "https://cursor.com/agents?id=bc_9f2a1234567890",
      latestRunId: "r1",
    },
    runStatus: "running",
    latestRunId: "r1",
    branch: "ade/fix-flaky-sync",
    prUrl: null,
    modelId: "composer-2",
    matchedBy: "repo",
    ownership: { sessionId: null, sessionTitle: null, laneId: "lane-7", laneName: "Sync", linearIssueId: "ADE-12" },
  };

  it("carries its whole story: badge, subtitle, mono, actions, overflow", () => {
    const row = fleetRow(entry, { now: Date.parse("2026-08-26T10:04:00.000Z") });
    assert.equal(row.title, "Fix the flaky sync test");
    assert.deepEqual(row.badge, { text: "RUNNING", tone: "accent" });
    assert.match(row.subtitle, /ade\/fix-flaky-sync/);
    assert.match(row.subtitle, /composer-2/);
    assert.match(row.subtitle, /ADE-12/);
    assert.match(row.mono, /^agent bc_9f2a1234567…/);
    assert.match(row.mono, /4m/);
    assert.equal(row.onPress.action, "openAgentDetail");
  });

  it("stays inside the vocabulary's per-row caps", () => {
    const row = fleetRow(entry);
    assert.ok(row.actions.length <= 3, "maxListItemActions is 3");
    assert.ok(row.overflow.length <= 6, "maxListItemOverflow is 6");
  });

  it("offers Stop only while the run is live", () => {
    const live = fleetRow(entry).actions.map((action) => action.action);
    assert.ok(live.includes("stopRun"));

    const finished = fleetRow({ ...entry, runStatus: "finished" }).actions.map((action) => action.action);
    assert.ok(!finished.includes("stopRun"));
  });

  it("offers Pull into lane only on a finished, unarchived agent", () => {
    const finished = fleetRow({ ...entry, runStatus: "finished" }).overflow.map((action) => action.action);
    assert.ok(finished.includes("pullIntoLane"));

    const running = fleetRow(entry).overflow.map((action) => action.action);
    assert.ok(!running.includes("pullIntoLane"));
  });

  it("asks before deleting an agent on Cursor", () => {
    const del = fleetRow(entry).overflow.find((action) => action.action === "deleteAgent");
    assert.ok(del.confirm, "a destructive row action must carry a confirm sentence");
  });

  it("carries the three filter fields a `where` compares", () => {
    const running = fleetRow(entry);
    assert.equal(running.status, "active");
    assert.equal(running.laneId, "lane-7");
    // `hide` on a LIVE agent: the control's live position is "Hide archived",
    // and its other option is the empty value that turns the clause off.
    assert.equal(running.archivedFlag, "hide");

    const archived = fleetRow({ ...entry, agent: { ...entry.agent, archived: true } });
    assert.equal(archived.archivedFlag, "archived");

    const failed = fleetRow({ ...entry, runStatus: "error" });
    assert.equal(failed.status, "failed");

    const done = fleetRow({ ...entry, runStatus: "finished" });
    assert.equal(done.status, "finished");
  });

  it("names an unlinked row's lane so a filter can still compare it", () => {
    const row = fleetRow({ ...entry, ownership: { ...entry.ownership, laneId: null } });
    assert.equal(row.laneId, "none");
  });

  it("keys rows so a group binds by prefix and sorts in order", () => {
    assert.equal(fleetRowKey("active", 0, "a1"), "active:0000:a1");
    assert.ok(fleetRowKey("active", 2, "z") > fleetRowKey("active", 1, "a"));
  });
});

describe("grouping", () => {
  function entryFor(id, over = {}) {
    return {
      agent: {
        agentId: id,
        name: id,
        summary: "",
        archived: false,
        status: over.status ?? "finished",
        createdAt: over.at ?? 1,
        lastModified: over.at ?? 1,
        repos: [ORIGIN],
        webUrl: null,
        latestRunId: null,
      },
      runStatus: over.runStatus,
      branch: over.branch ?? null,
      prUrl: null,
      modelId: null,
      matchedBy: "repo",
      ownership: { sessionId: null, sessionTitle: null, laneId: over.laneId ?? null, laneName: over.laneName ?? null, linearIssueId: null },
    };
  }

  it("puts live runs first, then lanes, then everything unlinked", () => {
    const grouped = groupFleet([
      entryFor("done", { runStatus: "finished", laneId: "lane-1", laneName: "One" }),
      entryFor("live", { runStatus: "running" }),
      entryFor("loose", { runStatus: "finished" }),
    ]);
    assert.deepEqual(grouped.active.map((entry) => entry.agent.agentId), ["live"]);
    assert.deepEqual(grouped.lanes.map((group) => group.laneId), ["lane-1"]);
    assert.equal(grouped.unlinked.length, 1);
  });

  it("orders every group newest first", () => {
    const grouped = groupFleet([
      entryFor("older", { runStatus: "running", at: 1 }),
      entryFor("newer", { runStatus: "running", at: 100 }),
    ]);
    assert.deepEqual(grouped.active.map((entry) => entry.agent.agentId), ["newer", "older"]);
  });

  it("offers only lanes that actually hold an agent, capped for the control", () => {
    const entries = Array.from({ length: 12 }, (_, i) =>
      entryFor(`a${i}`, { laneId: `lane-${i}`, laneName: `Lane ${i}` }));
    const options = laneOptions(entries);
    // Eight options on one control, one of which is "All lanes".
    assert.equal(options.length, 7);
    assert.deepEqual(options[0], { id: "lane-0", name: "Lane 0" });
  });
});

describe("display helpers", () => {
  it("has no red: a failure is amber", () => {
    assert.equal(statusTone("error"), "warning");
    assert.equal(statusTone("expired"), "warning");
    assert.equal(statusTone("finished"), "success");
    assert.equal(statusTone("running"), "accent");
    assert.equal(statusTone("archived"), "neutral");
  });

  it("says archived over whatever the run was doing", () => {
    const base = { agent: { archived: true, status: "running" }, runStatus: "running" };
    assert.equal(fleetDisplayStatus(base), "archived");
  });

  it("shows no age at all rather than a wrong one", () => {
    assert.equal(formatAge(null), null);
    assert.equal(formatAge("not a date"), null);
    assert.equal(formatAge(Date.now() + 60_000), null, "a future timestamp has no age");
    assert.equal(formatAge(Date.now() - 5_000), "just now");
  });

  it("formats a cost, and nothing when nothing was billed", () => {
    assert.equal(formatCost(184), "$1.84");
    assert.equal(formatCost(0), "$0");
    assert.equal(formatCost(null), null);
  });
});
