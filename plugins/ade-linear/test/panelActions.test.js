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

const { FILTER_STATE_KEYS, HOST_CAPABILITIES, bind, readChangedValue } = require("../panelActions");
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
      adoptHandoff: record("flows.adoptHandoff"),
      disconnect: record("flows.disconnect"),
      applySettings: record("flows.applySettings"),
      createAutolink: record("flows.createAutolink"),
    },
    sdk: { clipboard: { write: record("sdk.clipboard.write") } },
  };
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

  it("declares every capability it reaches for, and reaches for no other", () => {
    // The failure this pins is invisible from the outside: a handler calling
    // `data.loadIssue` when the data layer named it `fetchIssue` guards, falls
    // through and returns a polite message forever. The list is the contract
    // `index.js` builds its host against.
    const host = makeHost();
    const declared = new Set([...HOST_CAPABILITIES.required, ...HOST_CAPABILITIES.optional]);
    for (const path of HOST_CAPABILITIES.optional) {
      let node = host;
      for (const step of path.split(".")) node = node?.[step];
      assert.equal(typeof node, "function", `the test host has no ${path}`);
    }
    assert.ok(declared.has("publish") && declared.has("model"));
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
  it("loads the issue before it navigates, so the reader lands on it", async () => {
    const host = makeHost();
    const result = await bind(host).openIssue({ issueId: "issue-9" });
    assert.deepEqual(result, { navigate: { panelId: "issue", context: { issueId: "issue-9" } } });
    assert.deepEqual(reached(host), ["data.loadIssue"]);
    assert.deepEqual(published(host), ["issue"]);
  });

  it("still navigates when the fetch fails, because the panel says why", async () => {
    const host = makeHost({ fail: ["data.loadIssue"] });
    const result = await bind(host).openIssue({ issueId: "issue-9" });
    assert.equal(result.navigate.panelId, "issue");
  });

  it("reads the issue from a row key, a context and a selection alike", async () => {
    // One handler serves a detail button, a bound row and a bulk bar, so the
    // four places an id can ride are read in one order and only one order.
    const handlers = bind(makeHost());
    assert.equal((await handlers.openIssue({ key: "from-key" })).navigate.context.issueId, "from-key");
    assert.equal(
      (await handlers.openIssue({ context: { issueId: "from-context" } })).navigate.context.issueId,
      "from-context",
    );
    assert.equal(
      (await handlers.openIssue({ selection: ["from-selection"] })).navigate.context.issueId,
      "from-selection",
    );
  });

  it("falls back to the list when nothing named an issue", async () => {
    const result = await bind(makeHost()).openIssue({});
    assert.deepEqual(result, { navigate: { panelId: "issues" } });
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
    assert.ok(!result.resetState.includes(contract.STATE_VIEW), "the layout is not a filter");
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

  it("opens the URL the row carried, and falls back to the issue's own", async () => {
    const handlers = bind(makeHost());
    assert.deepEqual(await handlers.openInLinear({ url: "https://linear.app/acme/issue/ADE-9" }), {
      openUrl: "https://linear.app/acme/issue/ADE-9",
    });
    assert.deepEqual(await handlers.openInLinear({}), {
      openUrl: "https://linear.app/acme/issue/ADE-122",
    });
  });
});

describe("the connection", () => {
  it("names the declared flow and never builds an authorize URL", async () => {
    // A plugin that built its own URL would be a plugin that could point one
    // somewhere else. The host stamps the URL and the transport.
    const host = makeHost();
    delete host.flows.connectOAuth;
    assert.deepEqual(await bind(host).connectOAuth(), { authSession: { sessionId: "linear" } });
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

  it("reads a declined handoff as an answer, not as a failure", async () => {
    const host = makeHost();
    host.flows.adoptHandoff = () => false;
    const result = await bind(host).adoptHandoff();
    assert.equal(result.message, "ADE kept the connection.");
    assert.ok(!("ok" in result), "a decline is not an error");
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
