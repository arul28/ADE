// The publish path, end to end, with no second mapping anywhere in it.
//
// Every other test in this directory proves ONE half. `panels.test.js` hands a
// builder a hand-written object and reads the schema; `index.test.js` proves
// the wiring resolves. Neither could see the bug that shipped: `viewFor` sent a
// FLAT view and the panel half re-derived `connected` from a `model.connection`
// nobody sent, so `isConnected` was always false and a connected reader got the
// "Connect Linear" card. Both halves passed their own tests. The seam was
// untested, and the fixtures on each side were written to agree with the half
// they belonged to.
//
// So this test owns the seam and neither half owns it. It loads the REAL entry
// point, gives it a fake ADE and a fake Linear, seeds a connected workspace,
// calls `__internals.publish(...)` — the same function every refresh, webhook
// and press goes through — and asserts on the bytes the host is handed.
//
// The rule it enforces: what `index.js:viewFor` produces is what a builder
// reads. Nothing in between reshapes anything.

"use strict";

const assert = require("node:assert/strict");
const { afterEach, describe, it } = require("node:test");

const plugin = require("../index");
const contract = require("../panels/contract");
const { COPY } = require("../panels/common");
const { createSdk, issueNode } = require("./support");

/* ── The fake Linear ────────────────────────────────────────────────────── */

/** The two issues this workspace holds, in two different workflow states. */
const ISSUES = [
  issueNode({
    id: "issue-1",
    identifier: "ENG-1",
    title: "Fix the login redirect",
    state: { id: "state-started", name: "In Progress", type: "started" },
    labels: { nodes: [{ id: "label-1", name: "bug", color: "#f00" }, { id: "label-2", name: "auth", color: "#0f0" }] },
    startedAt: "2026-08-21T00:00:00.000Z",
    cycle: { id: "cycle-1", name: null, number: 14 },
  }),
  issueNode({
    id: "issue-2",
    identifier: "ENG-2",
    title: "Rotate the signing secret",
    state: { id: "state-todo", name: "Todo", type: "unstarted" },
    labels: { nodes: [] },
    updatedAt: "2026-08-19T00:00:00.000Z",
  }),
];

// Two teams, because the team control only draws for a workspace that has more
// than one — which is also the only workspace where filtering by team means
// anything.
const TEAMS = [
  {
    id: "team-1",
    key: "ENG",
    name: "Engineering",
    states: { nodes: [{ id: "state-started", name: "In Progress", type: "started" }, { id: "state-todo", name: "Todo", type: "unstarted" }] },
  },
  {
    id: "team-2",
    key: "OPS",
    name: "Operations",
    states: { nodes: [{ id: "state-ops", name: "Todo", type: "unstarted" }] },
  },
];

/**
 * A Linear that answers by operation name.
 *
 * `linearApi` puts `operationName` in every request body, so one fake can serve
 * the whole activate — the identity read, the catalog and the issue search —
 * without a queue whose order the test would then depend on.
 */
function linearFetch() {
  const calls = [];
  const requests = [];
  const impl = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.operationName);
    requests.push({ operationName: body.operationName, variables: body.variables ?? null });
    const data = {
      ConnectionIdentity: {
        viewer: { id: "user-1", name: "Ada", displayName: "Ada L" },
        organization: { id: "org-1", name: "Acme", urlKey: "acme", logoUrl: null },
      },
      AllTeamStates: { teams: { nodes: TEAMS } },
      TeamStates: { teams: { nodes: TEAMS } },
      Projects: { projects: { nodes: [{ id: "proj-1", name: "Platform", slugId: "platform" }] } },
      Users: { users: { nodes: [{ id: "user-1", name: "Ada", displayName: "Ada L", email: "ada@acme.test" }] } },
      Labels: { issueLabels: { nodes: [] } },
      SearchIssues: { issues: { nodes: ISSUES, pageInfo: { hasNextPage: false, endCursor: null } } },
      IssueComments: { issue: { comments: { nodes: [] } } },
    }[body.operationName] ?? {};
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      async text() {
        return JSON.stringify({ data });
      },
    };
  };
  impl.calls = calls;
  impl.requests = requests;
  return impl;
}

/* ── The fake ADE ───────────────────────────────────────────────────────── */

function host(overrides = {}) {
  // `actions` LAST, so a test that adds one verb keeps the two every activate
  // needs rather than replacing the whole namespace with its own.
  return createSdk({
    secrets: undefined,
    ...overrides,
    actions: {
      "chat.getAvailableModels": async () => [{ value: "opus-5", label: "Opus 5" }],
      "git.getOriginRemote": async () => "https://github.com/acme/app.git",
      ...(overrides.actions ?? {}),
    },
  });
}

/**
 * Activate the real plugin against a fake ADE and a fake Linear.
 *
 * `connected` seeds the API key before activate, which is the only difference
 * between a machine that has signed in and one that has not — exactly as it is
 * in the product.
 */
async function activate({ connected = true, ...overrides } = {}) {
  const sdk = host(overrides);
  if (connected) {
    await sdk.secrets.set("LINEAR_ACCESS_TOKEN", "lin_api_abcdefghijklmnopqrstuv");
    await sdk.secrets.set("LINEAR_AUTH_MODE", "manual");
  }
  linear = linearFetch();
  await withLinear(() => plugin.activate(sdk));
  return { sdk, linear };
}

/**
 * The fake Linear for the activation under test, and every request it saw.
 *
 * ONE instance per activate, not one per step. `createLinearApi` captures
 * `globalThis.fetch` at construction (`linearApi.js:fetch = globalThis.fetch`),
 * so the client built during `activate` is pinned to whatever fake was
 * installed then — a fresh fake per step would record nothing and quietly
 * assert against an empty list.
 */
let linear = null;

/** Run one step of the plugin with the fake Linear in place of the real one. */
async function withLinear(run) {
  const realFetch = globalThis.fetch;
  if (!linear) linear = linearFetch();
  globalThis.fetch = linear;
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** Publish one panel through the real path and hand back what the host got. */
async function published(sdk, panelId, context = null) {
  await withLinear(() => plugin.__internals.publish(panelId, context));
  return sdk.panels.get(panelId);
}

/* ── Walking a published schema ─────────────────────────────────────────── */

function everyNode(value, found = []) {
  if (Array.isArray(value)) {
    for (const entry of value) everyNode(entry, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  if (typeof value.component === "string") found.push(value);
  for (const entry of Object.values(value)) everyNode(entry, found);
  return found;
}

function nodesOf(panel, component) {
  return everyNode(panel).filter((node) => node.component === component);
}

function pressed(panel) {
  return new Set(
    [
      ...everyNode(panel)
        .flatMap((node) => [node.onPress, node.onChange, node.action?.onPress, node.submit?.onPress]),
      panel.chrome?.search?.onChange,
      ...(panel.chrome?.navActions ?? []),
    ]
      .filter(Boolean)
      .map((press) => press.action),
  );
}

afterEach(async () => {
  await plugin.deactivate().catch(() => {});
  linear = null;
});

/* ── The issue list ─────────────────────────────────────────────────────── */

describe("the issue list a connected reader is actually published", () => {
  it("draws the list, not the connect card", async () => {
    // THE REGRESSION. The panel half derived `connected` from `model.connection`
    // and `viewFor` never sent one, so every connected reader was published the
    // "Connect Linear" empty state with no error anywhere to say why.
    const { sdk } = await activate();
    const panel = await published(sdk, "issues");

    const emptyStates = nodesOf(panel, "emptyState").map((node) => node.title);
    assert.ok(!emptyStates.includes(COPY.connectTitle), `published the connect card: ${emptyStates}`);
    assert.ok(!pressed(panel).has(contract.ACTIONS.connectOAuth), "published a sign-in button to a signed-in reader");
  });

  it("binds the rows rather than carrying them", async () => {
    // Every issue arrives through a collection BINDING, so the schema is the
    // same handful of bytes whether the workspace holds two issues or nine
    // hundred. A panel with no binding is a panel that would have to.
    const { sdk } = await activate();
    const panel = await published(sdk, "issues");

    const lists = nodesOf(panel, "list");
    assert.ok(lists.length > 0, "no bound list in the published issue panel");
    for (const list of lists) {
      assert.equal(list.bind.collection, contract.COLLECTION_ISSUES);
      for (const action of list.bind.allowActions) {
        assert.ok(contract.ISSUE_ROW_ACTIONS.includes(action), `${action} is not a declared row verb`);
      }
    }
    // One section per workflow state the two issues sit in, keyed on the state
    // id so renaming a state in Linear does not re-open a folded section.
    const groups = nodesOf(panel, "group");
    // In the built-in's fixed rank order, which is In Progress before Todo.
    assert.deepEqual(groups.map((node) => node.groupKey), ["state-started", "state-todo"]);
    for (const [index, group] of groups.entries()) {
      const [list] = everyNode(group.children).filter((node) => node.component === "list");
      assert.equal(list.bind.keyPrefix, contract.groupKeyPrefix(groups[index].groupKey));
    }
  });

  it("carries the stored filter's own value into the control the reader sees", async () => {
    // `data.js` stores the preset as `stateTab` and the builder reads
    // `statePreset`. ONE mapper does that rename, in `viewFor`. This is the
    // check that the rename happens at all: nothing else can see both names.
    const { sdk } = await activate();
    await withLinear(() => plugin.actions.applyFilters({ [contract.STATE_PRESET]: "active" }));
    const panel = await published(sdk, "issues");

    const preset = nodesOf(panel, "segmented").find((node) => node.stateKey === contract.STATE_PRESET);
    assert.ok(preset, "no state preset control");
    assert.equal(preset.default, "active");
    // And a filter that is away from its unset value offers the way back.
    assert.ok(pressed(panel).has(contract.ACTIONS.clearFilters));
  });

  it("keeps grouped lists selectable after a filter change", async () => {
    // Grouped lists share one batch key. A filter change used to drop `view`
    // and force a flat list; that toggle is gone, and the published panel must
    // still tick.
    const { sdk } = await activate();
    await withLinear(() => plugin.actions.applyFilters({ [contract.STATE_PRESET]: "all" }));
    const panel = await published(sdk, "issues");

    assert.ok(nodesOf(panel, "group").length > 0, "the list is not grouped");
    const selectable = nodesOf(panel, "list").filter((node) => node.selectable);
    assert.ok(selectable.length > 0, "grouped lists do not tick");
    assert.equal(selectable[0].selectable.stateKey, contract.STATE_BATCH);
    assert.equal(panel.chrome.search.stateKey, contract.STATE_SEARCH);
    assert.ok(!nodesOf(panel, "segmented").some((node) => node.stateKey === contract.STATE_VIEW));
  });

  it("sends the team the reader picked to Linear, and draws it back", async () => {
    // The team control dispatched `applyFilters` into a patch key nothing
    // stored, so it moved and changed nothing at all — the same two-key-spaces
    // defect as the state preset. It is a ROUND TRIP and not a client `where`:
    // the team decides which groups exist, and a predicate hides rows inside a
    // section without removing the section.
    const { sdk } = await activate();
    await withLinear(() => plugin.actions.applyFilters({ [contract.STATE_TEAM]: "ENG" }));

    // It reached Linear, in the one shape `IssueFilter` offers.
    const search = [...linear.requests].reverse().find((request) => request.operationName === "SearchIssues");
    assert.deepEqual(search?.variables?.filter?.team, { key: { eq: "ENG" } });

    // And it comes back on the control, so the reader sees what is filtering.
    const panel = await published(sdk, "issues");
    const control = nodesOf(panel, "segmented").find((node) => node.stateKey === contract.STATE_TEAM);
    assert.ok(control, "no team control");
    assert.equal(control.default, "ENG");
    // Bound on the KEY, not the id: the value rides back as `teamKey` and
    // reaches Linear as `team: { key: { eq } }`. Binding the id would have sent
    // a uuid where a key belongs and matched nothing.
    assert.equal(control.optionsFrom.valueField, "key");
    assert.ok(pressed(panel).has(contract.ACTIONS.clearFilters), "no way back from a team filter");
  });

  it("publishes the connect card when there IS no credential", async () => {
    const { sdk } = await activate({ connected: false });
    const panel = await published(sdk, "issues");
    assert.equal(nodesOf(panel, "segmented").length, 0);
    assert.equal(nodesOf(panel, "emptyState")[0].title, COPY.connectTitle);
    assert.ok(pressed(panel).has(contract.ACTIONS.connectOAuth));
  });
});

/* ── The issue detail ───────────────────────────────────────────────────── */

describe("the issue detail a connected reader is actually published", () => {
  it("draws a chip per label, from the rows the plugin stores", async () => {
    // The row stores `{id, name, color}`; the panel draws one badge per NAME.
    // The panel half filtered for strings, so against the stored shape every
    // label was silently dropped. `viewFor` maps them, and only `viewFor`.
    const { sdk } = await activate();
    const panel = await published(sdk, "issue", { issueId: "issue-1" });

    const chips = nodesOf(panel, "badge").map((node) => node.text);
    assert.ok(chips.includes("bug"), `no label chips: ${chips}`);
    assert.ok(chips.includes("auth"), `no label chips: ${chips}`);
  });

  it("draws the properties Linear actually answered with", async () => {
    // Four rows on this card once read fields `normalizeIssue` never produced.
    // Three are real and now fetched; the fourth needed a second query and its
    // row is gone rather than drawn from nothing.
    const { sdk } = await activate();
    const panel = await published(sdk, "issue", { issueId: "issue-1" });

    const [properties] = nodesOf(panel, "keyValue");
    const rows = new Map(properties.rows.map((row) => [row.key, row.value]));
    assert.equal(rows.get(COPY.propStatus), "In Progress");
    assert.equal(rows.get(COPY.propCycle), "Cycle 14");
    assert.equal(rows.get(COPY.propStarted), "2026-08-21T00:00:00.000Z");
    assert.ok(!properties.rows.some((row) => row.key === "Blockers"));
  });

  it("publishes the connect card rather than 'not found' with no credential", async () => {
    const { sdk } = await activate({ connected: false });
    const panel = await published(sdk, "issue", { issueId: "issue-1" });
    assert.equal(nodesOf(panel, "emptyState")[0].title, COPY.connectTitle);
  });
});

/* ── Settings ───────────────────────────────────────────────────────────── */

describe("the settings panel a reader is actually published", () => {
  it("offers the adopt-handoff button while ADE is still offering the credential", async () => {
    // `handoffLabel` maps the SDK's `accepted` | `declined` | `empty` into the
    // panel's `offered` | `taken` | `declined`. The two once shared the name
    // `handoffStatus`, the card compared the stored word to `offered`, and the
    // button could never draw for anybody.
    const { sdk } = await activate({ connected: false, handoff: { builtin: "linear" } });
    const panel = await published(sdk, "settings");
    assert.ok(
      pressed(panel).has(contract.ACTIONS.adoptHandoff),
      `no adopt button: ${[...pressed(panel)].join(", ")}`,
    );
  });

  it("withdraws it once the handoff has been answered", async () => {
    const { sdk } = await activate({ connected: false, handoff: { builtin: "linear", status: "declined" } });
    const panel = await published(sdk, "settings");
    assert.ok(!pressed(panel).has(contract.ACTIONS.adoptHandoff));
  });

  it("words the stored auth mode as the reader's own", async () => {
    // Stored as `manual`, which is the handoff's vocabulary and must not
    // change; shown as "API key". That rename is `viewFor`'s, and a panel that
    // did it itself would be the second mapper this seam had.
    const { sdk } = await activate();
    const panel = await published(sdk, "settings");
    const rows = nodesOf(panel, "keyValue").flatMap((node) => node.rows);
    const method = rows.find((row) => row.key === COPY.signInMethod);
    assert.equal(method?.value, "API key");
    assert.ok(pressed(panel).has(contract.ACTIONS.disconnect), "a connected reader has no way to sign out");
  });
});

/* ── The chat header's two Linear verbs ─────────────────────────────────── */

describe("the chat header, whose socket sends a session and nothing else", () => {
  /**
   * The context that ACTUALLY arrives.
   *
   * `chat-header-action` dispatches `{context, ...args}` where context is a
   * `PluginSessionContext` — `{kind, id, title, provider, status}` — and
   * `PluginChatHeaderActions` passes no extra args. There is no `laneId` on it,
   * which is the fact both of these verbs were written without.
   */
  function sessionContext(id = "session-1") {
    return { context: { kind: "session", id, title: "Fix the login redirect", provider: "claude", status: "idle" } };
  }

  const LANES = [{ id: "lane-1", name: "First lane" }, { id: "lane-2", name: "Second lane" }];

  /** Two lanes, each with its own Linear issue, and one session inside lane 2. */
  function chatHost() {
    return {
      lanes: [
        { ...LANES[0], primaryIssue: { provider: "linear", issueId: "issue-1", key: "ENG-1" }, issueLinks: [] },
        { ...LANES[1], primaryIssue: { provider: "linear", issueId: "issue-2", key: "ENG-2" }, issueLinks: [] },
      ],
      sessionIssues: { "lane-2": [{ sessionId: "session-1", issueLinks: [] }] },
    };
  }

  it("opens the issue of the lane the CHAT is in", async () => {
    // The verb branched on `kind === "lane"` and `kind === "composer"`, and the
    // socket sends neither — so the chat header's primary Linear button
    // answered "this lane has no Linear issue attached" for every chat in every
    // lane, including lanes that plainly had one.
    await activate(chatHost());
    const result = await withLinear(() => plugin.actions.openSessionIssue(sessionContext()));
    assert.equal(result.navigate?.panelId, "issue");
    assert.equal(result.navigate.context.issueId, "issue-2");
  });

  it("comments on the chat's OWN issue, never on the first one it can find", async () => {
    // THE REGRESSION. `rows.find(row => row.laneId === laneId) ?? rows[0]` with
    // a `laneId` that was always null: every press posted the transcript onto
    // the first Linear-linked lane in the project — `issue-1` here — which is a
    // ticket other people read and not the one the reader was looking at.
    await activate({
      ...chatHost(),
      actions: {
        "chat.readTranscript": async () => [{ role: "assistant", text: "Fixed the redirect." }],
      },
    });
    const original = globalThis.fetch;
    globalThis.fetch = linearFetch();
    let result;
    try {
      result = await plugin.actions.commentProgress(sessionContext());
    } finally {
      globalThis.fetch = original;
    }
    assert.ok(result.message?.includes("ENG-2"), `commented on the wrong issue: ${result.message}`);
    assert.ok(!result.message?.includes("ENG-1"), "commented on the first lane in the project");
  });

  it("says there is no issue rather than picking somebody else's", async () => {
    // A chat in a lane with no Linear issue, and a host that cannot say which
    // lane holds the session, are both honestly "there is nothing here".
    await activate({ lanes: [], sessionIssues: {} });
    const opened = await withLinear(() => plugin.actions.openSessionIssue(sessionContext()));
    assert.equal(opened.ok, false);
    assert.ok(opened.message.includes("no Linear issue"));

    const commented = await withLinear(() => plugin.actions.commentProgress(sessionContext()));
    assert.equal(commented.ok, false);
    assert.ok(commented.message.includes("no Linear issue"));
  });

  it("still reads a lane context and a composer context, which do name their lane", async () => {
    await activate(chatHost());
    const fromLane = await withLinear(() => plugin.actions.openSessionIssue({ context: { kind: "lane", id: "lane-1" } }));
    assert.equal(fromLane.navigate.context.issueId, "issue-1");

    const fromComposer = await withLinear(() => plugin.actions.openSessionIssue({
      context: { kind: "composer", laneId: "lane-2" },
    }));
    assert.equal(fromComposer.navigate.context.issueId, "issue-2");
  });
});

/* ── The launch form ────────────────────────────────────────────────────── */

describe("the launch form a reader is actually published", () => {
  it("opens on the issue, with a model the picker can default to", async () => {
    const { sdk } = await activate();
    const panel = await published(sdk, "launch", { issueId: "issue-1" });

    const [form] = nodesOf(panel, "form");
    assert.ok(form, "no launch form");
    assert.equal(form.submit.onPress.action, contract.ACTIONS.submitLaunch);
    assert.equal(form.submit.onPress.args.issueId, "issue-1");
    // The picker opens on a real choice rather than on its first option, which
    // would silently be a different model from the one they picked last time.
    const models = form.fields.find((field) => field.id === "model");
    if (models) assert.ok(models.value, "the model picker opens on nothing");
    assert.ok(nodesOf(panel, "text").some((node) => node.variant === "code"), "no branch name to compare");
  });
});
