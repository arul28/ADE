// The lifecycle, and the one check nothing else can make.
//
// Every other test in this directory proves one module against injected fakes.
// This one loads the REAL entry point the way the child bootstrap does, runs
// `activate` against a fake host, and asks the question that spans the two
// halves of the package: does every action id somebody can press actually
// resolve to a function?
//
// Four places declare one, and none of them can check the others:
//
//   * `plugin.json` — sockets, tools, automation steps, search providers,
//     keybindings and the panels' `refreshAction` fields;
//   * `panels/contract.js` — the ids a panel schema dispatches;
//   * `panelActions.js` — the handlers the panel half defines;
//   * `index.js` — the handlers this half defines.
//
// A gap between them is a button that does nothing, and it is silent: the host
// answers "no such action" to a press nobody is watching.

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { afterEach, describe, it } = require("node:test");

const plugin = require("../index");
const { ACTIONS } = require("../panels/contract");
const panelActions = require("../panelActions");
const { createApi, createSdk, issueNode } = require("./support");

const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "plugin.json"), "utf8"));

/** Every action id `plugin.json` names, wherever it names one. */
function declaredActionIds() {
  const ids = new Set();
  for (const panel of MANIFEST.panels ?? []) if (panel.refreshAction) ids.add(panel.refreshAction);
  for (const socket of MANIFEST.sockets ?? []) {
    if (socket.actionId) ids.add(socket.actionId);
    for (const entry of socket.menu ?? []) if (entry.actionId) ids.add(entry.actionId);
  }
  for (const tool of MANIFEST.tools ?? []) if (tool.action) ids.add(tool.action);
  for (const step of MANIFEST.automationSteps ?? []) if (step.action) ids.add(step.action);
  for (const provider of MANIFEST.searchProviders ?? []) if (provider.action) ids.add(provider.action);
  for (const binding of MANIFEST.keybindings ?? []) if (binding.action) ids.add(binding.action);
  for (const matcher of MANIFEST.urlMatchers ?? []) if (matcher.actionId) ids.add(matcher.actionId);
  for (const word of MANIFEST.cli ?? []) ids.add(typeof word === "string" ? word : word?.action);
  ids.delete(undefined);
  return [...ids];
}

function host(overrides = {}) {
  return createSdk({
    actions: {
      "chat.getAvailableModels": async () => [{ id: "codex/gpt", label: "GPT" }],
      "git.getOriginRemote": async () => "https://github.com/acme/app.git",
      "lane.create": async (args) => ({ id: "lane-1", name: args.name, branchRef: args.branchName }),
      "pr.getDetail": async () => ({ pr: { state: "open", laneId: null } }),
      ...(overrides.actions ?? {}),
    },
    ...overrides,
  });
}

/** Run `activate` against a fake host and hand back both. */
async function activated(overrides = {}) {
  const sdk = host(overrides);
  // The real client is replaced wholesale: this test is about the WIRING, and
  // a plugin that reached Linear here would be testing Linear.
  const original = plugin.__internals;
  await plugin.activate(sdk);
  return { sdk, original };
}

afterEach(async () => {
  await plugin.deactivate().catch(() => {});
});

describe("loading the package the way the child bootstrap does", () => {
  it("exports the three things the host calls", () => {
    assert.equal(typeof plugin.activate, "function");
    assert.equal(typeof plugin.deactivate, "function");
    assert.equal(typeof plugin.actions, "object");
  });

  it("resolves every manifest-declared action id BEFORE activate", () => {
    // A tool call or a CLI word can arrive before the first `activate`
    // finishes, and "no such action" for a declared tool is a failure the model
    // reports to the user as the tool being broken.
    for (const id of declaredActionIds()) {
      assert.equal(typeof plugin.actions[id], "function", `${id} is declared and undefined`);
    }
  });

  it("declares the ids this test expects to find, so a rename fails loudly here", () => {
    const ids = declaredActionIds();
    for (const id of [
      "refreshIssues", "refreshIssue", "refreshConnection",
      "openIssues", "openSessionIssue", "openInLinear", "commentProgress",
      "getIssueTool", "searchIssuesTool", "addCommentTool", "updateIssueStateTool",
      "listStatesTool", "assignIssueTool", "addLabelTool", "createLaneForIssueTool", "graphqlTool",
      "stepSetIssueState", "stepCommentOnIssue", "stepAssignIssue", "stepCloseIssueOnMerge",
      "searchIssuesProvider", "linear",
    ]) {
      assert.ok(ids.includes(id), `${id} is no longer declared in plugin.json`);
    }
  });
});

describe("activate", () => {
  it("resolves every action id the PANEL half can dispatch", async () => {
    // The union check: `contract.js` is what a panel schema names, and a name
    // neither half defines renders as a button that silently does nothing.
    await activated();
    for (const id of Object.values(ACTIONS)) {
      assert.equal(typeof plugin.actions[id], "function", `${id} is in contract.js and undefined`);
    }
  });

  it("lets no id be defined by BOTH halves, so no merge order decides anything", async () => {
    // A collision was resolved by `Object.assign(actions, panelHandlers,
    // ownActions)` — last one wins — and that is how three handlers in
    // `panelActions.js` came to be unreachable while reading as the live ones.
    // Disjoint tables mean the merge order cannot decide anything, so it cannot
    // decide it wrongly.
    const { sdk } = await activated();
    const panelOnly = Object.keys(panelActions.bind({ publish: async () => {}, model: () => ({}) }));
    const ownOnly = Object.keys(require("../index").__internals.ownActions);
    const shared = panelOnly.filter((id) => ownOnly.includes(id));
    assert.deepEqual(shared, [], `both halves define ${shared.join(", ")}`);
    assert.ok(sdk);
  });

  it("keeps the three refresh ids as the DATA half's, not the panel half's", async () => {
    // `plugin.json` names them on `refreshAction`, and the data half is what
    // performs them. The merge order is what guarantees it.
    const before = {
      refreshIssues: plugin.actions.refreshIssues,
      refreshIssue: plugin.actions.refreshIssue,
      refreshConnection: plugin.actions.refreshConnection,
    };
    await activated();
    for (const [id, fn] of Object.entries(before)) {
      assert.equal(plugin.actions[id], fn, `${id} was replaced by the panel half`);
    }
  });

  it("subscribes to the four events it acts on", async () => {
    const { sdk } = await activated();
    const events = sdk.calls.filter(([name]) => name === "events.on").map(([, event]) => event).sort();
    assert.deepEqual(events, ["auth.completed", "lane.changed", "pr.changed", "webhook.received"]);
  });

  it("subscribes to auth.completed BEFORE anything can begin a sign-in", async () => {
    // The SDK requires it: a `beginSession` whose listener is not yet attached
    // loses its own result.
    const { sdk } = await activated();
    const order = sdk.calls.map(([name, arg]) => (name === "events.on" ? `on:${arg}` : name));
    const listened = order.indexOf("on:auth.completed");
    const handoff = order.indexOf("auth.requestHandoff");
    assert.ok(listened >= 0);
    assert.ok(handoff === -1 || listened < handoff, "the handoff ran before the listener was attached");
  });

  it("asks for the credential handoff exactly once", async () => {
    const { sdk } = await activated();
    assert.equal(sdk.calls.filter(([name]) => name === "auth.requestHandoff").length, 1);
  });

  it("publishes the gating pane before anything can fail", async () => {
    // The `main` panel is the one a client with no plugin process still draws,
    // so it goes out before the first Linear read.
    const { sdk } = await activated();
    const published = sdk.calls.filter(([name]) => name === "panels.update").map(([, id]) => id);
    assert.equal(published[0], "main");
  });

  it("draws the panels without a credential rather than failing to start", async () => {
    // A machine with no Linear connection is the normal state on install day.
    const { sdk } = await activated();
    const published = new Set(sdk.calls.filter(([name]) => name === "panels.update").map(([, id]) => id));
    assert.ok(published.has("settings"));
    assert.ok(published.has("issues"));
  });

  it("does not throw when the host refuses every panel write", async () => {
    const sdk = host();
    sdk.panels.update = async () => { throw new Error("no project attached"); };
    await assert.doesNotReject(() => plugin.activate(sdk));
  });
});

describe("the two facts a schema cannot compute for itself", () => {
  it("pre-formats the token's remaining life, because a schema has no dates", () => {
    const { expiry } = plugin.__internals;
    const inDays = new Date(Date.now() + 6 * 86_400_000).toISOString();
    assert.deepEqual(expiry(inDays), { expiresIn: "expires in 6 days", expired: false });

    const inHours = new Date(Date.now() + 3 * 3_600_000).toISOString();
    assert.deepEqual(expiry(inHours), { expiresIn: "expires in 3 hours", expired: false });

    const past = new Date(Date.now() - 1_000).toISOString();
    assert.deepEqual(expiry(past), { expiresIn: "expired", expired: true });
  });

  it("says nothing rather than 'never' for a credential that does not expire", () => {
    // An API key has no expiry, and the Token row simply does not render.
    const { expiry } = plugin.__internals;
    assert.deepEqual(expiry(null), { expiresIn: null, expired: false });
    assert.deepEqual(expiry("not a date"), { expiresIn: null, expired: false });
  });

  it("maps the handoff into the four words the settings card branches on", () => {
    // Two vocabularies, two names. The SDK's answer is `handoffAnswer`
    // (`accepted` | `declined` | `empty`) and the panel's word is
    // `handoffStatus` (`offered` | `taken` | `declined`). They were both
    // spelled `handoffStatus` once: the settings card compared the stored word
    // to `offered`, and the adopt button could never draw.
    const { handoffLabel } = plugin.__internals;
    assert.equal(handoffLabel({ canHandoff: true }), "offered");
    assert.equal(handoffLabel({ handoffAnswer: "accepted" }), "taken");
    assert.equal(handoffLabel({ handoffAnswer: "declined" }), "declined");
    // `empty` is null, NOT "offered": there is nothing on this machine to
    // adopt, and a button that copies nothing is worse than no button.
    assert.equal(handoffLabel({ handoffAnswer: "empty" }), null);
    assert.equal(handoffLabel({}), null);
    // And the SDK's word under the PANEL's name maps to nothing, which is what
    // stops the two from being confused for each other again.
    assert.equal(handoffLabel({ handoffStatus: "accepted" }), null);
  });
});

describe("republishing a panel that is ABOUT something", () => {
  /**
   * The panel half's host capability is `publish(panelId)` — one argument.
   *
   * So every republish it makes of the issue or launch panel arrives with
   * nothing naming the issue. Before this was handled, a handler that wrote a
   * comment and then redrew the panel blanked the issue it had just changed,
   * and the launch form showed "that issue is not in this view" the moment it
   * opened. Both are silent: the panel renders, it is just empty.
   */
  async function seeded() {
    const built = await activated({
      actions: { "chat.getAvailableModels": async () => [{ id: "codex/gpt", label: "GPT" }] },
    });
    return built;
  }

  it("draws the issue panel on a context-less republish, not an empty one", async () => {
    const { sdk } = await seeded();
    await plugin.__internals.publish("issue", { issueId: "a" });
    // The panel half's redraw: a panel id and nothing else.
    await plugin.__internals.publish("issue");
    const schema = sdk.panels.get("issue");
    // A blanked panel is the "could not be found" empty state.
    assert.ok(schema);
    assert.ok(!JSON.stringify(schema).includes("could not be found"));
  });

  it("prefers the client's own context over what it remembered", async () => {
    const { sdk } = await seeded();
    await plugin.__internals.publish("issue", { issueId: "a" });
    await plugin.__internals.publish("issue", { issueId: "b" });
    // Whatever the client says is on screen wins; the memory is only ever the
    // fallback for the caller that structurally cannot say.
    assert.ok(sdk.panels.get("issue"));
  });

  it("forgets the subject on deactivate, so a restart resumes nothing stale", async () => {
    await seeded();
    await plugin.__internals.publish("issue", { issueId: "a" });
    await plugin.deactivate();
    const { sdk } = await seeded();
    await plugin.__internals.publish("issue");
    assert.ok(sdk.panels.get("issue"));
  });
});

describe("a connection Linear will never deliver webhooks to", () => {
  /**
   * Linear delivers data-change webhooks only to an authorization carrying
   * `admin`, and BOTH OAuth clients ask for it — ADE's own registered app and
   * one the user registered themselves. What is left without a grant is the
   * API-key connection: a personal key carries no OAuth scope at all, so that
   * reader signs in, browses and writes issues normally, pastes the relay URL,
   * pastes the signing secret — and never receives one event.
   *
   * A webhook that never fires is indistinguishable from a workspace where
   * nothing happened, which is why every surface that reports on the ingress
   * has to say this rather than only the settings panel.
   */
  it("is possible on either OAuth client, because both ask for admin", () => {
    const { webhooksReachable } = plugin.__internals;
    assert.equal(webhooksReachable({ clientSource: "official" }), true);
    assert.equal(webhooksReachable({ clientSource: "custom" }), true);
    // An API key has no OAuth grant at all.
    assert.equal(webhooksReachable({ clientSource: null }), false);
    assert.equal(webhooksReachable({}), false);
  });

  it("the CLI stays quiet on a client the user registered, which now delivers", async () => {
    const built = await activated();
    await built.sdk.secrets.set("LINEAR_OAUTH_CLIENT_ID", "somebody-elses-app");
    const result = await plugin.actions.linear({ verb: "status" });
    assert.equal(result.clientSource, "custom");
    assert.equal(result.webhooksPossible, true);
    assert.equal(result.note, undefined);
  });

  it("the CLI stays quiet about it on ADE's own app", async () => {
    // A warning a reader cannot act on, about the connection they were told to
    // make, is noise that trains them to ignore the real one.
    await activated();
    const result = await plugin.actions.linear({ verb: "status" });
    assert.equal(result.clientSource, "official");
    assert.equal(result.webhooksPossible, true);
    assert.equal(result.note, undefined);
  });

  it("the CLI says so on an API-key connection, rather than reporting a healthy green", async () => {
    // The only connection left that cannot receive an event. `resolveClient`
    // finds no client id here at all, so `clientSource` is null.
    await activated({ officialClient: null });
    const result = await plugin.actions.linear({ verb: "status" });
    assert.equal(result.clientSource, null);
    assert.equal(result.webhooksPossible, false);
    assert.match(result.note, /will not fire/);
  });
});

describe("the webhook channel, which now fails closed", () => {
  it("declares verify against the header the relay stores", () => {
    // The relay drops every header outside PLUGIN_WEBHOOK_STORED_HEADERS
    // before the delivery is written, so a header outside it can never be
    // verified — and Linear's is unprefixed, which is why it had to be added.
    const channel = MANIFEST.webhookIngress[0];
    assert.deepEqual(channel.verify, {
      kind: "hmac-sha256",
      secretRef: "LINEAR_WEBHOOK_SECRET",
      header: "linear-signature",
    });
  });

  it("points verify at a secret this plugin can actually write", async () => {
    // A `secretRef` naming a secret nothing stores is a channel that fails
    // closed forever. `saveWebhookSecret` is the action that fills it.
    await activated();
    assert.equal(typeof plugin.actions.saveWebhookSecret, "function");
    const result = await plugin.actions.saveWebhookSecret({ secret: "lin_wh_abc" });
    assert.equal(result.ok, undefined);
    assert.match(result.message, /Saved/);
  });

  it("refuses an empty secret rather than storing one that verifies nothing", async () => {
    await activated();
    assert.equal((await plugin.actions.saveWebhookSecret({ secret: "  " })).ok, false);
  });
});

describe("deactivate", () => {
  it("unsubscribes from everything it subscribed to", async () => {
    const { sdk } = await activated();
    const before = Object.values(sdk.listeners).reduce((total, list) => total + list.length, 0);
    assert.ok(before > 0);
    await plugin.deactivate();
    const after = Object.values(sdk.listeners).reduce((total, list) => total + list.length, 0);
    assert.equal(after, 0);
  });

  it("is safe to call twice", async () => {
    await activated();
    await plugin.deactivate();
    await assert.doesNotReject(() => plugin.deactivate());
  });

  it("leaves the action table callable, because the host still holds it", async () => {
    await activated();
    await plugin.deactivate();
    assert.equal(typeof plugin.actions.refreshIssues, "function");
  });
});

describe("the CLI word", () => {
  it("lists its verbs rather than failing on an unknown one", async () => {
    await activated();
    const result = await plugin.actions.linear({ verb: "not-a-verb" });
    assert.match(result.error, /Unknown verb/);
    assert.ok(result.verbs.includes("issue"));
    assert.ok(result.verbs.includes("set-state"));
  });

  it("takes a verb positionally, the way a shell passes it", async () => {
    await activated();
    const result = await plugin.actions.linear({ _: ["not-a-verb"] });
    assert.match(result.error, /Unknown verb/);
  });

  it("defaults to listing issues, and says what is missing when it cannot", async () => {
    // On a machine with no Linear credential the honest answer is the sentence
    // that names the credential — an empty list would read as "your workspace
    // has no issues", which is a different and wrong statement.
    await activated();
    await assert.rejects(() => plugin.actions.linear({}), /No Linear credential/);
  });

  it("answers the connection for `status`", async () => {
    await activated();
    const result = await plugin.actions.linear({ verb: "status" });
    assert.ok(result.connection);
    // Never the token, on a surface that prints to a terminal and a log.
    assert.ok(!JSON.stringify(result.connection).includes("lin_api"));
  });
});

describe("navigation actions", () => {
  it("openIssues goes to the list without waiting on Linear", async () => {
    await activated();
    assert.deepEqual(await plugin.actions.openIssues(), { navigate: { panelId: "issues" } });
  });

  it("openIssue falls back to the list when given nothing", async () => {
    await activated();
    assert.deepEqual(await plugin.actions.openIssue({}), { navigate: { panelId: "issues" } });
  });

  it("openIssue reports an issue Linear does not have", async () => {
    await activated();
    const result = await plugin.actions.openIssue({ issueId: "ENG-999" });
    assert.equal(result.ok, false);
    assert.match(result.message, /ENG-999/);
  });

  it("openSessionIssue says so when the lane carries no issue", async () => {
    await activated();
    const result = await plugin.actions.openSessionIssue({ context: { kind: "lane", id: "lane-1" } });
    assert.equal(result.ok, false);
    assert.match(result.message, /no Linear issue/);
  });

  it("openInLinear refuses an issue with no stored URL", async () => {
    await activated();
    assert.equal((await plugin.actions.openInLinear({ issueId: "nope" })).ok, false);
  });
});

describe("commenting a chat's progress onto its issue", () => {
  it("refuses outside a chat", async () => {
    await activated();
    assert.equal((await plugin.actions.commentProgress({})).ok, false);
  });

  it("refuses when the lane carries no issue", async () => {
    await activated();
    const result = await plugin.actions.commentProgress({ context: { kind: "session", id: "chat-1" } });
    assert.equal(result.ok, false);
    assert.match(result.message, /no Linear issue/);
  });

  it("reads the transcript rather than inventing a summary", async () => {
    // Posting words the agent never said onto a ticket other people read is
    // not a thing a plugin may do.
    let read = null;
    const { sdk } = await activated({
      lanes: [{
        id: "lane-1",
        name: "Fix",
        primaryIssue: { provider: "linear", issueId: "a", key: "ENG-1" },
        issueLinks: [],
      }],
      actions: {
        "chat.readTranscript": async (args) => {
          read = args;
          return { entries: [{ role: "assistant", text: "I fixed it." }] };
        },
      },
    });
    await plugin.actions.commentProgress({ context: { kind: "session", id: "chat-1" }, laneId: "lane-1" });
    assert.equal(read.sessionId, "chat-1");
    assert.ok(sdk.calls.some(([name]) => name === "actions.chat.readTranscript"));
  });

  it("says the chat has nothing to report rather than posting an empty comment", async () => {
    await activated({
      lanes: [{
        id: "lane-1",
        name: "Fix",
        primaryIssue: { provider: "linear", issueId: "a", key: "ENG-1" },
        issueLinks: [],
      }],
      actions: { "chat.readTranscript": async () => ({ entries: [] }) },
    });
    const result = await plugin.actions.commentProgress({ context: { kind: "session", id: "chat-1" }, laneId: "lane-1" });
    assert.equal(result.ok, false);
    assert.match(result.message, /nothing to report/);
  });
});

describe("the lane badge published as a contribution", () => {
  it("names its socket id, because two kinds ride on one surface", async () => {
    // A published row is keyed by socket KIND, so a plugin declaring two of a
    // kind on one surface must say which declaration a row fills.
    const { sdk } = await activated({
      lanes: [{
        id: "lane-1",
        name: "Fix",
        primaryIssue: { provider: "linear", issueId: "a", key: "ENG-1" },
        issueLinks: [],
      }],
    });
    // A machine with no credential publishes no badges; drive it directly.
    await plugin.__internals.refreshCatalogAndIssues().catch(() => {});
    const published = sdk.calls.filter(([name]) => name === "contributions.publish");
    for (const [, kind, , socket, id] of published) {
      assert.equal(kind, "lane");
      assert.ok(id, `${socket} was published with no id`);
    }
  });
});
