"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { createAutomation, integer, toolIssue } = require("../automation");
const { createData } = require("../data");
const { createFlows } = require("../flows");
const { normalizeIssue } = require("../issueFormat");
const { createApi, createSdk, issueNode } = require("./support");

function build(overrides = {}) {
  const sdk = createSdk({
    actions: {
      "lane.create": async (args) => ({ id: "lane-1", name: args.name, branchRef: args.branchName }),
      ...(overrides.actions ?? {}),
    },
    ...(overrides.sdk ?? {}),
  });
  const api = createApi(overrides.api ?? {});
  const data = createData({ sdk, api });
  const flows = createFlows({ sdk, api, data });
  return { sdk, api, data, flows, automation: createAutomation({ api, data, flows }) };
}

/** Seed the collections with two issues, the way a refresh would. */
async function seeded(overrides = {}) {
  // The api overrides are merged ON TOP of the seed, and the spread of the rest
  // comes FIRST — the other way round, `...overrides` puts the bare `api` back
  // and the seed's `searchAllIssues` is lost, which makes every test look like
  // an empty workspace.
  const built = build({
    ...overrides,
    api: {
      searchAllIssues: async () => [
        issueNode({ id: "a", identifier: "ENG-1", title: "Fix OAuth" }),
        issueNode({ id: "b", identifier: "ENG-2", title: "Add paging" }),
      ],
      ...(overrides.api ?? {}),
    },
  });
  await built.data.refreshIssues();
  return built;
}

describe("reading an argument that may have arrived as text", () => {
  it("takes a number from a schema and a string from a rule template", () => {
    // A rule's arguments come out of a template and are text; an agent tool's
    // come out of a JSON schema and are numbers.
    assert.equal(integer(3), 3);
    assert.equal(integer("3"), 3);
    assert.equal(integer("-1"), -1);
  });

  it("answers null rather than NaN for anything else", () => {
    for (const value of ["", "three", null, undefined, {}, 1.5]) assert.equal(integer(value), null, String(value));
  });
});

describe("resolving whatever the caller named", () => {
  it("finds a stored issue by id and by identifier", async () => {
    const { automation } = await seeded();
    assert.equal((await automation.resolveIssue("a")).identifier, "ENG-1");
    assert.equal((await automation.resolveIssue("ENG-2")).id, "b");
  });

  it("falls through to Linear for an issue outside the reader's filter", async () => {
    // An agent asked about an issue the reader's filter excludes must still get
    // an answer, and a rule firing on one is the normal case.
    let fetched = null;
    const { automation } = await seeded({
      api: { fetchIssueById: async (id) => { fetched = id; return issueNode({ id: "z", identifier: "ENG-9" }); } },
    });
    assert.equal((await automation.resolveIssue("ENG-9")).identifier, "ENG-9");
    assert.equal(fetched, "ENG-9");
  });

  it("throws for an issue Linear does not have either", async () => {
    const { automation } = await seeded({ api: { fetchIssueById: async () => null } });
    await assert.rejects(() => automation.resolveIssue("ENG-99"), /no issue/i);
  });

  it("throws for no argument at all", async () => {
    const { automation } = build();
    await assert.rejects(() => automation.resolveIssue(""), /Name the issue/);
  });
});

describe("the shape a tool answers with", () => {
  const projected = toolIssue(normalizeIssue(issueNode()));

  it("keeps what a model needs and drops what a renderer needs", () => {
    assert.equal(projected.state, "In Progress");
    assert.equal(projected.priority, "High");
    // `badgeTone`, `stateRank`, `title2` and `subtitle` are a renderer's, and a
    // model pays for every field it is handed.
    for (const field of ["badgeTone", "stateRank", "title2", "subtitle", "badgeText", "labelNames"]) {
      assert.ok(!(field in projected), `${field} should not reach the model`);
    }
  });

  it("keeps the branch name, because an agent opening a lane needs it", () => {
    assert.equal(projected.branchName, "eng-1-fix-the-thing");
  });

  it("flattens labels to names", () => {
    assert.deepEqual(projected.labels, ["bug"]);
  });

  it("answers null for nothing at all", () => {
    assert.equal(toolIssue(null), null);
  });
});

describe("the nine agent tools", () => {
  it("get_issue answers one issue", async () => {
    const { automation } = await seeded();
    assert.equal((await automation.getIssue({ issueId: "ENG-1" })).issue.identifier, "ENG-1");
  });

  it("search_issues goes to Linear, not to the reader's current view", async () => {
    // The collections hold the READER's filter, and an agent asking "what is
    // assigned to me in ENG" must not be answered out of somebody else's view.
    let query = null;
    const { automation } = await seeded({
      api: {
        searchAllIssues: async (sent) => {
          query = sent;
          return [issueNode({ id: "z", identifier: "ENG-9" })];
        },
      },
    });
    const result = await automation.searchIssues({ query: "oauth", teamKey: "eng", priority: "2" });
    assert.equal(result.count, 1);
    assert.equal(query.query, "oauth");
    assert.equal(query.teamKey, "ENG");
    assert.equal(query.priority, 2);
  });

  it("search_issues clamps the limit to the tool ceiling", async () => {
    let limit = null;
    const { automation } = build({ api: { searchAllIssues: async (_, cap) => { limit = cap; return []; } } });
    await automation.searchIssues({ limit: 5_000 });
    assert.equal(limit, 100);
    await automation.searchIssues({ limit: 0 });
    assert.equal(limit, 1);
  });

  it("add_comment posts the body and refreshes the thread", async () => {
    const posted = [];
    let threadRead = 0;
    const { automation } = await seeded({
      api: {
        createComment: async (...args) => { posted.push(args); return "c1"; },
        fetchIssueComments: async () => { threadRead += 1; return []; },
      },
    });
    const result = await automation.addComment({ issueId: "ENG-1", body: "done" });
    assert.deepEqual(posted, [["a", "done"]]);
    assert.equal(result.commentId, "c1");
    assert.equal(threadRead, 1);
  });

  it("add_comment refuses an empty body", async () => {
    const { automation } = await seeded();
    await assert.rejects(() => automation.addComment({ issueId: "ENG-1", body: "  " }), /needs a body/);
  });

  it("update_issue_state takes an ID and says so when given none", async () => {
    // Two teams can both have a "Done" whose ids differ, so a name would be
    // ambiguous exactly where it mattered.
    const { automation } = await seeded();
    await assert.rejects(() => automation.updateIssueState({ issueId: "ENG-1" }), /list_states/);
  });

  it("update_issue_state moves the issue and answers the new row", async () => {
    const moves = [];
    const { automation } = await seeded({
      api: {
        updateIssueState: async (...args) => moves.push(args),
        fetchIssueById: async () => issueNode({ id: "a", identifier: "ENG-1", state: { id: "s9", name: "Done", type: "completed" } }),
      },
    });
    const result = await automation.updateIssueState({ issueId: "ENG-1", stateId: "s9" });
    assert.deepEqual(moves, [["a", "s9"]]);
    assert.equal(result.issue.state, "Done");
  });

  it("list_states fetches the catalog when the team has never been browsed", async () => {
    let fetched = 0;
    const { automation } = build({
      api: {
        listTeamsAndStates: async () => {
          fetched += 1;
          return [{ id: "t", key: "ENG", name: "Eng", states: { nodes: [{ id: "s1", name: "Todo", type: "unstarted" }] } }];
        },
      },
    });
    const result = await automation.listStates({ teamKey: "eng" });
    assert.equal(fetched, 1);
    assert.deepEqual(result.states, [{ id: "s1", name: "Todo", type: "unstarted", team: "ENG" }]);
  });

  it("assign_issue clears the assignee when given none", async () => {
    const calls = [];
    const { automation } = await seeded({
      api: {
        updateIssueAssignee: async (...args) => calls.push(args),
        fetchIssueById: async () => issueNode({ id: "a", assignee: null }),
      },
    });
    const result = await automation.assignIssue({ issueId: "ENG-1" });
    assert.deepEqual(calls, [["a", null]]);
    assert.equal(result.cleared, true);
  });

  it("add_label resolves within the issue's own team", async () => {
    const calls = [];
    const { automation } = await seeded({ api: { addLabel: async (...args) => { calls.push(args); return "l9"; } } });
    await automation.addLabel({ issueId: "ENG-1", labelName: "p1" });
    assert.deepEqual(calls, [["a", "p1", "ENG"]]);
  });

  it("create_lane_for_issue THROWS when the lane could not be made", async () => {
    // A tool that answered `{ok:false}` would be reported to the user as done.
    const { automation } = await seeded({ actions: { "lane.create": async () => { throw new Error("dirty"); } } });
    await assert.rejects(() => automation.createLaneForIssue({ issueId: "ENG-1" }), /dirty/);
  });

  it("create_lane_for_issue answers the branch Linear expects", async () => {
    const { automation } = await seeded();
    const result = await automation.createLaneForIssue({ issueId: "ENG-1" });
    assert.equal(result.branchName, "eng-1-fix-oauth");
    assert.equal(result.laneId, "lane-1");
  });

  it("graphql passes an operation straight through", async () => {
    let sent = null;
    const { automation } = build({ api: { request: async (query, variables) => { sent = [query, variables]; return { ok: 1 }; } } });
    const result = await automation.graphql({ query: "{ viewer { id } }", variables: { a: 1 } });
    assert.deepEqual(result.data, { ok: 1 });
    assert.deepEqual(sent, ["{ viewer { id } }", { a: 1 }]);
  });

  it("graphql refuses an empty operation", async () => {
    const { automation } = build();
    await assert.rejects(() => automation.graphql({}), /operation is required/);
  });
});

describe("the same verbs as automation steps", () => {
  it("answer a sentence rather than throwing, because a rule reports", async () => {
    const { automation } = await seeded({
      api: {
        updateIssueState: async () => {},
        fetchIssueById: async () => issueNode({ id: "a", identifier: "ENG-1", state: { id: "s9", name: "Done", type: "completed" } }),
      },
    });
    const result = await automation.steps.setIssueState({ issueId: "ENG-1", stateId: "s9" });
    assert.equal(result.ok, true);
    assert.equal(result.message, "Moved ENG-1 to Done.");
  });

  it("turn a throw into a sentence a run log can print", async () => {
    // An exception would be a stack trace in a place nobody debugs.
    const { automation } = await seeded({ api: { updateIssueState: async () => { throw new Error("Linear refused"); } } });
    const result = await automation.steps.setIssueState({ issueId: "ENG-1", stateId: "s9" });
    assert.equal(result.ok, false);
    assert.equal(result.message, "Linear refused");
  });

  it("report a comment by the issue it landed on", async () => {
    const { automation } = await seeded();
    assert.equal((await automation.steps.commentOnIssue({ issueId: "ENG-1", body: "x" })).message, "Commented on ENG-1.");
  });

  it("word an assignment differently from a clearing", async () => {
    const { automation } = await seeded({ api: { fetchIssueById: async () => issueNode({ id: "a", assignee: null }) } });
    assert.match((await automation.steps.assignIssue({ issueId: "ENG-1" })).message, /Cleared the assignee/);
  });

  // No setting gates it any more. The two issue-transition toggles are gone
  // and each is an automation the reader writes, so the step reports what it
  // did rather than pointing at a checkbox that no longer exists.
  it("report what they moved rather than naming a setting", async () => {
    const { automation } = await seeded();
    const result = await automation.steps.closeIssueOnMerge({ laneId: "lane-1" });
    assert.equal(result.ok, true);
    assert.match(result.message, /Moved \d+ issues? to Done\./);
  });

  it("move a lane's issues to In Progress on the launch template's step", async () => {
    const { automation } = await seeded({ sdk: { lanes: [] } });
    const result = await automation.steps.startIssueOnLane({ laneId: "lane-1" });
    assert.equal(result.ok, true);
    assert.match(result.message, /Moved 0 issues to In Progress\./);
  });

  it("take one lane id or a list of them", async () => {
    const { automation } = await seeded({ sdk: { lanes: [] } });
    assert.match((await automation.steps.closeIssueOnMerge({ laneId: "lane-1" })).message, /Moved 0 issues/);
    assert.match((await automation.steps.closeIssueOnMerge({ laneIds: ["a", "b"] })).message, /Moved 0 issues/);
    assert.match((await automation.steps.closeIssueOnMerge({})).message, /Moved 0 issues/);
  });
});

describe("universal search", () => {
  it("answers from the stored rows, with no round trip", async () => {
    // The palette is a keystroke-latency surface; a round trip per keystroke
    // makes it feel broken.
    let hits = 0;
    const { automation } = await seeded({ api: { searchAllIssues: async () => { hits += 1; return []; } } });
    const before = hits;
    await automation.searchProvider({ query: "oauth" });
    assert.equal(hits, before);
  });

  it("matches an issue key and a title", async () => {
    const { automation } = await seeded();
    assert.deepEqual((await automation.searchProvider({ query: "eng-2" })).results.map((r) => r.id), ["b"]);
    assert.deepEqual((await automation.searchProvider({ query: "paging" })).results.map((r) => r.id), ["b"]);
  });

  it("names the action a row press dispatches", async () => {
    const { automation } = await seeded();
    const row = (await automation.searchProvider({ query: "oauth" })).results[0];
    assert.equal(row.action, "openIssue");
    assert.deepEqual(row.args, { issueId: "a" });
    assert.equal(row.title, "ENG-1 Fix OAuth");
  });

  it("answers nothing for an empty query rather than everything", async () => {
    const { automation } = await seeded();
    assert.deepEqual((await automation.searchProvider({ query: "   " })).results, []);
    assert.deepEqual((await automation.searchProvider({})).results, []);
  });

  it("caps what it shows the palette", async () => {
    const many = Array.from({ length: 30 }, (_, index) => issueNode({ id: `i${index}`, identifier: `ENG-${index}` }));
    const { automation } = await seeded({ api: { searchAllIssues: async () => many } });
    assert.equal((await automation.searchProvider({ query: "eng" })).results.length, 8);
  });
});
