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

function issuesModel(overrides = {}) {
  return {
    connection: CONNECTION,
    groups: GROUPS,
    filters: { hasProjects: true, hasPeople: true, hasTeams: true, ...(overrides.filters ?? {}) },
    updatedAgo: "2 minutes ago",
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
    const panel = panels.buildIssuesPanel(issuesModel());
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
    const panel = panels.buildIssuesPanel(issuesModel());
    const keys = nodesOf(panel, "segmented").map((node) => node.stateKey);
    assert.equal(new Set(keys).size, keys.length, "two controls share a state key");
    assert.ok(keys.length <= MAX_FILTER_CONTROLS, `${keys.length} controls`);
    assert.ok(keys.includes(contract.STATE_PRESET));
    assert.ok(keys.includes(contract.STATE_VIEW));
  });

  it("keeps the strip under the ceiling even when every optional axis is on", () => {
    const panel = panels.buildIssuesPanel(issuesModel());
    assert.equal(nodesOf(panel, "segmented").length, MAX_FILTER_CONTROLS);
  });

  it("draws no literal control with more options than a strip can hold", () => {
    const panel = panels.buildIssuesPanel(issuesModel());
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
    const panel = panels.buildIssuesPanel(issuesModel());
    const assignee = nodesOf(panel, "segmented").find((node) => node.stateKey === contract.STATE_ASSIGNEE);
    assert.ok(assignee, "no assignee control");
    const me = assignee.options.find((option) => option.label === COPY.assignedToMe);
    assert.equal(me?.value, CONNECTION.viewerId);
    assert.equal(assignee.optionsFrom.collection, contract.COLLECTION_PEOPLE);
  });

  it("omits a bound control when the plugin has no rows to bind", () => {
    const panel = panels.buildIssuesPanel(
      issuesModel({ filters: { hasProjects: false, hasPeople: false, hasTeams: false } }),
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
    const panel = panels.buildIssuesPanel(issuesModel({ filters: { view: "flat" } }));
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
    const panel = panels.buildIssuesPanel(issuesModel());
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
    const grouped = panels.buildIssuesPanel(issuesModel());
    assert.equal(nodesOf(grouped, "list").filter((node) => node.selectable).length, 0);

    const flat = panels.buildIssuesPanel(issuesModel({ filters: { view: "flat" } }));
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
    const panel = panels.buildIssuesPanel(issuesModel({ filters: { view: "flat" } }));
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

  it("asks to sign in rather than drawing a filter strip nobody can use", () => {
    const panel = panels.buildIssuesPanel({ connection: { connected: false } });
    assert.equal(nodesOf(panel, "segmented").length, 0);
    const [empty] = nodesOf(panel, "emptyState");
    assert.equal(empty.title, COPY.connectTitle);
    assert.equal(empty.action.onPress.action, contract.ACTIONS.connectOAuth);
  });

  it("offers a way out of a filter that hid everything", () => {
    const panel = panels.buildIssuesPanel(issuesModel({ groups: [], filters: { statePreset: "active" } }));
    const [empty] = nodesOf(panel, "emptyState");
    assert.equal(empty.action.label, COPY.resetFilters);
    assert.equal(empty.action.onPress.action, contract.ACTIONS.clearFilters);
  });

  it("says which filters are on when a search is live", () => {
    const panel = panels.buildIssuesPanel(issuesModel({ filters: { text: "handoff" } }));
    const labels = nodesOf(panel, "button").map((node) => node.label);
    assert.ok(labels.includes(COPY.clearSearch));
    assert.ok(labels.includes(COPY.resetFilters));
    assert.ok(nodesOf(panel, "badge").some((node) => node.text.includes("handoff")));
  });
});

/* ── The issue detail ───────────────────────────────────────────────────── */

describe("the issue detail panel", () => {
  it("draws the built-in's properties in the built-in's order", () => {
    const panel = panels.buildIssuePanel({ connection: CONNECTION, issue: ISSUE });
    const [properties] = nodesOf(panel, "keyValue");
    const keys = properties.rows.map((row) => row.key);
    assert.deepEqual(keys.slice(0, 3), [COPY.propStatus, COPY.propPriority, COPY.propAssignee]);
    assert.ok(properties.rows.length <= LIMITS.maxKeyValueRows);
    assert.ok(keys.includes(COPY.propTeam));
    assert.ok(keys.includes(COPY.propCreator));
  });

  it("renders the description as prose rather than as a wall of source", () => {
    const panel = panels.buildIssuePanel({ connection: CONNECTION, issue: ISSUE });
    const [markdown] = nodesOf(panel, "markdown");
    assert.ok(markdown.text.includes("## What happens"));
    assert.ok(markdown.text.length <= LIMITS.maxMarkdownChars);
  });

  it("keeps the branch name monospaced, which a keyValue row cannot be", () => {
    const panel = panels.buildIssuePanel({ connection: CONNECTION, issue: ISSUE });
    const code = nodesOf(panel, "text").filter((node) => node.variant === "code");
    assert.equal(code.length, 1);
    assert.equal(code[0].text, ISSUE.branchName);
  });

  it("keys its inline controls on the issue, so one panel can draw two", () => {
    // Panel state survives a re-publish of the same controls. A shared key would
    // carry the state the reader picked on ADE-122 onto ADE-140 the moment they
    // navigated, which is the one bug a single detail panel can have.
    const first = panels.buildIssuePanel({ connection: CONNECTION, issue: ISSUE });
    const second = panels.buildIssuePanel({
      connection: CONNECTION,
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
      connection: CONNECTION,
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
    const panel = panels.buildIssuePanel({ connection: CONNECTION, issue: ISSUE, comments });
    assert.ok(schemaBytes(panel) <= LIMITS.maxSchemaBytes, `${schemaBytes(panel)} bytes`);
    assert.ok(everyNode(panel.body).length <= LIMITS.maxNodes);
    const captions = nodesOf(panel, "text").map((node) => node.text);
    assert.ok(captions.some((text) => text.includes("not shown here")), "the drop is silent");
  });

  it("offers both launch verbs and the way out to Linear", () => {
    const panel = panels.buildIssuePanel({ connection: CONNECTION, issue: ISSUE });
    const actions = nodesOf(panel, "button").map((node) => node.onPress.action);
    assert.ok(actions.includes(contract.ACTIONS.launchLaneAndAgent));
    assert.ok(actions.includes(contract.ACTIONS.launchLaneOnly));
    assert.ok(actions.includes(contract.ACTIONS.openInLinear));
    assert.ok(actions.includes(contract.ACTIONS.commentOnIssue));
  });

  it("draws the loading body rather than the previous issue's words", () => {
    // A model carrying a different issue than the one the reader navigated to
    // means the fetch has not landed. Showing ADE-122 under the title ADE-140 is
    // the one failure worse than a spinner.
    const panel = panels.buildIssuePanel(
      { connection: CONNECTION, issue: ISSUE, loading: true },
      { issueId: "issue-2" },
    );
    assert.equal(nodesOf(panel, "emptyState").length, 1);
    assert.equal(nodesOf(panel, "markdown").length, 0);
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
    const [form] = nodesOf(panel, "form");
    assert.ok(form.applyOnChange, "settings must apply without an Apply button");
    for (const field of form.fields) {
      assert.ok(declared.has(field.id), `${field.id} is not declared in plugin.json`);
    }
    assert.ok(form.fields.length <= LIMITS.maxFormFields);
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
    const offered = panels.buildSettingsPanel({
      connection: { connected: false, handoffStatus: "offered" },
    });
    assert.ok(
      nodesOf(offered, "button").some((node) => node.onPress.action === contract.ACTIONS.adoptHandoff),
    );
    const declined = panels.buildSettingsPanel({
      connection: { connected: false, handoffStatus: "declined" },
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
      const built = panels.build(panel.id, { connection: CONNECTION, issue: ISSUE, groups: GROUPS });
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
