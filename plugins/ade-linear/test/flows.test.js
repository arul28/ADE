"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  contextFileContent,
  createFlows,
  defaultKickoff,
  parseGithubRemote,
  pickCompletedStateId,
  pickStartedStateId,
  sessionSetupFor,
} = require("../flows");
const { createData } = require("../data");
const { normalizeIssue } = require("../issueFormat");
const { createApi, createSdk, issueNode } = require("./support");

const ROW = normalizeIssue(issueNode({ id: "a", identifier: "ENG-431", title: "Fix OAuth refresh" }));

/**
 * The env key pattern the host enforces
 * (`sessionSetup.ts:PLUGIN_SESSION_ENV_KEY_PATTERN`). Repeated here because a
 * key that fails it is refused at the host with `invalid_args`, and the launch
 * that carried it fails as a whole.
 */
const ENV_KEY_PATTERN = /^ADE_PLUGIN_[A-Z0-9_]{1,64}$/u;

/** Names the host owns inside that prefix. A plugin setting one is refused. */
const RESERVED_ENV_KEYS = [
  "ADE_PLUGIN_CONTEXT_FILE",
  "ADE_PLUGIN_SOURCE_ID",
  "ADE_PLUGIN_CHILD_BOOTSTRAP_PATH",
  "ADE_PLUGIN_ID",
  "ADE_PLUGIN_INSTALL_PINGS",
  "ADE_PLUGIN_REGISTRY_URL",
  "ADE_PLUGIN_RELAY_API_BASE_URL",
  "ADE_PLUGIN_ROOT",
];

function build(overrides = {}) {
  const sdk = createSdk({
    actions: {
      "lane.create": async (args) => ({ id: "lane-1", name: args.name, branchRef: args.branchName }),
      "chat.createSession": async () => ({ sessionId: "chat-1" }),
      "chat.launchCli": async () => ({ sessionId: "cli-1" }),
      "pr.getDetail": async ({ prId }) => ({ pr: { id: prId, state: "open", laneId: "lane-1" } }),
      "git.getOriginRemote": async () => "https://github.com/acme/app.git",
      "github.createRepoAutolink": async () => ({ ok: true }),
      ...(overrides.actions ?? {}),
    },
    ...(overrides.sdk ?? {}),
  });
  const api = createApi(overrides.api ?? {});
  const data = createData({ sdk, api });
  const flows = createFlows({ sdk, api, data, now: () => Date.parse("2026-08-31T00:00:00.000Z") });
  return { sdk, api, data, flows };
}

describe("opening a lane on an issue", () => {
  it("names the branch what Linear expects, not what ADE would choose", async () => {
    // Linear matches a branch to an issue BY NAME. A lane whose branch ADE
    // named its own way silently breaks Linear's branch linking, and nothing
    // reports it.
    const { sdk, flows } = build();
    const result = await flows.createLaneFromIssue({ issue: ROW });
    const create = sdk.calls.find(([name]) => name === "actions.lane.create")[1];
    assert.equal(create.branchName, "eng-431-fix-oauth-refresh");
    assert.equal(create.name, "ENG-431 Fix OAuth refresh");
    assert.equal(result.ok, true);
  });

  it("links the issue as a SECOND step, so the link is this plugin's own", async () => {
    // `lane.create` takes a `linearIssue` field and the built-in fills it. A
    // link made that way carries no plugin id, so `unlinkIssue` would refuse to
    // remove it.
    const { sdk, flows } = build();
    await flows.createLaneFromIssue({ issue: ROW });
    const link = sdk.calls.find(([name]) => name === "lanes.linkIssue")[1];
    assert.equal(link.laneId, "lane-1");
    assert.equal(link.issue.provider, "linear");
    assert.ok(!("pluginId" in link.issue));
    assert.equal(link.role, "primary");
    assert.equal(link.includeInPr, true);
    assert.equal(link.closeOnMerge, true);
  });

  it("keeps the lane when only the link failed, and says so", async () => {
    // Reporting failure would send the reader looking for a lane that is
    // already there.
    const { flows } = build({ sdk: { linkIssueThrows: true } });
    const result = await flows.createLaneFromIssue({ issue: ROW });
    assert.equal(result.ok, true);
    assert.equal(result.linked, false);
    assert.match(result.message, /could not link/i);
  });

  it("fails when ADE refused to make the lane at all", async () => {
    const { flows } = build({ actions: { "lane.create": async () => { throw new Error("dirty worktree"); } } });
    const result = await flows.createLaneFromIssue({ issue: ROW });
    assert.equal(result.ok, false);
    assert.equal(result.message, "dirty worktree");
  });

  it("fails when ADE made something with no id rather than reporting success", async () => {
    const { flows } = build({ actions: { "lane.create": async () => ({}) } });
    assert.equal((await flows.createLaneFromIssue({ issue: ROW })).ok, false);
  });

  it("passes a base ref through when the caller named one", async () => {
    const { sdk, flows } = build();
    await flows.createLaneFromIssue({ issue: ROW, baseRef: "release/2.1" });
    assert.equal(sdk.calls.find(([name]) => name === "actions.lane.create")[1].baseBranch, "release/2.1");
  });

  it("refuses an issue this project has never listed", async () => {
    const { flows } = build();
    const result = await flows.createLaneFromIssue({ issueId: "ENG-999" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "not_found");
  });
});

describe("attaching an issue to a lane that already exists", () => {
  it("links without creating anything", async () => {
    const { sdk, flows } = build();
    const result = await flows.linkIssueToLane({ issue: ROW, laneId: "lane-9" });
    assert.equal(result.ok, true);
    assert.equal(sdk.calls.some(([name]) => name === "actions.lane.create"), false);
  });

  it("defaults to a referenced link that does NOT close on merge", async () => {
    // Attaching is weaker than opening a lane on the issue, and silently
    // closing somebody's ticket is not what "attach" means.
    const { sdk, flows } = build();
    await flows.linkIssueToLane({ issue: ROW, laneId: "lane-9" });
    const link = sdk.calls.find(([name]) => name === "lanes.linkIssue")[1];
    assert.equal(link.role, "referenced");
    assert.equal(link.closeOnMerge, false);
  });

  it("refuses without a lane rather than guessing one", async () => {
    const { flows } = build();
    assert.equal((await flows.linkIssueToLane({ issue: ROW })).code, "invalid_args");
  });
});

describe("the session setup a launched agent reads", () => {
  const setup = sessionSetupFor([ROW], "2026-08-31T00:00:00.000Z");

  it("uses only keys the host's pattern accepts", () => {
    for (const key of Object.keys(setup.env)) {
      assert.match(key, ENV_KEY_PATTERN, `${key} would be refused by the host`);
    }
  });

  it("shadows no name the host owns", () => {
    // The fixed `ADE_PLUGIN_` prefix is what makes shadowing impossible by
    // construction; these eight are the names the host keeps inside it.
    for (const key of Object.keys(setup.env)) {
      assert.ok(!RESERVED_ENV_KEYS.includes(key), `${key} is the host's`);
    }
  });

  it("carries the issue keys the agent skill looks for", () => {
    assert.equal(setup.env.ADE_PLUGIN_LINEAR_ISSUE_IDS, "ENG-431");
  });

  it("writes the same JSON the built-in writes, so an agent finds what it expects", () => {
    const payload = JSON.parse(setup.contextFile.content);
    assert.equal(setup.contextFile.name, "linear-issues.json");
    assert.deepEqual(payload.issues, [{
      id: "a",
      identifier: "ENG-431",
      title: "Fix OAuth refresh",
      url: ROW.url,
      stateName: "In Progress",
      role: "primary",
      teamKey: "ENG",
    }]);
  });

  it("names the file with one path segment and no directory part", () => {
    // `PLUGIN_SESSION_CONTEXT_FILE_NAME_PATTERN` refuses anything else.
    assert.match(setup.contextFile.name, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
  });

  it("handles several issues at once", () => {
    const two = sessionSetupFor([ROW, { ...ROW, id: "b", identifier: "ENG-9" }], "2026-08-31T00:00:00.000Z");
    assert.equal(two.env.ADE_PLUGIN_LINEAR_ISSUE_IDS, "ENG-431,ENG-9");
    assert.equal(JSON.parse(two.contextFile.content).issues.length, 2);
  });

  it("writes valid JSON for no issues at all", () => {
    assert.deepEqual(JSON.parse(contextFileContent([], "now")).issues, []);
  });
});

describe("starting an agent on an issue", () => {
  it("opens a chat by default, carrying the setup and the kickoff", async () => {
    const { sdk, flows } = build();
    const result = await flows.spawnAgentOnIssue({ issue: ROW, laneId: "lane-1" });
    const call = sdk.calls.find(([name]) => name === "actions.chat.createSession")[1];
    assert.equal(result.ok, true);
    assert.equal(call.laneId, "lane-1");
    assert.equal(call.initialMessage, defaultKickoff(ROW));
    assert.equal(call.sessionSetup.env.ADE_PLUGIN_LINEAR_ISSUE_IDS, "ENG-431");
  });

  it("starts a tracked CLI instead when the user picked one", async () => {
    const { sdk, flows } = build();
    await flows.spawnAgentOnIssue({ issue: ROW, laneId: "lane-1", sessionType: "cli" });
    const call = sdk.calls.find(([name]) => name === "actions.chat.launchCli")[1];
    // Same setup either way — that is the whole point of the seam.
    assert.equal(call.sessionSetup.env.ADE_PLUGIN_LINEAR_ISSUE_IDS, "ENG-431");
    assert.equal(call.initialInput, defaultKickoff(ROW));
  });

  it("keeps the phone's kickoff wording, so a launch behaves the same everywhere", () => {
    assert.equal(
      defaultKickoff(ROW),
      "Pick up ENG-431: Fix OAuth refresh.\n\nRead the attached Linear issue for full context, plan the change, then implement it.",
    );
  });

  it("uses the caller's prompt when they wrote one", async () => {
    const { sdk, flows } = build();
    await flows.spawnAgentOnIssue({ issue: ROW, laneId: "lane-1", prompt: "  Just read it.  " });
    assert.equal(sdk.calls.find(([name]) => name === "actions.chat.createSession")[1].initialMessage, "Just read it.");
  });

  it("passes the model configuration through, and omits what was not set", async () => {
    const { sdk, flows } = build();
    await flows.spawnAgentOnIssue({
      issue: ROW, laneId: "lane-1", provider: "codex", model: "gpt", reasoningEffort: "xhigh", fastMode: false,
    });
    const call = sdk.calls.find(([name]) => name === "actions.chat.createSession")[1];
    assert.equal(call.provider, "codex");
    assert.equal(call.fastMode, false);
    assert.ok(!("permissionMode" in call));
  });

  it("links the issue to the SESSION as well as the lane", async () => {
    // That second link is what makes the chat header's issue affordances find
    // the issue in a lane that carries several.
    const { sdk, flows } = build();
    await flows.spawnAgentOnIssue({ issue: ROW, laneId: "lane-1" });
    const link = sdk.calls.find(([name]) => name === "lanes.linkIssue")[1];
    assert.equal(link.sessionId, "chat-1");
    assert.ok(!("laneId" in link));
  });

  it("still reports success when only the session link failed", async () => {
    const { flows } = build({ sdk: { linkIssueThrows: true } });
    assert.equal((await flows.spawnAgentOnIssue({ issue: ROW, laneId: "lane-1" })).ok, true);
  });

  it("refuses without a lane, because an agent with no branch has nothing to work on", async () => {
    const { flows } = build();
    assert.equal((await flows.spawnAgentOnIssue({ issue: ROW })).code, "invalid_args");
  });

  it("reports what ADE refused rather than a stack trace", async () => {
    const { flows } = build({ actions: { "chat.createSession": async () => { throw new Error("no model"); } } });
    const result = await flows.spawnAgentOnIssue({ issue: ROW, laneId: "lane-1" });
    assert.equal(result.ok, false);
    assert.equal(result.message, "no model");
  });
});

describe("the In Progress transition on launch", () => {
  const teams = [{
    id: "t1",
    key: "ENG",
    name: "Eng",
    states: {
      nodes: [
        { id: "s-todo", name: "Todo", type: "unstarted" },
        { id: "s-doing", name: "In Progress", type: "started" },
      ],
    },
  }];

  it("does nothing while the setting is off", async () => {
    let moved = false;
    const { flows } = build({ api: { updateIssueState: async () => { moved = true; } } });
    const result = await flows.moveToStarted(ROW);
    assert.equal(result.skipped, "setting");
    assert.equal(moved, false);
  });

  it("moves the issue to the team's first started state when it is on", async () => {
    const moves = [];
    const { data, flows } = build({
      sdk: { config: { moveToStartedOnLaunch: true } },
      api: { listTeamsAndStates: async () => teams, updateIssueState: async (id, state) => moves.push([id, state]) },
    });
    await data.refreshCatalog();
    await flows.moveToStarted({ ...ROW, stateId: "s-todo" });
    assert.deepEqual(moves, [["a", "s-doing"]]);
  });

  it("skips the call when the issue is already there", async () => {
    const moves = [];
    const { data, flows } = build({
      sdk: { config: { moveToStartedOnLaunch: true } },
      api: { listTeamsAndStates: async () => teams, updateIssueState: async (...args) => moves.push(args) },
    });
    await data.refreshCatalog();
    await flows.moveToStarted({ ...ROW, stateId: "s-doing" });
    assert.deepEqual(moves, []);
  });
});

describe("picking the state a transition targets", () => {
  const states = [
    { id: "s1", type: "unstarted" },
    { id: "s2", type: "started" },
    { id: "s3", type: "completed" },
    { id: "s4", type: "completed" },
  ];

  it("takes the FIRST completed state, not the one called Done", () => {
    // A team that renamed Done still works, and a team with two completed
    // states gets Linear's own ordering rather than a name match we invented.
    assert.equal(pickCompletedStateId(states), "s3");
    assert.equal(pickStartedStateId(states), "s2");
  });

  it("answers null when the team has no such state", () => {
    assert.equal(pickCompletedStateId([{ id: "s1", type: "unstarted" }]), null);
    assert.equal(pickStartedStateId([]), null);
  });
});

describe("a merged pull request moving its issues to Done", () => {
  const doneStates = [{
    id: "t1",
    key: "ENG",
    name: "Eng",
    states: { nodes: [{ id: "s-todo", name: "Todo", type: "unstarted" }, { id: "s-done", name: "Done", type: "completed" }] },
  }];

  function merged(overrides = {}) {
    const lanes = [{
      id: "lane-1",
      name: "Fix OAuth",
      primaryIssue: {
        provider: "linear",
        issueId: "a",
        key: "ENG-431",
        state: { id: "s-todo" },
        container: { key: "ENG" },
      },
      issueLinks: [],
      ...overrides.lane,
    }];
    const moves = [];
    const built = build({
      sdk: { lanes, config: { moveToDoneOnMerge: true, ...(overrides.config ?? {}) } },
      api: {
        listTeamsAndStates: async () => doneStates,
        updateIssueState: async (...args) => moves.push(args),
        ...(overrides.api ?? {}),
      },
    });
    return { ...built, moves };
  }

  it("does nothing at all while the setting is off", async () => {
    const { flows, moves } = merged({ config: { moveToDoneOnMerge: false } });
    const result = await flows.closeIssueOnMerge({ laneIds: ["lane-1"] });
    assert.equal(result.skipped, "setting");
    assert.deepEqual(moves, []);
  });

  it("moves the lane's primary issue to the team's completed state", async () => {
    const { data, flows, moves } = merged();
    await data.refreshCatalog();
    const result = await flows.closeIssueOnMerge({ laneIds: ["lane-1"] });
    assert.equal(result.moved, 1);
    assert.deepEqual(moves, [["a", "s-done"]]);
  });

  it("moves a secondary link ONLY when it asked to close on merge", async () => {
    const { data, flows, moves } = merged({
      lane: {
        issueLinks: [
          { issue: { provider: "linear", issueId: "b", key: "ENG-9", container: { key: "ENG" } }, closeOnMerge: true },
          { issue: { provider: "linear", issueId: "c", key: "ENG-10", container: { key: "ENG" } }, closeOnMerge: false },
        ],
      },
    });
    await data.refreshCatalog();
    await flows.closeIssueOnMerge({ laneIds: ["lane-1"] });
    assert.deepEqual(moves.map(([id]) => id).sort(), ["a", "b"]);
  });

  it("moves each issue once even when two lanes name it", async () => {
    const { data, flows, moves } = merged();
    await data.refreshCatalog();
    await flows.closeIssueOnMerge({ laneIds: ["lane-1"] });
    await flows.closeIssueOnMerge({ laneIds: ["lane-1"] });
    assert.equal(moves.length, 1);
  });

  it("retries on a later merge when the move failed", async () => {
    // Latching a failure permanently would mean a transient Linear outage
    // silently disabled the transition for that issue forever.
    let attempts = 0;
    const { data, flows } = merged({
      api: {
        updateIssueState: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("Linear is down");
        },
      },
    });
    await data.refreshCatalog();
    await flows.closeIssueOnMerge({ laneIds: ["lane-1"] });
    await flows.closeIssueOnMerge({ laneIds: ["lane-1"] });
    assert.equal(attempts, 2);
  });

  it("leaves the issue alone when the team has no completed state", async () => {
    const { data, flows, moves } = merged({
      api: { listTeamsAndStates: async () => [{ id: "t1", key: "ENG", name: "Eng", states: { nodes: [] } }] },
    });
    await data.refreshCatalog();
    assert.equal((await flows.closeIssueOnMerge({ laneIds: ["lane-1"] })).moved, 0);
    assert.deepEqual(moves, []);
  });

  it("skips the call when the issue is already in that state", async () => {
    const { data, flows, moves } = merged({
      lane: {
        primaryIssue: {
          provider: "linear", issueId: "a", key: "ENG-431", state: { id: "s-done" }, container: { key: "ENG" },
        },
      },
    });
    await data.refreshCatalog();
    await flows.closeIssueOnMerge({ laneIds: ["lane-1"] });
    assert.deepEqual(moves, []);
  });

  it("answers zero for a lane with no Linear issue", async () => {
    const { data, flows } = merged({ lane: { primaryIssue: null } });
    await data.refreshCatalog();
    assert.equal((await flows.closeIssueOnMerge({ laneIds: ["lane-1"] })).moved, 0);
  });

  it("answers zero for no lanes at all", async () => {
    const { flows } = merged();
    assert.equal((await flows.closeIssueOnMerge({ laneIds: [] })).skipped, "no-lanes");
  });
});

describe("deriving the merge from pr.changed, which core does not have to", () => {
  it("answers only the lanes whose PR reads back as merged", async () => {
    // `pr.changed` is a debounced, coalesced hint with ids and no previous
    // state, so the transition is derived by reading each PR back.
    const { flows } = build({
      actions: {
        "pr.getDetail": async ({ prId }) => ({
          pr: { id: prId, state: prId === "pr-1" ? "merged" : "open", laneId: `lane-${prId}` },
        }),
      },
    });
    assert.deepEqual(await flows.mergedLanesFromPrIds(["pr-1", "pr-2"]), ["lane-pr-1"]);
  });

  it("de-duplicates two PRs on one lane", async () => {
    const { flows } = build({
      actions: { "pr.getDetail": async ({ prId }) => ({ pr: { id: prId, state: "merged", laneId: "lane-1" } }) },
    });
    assert.deepEqual(await flows.mergedLanesFromPrIds(["pr-1", "pr-2"]), ["lane-1"]);
  });

  it("skips a PR it could not read rather than failing the batch", async () => {
    const { flows } = build({
      actions: {
        "pr.getDetail": async ({ prId }) => {
          if (prId === "pr-1") throw new Error("gone");
          return { pr: { id: prId, state: "merged", laneId: "lane-2" } };
        },
      },
    });
    assert.deepEqual(await flows.mergedLanesFromPrIds(["pr-1", "pr-2"]), ["lane-2"]);
  });

  it("answers nothing for a merged PR with no lane", async () => {
    const { flows } = build({
      actions: { "pr.getDetail": async () => ({ pr: { state: "merged", laneId: null } }) },
    });
    assert.deepEqual(await flows.mergedLanesFromPrIds(["pr-1"]), []);
  });
});

describe("reading the GitHub repo out of a git remote", () => {
  const CASES = [
    ["git@github.com:acme/app.git", { owner: "acme", name: "app" }],
    ["git@github.com:acme/app", { owner: "acme", name: "app" }],
    ["https://github.com/acme/app.git", { owner: "acme", name: "app" }],
    ["https://github.com/acme/app", { owner: "acme", name: "app" }],
    ["https://github.com/acme/app/", { owner: "acme", name: "app" }],
    ["http://github.com/acme/app", { owner: "acme", name: "app" }],
    ["https://token@github.com/acme/app", { owner: "acme", name: "app" }],
    ["ssh://git@github.com/acme/app.git", { owner: "acme", name: "app" }],
    ["https://GitHub.com/Acme/App", { owner: "Acme", name: "App" }],
  ];

  for (const [remote, expected] of CASES) {
    it(`reads ${remote}`, () => {
      assert.deepEqual(parseGithubRemote(remote), expected);
    });
  }

  it("answers null for a remote that is not GitHub", () => {
    // Sending it to GitHub to be refused would report a permissions problem
    // the user does not have.
    for (const remote of ["git@gitlab.com:acme/app.git", "https://bitbucket.org/a/b", "/local/path", "", null]) {
      assert.equal(parseGithubRemote(remote), null, String(remote));
    }
  });
});

describe("creating a GitHub autolink", () => {
  function withConnection(overrides = {}) {
    const built = build(overrides);
    return built;
  }

  it("sends the owner, the repo, the key prefix and the workspace URL", async () => {
    const { sdk, data, flows } = withConnection();
    await data.refreshConnection();
    const result = await flows.createAutolink({ teamKey: "eng" });
    assert.equal(result.ok, true);
    const call = sdk.calls.find(([name]) => name === "actions.github.createRepoAutolink")[1];
    assert.deepEqual(call, {
      owner: "acme",
      name: "app",
      keyPrefix: "ENG-",
      urlTemplate: "https://linear.app/acme/issue/ENG-<num>",
      isAlphanumeric: false,
    });
  });

  it("refuses before connecting, because the workspace URL is part of the link", async () => {
    const { data, flows } = withConnection({ api: { readCredential: async () => ({ token: null, authMode: null }) } });
    await data.refreshConnection();
    assert.equal((await flows.createAutolink({ teamKey: "ENG" })).code, "no_token");
  });

  it("says there is nothing to autolink when the project has no GitHub origin", async () => {
    const { data, flows } = withConnection({
      actions: { "git.getOriginRemote": async () => "git@gitlab.com:acme/app.git" },
    });
    await data.refreshConnection();
    assert.equal((await flows.createAutolink({ teamKey: "ENG" })).code, "no_repo");
  });

  it("refuses an empty team key before spending anything", async () => {
    const { flows } = withConnection();
    assert.equal((await flows.createAutolink({ teamKey: "  " })).code, "invalid_args");
  });
});
