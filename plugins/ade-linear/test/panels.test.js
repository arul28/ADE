// The panel builders, under the ceilings they have to render inside.
//
// These run under `node --test` in CommonJS, exactly as the plugin child loads
// the modules, so a missing export or a syntax error fails here rather than at
// install time. What they cannot do is parse a schema with ADE's own parser —
// that is TypeScript in `apps/desktop` — so the structural ceilings below are
// re-derived by walking the tree. The REAL parse, with zero warnings required,
// and a real desktop render live in
// `apps/desktop/src/renderer/components/plugins/linearPluginPanels.test.tsx`.
// The two files are deliberately different checks: this one proves the builders
// hold their shape with no host at all, that one proves four clients can draw
// what comes out.

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

const panels = require("../panels");
const contract = require("../panels/contract");
const { COPY, LIMITS } = require("../panels/common");
const { MAX_FILTER_CONTROLS } = require("../panels/issues");
const { commentListRow, issueIdFromRowKey, issueListRow, metaLine } = require("../panels/rows");

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "plugin.json"), "utf8"));

/* ── Walking a schema ───────────────────────────────────────────────────── */

/** Every node in a panel, in reading order, whatever key its children sit under. */
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
  return everyNode(panel.body).filter((node) => node.component === component);
}

function schemaBytes(panel) {
  return Buffer.byteLength(JSON.stringify(panel), "utf8");
}

/** Depth of the deepest node. A root `body` entry is depth 1, as the parser counts. */
function depthOf(nodes, depth = 1) {
  let deepest = 0;
  for (const node of nodes || []) {
    if (!node || typeof node !== "object") continue;
    deepest = Math.max(deepest, depth);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) deepest = Math.max(deepest, depthOf(value, depth + 1));
    }
  }
  return deepest;
}

/* ── Fixtures ───────────────────────────────────────────────────────────── */

const CONNECTION = {
  connected: true,
  authMode: "oauth",
  viewerId: "user-1",
  viewerName: "Ada",
  organizationName: "Acme",
  organizationUrlKey: "acme",
  issueCount: 143,
};

const GROUPS = [
  { stateId: "s-started", stateName: "In Progress", stateType: "started", count: 4 },
  { stateId: "s-todo", stateName: "Todo", stateType: "unstarted", count: 11 },
  { stateId: "s-backlog", stateName: "Backlog", stateType: "backlog", count: 62 },
  { stateId: "s-done", stateName: "Done", stateType: "completed", count: 66, defaultOpen: false },
];

/**
 * The issue list's VIEW, exactly as `index.js:viewFor("issues")` shapes it.
 *
 * Flat, and already in the panel half's words — there is no `connection` and no
 * `filters` branch to dig into, because the builder does no mapping at all.
 * Hand-writing a model shape here is what once hid the seam bug: this fixture
 * had a `connection` the real publish path never sends, so `isConnected` was
 * true here and false in the product.
 */
function issuesView(overrides = {}) {
  return {
    state: "list",
    error: null,
    groups: GROUPS,
    query: null,
    title: "Linear",
    statePreset: "all",
    sort: "updated_desc",
    view: "grouped",
    viewerId: CONNECTION.viewerId,
    assignedToMe: false,
    hasProjects: true,
    hasPeople: true,
    hasTeams: true,
    filtersActive: false,
    workspace: CONNECTION.organizationName,
    age: "2 minutes ago",
    ...overrides,
  };
}

const ISSUE = {
  id: "issue-1",
  identifier: "ADE-122",
  title: "Handoff glitches when the lane switches mid-turn",
  description: "## What happens\n\nThe turn is `handed off` and the next one starts twice.",
  url: "https://linear.app/acme/issue/ADE-122",
  priority: 2,
  stateId: "s-started",
  stateName: "In Progress",
  stateType: "started",
  teamKey: "ADE",
  teamName: "Platform",
  assigneeName: "Ada",
  projectName: "Runtime",
  creatorName: "Grace",
  branchName: "ade-122-handoff-glitches",
  labels: ["bug", "runtime"],
  hasLane: true,
  updatedAt: "2026-08-31T10:00:00.000Z",
};

/* ── The issue list ─────────────────────────────────────────────────────── */

describe("the issue list panel", () => {
  it("stays inside every ceiling that fails a whole panel", () => {
    const panel = panels.buildIssuesPanel(issuesView());
    const nodes = everyNode(panel.body);

    // Each of these refuses the panel outright rather than dropping one node,
    // so a list that grew past one of them is a blank screen, not a poorer one.
    assert.ok(nodes.length <= LIMITS.maxNodes, `${nodes.length} nodes`);
    assert.ok(schemaBytes(panel) <= LIMITS.maxSchemaBytes, `${schemaBytes(panel)} bytes`);
    assert.ok(depthOf(panel.body) <= 8, `depth ${depthOf(panel.body)}`);
    assert.equal(panel.v, 1);
    assert.ok(panel.fallback.title && panel.fallback.text && panel.fallback.deeplink);
  });

  it("never declares more state keys than one panel may hold", () => {
    // The one ceiling this panel can actually reach: eight controls is every
    // axis the built-in has plus the two this panel adds. A ninth is a blank
    // screen, so the strip builds in importance order and cuts the tail.
    const panel = panels.buildIssuesPanel(issuesView());
    const keys = nodesOf(panel, "segmented").map((node) => node.stateKey);
    assert.equal(new Set(keys).size, keys.length, "two controls share a state key");
    assert.ok(keys.length <= MAX_FILTER_CONTROLS, `${keys.length} controls`);
    assert.ok(keys.includes(contract.STATE_PRESET));
    assert.ok(keys.includes(contract.STATE_VIEW));
  });

  it("keeps the strip under the ceiling even when every optional axis is on", () => {
    const panel = panels.buildIssuesPanel(issuesView());
    assert.equal(nodesOf(panel, "segmented").length, MAX_FILTER_CONTROLS);
  });

  it("draws no literal control with more options than a strip can hold", () => {
    const panel = panels.buildIssuesPanel(issuesView());
    for (const node of nodesOf(panel, "segmented")) {
      assert.ok(
        node.options.length <= LIMITS.maxStateOptions,
        `${node.stateKey} declares ${node.options.length} literal options`,
      );
      assert.ok(node.options.length >= 2 || node.optionsFrom, `${node.stateKey} has one option and no binding`);
    }
  });

  it("offers the phone's one-tap 'Assigned to me' as a literal option", () => {
    // The phone's built-in has a chip, not a menu. A literal option carrying the
    // viewer's own id is what keeps that one tap when the rest of the assignees
    // arrive from a collection — a bound option would need the rows to land
    // first, and the reader would be looking at a menu of eighty names.
    const panel = panels.buildIssuesPanel(issuesView());
    const assignee = nodesOf(panel, "segmented").find((node) => node.stateKey === contract.STATE_ASSIGNEE);
    assert.ok(assignee, "no assignee control");
    const me = assignee.options.find((option) => option.label === COPY.assignedToMe);
    assert.equal(me?.value, CONNECTION.viewerId);
    assert.equal(assignee.optionsFrom.collection, contract.COLLECTION_PEOPLE);
  });

  it("omits a bound control when the plugin has no rows to bind", () => {
    const panel = panels.buildIssuesPanel(
      issuesView({ hasProjects: false, hasPeople: false, hasTeams: false }),
    );
    const keys = nodesOf(panel, "segmented").map((node) => node.stateKey);
    assert.ok(!keys.includes(contract.STATE_PROJECT));
    assert.ok(!keys.includes(contract.STATE_TEAM));
    // The assignee control survives without `people`, because "Assigned to me"
    // is a literal option and is the filter the phone reaches for most.
    assert.ok(keys.includes(contract.STATE_ASSIGNEE));
  });

  it("filters four axes on the client and no more", () => {
    // Four is `maxWhereClauses`. A fifth is dropped with a warning, which is a
    // filter that silently stops filtering — so the count is pinned here.
    const panel = panels.buildIssuesPanel(issuesView({ view: "flat" }));
    const [list] = nodesOf(panel, "list");
    assert.equal(list.bind.where.length, 4);
    assert.deepEqual(
      list.bind.where.map((clause) => clause.field),
      [contract.FIELD_PROJECT, contract.FIELD_ASSIGNEE, contract.FIELD_PRIORITY, contract.FIELD_UPDATED],
    );
    // Recency is read against the client's clock, so no row carries a `today`
    // field that would be false by morning.
    assert.deepEqual(list.bind.where[3].since, { $state: contract.STATE_UPDATED });
  });

  it("groups by state with a stable key and the phone's folded Done", () => {
    const panel = panels.buildIssuesPanel(issuesView());
    const groups = nodesOf(panel, "group");
    assert.equal(groups.length, GROUPS.length);
    assert.deepEqual(
      groups.map((node) => node.groupKey),
      GROUPS.map((group) => group.stateId),
    );
    // The key is the state id, not the title: renaming a state in Linear must
    // not re-open a section the reader just closed.
    assert.equal(groups[3].defaultOpen, false);
    assert.equal(groups[0].badge, "4");
    for (const [index, group] of groups.entries()) {
      const [list] = everyNode(group.children).filter((node) => node.component === "list");
      assert.equal(list.bind.keyPrefix, contract.groupKeyPrefix(GROUPS[index].stateId));
    }
  });

  it("ticks and batches only in the flat view", () => {
    const grouped = panels.buildIssuesPanel(issuesView());
    assert.equal(nodesOf(grouped, "list").filter((node) => node.selectable).length, 0);

    const flat = panels.buildIssuesPanel(issuesView({ view: "flat" }));
    const selectable = nodesOf(flat, "list").filter((node) => node.selectable);
    // One bar, not seven: a bulk bar is computed per list, so grouping and a
    // cross-group batch cannot both be on screen in vocabulary v1.
    assert.equal(selectable.length, 1);
    const { actions, max, stateKey } = selectable[0].selectable;
    assert.equal(stateKey, contract.STATE_BATCH);
    assert.ok(actions.length <= LIMITS.maxBulkActions, `${actions.length} bulk actions`);
    assert.ok(max <= LIMITS.maxSelectedRows);
    // The two that create lanes ask first. A mistake here costs eleven lanes.
    assert.ok(actions[0].confirm && actions[1].confirm);
  });

  it("lets a bound row press only the verbs the panel itself declared", () => {
    const panel = panels.buildIssuesPanel(issuesView({ view: "flat" }));
    for (const list of nodesOf(panel, "list")) {
      assert.ok(list.bind.allowActions.length <= 16);
      for (const action of list.bind.allowActions) {
        assert.ok(
          contract.ISSUE_ROW_ACTIONS.includes(action),
          `${action} is not a declared issue-row verb`,
        );
      }
    }
  });

  it("says it is still reading rather than that nobody is connected", () => {
    // `viewFor` sends `loading` while there is no connection ROW yet, which is
    // a different fact from a machine that read one and found no credential.
    // Telling a reader to sign in half a second before their credential lands
    // is the worse of the two answers.
    const panel = panels.buildIssuesPanel({ state: "loading" });
    assert.equal(nodesOf(panel, "segmented").length, 0);
    assert.equal(nodesOf(panel, "emptyState")[0].title, COPY.loadingTitle);
    assert.ok(!nodesOf(panel, "emptyState")[0].action, "a spinner offers nothing to press");
  });

  it("asks to sign in rather than drawing a filter strip nobody can use", () => {
    const panel = panels.buildIssuesPanel({ state: "disconnected" });
    assert.equal(nodesOf(panel, "segmented").length, 0);
    const [empty] = nodesOf(panel, "emptyState");
    assert.equal(empty.title, COPY.connectTitle);
    assert.equal(empty.action.onPress.action, contract.ACTIONS.connectOAuth);
  });

  it("offers a way out of a filter that hid everything", () => {
    const panel = panels.buildIssuesPanel(issuesView({ state: "empty", groups: [], statePreset: "active", filtersActive: true }));
    const [empty] = nodesOf(panel, "emptyState");
    assert.equal(empty.action.label, COPY.resetFilters);
    assert.equal(empty.action.onPress.action, contract.ACTIONS.clearFilters);
  });

  it("draws each preset and each optional axis from the view, unmapped", () => {
    // There is no second spelling to read here any more. `viewFor` names the
    // preset `statePreset` and the builder branches on that one word; the
    // mapping from the STORED `stateTab` is proved end to end in
    // `publish.test.js`, where stored filters actually reach a published panel.
    const active = panels.buildIssuesPanel(issuesView({ statePreset: "active" }));
    const preset = nodesOf(active, "segmented").find((node) => node.stateKey === contract.STATE_PRESET);
    assert.equal(preset.default, "active");

    const backlog = panels.buildIssuesPanel(issuesView({ statePreset: "backlog" }));
    assert.equal(
      nodesOf(backlog, "segmented").find((node) => node.stateKey === contract.STATE_PRESET).default,
      "backlog",
    );

    const noTeams = panels.buildIssuesPanel(issuesView({ hasTeams: false }));
    assert.ok(!nodesOf(noTeams, "segmented").some((node) => node.stateKey === contract.STATE_TEAM));
  });

  it("says which filters are on when a search is live", () => {
    const panel = panels.buildIssuesPanel(issuesView({ query: "handoff", filtersActive: true }));
    const labels = nodesOf(panel, "button").map((node) => node.label);
    assert.ok(labels.includes(COPY.clearSearch));
    assert.ok(labels.includes(COPY.resetFilters));
    assert.ok(nodesOf(panel, "badge").some((node) => node.text.includes("handoff")));
  });
});

/* ── The issue detail ───────────────────────────────────────────────────── */

describe("the issue detail panel", () => {
  it("draws the built-in's properties in the built-in's order", () => {
    const panel = panels.buildIssuePanel({ state: "detail", issue: ISSUE });
    const [properties] = nodesOf(panel, "keyValue");
    const keys = properties.rows.map((row) => row.key);
    assert.deepEqual(keys.slice(0, 3), [COPY.propStatus, COPY.propPriority, COPY.propAssignee]);
    assert.ok(properties.rows.length <= LIMITS.maxKeyValueRows);
    assert.ok(keys.includes(COPY.propTeam));
    assert.ok(keys.includes(COPY.propCreator));
  });

  it("renders the description as prose rather than as a wall of source", () => {
    const panel = panels.buildIssuePanel({ state: "detail", issue: ISSUE });
    const [markdown] = nodesOf(panel, "markdown");
    assert.ok(markdown.text.includes("## What happens"));
    assert.ok(markdown.text.length <= LIMITS.maxMarkdownChars);
  });

  it("keeps the branch name monospaced, which a keyValue row cannot be", () => {
    const panel = panels.buildIssuePanel({ state: "detail", issue: ISSUE });
    const code = nodesOf(panel, "text").filter((node) => node.variant === "code");
    assert.equal(code.length, 1);
    assert.equal(code[0].text, ISSUE.branchName);
  });

  it("keys its inline controls on the issue, so one panel can draw two", () => {
    // Panel state survives a re-publish of the same controls. A shared key would
    // carry the state the reader picked on ADE-122 onto ADE-140 the moment they
    // navigated, which is the one bug a single detail panel can have.
    const first = panels.buildIssuePanel({ state: "detail", issue: ISSUE });
    const second = panels.buildIssuePanel({
      state: "detail",
      issue: { ...ISSUE, id: "issue-2", identifier: "ADE-140" },
    });
    const keysOf = (panel) => nodesOf(panel, "segmented").map((node) => node.stateKey);
    for (const key of keysOf(first)) assert.ok(!keysOf(second).includes(key), `${key} is shared`);
    assert.ok(keysOf(first).includes(contract.issueStateKey("ADE-122")));
  });

  it("drops the state control when the issue has no team to read states from", () => {
    // REGRESSION. A `segmented` needs two distinct options; a bound one is
    // exempt only because its rows have not arrived. An issue whose team Linear
    // did not return used to emit one literal option and no binding, which the
    // parser refuses — so the editor vanished behind a warning nobody reads.
    // Status is still on the properties card, which is where the built-in has it.
    const panel = panels.buildIssuePanel({
      state: "detail",
      issue: { ...ISSUE, teamKey: undefined, teamName: undefined },
    });
    for (const node of nodesOf(panel, "segmented")) {
      assert.ok(node.options.length >= 2 || node.optionsFrom, `${node.stateKey} would be refused`);
    }
    const keys = nodesOf(panel, "segmented").map((node) => node.stateKey);
    assert.ok(!keys.includes(contract.issueStateKey("ADE-122")));
    const [properties] = nodesOf(panel, "keyValue");
    assert.equal(properties.rows[0].key, COPY.propStatus);
  });

  it("stops adding comments before the byte ceiling refuses the panel", () => {
    // The ceiling refuses the panel WHOLE, so an issue that lost its description
    // because its eleventh comment was long is a blank screen where there was a
    // working issue. What did not fit is said out loud instead.
    const comments = Array.from({ length: 60 }, (_, index) => ({
      author: `Person ${index}`,
      at: "2026-08-31",
      body: "x".repeat(3_000),
    }));
    const panel = panels.buildIssuePanel({ state: "detail", issue: ISSUE, comments });
    assert.ok(schemaBytes(panel) <= LIMITS.maxSchemaBytes, `${schemaBytes(panel)} bytes`);
    assert.ok(everyNode(panel.body).length <= LIMITS.maxNodes);
    const captions = nodesOf(panel, "text").map((node) => node.text);
    assert.ok(captions.some((text) => text.includes("not shown here")), "the drop is silent");
  });

  it("opens the launch configuration rather than picking a model for the reader", () => {
    // Both verbs go through `openLaunch`, which is the phone's own flow: one
    // screen serves both and `laneOnly` hides the agent half. Launching straight
    // from the detail would silently choose a model, a permission mode and a
    // kickoff prompt on the reader's behalf.
    const panel = panels.buildIssuePanel({ state: "detail", issue: ISSUE });
    const launches = nodesOf(panel, "button").filter(
      (node) => node.onPress.action === contract.ACTIONS.openLaunch,
    );
    assert.equal(launches.length, 2);
    assert.deepEqual(
      launches.map((node) => node.onPress.args.laneOnly),
      [false, true],
    );
    assert.deepEqual(launches.map((node) => node.label), [COPY.launchOne, COPY.laneOne]);

    const actions = nodesOf(panel, "button").map((node) => node.onPress.action);
    assert.ok(actions.includes(contract.ACTIONS.openInLinear));
    assert.ok(actions.includes(contract.ACTIONS.commentOnIssue));
  });

  it("draws one body per state and never an issue under the wrong title", () => {
    // The builder branches on the word it is handed and on nothing else. It
    // cannot draw ADE-122 under the title ADE-140, because `viewFor` reads the
    // row for the id the reader navigated to and hands over that row or none.
    const loading = panels.buildIssuePanel({ state: "loading" });
    assert.equal(nodesOf(loading, "emptyState").length, 1);
    assert.equal(nodesOf(loading, "markdown").length, 0);

    const missing = panels.buildIssuePanel({ state: "detail", issue: null });
    assert.equal(nodesOf(missing, "emptyState")[0].action.onPress.action, contract.ACTIONS.backToIssues);

    // No credential is the connect card, not "that issue could not be found"
    // for an issue this machine has never been able to look for.
    const disconnected = panels.buildIssuePanel({ state: "disconnected" });
    assert.equal(nodesOf(disconnected, "emptyState")[0].title, COPY.connectTitle);
    assert.equal(
      nodesOf(disconnected, "emptyState")[0].action.onPress.action,
      contract.ACTIONS.connectOAuth,
    );
  });
});

/* ── Settings ───────────────────────────────────────────────────────────── */

describe("the settings panel", () => {
  it("names only setting keys the manifest declares", () => {
    // `config.set` writes the manifest's keys and drops the rest, so a field
    // naming anything else is a control that moves and changes nothing.
    const declared = new Set(manifest.settings.map((entry) => entry.key));
    const panel = panels.buildSettingsPanel({
      connection: CONNECTION,
      settings: { moveToDoneOnMerge: true },
      teams: [{ key: "ADE", name: "Platform" }],
    });
    const form = nodesOf(panel, "form").find((node) => node.applyOnChange);
    assert.ok(form, "settings must apply without an Apply button");
    for (const field of form.fields) {
      assert.ok(declared.has(field.id), `${field.id} is not declared in plugin.json`);
    }
    assert.ok(form.fields.length <= LIMITS.maxFormFields);
  });

  it("draws the reading body before the first connection row exists", () => {
    const panel = panels.buildSettingsPanel({ state: "loading" });
    assert.equal(nodesOf(panel, "form").length, 0, "a form for a connection nobody has read yet");
    assert.equal(nodesOf(panel, "emptyState").length, 1);
  });

  it("masks the API key rather than asking for it in a plain field", () => {
    const panel = panels.buildSettingsPanel({ connection: { connected: false } });
    const [form] = nodesOf(panel, "form");
    assert.equal(form.fields[0].kind, "secret");
    assert.equal(form.submit.onPress.action, contract.ACTIONS.connectApiKey);
    const actions = nodesOf(panel, "emptyState").map((node) => node.action.onPress.action);
    assert.ok(actions.includes(contract.ACTIONS.connectOAuth));
  });

  it("offers the handoff only while ADE is still offering it", () => {
    // Top level, and in the PANEL's vocabulary. The stored SDK word is
    // `connection.handoffAnswer` — `accepted` | `declined` | `empty` — and
    // `index.js:handoffLabel` is the one place the two vocabularies meet. They
    // shared the name `handoffStatus` once, and the adopt button never drew.
    const offered = panels.buildSettingsPanel({
      connection: { connected: false },
      handoffStatus: "offered",
    });
    assert.ok(
      nodesOf(offered, "button").some((node) => node.onPress.action === contract.ACTIONS.adoptHandoff),
    );
    const declined = panels.buildSettingsPanel({
      connection: { connected: false },
      handoffStatus: "declined",
    });
    assert.ok(
      !nodesOf(declined, "button").some((node) => node.onPress.action === contract.ACTIONS.adoptHandoff),
    );
  });

  it("asks before it forgets the credential, and names the blast radius", () => {
    const panel = panels.buildSettingsPanel({ connection: CONNECTION });
    const disconnect = nodesOf(panel, "button").find(
      (node) => node.onPress.action === contract.ACTIONS.disconnect,
    );
    assert.ok(disconnect.onPress.confirm.includes("whole machine"));
  });

  it("shows the webhook URL as something to compare, not only to copy", () => {
    // A copy button that fails on a surface with no clipboard would leave a
    // reader with no way to get the string at all.
    const panel = panels.buildSettingsPanel({
      connection: CONNECTION,
      ingress: { status: "Connected", url: "https://relay.ade.dev/hook/abc" },
    });
    const code = nodesOf(panel, "text").filter((node) => node.variant === "code");
    assert.equal(code[0].text, "https://relay.ade.dev/hook/abc");
    assert.ok(
      nodesOf(panel, "button").some((node) => node.onPress.action === contract.ACTIONS.copyWebhookUrl),
    );
  });

  it("builds autolinks from literal rows, never from a collection it cannot write", () => {
    // `plugin.json` declares no `autolinks` collection, and a write to an
    // undeclared one is refused — so a binding here would draw an empty list
    // with no error anywhere.
    const panel = panels.buildSettingsPanel({
      connection: CONNECTION,
      showAutolinks: true,
      githubRepo: "acme/ade",
      autolinks: [
        { prefix: "ADE-", title: "ADE Linear issues", description: "Turns ADE-123 into a link.", configured: false },
        { prefix: "ADEPR-", title: "Open PRs in ADE", description: "Turns ADEPR-123 into a link.", configured: true },
      ],
    });
    const declared = new Set(Object.keys(manifest.collections));
    for (const node of everyNode(panel.body)) {
      if (node.bind) assert.ok(declared.has(node.bind.collection), `${node.bind.collection} is undeclared`);
    }
    const [list] = nodesOf(panel, "list");
    assert.equal(list.items.length, 2);
    assert.equal(list.items[0].actions[0].action, contract.ACTIONS.createAutolink);
    assert.equal(list.items[1].badge.text, COPY.autolinksConfigured);
    assert.ok(!list.items[1].actions, "a configured row still offers Create");
  });
});

/* ── The gating panel and the dispatcher ────────────────────────────────── */

describe("the gating panel", () => {
  it("is the manifest's own file and nothing rebuilt beside it", () => {
    const onDisk = JSON.parse(fs.readFileSync(panels.MAIN_PANEL_PATH, "utf8"));
    assert.deepEqual(panels.buildMainPanel(), onDisk);
  });

  it("hands out a fresh copy, so one caller cannot corrupt the next", () => {
    const first = panels.buildMainPanel();
    first.body.length = 0;
    assert.ok(panels.buildMainPanel().body.length > 0);
  });
});

describe("the publish dispatcher", () => {
  it("answers every panel the manifest declares", () => {
    for (const panel of manifest.panels) {
      // The dispatcher passes this straight through, so one object has to
      // carry every panel's view at once. That is the point: nothing between
      // here and a builder reshapes it.
      const built = panels.build(panel.id, {
        ...issuesView(),
        state: "detail",
        issue: ISSUE,
        connection: CONNECTION,
      });
      assert.ok(built, `build("${panel.id}") returned nothing`);
      assert.equal(built.v, 1);
      assert.ok(built.fallback?.title && built.fallback?.text, `${panel.id} has no fallback`);
    }
  });

  it("returns null for an id it does not know rather than taking the child down", () => {
    assert.equal(panels.build("nope", {}), null);
  });

  it("every declared panel's schemaFile exists and parses", () => {
    for (const panel of manifest.panels) {
      const file = path.join(__dirname, "..", panel.schemaFile);
      const seed = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(seed.v, 1, `${panel.schemaFile} declares the wrong version`);
      assert.ok(seed.fallback?.title && seed.fallback?.text, `${panel.schemaFile} has no fallback`);
    }
  });

  it("names a refresh action the panel can actually reach", () => {
    // The three refresh ids belong to `index.js`. A panel declaring one this
    // plugin never registers is a pull-to-refresh gesture that does nothing.
    const refreshable = manifest.panels.filter((panel) => panel.refreshAction);
    assert.deepEqual(
      refreshable.map((panel) => panel.refreshAction).sort(),
      [contract.ACTIONS.refreshConnection, contract.ACTIONS.refreshIssue, contract.ACTIONS.refreshIssues].sort(),
    );
  });
});

/* ── The bound row ──────────────────────────────────────────────────────── */

describe("the issue row a list binds", () => {
  const ISSUE_ROW = {
    id: "issue-1",
    identifier: "ADE-122",
    title: "Handoff glitches when the lane switches mid-turn",
    stateName: "In Progress",
    stateType: "started",
    priority: 2,
    assigneeName: "Ada",
    labelNames: "bug, runtime",
    url: "https://linear.app/acme/issue/ADE-122",
  };

  it("declares only fields the row reader actually looks at", () => {
    // `readListItem` reads eleven names and ignores every other field on the
    // row. A row carrying `badgeText`/`badgeTone` therefore draws no badge at
    // all — which is what the materialized row did before this function.
    const readable = new Set([
      "title", "key", "subtitle", "meta", "tone", "icon", "mono", "badge", "onPress", "actions", "overflow",
    ]);
    for (const key of Object.keys(issueListRow(ISSUE_ROW))) {
      assert.ok(readable.has(key), `${key} is invisible to the row reader`);
    }
  });

  it("declares its own key, so a tick never carries a sort prefix", () => {
    // A bound row inherits its COLLECTION key when it declares none, and this
    // plugin's keys encode sort order. A batch handed `flat:000012:…` would
    // create a lane named after a sort rank.
    assert.equal(issueListRow(ISSUE_ROW).key, "issue-1");
  });

  it("recovers the issue id from either key space, and leaves a bare id alone", () => {
    assert.equal(issueIdFromRowKey(contract.flatIssueKey(12, "abc")), "abc");
    assert.equal(issueIdFromRowKey(contract.groupIssueKey("s-1", 3, "abc")), "abc");
    assert.equal(issueIdFromRowKey("abc"), "abc");
    assert.equal(issueIdFromRowKey(""), null);
    assert.equal(issueIdFromRowKey(null), null);
  });

  it("carries the state as an icon, a tone AND a chip, which is both built-ins", () => {
    // The phone leads with a state icon; the desktop puts the state in its group
    // header. A row has a slot for each, so this is both rather than a choice.
    const row = issueListRow(ISSUE_ROW);
    assert.equal(row.icon, "play");
    assert.equal(row.tone, "accent");
    assert.deepEqual(row.badge, { text: "In Progress", tone: "accent", icon: "play" });
    assert.equal(row.mono, "ADE-122");
  });

  it("puts the lane first in the meta line, because it changes what a press means", () => {
    assert.ok(metaLine({ ...ISSUE_ROW, hasLane: true, laneName: "ade-122" }).startsWith("Lane: ade-122"));
    assert.ok(metaLine({ ...ISSUE_ROW, hasLane: true }).startsWith(COPY.hasLane));
    assert.ok(!metaLine(ISSUE_ROW).includes("Lane"));
  });

  it("says nothing about a priority Linear did not set", () => {
    assert.ok(!metaLine({ ...ISSUE_ROW, priority: 0 }).includes("No priority"));
    assert.ok(metaLine({ ...ISSUE_ROW, priority: 1 }).includes("Urgent"));
  });

  it("offers no launch verb on an issue that already has a lane", () => {
    const row = issueListRow({ ...ISSUE_ROW, hasLane: true, laneName: "ade-122" });
    const ids = (row.actions ?? []).map((action) => action.action);
    assert.ok(!ids.includes(contract.ACTIONS.launchLaneAndAgent));
    assert.ok(ids.includes(contract.ACTIONS.openInLinear));
  });

  it("never names a verb the binding would refuse", () => {
    // `allowActions` coerces an unlisted id to no action, so a row naming one
    // draws a button that does nothing at all.
    const row = issueListRow(ISSUE_ROW);
    const named = [
      row.onPress.action,
      ...(row.actions ?? []).map((action) => action.action),
      ...(row.overflow ?? []).map((action) => action.action),
    ];
    for (const id of named) {
      assert.ok(contract.ISSUE_ROW_ACTIONS.includes(id), `${id} is not in ISSUE_ROW_ACTIONS`);
    }
    assert.ok((row.actions ?? []).length <= LIMITS.maxListItemActions);
    assert.ok((row.overflow ?? []).length <= 6);
  });

  it("draws a row for an issue with almost nothing on it", () => {
    // Every field but the id can be absent, and a row with no title is REFUSED
    // by the reader — so the identifier is the floor.
    const row = issueListRow({ id: "x", identifier: "ADE-9" });
    assert.equal(row.title, "ADE-9");
    assert.equal(row.key, "x");
    assert.ok(typeof row.meta === "string");
  });

  it("flattens a comment body rather than drawing its markdown in a subtitle", () => {
    const row = commentListRow({
      id: "c1",
      userDisplayName: "Grace",
      createdAt: "2026-08-31",
      body: "Looks right.\n\n```js\nconst a = 1;\n```",
    });
    assert.equal(row.key, "c1");
    assert.ok(row.title.startsWith("Grace"));
    assert.ok(!row.subtitle.includes("\n"));
  });
});

/* ── The seam with the data half ────────────────────────────────────────── */

describe("the ids the two halves share", () => {
  it("never dispatches a core-owned id with a shape that half cannot read", () => {
    // `index.js` merges its handlers in AFTER this half's, so any id both halves
    // define goes to it. The three step verbs moved behind `step*` names to end
    // that collision, and `openInLinear` stayed on that side because it is also
    // a socket menu item — it resolves the URL from the stored row and ignores a
    // `url` argument. This walks every action every panel declares and fails if
    // one names a core-owned id that would be answered with the wrong shape.
    const panelsToCheck = [
      panels.buildIssuesPanel(issuesView({ view: "flat" })),
      panels.buildIssuePanel({ state: "detail", issue: ISSUE }),
      panels.buildSettingsPanel({ connection: CONNECTION, showAutolinks: true, autolinks: [] }),
      panels.buildSettingsPanel({ connection: { connected: false } }),
    ];

    const dispatched = new Set();
    const collect = (action) => {
      if (action && typeof action.action === "string") dispatched.add(action.action);
    };
    for (const panel of panelsToCheck) {
      for (const node of everyNode(panel.body)) {
        collect(node.onPress);
        collect(node.onChange);
        collect(node.applyOnChange);
        collect(node.action?.onPress ?? node.action);
        collect(node.submit?.onPress);
        for (const item of node.items ?? []) {
          collect(item.onPress);
          for (const entry of [...(item.actions ?? []), ...(item.overflow ?? [])]) collect(entry);
        }
        for (const entry of node.selectable?.actions ?? []) collect(entry);
      }
    }

    // The panel owns these three now, so it SHOULD name them.
    assert.ok(dispatched.has(contract.ACTIONS.setIssueState));
    assert.ok(dispatched.has(contract.ACTIONS.setIssuePriority));
    assert.ok(dispatched.has(contract.ACTIONS.commentOnIssue));

    // And it must never name a step verb, which reads `{issueId, stateId}`.
    for (const id of dispatched) {
      assert.ok(!id.startsWith("step"), `a schema dispatches the automation step ${id}`);
    }

    // Every id a schema names must be in the ACTIONS table. An id that is not
    // reaches a handler neither half defines, and the button does nothing at
    // all — silently, because the host answers "no such action" to a press
    // nobody is watching. WHICH half answers is not this test's business:
    // `test/index.test.js` proves every id in the table resolves, and
    // `test/panelActions.test.js` proves the data half's ids are not
    // shadowed by a second copy here.
    const mine = new Set(Object.values(contract.ACTIONS));
    for (const id of dispatched) {
      assert.ok(mine.has(id), `${id} is dispatched by a schema and is in no action table`);
    }
  });

  it("passes an issue id, never a url, to the core-owned openInLinear", () => {
    const row = issueListRow({ id: "i1", identifier: "ADE-1", title: "x", url: "https://linear.app/a/issue/ADE-1" });
    const openInLinear = (row.actions ?? []).find((action) => action.action === "openInLinear");
    assert.deepEqual(openInLinear.args, { issueId: "i1" });

    const panel = panels.buildIssuePanel({ state: "detail", issue: ISSUE });
    const button = nodesOf(panel, "button").find((node) => node.onPress.action === "openInLinear");
    assert.deepEqual(button.onPress.args, { issueId: ISSUE.id });
  });

  it("uses an id the data half does not own for a link that is not an issue", () => {
    // `openInLinear` answers by looking up a stored ISSUE row, so the settings
    // link to linear.app/settings/api has to name a different verb or be told
    // that the API settings page is not a Linear issue.
    const panel = panels.buildSettingsPanel({ connection: { connected: false } });
    const button = nodesOf(panel, "button").find((node) => node.onPress.args?.url);
    assert.equal(button.onPress.action, contract.ACTIONS.openExternal);
    assert.notEqual(button.onPress.action, contract.ACTIONS.openInLinear);
  });

  it("offers the signing secret the webhook channel cannot be verified without", () => {
    // A channel that declares `verify` and cannot find its secret FAILS CLOSED
    // and drops every delivery, so the field must exist before the manifest can
    // declare verification.
    const panel = panels.buildSettingsPanel({
      connection: CONNECTION,
      ingress: { status: "Connected", url: "https://relay.ade.dev/hook/abc", secretStored: false },
    });
    const form = nodesOf(panel, "form").find((node) => node.submit?.onPress.action === contract.ACTIONS.saveWebhookSecret);
    assert.ok(form, "no signing-secret form");
    assert.equal(form.fields[0].kind, "secret", "a credential must be masked");
    assert.ok(!form.applyOnChange, "a half-typed secret must not commit on blur");
    // The unverified state says what is actually at risk rather than "not configured".
    const captions = nodesOf(panel, "text").map((node) => node.text).join(" ");
    assert.ok(captions.includes("drops every delivery"), captions);
  });
});

/* ── The launch panel ───────────────────────────────────────────────────── */

describe("the launch panel", () => {
  /** The view `index.js` hands `build("launch", …)`, spelled as it spells it. */
  const LAUNCH_VIEW = {
    state: "form",
    issue: ISSUE,
    models: [
      { id: "claude-opus-5", label: "Opus 5" },
      { id: "gpt-5", label: "GPT-5" },
    ],
    permissionModes: ["default", "accept-edits", "full-auto"],
    // As `index.js:REASONING_EFFORTS` sends them. "Default" rides a SENTINEL
    // and not an empty string: an empty option value fails the whole select.
    reasoningEfforts: [
      { value: "default", label: "Default" },
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
      { value: "xhigh", label: "Extra high" },
    ],
    laneOnly: false,
    fastModeSupported: false,
  };

  function formOf(panel) {
    return nodesOf(panel, "form")[0];
  }

  it("labels the models rather than showing their raw ids", () => {
    // The data half sends `{id, label}`; the builder used to read `name || id`
    // and fell through to the id, so the picker listed `claude-opus-5` where the
    // phone's own sheet says "Opus 5".
    const form = formOf(panels.build("launch", LAUNCH_VIEW));
    const model = form.fields.find((field) => field.id === "model");
    assert.deepEqual(model.options.map((option) => option.label), ["Opus 5", "GPT-5"]);
  });

  it("reads a choice list whether it holds strings or objects", () => {
    // `permissionModes` arrives as bare strings and `models` as objects. One
    // reader for both, because a select of `[object Object]` renders fine and is
    // useless.
    const form = formOf(panels.build("launch", LAUNCH_VIEW));
    const permissions = form.fields.find((field) => field.id === "permissionMode");
    assert.deepEqual(permissions.options.map((option) => option.value), ["default", "accept-edits", "full-auto"]);
  });

  it("carries the default reasoning effort on a value the parser will keep", () => {
    // "Whatever the model does by default" is a real choice, and it used to
    // ride an EMPTY value. `vocabString("")` answers `undefined`, which drops
    // the option and then fails the whole field — so the Reasoning effort row
    // did not render on any client. A segmented control does accept an empty
    // value, which is where the assumption came from; a form select does not.
    const form = formOf(panels.build("launch", LAUNCH_VIEW));
    const effort = form.fields.find((field) => field.id === "reasoningEffort");
    assert.equal(effort.options.length, 5);
    assert.equal(effort.options[0].label, "Default");
    for (const option of effort.options) {
      assert.ok(
        typeof option.value === "string" && option.value.trim(),
        `the "${option.label}" option carries a value the parser drops`,
      );
    }
    // And the sentinel maps back to sending nothing, so the provider sees the
    // same request it saw before.
    const { chosenReasoningEffort } = require("../index").__internals;
    assert.equal(chosenReasoningEffort(effort.options[0].value), null);
    assert.equal(chosenReasoningEffort("high"), "high");
    assert.equal(chosenReasoningEffort(""), null);
  });

  it("reads the state the data half declares, not only a loading flag", () => {
    assert.equal(nodesOf(panels.build("launch", { ...LAUNCH_VIEW, state: "loading" }), "form").length, 0);
    assert.ok(formOf(panels.build("launch", LAUNCH_VIEW)));
  });

  it("hides the agent configuration when only a lane was asked for", () => {
    const form = formOf(panels.build("launch", { ...LAUNCH_VIEW, laneOnly: true }));
    assert.equal(form.fields.find((field) => field.id === "sessionType").value, "laneOnly");
    assert.equal(form.submit.label, "Create");
    assert.equal(form.submit.onPress.action, contract.ACTIONS.submitLaunch);
  });

  it("stays inside the form and node ceilings with every option list full", () => {
    const many = Array.from({ length: 80 }, (_, index) => ({ id: `m${index}`, label: `Model ${index}` }));
    const panel = panels.build("launch", { ...LAUNCH_VIEW, models: many, fastModeSupported: true });
    const form = formOf(panel);
    assert.ok(form.fields.length <= LIMITS.maxFormFields);
    for (const field of form.fields) {
      assert.ok((field.options ?? []).length <= LIMITS.maxSelectOptions, `${field.id} has too many options`);
    }
    assert.ok(everyNode(panel.body).length <= LIMITS.maxNodes);
    assert.ok(schemaBytes(panel) <= LIMITS.maxSchemaBytes);
  });
});

/* ── The OAuth client the sign-in uses ──────────────────────────────────── */

describe("which Linear app the connection is made with", () => {
  function warnings(panel) {
    return everyNode(panel.body)
      .filter((node) => node.tone === "warning" && typeof node.text === "string")
      .map((node) => node.text)
      .join(" ");
  }

  it("withholds a sign-in button that cannot run, and says why", () => {
    // A build with no Linear OAuth client cannot start the flow. Drawing the
    // button anyway opens an authorize URL Linear refuses, and the reader has
    // no way to tell why — so the reason takes the button's place and the API
    // key becomes the one path that works.
    const reason = "This copy of ADE has no Linear OAuth client to sign in with. Paste a Linear API key instead.";
    const panel = panels.buildSettingsPanel({ connection: { connected: false }, oauthBlockedReason: reason });

    const actions = everyNode(panel.body)
      .map((node) => node.action?.onPress?.action)
      .filter(Boolean);
    assert.ok(!actions.includes(contract.ACTIONS.connectOAuth), "drew a sign-in that cannot run");
    assert.ok(warnings(panel).includes(reason));

    // The API key path is untouched, because it is the one that still works.
    const form = nodesOf(panel, "form").find((node) => node.submit?.onPress.action === contract.ACTIONS.connectApiKey);
    assert.ok(form, "no API key form");
  });

  it("still offers the sign-in when this machine can run it", () => {
    const panel = panels.buildSettingsPanel({ connection: { connected: false } });
    const actions = everyNode(panel.body).map((node) => node.action?.onPress?.action).filter(Boolean);
    assert.ok(actions.includes(contract.ACTIONS.connectOAuth));
    assert.equal(warnings(panel), "");
  });

  it("warns that a custom Linear app will never receive a webhook", () => {
    // Linear delivers data-change events only to an authorization carrying
    // `admin`, and a custom client is narrowed to `read,write` on purpose — the
    // app is the user's own. So the same button produces a connection that
    // browses and writes normally and never receives an event. Without this,
    // the reader pastes the URL into Linear, pastes the signing secret, reads
    // "Signed deliveries only", and waits forever.
    const panel = panels.buildSettingsPanel({
      connection: { connected: true, clientSource: "custom", organizationName: "Acme" },
      clientSource: "custom",
      ingress: {
        status: "Linear will not deliver to this connection",
        url: "https://relay.ade.dev/hook/abc",
        secretStored: true,
        webhooksPossible: false,
      },
    });
    assert.ok(warnings(panel).includes("Linear does not grant webhooks to it"), warnings(panel));
    // The Webhook row carries the headline; the caption must not restate it in
    // different words, which is the duplicate the data half removed from its
    // own status string.
    assert.ok(!warnings(panel).includes("Linear will not deliver events to this connection"));
  });

  it("warns an API-key reader too, who has no OAuth grant at all", () => {
    // The case a `clientSource === "custom"` test would miss completely. An API
    // key carries no OAuth grant, so `webhooksPossible` is false with
    // `clientSource` null — and that reader would otherwise paste a signing
    // secret for a webhook that can never fire, with nothing saying so.
    const panel = panels.buildSettingsPanel({
      connection: { connected: true, authMode: "apiKey", organizationName: "Acme" },
      clientSource: null,
      ingress: {
        status: "Linear will not deliver to this connection",
        url: "https://relay.ade.dev/hook/abc",
        secretStored: true,
        webhooksPossible: false,
      },
    });
    assert.ok(warnings(panel).includes("an API key carries none"), warnings(panel));
  });

  it("falls back to clientSource for a data half that sends no flag", () => {
    const panel = panels.buildSettingsPanel({
      connection: { connected: true, clientSource: "custom", organizationName: "Acme" },
      clientSource: "custom",
      ingress: { status: "Endpoint ready", url: "https://relay.ade.dev/hook/abc", secretStored: true },
    });
    assert.ok(warnings(panel).includes("Linear does not grant webhooks to it"), warnings(panel));
  });

  it("says nothing when Linear can actually deliver", () => {
    const panel = panels.buildSettingsPanel({
      connection: { connected: true, clientSource: "official", organizationName: "Acme" },
      clientSource: "official",
      ingress: {
        status: "Endpoint ready",
        url: "https://relay.ade.dev/hook/abc",
        secretStored: true,
        webhooksPossible: true,
      },
    });
    assert.equal(warnings(panel), "");
  });

  it("says so before the reader spends ten minutes in Linear's settings", () => {
    // The warning has to come BEFORE the URL and the secret field, because
    // after them it is a post-mortem rather than a warning.
    const panel = panels.buildSettingsPanel({
      connection: { connected: true, clientSource: "custom", organizationName: "Acme" },
      clientSource: "custom",
      ingress: {
        status: "Linear will not deliver to this connection",
        url: "https://relay.ade.dev/hook/abc",
        secretStored: false,
        webhooksPossible: false,
      },
    });
    const body = everyNode(panel.body);
    const warnAt = body.findIndex(
      (node) => typeof node.text === "string" && node.text.includes("Linear does not grant webhooks to it"),
    );
    const secretAt = body.findIndex((node) => node.component === "form" && node.fields?.[0]?.id === "secret");
    assert.ok(warnAt !== -1 && secretAt !== -1);
    assert.ok(warnAt < secretAt, "the warning comes after the field it is about");
  });

  it("warns before sign-in too, so the choice is made knowingly", () => {
    // The shape the data half actually sends when nobody is signed in:
    // `connection` is NULL and `clientSource` rides at the top level, because
    // which app this build signs in as is a fact about the BUILD, not about a
    // credential that does not exist yet. Reading it only off `connection`
    // would have silently dropped the warning in exactly the state where a
    // reader can still act on it.
    const panel = panels.buildSettingsPanel({ connection: null, clientSource: "custom" });
    assert.ok(warnings(panel).includes("does not send webhooks to a connection made this way"), warnings(panel));
  });

  it("warns a disconnected reader who has a connection row but no credential", () => {
    // `viewFor` sends `clientSource` at the top level in every state, because
    // it is a fact about this BUILD. The warning must not depend on whether a
    // connection row happens to exist beside it.
    const panel = panels.buildSettingsPanel({ connection: { connected: false }, clientSource: "custom" });
    assert.ok(warnings(panel).includes("does not send webhooks to a connection made this way"), warnings(panel));
  });

  it("says nothing at all when the connection uses ADE's own app", () => {
    // The quiet case has to stay quiet: a warning a reader cannot act on, on
    // the connection they were told to make, is noise that trains them to
    // ignore the loud one.
    const panel = panels.buildSettingsPanel({
      connection: { connected: true, clientSource: "official", organizationName: "Acme" },
      ingress: { status: "Endpoint ready", url: "https://relay.ade.dev/hook/abc", secretStored: true },
    });
    assert.equal(warnings(panel), "");
  });
});
