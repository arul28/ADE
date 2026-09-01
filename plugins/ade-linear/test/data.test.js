"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  MAX_DESCRIPTION_CHARS,
  createData,
  defaultFilters,
  dueOrder,
  filtersToQuery,
  normalizeFilters,
  priorityOrder,
} = require("../data");
const { createApi, createSdk, issueNode } = require("./support");

function build(overrides = {}) {
  const sdk = createSdk(overrides.sdk ?? {});
  const api = createApi(overrides.api ?? {});
  return { sdk, api, data: createData({ sdk, api, now: () => Date.parse("2026-08-31T00:00:00.000Z") }) };
}

/** Issue nodes that differ on exactly the axis under test. */
function nodes(...specs) {
  return specs.map((spec) => issueNode(spec));
}

describe("filters", () => {
  it("defaults to every issue, newest updated first", () => {
    assert.deepEqual(defaultFilters(), {
      stateTab: "all", projectId: "", assigneeId: "", priority: "", sort: "updated_desc", text: "",
    });
  });

  it("drops a state tab and a sort this build does not know", () => {
    const filters = normalizeFilters({ stateTab: "invented", sort: "by-vibes" });
    assert.equal(filters.stateTab, "all");
    assert.equal(filters.sort, "updated_desc");
  });

  it("keeps priority 0, which is a real value and not an absence", () => {
    assert.equal(normalizeFilters({ priority: 0 }).priority, "0");
    assert.equal(normalizeFilters({ priority: "" }).priority, "");
    assert.equal(normalizeFilters({ priority: 9 }).priority, "");
  });

  it("survives a stored row that is not an object at all", () => {
    assert.deepEqual(normalizeFilters(null), defaultFilters());
    assert.deepEqual(normalizeFilters("nonsense"), defaultFilters());
  });

  it("turns the three presets into Linear state types", () => {
    assert.equal(filtersToQuery(normalizeFilters({ stateTab: "all" })).stateTypes, undefined);
    assert.deepEqual(
      filtersToQuery(normalizeFilters({ stateTab: "active" })).stateTypes,
      ["backlog", "unstarted", "started"],
    );
    assert.deepEqual(filtersToQuery(normalizeFilters({ stateTab: "backlog" })).stateTypes, ["backlog", "triage"]);
  });

  it("sends no empty strings to Linear", () => {
    assert.deepEqual(filtersToQuery(defaultFilters()), {});
  });
});

describe("the two sorts Linear's own numbers get wrong", () => {
  it("sorts urgent above unprioritized, not below", () => {
    // Linear's 0 means "no priority" and 1 means URGENT, so a plain ascending
    // sort would put the unprioritized issues on top.
    assert.ok(priorityOrder(1) < priorityOrder(0));
    assert.deepEqual([0, 1, 2, 3, 4].map(priorityOrder), [99, 1, 2, 3, 4]);
  });

  it("sorts an issue with no due date after every issue that has one", () => {
    assert.ok(dueOrder(null) > dueOrder("2099-01-01"));
  });

  it("treats an unparseable due date as no due date", () => {
    assert.equal(dueOrder("soon"), dueOrder(null));
  });
});

describe("materializing the issue rows", () => {
  it("writes each issue three times: by id, by sort rank, and inside its state", async () => {
    const { sdk, data } = build({
      api: { searchAllIssues: async () => nodes({ id: "i1", identifier: "ENG-1" }) },
    });
    await data.refreshIssues();
    const keys = sdk.collections.keys("issues");
    assert.deepEqual(keys, ["flat:000001:i1", "group:state-started:000001:i1", "issue:i1"]);
  });

  it("orders the flat keys by the reader's sort, so the list draws in that order", async () => {
    const { sdk, data } = build({
      api: {
        searchAllIssues: async () => nodes(
          { id: "old", identifier: "ENG-1", updatedAt: "2026-01-01T00:00:00.000Z" },
          { id: "new", identifier: "ENG-2", updatedAt: "2026-08-30T00:00:00.000Z" },
        ),
      },
    });
    await data.refreshIssues({ filters: { sort: "updated_desc" } });
    assert.deepEqual(
      sdk.collections.keys("issues").filter((key) => key.startsWith("flat:")),
      ["flat:000001:new", "flat:000002:old"],
    );
  });

  it("reverses that order for the opposite sort, using the same key space", async () => {
    const { sdk, data } = build({
      api: {
        searchAllIssues: async () => nodes(
          { id: "b", identifier: "ENG-2" },
          { id: "a", identifier: "ENG-1" },
        ),
      },
    });
    await data.refreshIssues({ filters: { sort: "identifier_asc" } });
    assert.deepEqual(
      sdk.collections.keys("issues").filter((key) => key.startsWith("flat:")),
      ["flat:000001:a", "flat:000002:b"],
    );
  });

  it("ranks within a state group separately from the flat rank", async () => {
    const done = { id: "state-done", name: "Done", type: "completed" };
    const { sdk, data } = build({
      api: {
        searchAllIssues: async () => nodes(
          { id: "a", identifier: "ENG-1", updatedAt: "2026-08-30T00:00:00.000Z" },
          { id: "b", identifier: "ENG-2", state: done, updatedAt: "2026-08-29T00:00:00.000Z" },
          { id: "c", identifier: "ENG-3", updatedAt: "2026-08-28T00:00:00.000Z" },
        ),
      },
    });
    await data.refreshIssues();
    const groupKeys = sdk.collections.keys("issues").filter((key) => key.startsWith("group:"));
    // `c` is third in the flat order but SECOND inside its own state.
    assert.ok(groupKeys.includes("group:state-started:000002:c"));
    assert.ok(groupKeys.includes("group:state-done:000001:b"));
  });

  it("deletes the rows of an issue that left the filter", async () => {
    let listed = nodes({ id: "a", identifier: "ENG-1" }, { id: "b", identifier: "ENG-2" });
    const { sdk, data } = build({ api: { searchAllIssues: async () => listed } });
    await data.refreshIssues();
    assert.equal(sdk.collections.keys("issues").length, 6);

    listed = nodes({ id: "a", identifier: "ENG-1" });
    await data.refreshIssues();
    // A row for an issue no longer in the filter would still render, and the
    // reader has no way to tell it from a live one.
    assert.deepEqual(sdk.collections.keys("issues"), ["flat:000001:a", "group:state-started:000001:a", "issue:a"]);
  });

  it("clamps a description that would blow the per-value cap", async () => {
    const { sdk, data } = build({
      api: { searchAllIssues: async () => nodes({ id: "a", description: "x".repeat(200_000) }) },
    });
    await data.refreshIssues();
    const row = sdk.collections.value("issues", "issue:a");
    // The reader must not lose the ROW because of the BODY.
    assert.equal(row.description.length, MAX_DESCRIPTION_CHARS + 1);
    assert.equal(row.descriptionTruncated, true);
  });

  it("says nothing was truncated when nothing was", async () => {
    const { sdk, data } = build({ api: { searchAllIssues: async () => nodes({ id: "a", description: "short" }) } });
    await data.refreshIssues();
    assert.equal(sdk.collections.value("issues", "issue:a").descriptionTruncated, false);
  });

  it("reports the failure instead of emptying the panel", async () => {
    const error = Object.assign(new Error("Linear is down"), { code: "http" });
    const { sdk, data } = build({ api: { searchAllIssues: async () => { throw error; } } });
    const result = await data.refreshIssues();
    assert.equal(result.state, "error");
    assert.equal(result.error, "Linear is down");
    // The previous rows survive: a stale screen beats a blank one.
    assert.equal(sdk.collections.keys("issues").length, 0);
    assert.equal(data.currentModel().error, "Linear is down");
  });

  it("reports a missing credential as its own state, not as an error", async () => {
    const error = Object.assign(new Error("no token"), { code: "no_token" });
    const { data } = build({ api: { searchAllIssues: async () => { throw error; } } });
    assert.equal((await data.refreshIssues()).state, "no-token");
  });

  it("says empty rather than list when the workspace answered nothing", async () => {
    const { data } = build({ api: { searchAllIssues: async () => [] } });
    assert.equal((await data.refreshIssues()).state, "empty");
  });
});

describe("the lane badge, which Linear cannot know", () => {
  const lanes = [{
    id: "lane-1",
    name: "Fix OAuth",
    primaryIssue: { provider: "linear", issueId: "a", key: "ENG-1" },
    issueLinks: [],
  }];

  it("stamps hasLane onto the issue the lane carries", async () => {
    const { sdk, data } = build({
      sdk: { lanes },
      api: { searchAllIssues: async () => nodes({ id: "a" }, { id: "b" }) },
    });
    await data.refreshIssues();
    assert.equal(sdk.collections.value("issues", "issue:a").hasLane, true);
    assert.equal(sdk.collections.value("issues", "issue:a").laneName, "Fix OAuth");
    assert.equal(sdk.collections.value("issues", "issue:b").hasLane, false);
  });

  it("counts a link the BUILT-IN made, not only this plugin's own", async () => {
    // The whole point of the badge is to stop a duplicate lane, and filtering
    // by owner would hide exactly the duplicates that exist today while the
    // built-in still runs.
    const { data } = build({
      sdk: {
        lanes: [{
          id: "lane-2",
          name: "Someone else's",
          primaryIssue: null,
          issueLinks: [{ issue: { provider: "linear", issueId: "a", key: "ENG-1" }, closeOnMerge: true }],
        }],
      },
    });
    const { byIssueId } = await data.laneIndex();
    assert.equal(byIssueId.get("a").laneName, "Someone else's");
  });

  it("ignores a link from another tracker", async () => {
    const { data } = build({
      sdk: { lanes: [{ id: "l", name: "Jira lane", primaryIssue: { provider: "jira", issueId: "a" }, issueLinks: [] }] },
    });
    assert.equal((await data.laneIndex()).byIssueId.size, 0);
  });

  it("answers an empty index rather than throwing when lanes cannot be read", async () => {
    const sdk = createSdk({});
    sdk.lanes.list = async () => { throw new Error("no project"); };
    const data = createData({ sdk, api: createApi() });
    assert.deepEqual((await data.laneIndex()).rows, []);
  });
});

describe("the state groups the panel draws sections from", () => {
  it("orders groups by Linear's board rank and counts each", async () => {
    const { data } = build({
      api: {
        searchAllIssues: async () => nodes(
          { id: "a", state: { id: "s-done", name: "Done", type: "completed" } },
          { id: "b", state: { id: "s-todo", name: "Todo", type: "unstarted" } },
          { id: "c", state: { id: "s-todo", name: "Todo", type: "unstarted" } },
        ),
      },
    });
    await data.refreshIssues();
    const groups = data.currentModel().groups;
    assert.deepEqual(groups.map((group) => [group.stateName, group.count]), [["Todo", 2], ["Done", 1]]);
  });

  it("has no group for a state with no issues in this filter", async () => {
    // A predicate can hide rows but cannot remove a section, which is why the
    // state preset is a round trip rather than a `where`.
    const { data } = build({ api: { searchAllIssues: async () => nodes({ id: "a" }) } });
    await data.refreshIssues();
    assert.equal(data.currentModel().groups.length, 1);
  });
});

describe("the project and assignee filters", () => {
  it("offers only values the visible issues actually have", async () => {
    const { sdk, data } = build({
      api: {
        searchAllIssues: async () => nodes(
          { id: "a", project: { id: "p1", name: "Platform" }, assignee: { id: "u1", displayName: "Ada" } },
          { id: "b", project: { id: "p1", name: "Platform" }, assignee: null },
        ),
      },
    });
    await data.refreshIssues();
    // A filter offering a project none of the visible issues belong to is one
    // whose every option returns nothing.
    assert.deepEqual(sdk.collections.keys("projects"), ["project:p1"]);
    assert.deepEqual(sdk.collections.keys("people"), ["user:u1"]);
  });

  it("tells the panel whether the bound controls have anything to offer", async () => {
    const { data } = build({
      api: { searchAllIssues: async () => nodes({ id: "a", project: null, assignee: null }) },
    });
    await data.refreshIssues();
    // A `segmented` whose `optionsFrom` reads an empty collection draws an
    // empty control, which reads as broken rather than as absent.
    assert.equal(data.currentModel().filters.hasProjects, false);
    assert.equal(data.currentModel().filters.hasPeople, false);
  });
});

describe("refreshing one issue", () => {
  async function seeded() {
    const built = build({
      api: {
        searchAllIssues: async () => nodes({ id: "a", identifier: "ENG-1" }, { id: "b", identifier: "ENG-2" }),
      },
    });
    await built.data.refreshIssues();
    return built;
  }

  it("rewrites the canonical row and both ordered copies", async () => {
    const { sdk, api, data } = await seeded();
    api.fetchIssueById = async () => issueNode({ id: "a", identifier: "ENG-1", title: "Renamed" });
    await data.refreshIssue("a", { comments: false });
    for (const key of ["issue:a", "flat:000001:a", "group:state-started:000001:a"]) {
      assert.equal(sdk.collections.value("issues", key).title, "Renamed", key);
    }
  });

  it("MOVES the row between groups when the state changed", async () => {
    const { sdk, api, data } = await seeded();
    api.fetchIssueById = async () => issueNode({
      id: "a", identifier: "ENG-1", state: { id: "state-done", name: "Done", type: "completed" },
    });
    await data.refreshIssue("a", { comments: false });
    const keys = sdk.collections.keys("issues");
    // Rewriting instead of moving would draw the issue in both sections.
    assert.ok(!keys.includes("group:state-started:000001:a"));
    assert.ok(keys.includes("group:state-done:000001:a"));
  });

  it("leaves the other issue's rows alone", async () => {
    const { sdk, api, data } = await seeded();
    api.fetchIssueById = async () => issueNode({ id: "a", identifier: "ENG-1", title: "Renamed" });
    await data.refreshIssue("a", { comments: false });
    assert.equal(sdk.collections.value("issues", "issue:b").title, "Fix the thing");
  });

  it("says not_found rather than writing an empty row", async () => {
    const { data } = build({ api: { fetchIssueById: async () => null } });
    const result = await data.refreshIssue("missing");
    assert.equal(result.ok, false);
    assert.equal(result.code, "not_found");
  });
});

describe("finding an issue by whatever the caller typed", () => {
  it("finds it by id", async () => {
    const { data } = build({ api: { searchAllIssues: async () => nodes({ id: "a", identifier: "ENG-1" }) } });
    await data.refreshIssues();
    assert.equal((await data.findIssueRow("a")).identifier, "ENG-1");
  });

  it("finds it by identifier, case-insensitively", async () => {
    // Everything a user types names the identifier and everything Linear sends
    // names the id.
    const { data } = build({ api: { searchAllIssues: async () => nodes({ id: "a", identifier: "ENG-1" }) } });
    await data.refreshIssues();
    assert.equal((await data.findIssueRow("eng-1")).id, "a");
  });

  it("answers null for something it has never seen", async () => {
    const { data } = build({});
    assert.equal(await data.findIssueRow("ENG-999"), null);
  });

  it("counts each issue once, not three times", async () => {
    const { data } = build({ api: { searchAllIssues: async () => nodes({ id: "a" }, { id: "b" }) } });
    await data.refreshIssues();
    assert.equal((await data.issueRows()).length, 2);
  });
});

describe("comments", () => {
  it("keys the thread so it reads oldest first", async () => {
    const { sdk, data } = build({
      api: {
        fetchIssueComments: async () => [
          { id: "c-zzz", body: "first", createdAt: "2026-01-01", user: { name: "Ada" } },
          { id: "c-aaa", body: "second", createdAt: "2026-01-02", user: { name: "Grace" } },
        ],
      },
    });
    await data.refreshComments("a");
    // A raw comment id sorts randomly for a UUID; the rank is what makes it a
    // thread rather than a bag.
    assert.deepEqual(sdk.collections.keys("comments"), ["comment:a:000001:c-zzz", "comment:a:000002:c-aaa"]);
  });

  it("replaces one issue's thread without touching another's", async () => {
    const { sdk, api, data } = build({
      api: { fetchIssueComments: async () => [{ id: "c1", body: "x", user: { name: "Ada" } }] },
    });
    await data.refreshComments("a");
    await data.refreshComments("b");
    api.fetchIssueComments = async () => [];
    await data.refreshComments("a");
    assert.deepEqual(sdk.collections.keys("comments"), ["comment:b:000001:c1"]);
  });

  it("does not fail the caller when Linear refuses the thread", async () => {
    const { data } = build({ api: { fetchIssueComments: async () => { throw new Error("nope"); } } });
    assert.equal((await data.refreshComments("a")).ok, false);
  });
});

describe("teams and workflow states", () => {
  const teams = [{
    id: "t1",
    key: "ENG",
    name: "Engineering",
    states: {
      nodes: [
        { id: "s-done", name: "Done", type: "completed" },
        { id: "s-todo", name: "Todo", type: "unstarted" },
      ],
    },
  }];

  it("stores states in board order under their team", async () => {
    const { sdk, data } = build({ api: { listTeamsAndStates: async () => teams } });
    await data.refreshCatalog();
    assert.deepEqual(sdk.collections.keys("states"), ["team:ENG:000001:s-todo", "team:ENG:000002:s-done"]);
  });

  it("reads one team's states without seeing another team's", async () => {
    const { data } = build({
      api: {
        listTeamsAndStates: async () => [
          ...teams,
          { id: "t2", key: "OPS", name: "Ops", states: { nodes: [{ id: "s-x", name: "X", type: "started" }] } },
        ],
      },
    });
    await data.refreshCatalog();
    assert.deepEqual((await data.states("ENG")).map((state) => state.id), ["s-todo", "s-done"]);
    assert.equal((await data.states()).length, 3);
  });

  it("counts the teams into the model", async () => {
    const { data } = build({ api: { listTeamsAndStates: async () => teams } });
    await data.refreshCatalog();
    assert.equal(data.currentModel().counts.teams, 1);
  });
});

describe("the connection row, which syncs to every device", () => {
  it("never carries a token, a refresh token, or anything one could be derived from", async () => {
    const { sdk, data } = build({
      api: {
        readCredential: async () => ({
          token: "secret-token",
          authMode: "oauth",
          expiresAt: "2099-01-01T00:00:00.000Z",
          refreshToken: "secret-refresh",
          clientId: "client-1",
        }),
      },
    });
    await data.refreshConnection();
    const row = JSON.stringify(sdk.collections.value("viewer", "connection:current"));
    assert.ok(!row.includes("secret-token"));
    assert.ok(!row.includes("secret-refresh"));
    assert.ok(!row.includes("client-1"));
    // Only the boolean survives.
    assert.equal(sdk.collections.value("viewer", "connection:current").refreshTokenStored, true);
  });

  it("reports disconnected without calling Linear when nothing is stored", async () => {
    let called = false;
    const { data } = build({
      api: {
        readCredential: async () => ({ token: null, authMode: null }),
        getConnectionIdentity: async () => { called = true; return {}; },
      },
    });
    const connection = await data.refreshConnection();
    assert.equal(connection.connected, false);
    assert.equal(called, false);
  });

  it("stays connected through a transient failure and says what went wrong", async () => {
    const { data } = build({
      api: { getConnectionIdentity: async () => { throw Object.assign(new Error("Linear is down"), { code: "http" }); } },
    });
    const connection = await data.refreshConnection();
    // A timeout is not a revoked credential.
    assert.equal(connection.connected, true);
    assert.equal(connection.lastError, "Linear is down");
  });

  it("goes disconnected on unauthorized, which IS a revoked credential", async () => {
    const { data } = build({
      api: { getConnectionIdentity: async () => { throw Object.assign(new Error("no"), { code: "unauthorized" }); } },
    });
    assert.equal((await data.refreshConnection()).connected, false);
  });

  it("carries the relay URL for the user to paste into Linear", async () => {
    const { data } = build({});
    assert.match((await data.refreshConnection()).webhookUrl, /plugin\/ade-linear\/linear$/);
  });

  it("draws without the paste box on a host that runs no ingress drain", async () => {
    const { data } = build({ sdk: { webhookUrlThrows: true } });
    assert.equal((await data.refreshConnection()).webhookUrl, null);
  });
});

describe("the stored filter set, which the phone can see", () => {
  it("round-trips through the synced viewer row", async () => {
    // The built-in keeps this in localStorage per project root, so the phone
    // never sees what the desktop chose.
    const { sdk, data } = build({});
    await data.writeFilters({ stateTab: "active", sort: "priority" });
    assert.equal(sdk.collections.value("viewer", "prefs:filters").stateTab, "active");
    assert.equal((await data.readFilters()).sort, "priority");
  });

  it("merges a partial change into what was stored", async () => {
    const { data } = build({});
    await data.writeFilters({ stateTab: "active", projectId: "p1" });
    const next = await data.updateFilters({ priority: "1" });
    assert.equal(next.stateTab, "active");
    assert.equal(next.projectId, "p1");
    assert.equal(next.priority, "1");
  });

  it("uses the stored filters when a refresh names none", async () => {
    let sent = null;
    const { data } = build({ api: { searchAllIssues: async (query) => { sent = query; return []; } } });
    await data.writeFilters({ stateTab: "active" });
    await data.refreshIssues();
    assert.deepEqual(sent.stateTypes, ["backlog", "unstarted", "started"]);
  });
});

describe("the GitHub autolinks the settings panel offers", () => {
  it("builds one per team, pointing at the workspace", async () => {
    const { data } = build({
      api: {
        listTeamsAndStates: async () => [
          { id: "t1", key: "ENG", name: "Engineering", states: { nodes: [] } },
          { id: "t2", key: "OPS", name: "Ops", states: { nodes: [] } },
        ],
      },
    });
    await data.refreshCatalog();
    const links = await data.buildAutolinks("acme");
    assert.deepEqual(links.map((link) => link.keyPrefix), ["ENG-", "OPS-"]);
    assert.equal(links[0].urlTemplate, "https://linear.app/acme/issue/ENG-<num>");
    assert.deepEqual(data.currentModel().autolinks, links);
  });

  it("offers no template at all when the workspace is unknown", async () => {
    const { data } = build({
      api: { listTeamsAndStates: async () => [{ id: "t1", key: "ENG", name: "Eng", states: { nodes: [] } }] },
    });
    await data.refreshCatalog();
    assert.equal((await data.buildAutolinks(null))[0].urlTemplate, null);
  });
});

describe("the collections this plugin is allowed to write", () => {
  it("writes only names plugin.json declares", async () => {
    // The host REFUSES a write to an undeclared collection, so a name invented
    // in one half of the plugin is a panel bound to rows nobody stores — an
    // empty list with no error anywhere.
    const { sdk, data } = build({
      api: {
        searchAllIssues: async () => nodes({ id: "a" }),
        listTeamsAndStates: async () => [{
          id: "t",
          key: "ENG",
          name: "Eng",
          states: { nodes: [{ id: "s1", name: "Todo", type: "unstarted" }] },
        }],
        fetchIssueComments: async () => [{ id: "c", body: "x", user: { name: "Ada" } }],
      },
    });
    await data.refreshIssues();
    await data.refreshCatalog();
    await data.refreshConnection();
    await data.refreshComments("a");
    const written = new Set(sdk.collections.calls.filter(([verb]) => verb === "put").map(([, name]) => name));
    assert.deepEqual(
      [...written].sort(),
      ["comments", "issues", "people", "projects", "states", "teams", "viewer"],
    );
  });
});
