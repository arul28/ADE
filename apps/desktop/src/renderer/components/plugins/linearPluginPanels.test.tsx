/* @vitest-environment jsdom */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { PluginPanelView } from "./VocabularyRenderer";
import type { VocabRenderContext } from "./vocabularyComponents";
import type { PluginCollectionRow } from "../../lib/pluginRuntimeBridge";
import {
  VOCAB_LIMITS,
  bindingKey,
  collectVocabBindings,
  collectVocabSelectionDeclarations,
  collectVocabStateDeclarations,
  countVocabNodes,
  distinctBindings,
  parsePluginPanel,
  vocabChildNodes,
  vocabSchemaBytes,
  type VocabFormNode,
  type VocabGroupNode,
  type VocabListNode,
  type VocabNode,
  type VocabSegmentedNode,
} from "../../../shared/plugins/vocabulary";

/**
 * `ade-linear`'s four panels, built by the real plugin and drawn by the real
 * desktop renderer.
 *
 * The plugin's own `test/*.test.js` files run under `node --test` and prove the
 * data half — the branch name, the row shape, the API reader. What none of them
 * can prove is the half that only exists once a schema meets a client: that the
 * builders produce something the shared parser accepts WITHOUT dropping a node,
 * that the filter strip fits inside the panel-state ceilings a phone enforces
 * too, and that a reader looking at the panel actually sees the issue's title,
 * its status and its comments rather than a fallback card.
 *
 * So every assertion below is against content: the words in the DOM, the keys a
 * control declares, the prefix a binding reads. There are no snapshots — a
 * snapshot would go red for a padding change and stay green through a filter
 * bound to a collection nobody writes.
 *
 * The plugin is loaded through `require` on purpose. It is CommonJS, exactly as
 * the plugin child bootstrap loads it, so a syntax error or a missing export
 * fails here rather than at install time on a user's machine.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const pluginRoot = path.join(repoRoot, "plugins/ade-linear");
const require_ = createRequire(import.meta.url);

// This file sits five directories under `apps/`, so the hop to the repo root is
// worth proving rather than counting: a wrong root would `require` nothing and
// every case below would fail with a module error instead of a real one.
expect(fs.existsSync(path.join(pluginRoot, "plugin.json"))).toBe(true);

type Panel = Record<string, unknown>;

const panels = require_(path.join(pluginRoot, "panels.js")) as {
  MAIN_PANEL_PATH: string;
  buildIssuePanel: (model?: unknown, context?: unknown) => Panel;
  buildIssuesPanel: (model?: unknown) => Panel;
  buildLaunchPanel: (model?: unknown) => Panel;
  buildMainPanel: () => Panel;
  buildSettingsPanel: (model?: unknown) => Panel;
};

const contract = require_(path.join(pluginRoot, "panels/contract.js")) as {
  COLLECTION_ISSUES: string;
  COLLECTION_PEOPLE: string;
  COLLECTION_PROJECTS: string;
  COLLECTION_TEAMS: string;
  ISSUE_ROW_ACTIONS: string[];
  ACTIONS: Record<string, string>;
  STATE_ASSIGNEE: string;
  STATE_BATCH: string;
  STATE_PRESET: string;
  STATE_PRIORITY: string;
  STATE_PROJECT: string;
  STATE_SORT: string;
  STATE_TEAM: string;
  STATE_UPDATED: string;
  STATE_VIEW: string;
  flatIssueKey: (rank: number, issueId: string) => string;
  flatKeyPrefix: () => string;
  groupKeyPrefix: (stateId: string) => string;
};

const copy = require_(path.join(pluginRoot, "panels/common.js")) as {
  COPY: Record<string, string>;
};
const COPY = copy.COPY;

/** The `settings` block of the manifest, read rather than restated. */
const manifestSettingKeys: string[] = (
  JSON.parse(fs.readFileSync(path.join(pluginRoot, "plugin.json"), "utf8")) as {
    settings?: { key: string }[];
  }
).settings?.map((entry) => entry.key) ?? [];

/* ── Fixtures ───────────────────────────────────────────────────────────── */

/**
 * A workspace with everything turned on: projects, people and more than one
 * team, plus a viewer. That is the view that spends the MOST panel-state keys,
 * so it is the one that can hit `maxStateKeys` and fail the whole panel.
 *
 * This is the VIEW `index.js:viewFor("issues")` publishes — flat, and already
 * in the builder's words. It used to be a hand-written MODEL with a nested
 * `connection` the real publish path never sends, which is exactly why a
 * builder that read `model.connection.connected` passed here and drew the
 * "Connect Linear" card in the product.
 */
function connectedIssuesView(over: Record<string, unknown> = {}) {
  return {
    state: "list",
    error: null,
    groups: [
      { stateId: "state_started", stateName: "In Progress", stateType: "started", count: 3, defaultOpen: true },
      { stateId: "state_unstarted", stateName: "Todo", stateType: "unstarted", count: 5, defaultOpen: true },
      { stateId: "state_done", stateName: "Done", stateType: "completed", count: 9, defaultOpen: false },
    ],
    query: null,
    title: "Linear",
    statePreset: "all",
    sort: "updated_desc",
    view: "grouped",
    viewerId: "usr_viewer_1",
    assignedToMe: false,
    hasProjects: true,
    hasPeople: true,
    hasTeams: true,
    filtersActive: false,
    workspace: "Acme",
    age: "2 minutes ago",
    ...over,
  };
}

function flatIssuesView() {
  return connectedIssuesView({ view: "flat" });
}

/** One issue with every optional half present: prose, labels, children, a thread. */
const FULL_ISSUE = {
  id: "iss_1",
  identifier: "ADE-122",
  title: "Fix the login redirect",
  description: [
    "## Reproduce",
    "",
    "The redirect drops `next` when the session is **stale**.",
    "See [the runbook](https://example.com/runbook).",
    "",
    "```ts",
    "const next = resolveNext(session);",
    "```",
  ].join("\n"),
  url: "https://linear.app/acme/issue/ADE-122",
  priority: 2,
  stateId: "state_started",
  stateName: "In Progress",
  stateType: "started",
  teamKey: "ADE",
  teamName: "ADE Core",
  projectName: "Platform",
  assigneeName: "Arul Sharma",
  creatorName: "Dana Reed",
  branchName: "ade/ade-122-fix-the-login-redirect",
  labels: ["auth", "regression"],
  createdAt: "Aug 20, 2026",
  updatedAt: "Aug 30, 2026",
  hasLane: true,
};

function issueDetailView() {
  return {
    state: "detail",
    error: null,
    issue: FULL_ISSUE,
    subIssues: [
      {
        id: "iss_2",
        identifier: "ADE-123",
        title: "Add a regression test for the redirect",
        stateName: "Todo",
        stateType: "unstarted",
      },
    ],
    comments: [
      { author: "Dana Reed", at: "yesterday", body: "The session cookie expires early on Safari." },
      { author: "Arul Sharma", at: "today", body: "Fixed by keeping `next` on the retry." },
    ],
    commentsState: "loaded",
  };
}

function connectedSettingsView() {
  return {
    state: "connected",
    connection: {
      connected: true,
      authMode: "oauth",
      viewerName: "Arul Sharma",
      organizationName: "Acme Robotics",
      organizationUrlKey: "acme",
      issueCount: 42,
      expiresIn: "expires in 6 days",
      lastSyncAt: "2 minutes ago",
    },
    settings: { moveToDoneOnMerge: true, moveToStartedOnLaunch: false, defaultTeamKey: "ADE" },
    teams: [{ key: "ADE", name: "ADE Core" }, { key: "ENG", name: "Engineering" }],
  };
}

function disconnectedSettingsView() {
  return { state: "disconnected", connection: { connected: false }, handoffStatus: null };
}

function launchView() {
  return {
    state: "form",
    issue: FULL_ISSUE,
    models: [{ id: "opus-5", name: "Opus 5" }, { id: "sonnet-4.5", name: "Sonnet 4.5" }],
    permissionModes: [{ value: "ask", label: "Ask first" }, { value: "auto", label: "Auto" }],
    reasoningEfforts: [{ value: "high", label: "High" }],
    laneName: "ade-122-fix-the-login-redirect",
    branchName: FULL_ISSUE.branchName,
    kickoff: "Fix the login redirect.",
    fastModeSupported: true,
  };
}

/** Every panel this plugin can publish, in the states a reader actually reaches. */
function everyPanel(): { name: string; schema: Panel }[] {
  return [
    { name: "issues (grouped list)", schema: panels.buildIssuesPanel(connectedIssuesView()) },
    { name: "issues (flat list)", schema: panels.buildIssuesPanel(flatIssuesView()) },
    { name: "issue (detail)", schema: panels.buildIssuePanel(issueDetailView()) },
    { name: "settings (connected)", schema: panels.buildSettingsPanel(connectedSettingsView()) },
    { name: "settings (disconnected)", schema: panels.buildSettingsPanel(disconnectedSettingsView()) },
    { name: "main", schema: panels.buildMainPanel() },
    { name: "launch", schema: panels.buildLaunchPanel(launchView()) },
  ];
}

/* ── Harness ────────────────────────────────────────────────────────────── */

/**
 * The same render context the pane hands a panel, with nothing answered.
 *
 * Copied in shape from `VocabularyRenderer.test.tsx` on purpose: a panel drawn
 * against a different harness than the one the renderer's own suite uses would
 * be proving something about the harness.
 */
function makeContext(overrides: Partial<VocabRenderContext> = {}): VocabRenderContext {
  return {
    pluginId: "ade-linear",
    rowsByBinding: new Map<string, PluginCollectionRow[]>(),
    dispatch: vi.fn(async () => {}),
    active: true,
    state: {},
    setStateValue: vi.fn(),
    declarations: [],
    selection: {},
    selectionDeclarations: [],
    toggleRow: vi.fn(),
    clearSelection: vi.fn(),
    groupOpen: (node) => node.defaultOpen ?? true,
    toggleGroup: vi.fn(),
    listPage: () => 1,
    showMoreListRows: vi.fn(),
    ...overrides,
  };
}

/** Parse or fail loudly — every case below reads the parsed tree. */
function parsed(schema: unknown, name: string) {
  const result = parsePluginPanel(schema);
  if (!result.ok) {
    throw new Error(`${name} did not parse: ${JSON.stringify(result.errors)}`);
  }
  return result;
}

/** Every node in a parsed panel, flattened, so a walk is one line at a call site. */
function allNodes(nodes: readonly VocabNode[]): VocabNode[] {
  const flat: VocabNode[] = [];
  const walk = (list: readonly VocabNode[]) => {
    for (const node of list) {
      flat.push(node);
      walk(vocabChildNodes(node));
    }
  };
  walk(nodes);
  return flat;
}

function segmentedNodes(nodes: readonly VocabNode[]): VocabSegmentedNode[] {
  return allNodes(nodes).filter((node): node is VocabSegmentedNode => node.component === "segmented");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/* ── 1. Every panel, through the parser every client runs ───────────────── */

describe("every ade-linear panel, against the shared parser", () => {
  /**
   * A warning is not a cosmetic complaint: a dropped node is a control the
   * reader was meant to have and does not. So the bar is an EMPTY warning list,
   * and the message names the offender rather than reporting a length mismatch
   * — a regression here should say which node the builder broke.
   */
  it("parses with no errors and drops no node", () => {
    for (const { name, schema } of everyPanel()) {
      const result = parsePluginPanel(schema);
      expect(result.ok, `${name} failed to parse: ${JSON.stringify(result.ok ? [] : result.errors)}`)
        .toBe(true);
      if (!result.ok) continue;
      expect(
        result.warnings,
        `${name} dropped nodes: ${JSON.stringify(result.warnings)}`,
      ).toEqual([]);
    }
  });

  /**
   * Both ceilings that refuse a panel WHOLE. A panel over either is a blank
   * screen on every surface at once, and the builders have no second chance —
   * they are pure functions run once per publish.
   */
  it("stays inside the node and byte ceilings that fail a whole panel", () => {
    for (const { name, schema } of everyPanel()) {
      const result = parsed(schema, name);
      const nodes = countVocabNodes(result.panel.body);
      expect(nodes, `${name} spends ${nodes} nodes`).toBeLessThanOrEqual(VOCAB_LIMITS.maxNodes);
      const bytes = vocabSchemaBytes(schema);
      expect(bytes, `${name} measures ${bytes} bytes`).toBeLessThanOrEqual(VOCAB_LIMITS.maxSchemaBytes);
    }
  });
});

/* ── 2. The issue list's filters ────────────────────────────────────────── */

describe("the issues panel's filter strip", () => {
  const schema = panels.buildIssuesPanel(connectedIssuesView());
  const result = parsed(schema, "issues");
  const declarations = collectVocabStateDeclarations(result.panel.body);
  const byKey = new Map(declarations.map((entry) => [entry.stateKey, entry]));

  /**
   * The strip builds in importance order and slices to the budget, so the way
   * this fails in practice is a control silently missing rather than a panel
   * refused. Naming the six keys that must be there is what catches that.
   */
  it("declares every filter axis, within the panel-state key budget", () => {
    expect(declarations.length).toBeLessThanOrEqual(VOCAB_LIMITS.maxStateKeys);
    for (const key of [
      contract.STATE_PRESET,
      contract.STATE_PROJECT,
      contract.STATE_ASSIGNEE,
      contract.STATE_PRIORITY,
      contract.STATE_SORT,
      contract.STATE_VIEW,
    ]) {
      expect(byKey.has(key), `no control declared \`${key}\``).toBe(true);
    }
  });

  /**
   * The phone's one-tap chip, as a literal option carrying the viewer's own id.
   * A bound option would need the `people` rows to have landed first, so a
   * reader who wants their own issues would be waiting on a fetch to press the
   * filter they press most.
   */
  it("carries “Assigned to me” as a literal option holding the viewer's id", () => {
    const assignee = byKey.get(contract.STATE_ASSIGNEE);
    expect(assignee).toBeDefined();
    const me = assignee?.options.find((option) => option.label === COPY.assignedToMe);
    expect(me, `assignee options: ${JSON.stringify(assignee?.options)}`).toBeDefined();
    expect(me?.value).toBe("usr_viewer_1");
  });

  /**
   * A real workspace has thirty projects and eighty people, which is over
   * `maxStateOptions` — so both axes have to read rows, and a control bound to
   * the wrong collection name draws its "All" and nothing else, forever, with
   * no error anywhere.
   */
  it("reads its project and assignee options from the collections the plugin writes", () => {
    expect(byKey.get(contract.STATE_PROJECT)?.optionsFrom?.collection).toBe(contract.COLLECTION_PROJECTS);
    expect(byKey.get(contract.STATE_ASSIGNEE)?.optionsFrom?.collection).toBe(contract.COLLECTION_PEOPLE);
    // Teams too, when the workspace has more than one — the axis the built-in
    // browser does not have and the first one the strip's slice would drop.
    expect(byKey.get(contract.STATE_TEAM)?.optionsFrom?.collection).toBe(contract.COLLECTION_TEAMS);
  });

  /**
   * The literal ceiling, checked per NODE rather than per declaration: the
   * declaration merges in whatever the host resolved, so a control that spelled
   * nine literal options would look compliant there and be refused at parse on
   * a client whose rows had not landed.
   */
  it("writes no more literal options into a control than the vocabulary allows", () => {
    for (const node of segmentedNodes(result.panel.body)) {
      expect(
        node.options.length,
        `\`${node.stateKey}\` writes ${node.options.length} literal options`,
      ).toBeLessThanOrEqual(VOCAB_LIMITS.maxStateOptions);
    }
  });

  /**
   * `Reset filters` is the only way a reader clears the CONTROLS, and panel
   * state belongs to the client — so the button has to be offered exactly when
   * something is set. `index.js:viewFor` decides that and sends the answer as
   * `filtersActive`; the builder draws the button and works nothing out for
   * itself, which is why this asserts on the rendered panel rather than on a
   * helper the panel half no longer owns.
   */
  it("offers the reset only when the view says something is set", () => {
    const labelsOf = (schema: Panel) =>
      allNodes(parsed(schema, "issues").panel.body)
        .map((node) => (node as { label?: unknown }).label)
        .filter((label): label is string => typeof label === "string");

    expect(labelsOf(panels.buildIssuesPanel(connectedIssuesView()))).not.toContain(COPY.resetFilters);
    expect(
      labelsOf(panels.buildIssuesPanel(connectedIssuesView({ statePreset: "active", filtersActive: true }))),
    ).toContain(COPY.resetFilters);
  });
});

/* ── 3. The issue list's bindings and its batch ─────────────────────────── */

describe("the issues panel's lists", () => {
  /**
   * A stored row that could press `disconnect` because a collection said so is
   * the failure `allowActions` exists to prevent. The subset check is the audit
   * — a widened allowlist in a builder shows up here rather than in production.
   */
  it("binds the flat list to the flat key space, with a batch inside its ceilings", () => {
    const result = parsed(panels.buildIssuesPanel(flatIssuesView()), "issues (flat)");
    const lists = allNodes(result.panel.body).filter(
      (node): node is VocabListNode => node.component === "list",
    );
    expect(lists).toHaveLength(1);
    const [flat] = lists;
    expect(flat.bind?.collection).toBe(contract.COLLECTION_ISSUES);
    expect(flat.bind?.keyPrefix).toBe(contract.flatKeyPrefix());
    for (const action of flat.bind?.allowActions ?? []) {
      expect(contract.ISSUE_ROW_ACTIONS, `binding allows \`${action}\``).toContain(action);
    }

    const selectable = flat.selectable;
    expect(selectable, "the flat list is the one that ticks and it does not").toBeDefined();
    expect(selectable?.stateKey).toBe(contract.STATE_BATCH);
    expect(selectable?.actions.length).toBeLessThanOrEqual(VOCAB_LIMITS.maxBulkActions);
    expect(selectable?.max ?? 0).toBeLessThanOrEqual(VOCAB_LIMITS.maxSelectedRows);
    // A bulk verb the row binding does not allow would draw a button that
    // dispatches an id the panel never declared.
    for (const action of selectable?.actions ?? []) {
      expect(contract.ISSUE_ROW_ACTIONS, `bulk action \`${action.action}\``).toContain(action.action);
    }

    const declared = collectVocabSelectionDeclarations(result.panel.body);
    expect(declared.map((entry) => entry.stateKey)).toEqual([contract.STATE_BATCH]);
  });

  /**
   * One section per workflow state, each reading its own contiguous run of
   * keys. `groupKey` is the state's ID rather than its title, so republishing
   * every few seconds cannot re-open a section the reader just closed — and a
   * key prefix that disagreed with `groupIssueKey` would draw every group empty
   * with nothing to say why.
   */
  it("gives every state group its own section and its own key prefix", () => {
    const model = connectedIssuesView();
    const result = parsed(panels.buildIssuesPanel(model), "issues (grouped)");
    const groups = result.panel.body.filter(
      (node): node is VocabGroupNode => node.component === "group",
    );
    expect(groups).toHaveLength(model.groups.length);

    for (const [index, group] of model.groups.entries()) {
      const node = groups[index];
      expect(node.groupKey).toBe(group.stateId);
      expect(node.title).toBe(group.stateName);
      expect(node.defaultOpen).toBe(group.defaultOpen);
      const [list] = node.children.filter(
        (child): child is VocabListNode => child.component === "list",
      );
      expect(list, `${group.stateName} holds no list`).toBeDefined();
      expect(list.bind?.keyPrefix).toBe(contract.groupKeyPrefix(group.stateId));
    }

    // One fetch per section plus the three option collections, and no duplicate
    // — `distinctBindings` is what the host actually reads.
    const keys = distinctBindings(panels.buildIssuesPanel(model)).map((binding) => bindingKey(binding));
    expect(new Set(keys).size).toBe(keys.length);
    for (const group of model.groups) {
      expect(keys).toContain(
        bindingKey({ collection: contract.COLLECTION_ISSUES, keyPrefix: contract.groupKeyPrefix(group.stateId) }),
      );
    }
  });
});

/* ── 4. The issue list, drawn ───────────────────────────────────────────── */

describe("the issues panel, rendered by the desktop renderer", () => {
  const ISSUES = [
    {
      id: "iss_1",
      identifier: "ADE-122",
      title: "Fix the login redirect",
      stateName: "In Progress",
      stateType: "started",
      priority: "2",
      projectId: "prj_platform",
      assigneeId: "usr_viewer_1",
      updatedAt: "2026-08-30T10:00:00.000Z",
    },
    {
      id: "iss_2",
      identifier: "ADE-140",
      title: "Paged transcript loses its scroll",
      stateName: "Todo",
      stateType: "unstarted",
      priority: "3",
      projectId: "prj_platform",
      assigneeId: "usr_dana",
      updatedAt: "2026-08-29T10:00:00.000Z",
    },
    {
      id: "iss_3",
      identifier: "ADE-151",
      title: "Webhook relay drops a delivery under load",
      stateName: "Done",
      stateType: "completed",
      priority: "1",
      projectId: "prj_relay",
      assigneeId: "usr_viewer_1",
      updatedAt: "2026-08-28T10:00:00.000Z",
    },
  ];

  /** The row shape `issueFormat.js` materializes, as the binding reads it. */
  function issueRows(): PluginCollectionRow[] {
    return ISSUES.map((issue, index) => ({
      key: contract.flatIssueKey(index + 1, issue.id),
      value: {
        key: issue.id,
        title: issue.title,
        subtitle: `${issue.identifier} · ${issue.stateName}`,
        mono: issue.identifier,
        meta: "updated 2 minutes ago",
        badge: { text: issue.stateName, tone: issue.stateType === "completed" ? "success" : "accent" },
        icon: "kanban",
        tone: "neutral",
        projectId: issue.projectId,
        assigneeId: issue.assigneeId,
        priority: issue.priority,
        updatedAt: issue.updatedAt,
        stateType: issue.stateType,
        onPress: { action: contract.ACTIONS.openIssue, args: { issueId: issue.id } },
      },
    }));
  }

  /**
   * The key is computed from the panel rather than spelled: `bindingKey` puts a
   * NUL between the collection and the prefix, and a host that keyed its map any
   * other way answers every binding with a miss and draws an empty list. Reading
   * it back off the schema is what proves the two agree.
   */
  function flatBindingKey(schema: unknown): string {
    const result = parsed(schema, "issues (flat)");
    const bindings = collectVocabBindings(result.panel.body).filter(
      (binding) => binding.collection === contract.COLLECTION_ISSUES,
    );
    expect(bindings).toHaveLength(1);
    const [only] = distinctBindings(schema).filter(
      (binding) => binding.collection === contract.COLLECTION_ISSUES,
    );
    expect(bindingKey(only)).toBe(bindingKey(bindings[0]));
    return bindingKey(only);
  }

  it("draws every issue the collection answered, under the filter strip", () => {
    const schema = panels.buildIssuesPanel(flatIssuesView());
    const result = parsed(schema, "issues (flat)");
    const rowsByBinding = new Map<string, PluginCollectionRow[]>([
      [flatBindingKey(schema), issueRows()],
    ]);

    const { container } = render(
      <PluginPanelView
        schema={schema}
        context={makeContext({
          rowsByBinding,
          declarations: collectVocabStateDeclarations(result.panel.body),
          selectionDeclarations: collectVocabSelectionDeclarations(result.panel.body),
        })}
      />,
    );

    const text = container.textContent ?? "";
    // Rule 2's floor: a panel is never blank. Everything after this is about
    // WHICH words, but this is the one that says the reader got a panel at all.
    expect(text.trim()).toBeTruthy();

    for (const issue of ISSUES) {
      expect(text, `${issue.identifier} is missing`).toContain(issue.title);
      expect(text, `${issue.identifier}'s identifier is missing`).toContain(issue.identifier);
    }

    // The strip itself. A filter whose label never reached the DOM is an axis
    // the reader cannot see and therefore cannot use.
    for (const label of [
      COPY.filterState,
      COPY.filterProject,
      COPY.filterAssignee,
      COPY.filterPriority,
      COPY.filterSort,
      COPY.filterView,
      COPY.filterUpdated,
      COPY.filterTeam,
    ]) {
      expect(text, `the “${label}” filter never rendered`).toContain(label);
    }

    // The rows came from a collection, so the empty line must NOT be there —
    // that is the shape a mis-keyed binding produces and it looks like an empty
    // workspace rather than like a bug.
    expect(text).not.toContain(COPY.noIssues);

    // Every row is tickable, which is the whole reason the flat view exists.
    const boxes = container.querySelectorAll('input[type="checkbox"]');
    expect(boxes).toHaveLength(ISSUES.length);
  });

  /**
   * The grouped view is what the pane opens on, and it renders three sections
   * whose rows come from three different key prefixes. A section drawn with
   * another section's rows is the failure a shared prefix would produce.
   */
  it("draws each state group's own rows in its own section", () => {
    const model = connectedIssuesView();
    const schema = panels.buildIssuesPanel(model);
    const rowsByBinding = new Map<string, PluginCollectionRow[]>(
      model.groups.map((group, index) => [
        bindingKey({
          collection: contract.COLLECTION_ISSUES,
          keyPrefix: contract.groupKeyPrefix(group.stateId),
        }),
        [
          {
            key: `${contract.groupKeyPrefix(group.stateId)}000001:iss_${index}`,
            value: {
              key: `iss_${index}`,
              title: `${group.stateName} issue`,
              mono: `ADE-${100 + index}`,
              onPress: { action: contract.ACTIONS.openIssue, args: { issueId: `iss_${index}` } },
            },
          } as PluginCollectionRow,
        ],
      ]),
    );

    const { container } = render(
      <PluginPanelView
        schema={schema}
        // Every section open, so all three key prefixes are exercised in one
        // render — a closed group is unmounted and would prove nothing.
        context={makeContext({ rowsByBinding, groupOpen: () => true })}
      />,
    );

    const text = container.textContent ?? "";
    for (const group of model.groups) {
      expect(text, `the “${group.stateName}” section is missing`).toContain(group.stateName);
      expect(text, `the “${group.stateName}” section drew no rows`).toContain(`${group.stateName} issue`);
    }
    // The footer the list cannot draw itself: whose workspace, and how old.
    expect(text).toContain("Acme");
    expect(text).toContain("updated 2 minutes ago");
  });
});

/* ── 5. The issue detail, drawn ─────────────────────────────────────────── */

describe("the issue panel, rendered by the desktop renderer", () => {
  function renderDetail() {
    const schema = panels.buildIssuePanel(issueDetailView());
    return {
      schema,
      ...render(<PluginPanelView schema={schema} context={makeContext()} />),
    };
  }

  it("says what the issue is, what is true about it, and what can be done to it", () => {
    const { container } = renderDetail();
    const text = container.textContent ?? "";

    expect(text.trim()).toBeTruthy();
    expect(text).toContain(FULL_ISSUE.title);
    expect(text).toContain(FULL_ISSUE.stateName);

    // The properties block, in the built-in's own labels.
    for (const label of [COPY.propStatus, COPY.propPriority, COPY.propAssignee]) {
      expect(text, `the “${label}” property is missing`).toContain(label);
    }
    expect(text).toContain(FULL_ISSUE.assigneeName);

    // The branch a lane made from this issue would take. It is the one value on
    // this screen a reader compares character by character.
    expect(text).toContain(FULL_ISSUE.branchName);

    // The two launch verbs and the way out to Linear.
    expect(text).toContain(COPY.launchOne);
    expect(text).toContain(COPY.laneOne);
    expect(text).toContain(COPY.openInLinear);

    // The sub-issue and the thread, which are the two blocks the built-in's
    // detail column has and which cost this panel a list and two nodes each.
    expect(text).toContain("Add a regression test for the redirect");
    expect(text).toContain("The session cookie expires early on Safari.");
    expect(text).toContain("Dana Reed");
  });

  /**
   * The description goes through the `markdown` node, which is the reason this
   * panel can show an issue body at all — the built-in's phone and desktop
   * renderers are two different parsers that agree by coincidence.
   *
   * The fence is the tell. If the builder had put the description in a `text`
   * node, every word below would still be in the DOM and only the literal
   * backticks would give it away.
   */
  it("renders the description as prose, not as its source", () => {
    const { container } = renderDetail();
    const text = container.textContent ?? "";

    expect(container.querySelector("h2")?.textContent).toBe("Reproduce");
    expect(container.querySelector("strong")?.textContent).toBe("stale");
    expect(container.querySelector("pre code")?.textContent).toBe("const next = resolveNext(session);");
    expect(container.querySelector("pre code")?.getAttribute("data-language")).toBe("ts");

    const link = [...container.querySelectorAll("a")].find((a) => a.textContent === "the runbook");
    expect(link?.getAttribute("href")).toBe("https://example.com/runbook");

    // The code inside the fence is drawn; the fence markers are not. A raw
    // `text` node would show both.
    expect(text).toContain("const next = resolveNext(session);");
    expect(text).not.toContain("```");
    expect(text).not.toContain("## Reproduce");
  });

  /**
   * The two editable controls key on the issue's identifier, because this is
   * ONE panel drawing every issue and panel state survives a re-publish of the
   * same controls. A shared key would carry the state the reader picked on
   * ADE-122 onto ADE-140 the moment they navigated.
   */
  it("keys its inline editors per issue", () => {
    const result = parsed(panels.buildIssuePanel(issueDetailView()), "issue");
    const keys = segmentedNodes(result.panel.body).map((node) => node.stateKey);
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(key, `\`${key}\` does not name the issue`).toContain(FULL_ISSUE.identifier);
    }
  });
});

/* ── 6. Settings, both ways ─────────────────────────────────────────────── */

describe("the settings panel", () => {
  it("offers both ways in when there is no connection", () => {
    const { container, getByLabelText } = render(
      <PluginPanelView
        schema={panels.buildSettingsPanel(disconnectedSettingsView())}
        context={makeContext()}
      />,
    );
    const text = container.textContent ?? "";

    expect(text).toContain(COPY.connectTitle);
    expect(text).toContain(COPY.connectAction);

    // The API key is a `secret` field, not a `{prompt}`: a prompt is one plain
    // text field on every client, and a credential typed into a plain field is
    // a credential on screen.
    const field = getByLabelText(COPY.apiKeyLabel) as HTMLInputElement;
    expect(field.type).toBe("password");
    expect(text).toContain(COPY.connect);

    // Nothing about preferences: they belong to a connection that does not exist.
    expect(text).not.toContain(COPY.disconnect);
  });

  it("shows the workspace, the way out, and the preferences when connected", () => {
    const { container } = render(
      <PluginPanelView
        schema={panels.buildSettingsPanel(connectedSettingsView())}
        context={makeContext()}
      />,
    );
    const text = container.textContent ?? "";

    expect(text).toContain("Acme Robotics");
    expect(text).toContain(COPY.connectedTitle);
    expect(text).toContain(COPY.disconnect);
    expect(text).toContain("Arul Sharma");
  });

  /**
   * The point of this case: `config.set` writes the keys `plugin.json` declares
   * under `settings` and drops the rest, so a form field naming an undeclared
   * key is a toggle that moves and changes nothing — and nothing anywhere
   * reports it. The manifest is read here rather than restated so a rename in
   * one file and not the other fails.
   */
  it("names only settings the manifest declares in its preferences form", () => {
    expect(manifestSettingKeys.length).toBeGreaterThan(0);

    const result = parsed(panels.buildSettingsPanel(connectedSettingsView()), "settings (connected)");
    const preferenceForms = allNodes(result.panel.body).filter(
      (node): node is VocabFormNode =>
        node.component === "form" && node.applyOnChange?.action === contract.ACTIONS.applySettings,
    );
    expect(preferenceForms, "no preferences form is published").toHaveLength(1);

    const ids = preferenceForms[0].fields.map((field) => field.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(manifestSettingKeys, `the form writes \`${id}\`, which the manifest does not declare`)
        .toContain(id);
    }
    expect(ids.length).toBeLessThanOrEqual(VOCAB_LIMITS.maxFormFields);
  });
});

/* ── 7. The gating panel ────────────────────────────────────────────────── */

describe("the main panel", () => {
  const onDisk = JSON.parse(fs.readFileSync(panels.MAIN_PANEL_PATH, "utf8")) as Panel;

  /**
   * The manifest already ships `panels/main.json` as this panel's `schemaFile`,
   * so a builder that rebuilt it in code would be a second source for one screen
   * and a chance for the two to disagree — a phone drawing one sentence and the
   * desktop another for the same panel id.
   */
  it("is the file on disk, not a rebuild of it", () => {
    expect(panels.MAIN_PANEL_PATH).toBe(path.join(pluginRoot, "panels", "main.json"));
    expect(JSON.stringify(panels.buildMainPanel())).toBe(JSON.stringify(onDisk));
    const result = parsed(panels.buildMainPanel(), "main");
    expect(result.warnings).toEqual([]);
  });

  /**
   * The builder caches the file's TEXT and re-parses per call. A cached OBJECT
   * would hand every caller the same instance, so one caller decorating what it
   * publishes would corrupt the next reader's copy — on a panel whose whole job
   * is to be the same words everywhere.
   */
  it("hands out a fresh copy each call, so a caller cannot poison the next one", () => {
    const first = panels.buildMainPanel();
    expect(first).not.toBe(panels.buildMainPanel());
    (first as { title: string }).title = "Tampered";
    (first.body as Record<string, unknown>[])[0].title = "Tampered too";
    (first.body as Record<string, unknown>[]).push({ component: "text", text: "injected" });

    const second = panels.buildMainPanel();
    expect(JSON.stringify(second)).toBe(JSON.stringify(onDisk));
  });
});
