// Every verb a panel can press, against a host that records what it was asked.
//
// The handlers are where the plugin CHANGES something, so these cases are
// written around the two failures that cost a reader most: a button that
// silently does nothing, and a write that half-worked and reported success.
//
// The host below is a recorder rather than a mock of the real one. That is
// deliberate: `bind()` reaches for its capabilities by dotted path, so a test
// that stubbed the real object's methods would still pass if the data layer
// renamed one. {@link HOST_CAPABILITIES} is the list both sides agree on, and
// the first case here is the one that pins it.

"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { FILTER_STATE_KEYS, bind, readChangedValue } = require("../panelActions");
const contract = require("../panels/contract");

/**
 * A host that answers everything and remembers the order it was asked.
 *
 * `fail` names capability paths that reject, so a case can make exactly one leg
 * of a batch fail and read what the handler says about the rest.
 */
function makeHost(options = {}) {
  const calls = [];
  const fail = new Set(options.fail ?? []);
  const model = options.model ?? {
    connection: { connected: true, viewerId: "user-1" },
    issue: { id: "issue-1", url: "https://linear.app/acme/issue/ADE-122" },
  };

  const record = (path, answer) => (...args) => {
    calls.push({ path, args });
    if (fail.has(path)) throw new Error(`${path} refused`);
    return typeof answer === "function" ? answer(...args) : answer;
  };

  const host = {
    calls,
    publish: record("publish"),
    model: () => model,
    data: {
      reload: record("data.reload"),
      setFilters: record("data.setFilters"),
      search: record("data.search"),
      loadIssue: record("data.loadIssue"),
      loadComments: record("data.loadComments"),
    },
    api: {
      setIssueState: record("api.setIssueState"),
      setIssuePriority: record("api.setIssuePriority"),
      assignIssue: record("api.assignIssue"),
      createComment: record("api.createComment"),
    },
    flows: {
      createLaneFromIssue: record("flows.createLaneFromIssue"),
      spawnAgentOnIssue: record("flows.spawnAgentOnIssue"),
      linkIssueToLane: record("flows.linkIssueToLane"),
      openLaunch: record("flows.openLaunch"),
      connectOAuth: record("flows.connectOAuth"),
      connectApiKey: record("flows.connectApiKey"),
      disconnect: record("flows.disconnect"),
      applySettings: record("flows.applySettings"),
      createAutolink: record("flows.createAutolink"),
    },
    sdk: { clipboard: { write: record("sdk.clipboard.write") } },
  };
  // A build that does not have a verb at all, which is a different answer from
  // one whose verb threw — see the `openLaunch` test.
  for (const path of options.without ?? []) {
    const [branch, name] = path.split(".");
    delete host[branch][name];
  }
  return host;
}

/** Paths the handlers reached, in order, ignoring the publishes. */
function reached(host) {
  return host.calls.filter((call) => call.path !== "publish").map((call) => call.path);
}

function published(host) {
  return host.calls.filter((call) => call.path === "publish").map((call) => call.args[0]);
}

describe("the host seam", () => {
  it("refuses a host that cannot publish or cannot be read", () => {
    assert.throws(() => bind({}), TypeError);
    assert.throws(() => bind({ publish: () => {} }), TypeError);
  });

  it("tells a capability that is ABSENT from one that threw", async () => {
    // The two used to be one answer, and `openLaunch` acted on it: a transient
    // failure inside the launch flow was read as "this build has no launch
    // panel", and the button that says it opens a form silently created a
    // worktree and started an agent on the plugin's defaults instead.
    //
    // Absent IS still the fall-through — a build with no launch panel has
    // nowhere to navigate, so the button does what it says with the defaults.
    const absentHost = makeHost({ without: ["flows.openLaunch"] });
    await bind(absentHost).openLaunch({ issueId: "issue-9" });
    assert.ok(
      reached(absentHost).includes("flows.spawnAgentOnIssue"),
      "a build with no launch panel must still launch",
    );

    // A verb that threw creates nothing and says so.
    const brokenHost = makeHost({ fail: ["flows.openLaunch"] });
    const failed = await bind(brokenHost).openLaunch({ issueId: "issue-9" });
    assert.equal(failed.ok, false);
    assert.ok(!failed.navigate, "navigated after a launch flow that threw");
    assert.deepEqual(
      reached(brokenHost).filter((path) => path.startsWith("flows.spawn") || path.startsWith("flows.createLane")),
      [],
      "created a lane for a reader who had asked for the form",
    );
  });

  it("says what it could not do rather than throwing inside the host", async () => {
    // A bare host is what an older `index.js` looks like. Every handler must
    // still return a result: an exception here kills the plugin child.
    const handlers = bind({ publish: async () => {}, model: () => ({}) });
    for (const [name, handler] of Object.entries(handlers)) {
      const result = await handler({ issueId: "issue-1", prefix: "ADE-", apiKey: "lin_api_x" });
      assert.ok(result === undefined || typeof result === "object", `${name} returned ${typeof result}`);
    }
  });
});

describe("navigation", () => {
  it("defines no issue navigation of its own, which the data half owns", async () => {
    // `index.js` merges its handlers in AFTER these, so a second `openIssue`
    // here would be dead code that reads as the live one — and it was: the
    // panel half's copy could not resolve a row KEY or an identifier and had no
    // collection to fall through to. `contract.js:CORE_OWNED_ACTIONS` is the
    // audit, and this asserts the audit is true of the module.
    const handlers = bind(makeHost());
    for (const id of ["openIssue", "openSubIssue", "openInLinear", "openIssues", "openSessionIssue"]) {
      assert.equal(handlers[id], undefined, `${id} is the data half's and is defined here too`);
    }
  });

  it("still offers the way back, which no other half draws", async () => {
    assert.deepEqual(await bind(makeHost()).backToIssues(), { navigate: { panelId: "issues" } });
  });
});

describe("filters and search", () => {
  it("clears the controls, because only the plugin can move client state", async () => {
    // Panel state is per-viewer and lives on the client, so republishing a
    // schema with different defaults would not touch a control the reader has
    // already touched. `{resetState}` is the only verb that can.
    const host = makeHost();
    const result = await bind(host).clearFilters();
    assert.deepEqual(result.resetState, FILTER_STATE_KEYS);
    assert.ok(result.resetState.includes(contract.STATE_SEARCH), "a leftover query is a filter");
    assert.ok(!result.resetState.includes(contract.STATE_VIEW), "the leftover layout key is not a control");
    assert.ok(!result.resetState.includes(contract.STATE_BATCH), "the ticks are not a filter");
  });

  it("asks the question first and runs the search on the answer", async () => {
    const host = makeHost();
    const handlers = bind(host);

    const asked = await handlers.searchIssues({});
    assert.equal(asked.prompt.id, contract.PROMPT_SEARCH);
    assert.deepEqual(reached(host), [], "the first call must not search");

    const answered = await handlers.searchIssues({ prompt: { id: contract.PROMPT_SEARCH, text: " handoff " } });
    assert.deepEqual(host.calls.find((call) => call.path === "data.search").args, ["handoff"]);
    assert.ok(answered.message.includes("handoff"));
  });

  it("reads the nav-bar field without asking a prompt", async () => {
    const host = makeHost();
    const answered = await bind(host).searchIssues({ [contract.STATE_SEARCH]: " login " });
    assert.deepEqual(host.calls.find((call) => call.path === "data.search").args, ["login"]);
    assert.ok(answered.message.includes("login"));
    assert.ok(!answered.prompt);
  });

  it("reads an emptied field as a cleared search, not a search for nothing", async () => {
    const host = makeHost();
    const result = await bind(host).searchIssues({ prompt: { id: contract.PROMPT_SEARCH, text: "" } });
    assert.deepEqual(host.calls.find((call) => call.path === "data.search").args, [""]);
    assert.equal(result.message, "Search cleared.");
  });

  it("ignores a prompt answer meant for another question", async () => {
    // Two handlers ask questions on this plugin. An answer whose id belongs to
    // the other one must re-ask rather than search for a comment body.
    const result = await bind(makeHost()).searchIssues({ prompt: { id: contract.PROMPT_COMMENT, text: "hello" } });
    assert.equal(result.prompt.id, contract.PROMPT_SEARCH);
  });

  it("forwards only the filter keys it was given", async () => {
    const host = makeHost();
    await bind(host).applyFilters({ [contract.STATE_PRESET]: "active", selection: ["x"], nonsense: 1 });
    const [patch] = host.calls.find((call) => call.path === "data.setFilters").args;
    assert.deepEqual(patch, { [contract.STATE_PRESET]: "active" });
  });
});

describe("launching work", () => {
  it("walks a batch one issue at a time and reports the whole count", async () => {
    // Eleven lanes at once is eleven worktrees and eleven agents starting in the
    // same second on one machine. The built-in's own batch launcher walks them.
    const host = makeHost();
    const result = await bind(host).launchLaneAndAgent({ selection: ["a", "b", "c"] });
    assert.deepEqual(reached(host), [
      "flows.spawnAgentOnIssue",
      "flows.spawnAgentOnIssue",
      "flows.spawnAgentOnIssue",
      "data.reload",
    ]);
    assert.equal(result.message, "Started 3 agents.");
    assert.deepEqual(result.resetState, [contract.STATE_BATCH]);
  });

  it("never reports success for a batch that half-worked", async () => {
    const host = makeHost({ fail: ["flows.spawnAgentOnIssue"] });
    const result = await bind(host).launchLaneAndAgent({ selection: ["a", "b"] });
    assert.equal(result.ok, false);
    assert.ok(result.message.includes("2 failed"), result.message);
    assert.ok(!("resetState" in result), "a failed batch must keep its ticks");
  });

  it("stops at the lane when the reader asked for a lane", async () => {
    const host = makeHost();
    await bind(host).launchLaneOnly({ issueId: "issue-1" });
    assert.ok(reached(host).includes("flows.createLaneFromIssue"));
    assert.ok(!reached(host).includes("flows.spawnAgentOnIssue"));
  });

  it("carries laneOnly into the configuration panel", async () => {
    const host = makeHost();
    const result = await bind(host).openLaunch({ issueId: "issue-1", laneOnly: true });
    assert.deepEqual(result.navigate, {
      panelId: "launch",
      context: { issueId: "issue-1", laneOnly: true },
    });
  });

  it("falls back to the RIGHT verb when the manifest has no launch panel", async () => {
    // The fallback used to always launch an agent, so pressing "Create lane
    // only" on a build without the panel started one anyway.
    const host = makeHost();
    delete host.flows.openLaunch;
    await bind(host).openLaunch({ issueId: "issue-1", laneOnly: true });
    assert.ok(reached(host).includes("flows.createLaneFromIssue"));
    assert.ok(!reached(host).includes("flows.spawnAgentOnIssue"));
  });

  it("does the work directly when the manifest has no launch panel", async () => {
    // `flows.openLaunch` is the manifest's proxy. Without it, navigating would
    // send the reader to a panel id the host cannot resolve.
    const host = makeHost();
    delete host.flows.openLaunch;
    const result = await bind(host).openLaunch({ issueId: "issue-1" });
    assert.ok(!("navigate" in result), "navigated to a panel that is not declared");
    assert.ok(reached(host).includes("flows.spawnAgentOnIssue"));
  });

  it("asks which lane to link to instead of taking the first one", async () => {
    const host = makeHost();
    host.flows.linkIssueToLane = (...args) => {
      host.calls.push({ path: "flows.linkIssueToLane", args });
      const laneId = args[1];
      if (!laneId) {
        return {
          prompt: {
            id: contract.PROMPT_LANE,
            title: "Link to a lane",
            options: [{ value: "lane-1", label: "One" }, { value: "lane-2", label: "Two" }],
          },
        };
      }
      return { linked: Array.isArray(args[0]) ? args[0].length : 1 };
    };
    const asked = await bind(host).linkToLane({ issueId: "issue-1" });
    assert.equal(asked.prompt?.id, contract.PROMPT_LANE);
    assert.equal(host.calls.find((call) => call.path === "flows.linkIssueToLane").args[1], null);

    const linked = await bind(host).linkToLane({
      issueId: "issue-1",
      prompt: { id: contract.PROMPT_LANE, text: "lane-2" },
    });
    assert.equal(linked.message, "Linked 1 issue.");
    const [, laneId] = host.calls.filter((call) => call.path === "flows.linkIssueToLane").at(-1).args;
    assert.equal(laneId, "lane-2");
  });
});

describe("writing back to Linear", () => {
  it("assigns to the credential's own viewer, never to a name in the payload", async () => {
    // An assignee id in an action payload would be a payload that can assign an
    // issue to anybody, and nothing on this panel needs that.
    const host = makeHost();
    await bind(host).assignToMe({ selection: ["a", "b"], assigneeId: "somebody-else" });
    for (const call of host.calls.filter((entry) => entry.path === "api.assignIssue")) {
      assert.equal(call.args[1], "user-1");
    }
  });

  it("refuses to assign when nobody is signed in", async () => {
    const host = makeHost({ model: { connection: { connected: false } } });
    const result = await bind(host).assignToMe({ issueId: "issue-1" });
    assert.equal(result.ok, false);
    assert.deepEqual(reached(host), []);
  });

  it("reads the new state off the per-issue key the builder invented", async () => {
    // The detail panel keys its controls on the issue's identifier, so the
    // handler cannot know the key's name in advance.
    const host = makeHost();
    await bind(host).setIssueState({ issueId: "issue-1", "issueState:ADE-122": "state-2" });
    assert.deepEqual(host.calls.find((call) => call.path === "api.setIssueState").args, ["issue-1", "state-2"]);
  });

  it("treats priority 0 as a real value rather than as nothing", async () => {
    // "No priority" IS a priority in Linear, and a falsy check would drop it.
    const host = makeHost();
    await bind(host).setIssuePriority({ issueId: "issue-1", "issuePriority:ADE-122": "0" });
    assert.deepEqual(host.calls.find((call) => call.path === "api.setIssuePriority").args, ["issue-1", 0]);
  });

  it("republishes after a failed write, so the control shows the truth", async () => {
    // A control that moved optimistically shows the reader's intention. The
    // panel is the only thing that can put it back.
    const host = makeHost({ fail: ["api.setIssueState"] });
    const result = await bind(host).setIssueState({ issueId: "issue-1", "issueState:ADE-122": "state-2" });
    assert.equal(result.ok, false);
    assert.deepEqual(published(host), ["issue", "issues"]);
  });

  it("asks for the comment, then posts it and re-reads the thread", async () => {
    const host = makeHost();
    const handlers = bind(host);

    const asked = await handlers.commentOnIssue({ issueId: "issue-1" });
    assert.equal(asked.prompt.id, contract.PROMPT_COMMENT);
    assert.deepEqual(asked.prompt.context, { issueId: "issue-1" });

    await handlers.commentOnIssue({
      issueId: "issue-1",
      prompt: { id: contract.PROMPT_COMMENT, text: "  Looking at it now.  " },
    });
    assert.deepEqual(host.calls.find((call) => call.path === "api.createComment").args, [
      "issue-1",
      "Looking at it now.",
    ]);
    assert.ok(reached(host).includes("data.loadComments"));
  });

  it("posts nothing for an empty comment", async () => {
    const host = makeHost();
    const result = await bind(host).commentOnIssue({
      issueId: "issue-1",
      prompt: { id: contract.PROMPT_COMMENT, text: "   " },
    });
    assert.equal(result.message, "Nothing to post.");
    assert.deepEqual(reached(host), []);
  });

  it("opens a link that is not an issue under its own id", async () => {
    // `openInLinear` is the DATA half's and answers from the stored issue row,
    // so a settings link to `linear.app/settings/api` has to name a different
    // verb or be told that the API settings page is not a Linear issue.
    const handlers = bind(makeHost());
    assert.deepEqual(await handlers.openExternal({ url: "https://linear.app/settings/api" }), {
      openUrl: "https://linear.app/settings/api",
    });
    assert.equal((await handlers.openExternal({})).ok, false);
  });
});

describe("the connection", () => {
  it("returns the session the HOST stamped, never a literal of its own", async () => {
    // A plugin that built its own URL would be a plugin that could point one
    // somewhere else. The host stamps the URL and the transport, and this hands
    // back exactly what it answered.
    const host = makeHost();
    host.flows.connectOAuth = () => ({ authSession: { sessionId: "linear" }, transport: "loopback" });
    assert.deepEqual(
      await bind(host).connectOAuth(),
      { authSession: { sessionId: "linear" }, transport: "loopback" },
    );
  });

  it("reports a sign-in that never began instead of claiming one did", async () => {
    // `beginSession` refuses for three ordinary reasons — no OAuth client on
    // this build, a flow already running, nothing that can show a window — and
    // each one arrives as a message. This used to answer
    // `{authSession: {sessionId: "linear"}}` whatever happened, so the button
    // looked like it worked and no browser ever opened.
    const host = makeHost({ fail: ["flows.connectOAuth"] });
    const result = await bind(host).connectOAuth();
    assert.equal(result.ok, false);
    assert.ok(result.message, "a failed sign-in said nothing");
    assert.ok(!("authSession" in result), "named a flow the host never started");
  });

  it("says so when the host has no sign-in verb at all", async () => {
    const host = makeHost();
    delete host.flows.connectOAuth;
    const result = await bind(host).connectOAuth();
    assert.equal(result.ok, false);
    assert.ok(!("authSession" in result));
  });

  it("never echoes the API key back into a message", async () => {
    const host = makeHost({ fail: ["flows.connectApiKey"] });
    const result = await bind(host).connectApiKey({ apiKey: "lin_api_secret_value" });
    assert.equal(result.ok, false);
    assert.ok(!result.message.includes("lin_api_secret_value"), result.message);
  });

  it("refuses an empty key rather than storing one", async () => {
    const host = makeHost();
    const result = await bind(host).connectApiKey({ apiKey: "   " });
    assert.equal(result.ok, false);
    assert.deepEqual(reached(host), []);
  });

  it("sends the whole values map and strips the frame's own fields", async () => {
    // `applyOnChange` sends every field on every committed edit, so the handler
    // is idempotent by construction — but the host's own `selection`, `context`
    // and `prompt` must not be written as if they were settings.
    const host = makeHost();
    await bind(host).applySettings({
      moveToDoneOnMerge: true,
      defaultTeamKey: "ADE",
      selection: ["x"],
      context: { a: 1 },
      prompt: { id: "p", text: "t" },
    });
    const [values] = host.calls.find((call) => call.path === "flows.applySettings").args;
    assert.deepEqual(values, { moveToDoneOnMerge: true, defaultTeamKey: "ADE" });
  });

  it("copies the webhook URL and says so when there is no clipboard", async () => {
    const model = { connection: { connected: true }, ingress: { url: "https://relay.ade.dev/hook/abc" } };
    const withClipboard = makeHost({ model });
    assert.equal((await bind(withClipboard).copyWebhookUrl()).message, "Webhook URL copied.");

    const without = makeHost({ model });
    delete without.sdk;
    const result = await bind(without).copyWebhookUrl();
    assert.equal(result.ok, false);
  });
});

describe("readChangedValue", () => {
  it("prefers the prefixed key and falls back to a flat value", () => {
    assert.equal(readChangedValue({ "issueState:ADE-1": "s" }, "issueState:"), "s");
    assert.equal(readChangedValue({ value: "s" }, "issueState:"), "s");
    assert.equal(readChangedValue({ "issuePriority:ADE-1": 0 }, "issuePriority:"), "0");
    assert.equal(readChangedValue({}, "issueState:"), null);
  });
});
