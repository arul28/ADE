import { describe, expect, it, vi } from "vitest";

import {
  bindingKey,
  buildPluginPaneModel,
  cyclePluginFieldValue,
  movePluginPaneSelection,
  pluginFieldRawValue,
  pluginFieldUsesComposer,
  pluginFormValueKey,
  pluginInteractiveKey,
  pluginPaneBindingRows,
  pluginPaneStateChange,
  pluginPaneStateCycle,
  pluginPaneStatePayload,
  pluginPaneStateReset,
  pluginPaneWindow,
  pluginTableWidths,
  type PluginPaneCollectionMap,
  type PluginPaneInput,
  type PluginPaneModel,
  type PluginPanelFetch,
} from "../pluginPane";
import { defaultPluginPanelId, invokePluginAction, resolvePluginByName } from "../adeApi";
import {
  pluginPromptAnswerArgs,
  pluginPromptHint,
  pluginPromptOutcome,
  pluginPromptPlaceholder,
  pluginPromptTitle,
  pluginPromptTooLongNotice,
} from "../pluginPrompt";
import type { AdeCodeConnection } from "../types";
import { PLUGIN_FIXTURES } from "../../../../desktop/src/renderer/components/plugins/pluginFixtures";
import {
  readPluginActionNavigation,
  type PluginSummary,
} from "../../../../desktop/src/shared/plugins/sdk";
import type { VocabField } from "../../../../desktop/src/shared/plugins/vocabulary";

const FALLBACK = { title: "Graph", text: "Open ADE to see the graph.", deeplink: "ade://lane/lane-1" };

function panel(body: unknown[], extra: Record<string, unknown> = {}): PluginPanelFetch {
  return {
    state: "ok",
    record: {
      pluginId: "graph",
      panelId: "main",
      title: "Graph",
      schema: { v: 1, fallback: FALLBACK, body, ...extra },
      vocabVersion: 1,
      updatedAt: null,
    },
  };
}

function build(
  fetch: PluginPanelFetch,
  options: {
    collections?: PluginPaneCollectionMap;
    values?: Record<string, string>;
    editing?: number | null;
    state?: Record<string, string>;
    stateSignature?: string;
  } = {},
): PluginPaneModel {
  const input: PluginPaneInput = {
    pluginId: "graph",
    displayName: "Graph",
    panelId: "main",
    fetch,
    collections: options.collections ?? new Map(),
    values: options.values ?? {},
    editing: options.editing ?? null,
    ...(options.state !== undefined ? { state: options.state } : {}),
    ...(options.stateSignature !== undefined ? { stateSignature: options.stateSignature } : {}),
    width: 40,
  };
  return buildPluginPaneModel(input);
}

describe("plugin pane model", () => {
  it("renders the v1 component subset as rows in schema order", () => {
    const model = build(panel([
      { component: "text", text: "Overview", variant: "title" },
      { component: "badge", text: "12 nodes", tone: "accent" },
      { component: "divider", label: "Lanes" },
      { component: "keyValue", rows: [{ key: "Branch", value: "main" }] },
      {
        component: "list",
        items: [{ title: "lane-a", subtitle: "3 commits", onPress: { action: "openLane", args: { id: "a" } } }],
      },
      { component: "button", label: "Rebuild", onPress: { action: "rebuild" } },
    ]));

    expect(model.status).toBe("ok");
    expect(model.rows.map((row) => row.kind)).toEqual([
      "text",
      "inline",
      "divider",
      "keyValue",
      "listItem",
      "buttons",
    ]);
    // Pressable list rows and buttons are the selectable things, in row order.
    expect(model.interactives).toEqual([
      { kind: "action", label: "lane-a", action: { action: "openLane", args: { id: "a" } } },
      { kind: "action", label: "Rebuild", action: { action: "rebuild" } },
    ]);
  });

  it("folds a horizontal stack of text and badges onto one line", () => {
    const model = build(panel([
      {
        component: "stack",
        direction: "horizontal",
        children: [
          { component: "text", text: "Status" },
          { component: "badge", text: "green", tone: "success" },
        ],
      },
    ]));
    expect(model.rows).toHaveLength(1);
    const row = model.rows[0];
    expect(row?.kind).toBe("inline");
    expect(row?.kind === "inline" && row.parts.map((part) => part.badge)).toEqual([false, true]);
  });

  it("stacks a horizontal row vertically when its children cannot share a line", () => {
    const model = build(panel([
      {
        component: "stack",
        direction: "horizontal",
        children: [
          { component: "text", text: "Lanes" },
          { component: "list", items: [{ title: "lane-a" }] },
        ],
      },
    ]));
    expect(model.rows.map((row) => row.kind)).toEqual(["text", "listItem"]);
  });

  it("reads bound rows out of the collections the panel declared", () => {
    const collections: PluginPaneCollectionMap = new Map([
      [
        bindingKey({ collection: "issues" }),
        [
          { key: "1", value: { title: "Fix login", subtitle: "ADE-1" } },
          { key: "2", value: { title: "Ship plugins" } },
          // Not render-shaped: dropped rather than rendered as an empty row.
          { key: "3", value: { subtitle: "no title" } },
        ],
      ],
    ]);
    const model = build(panel([{ component: "list", bind: { collection: "issues" } }]), { collections });

    const titles = model.rows.flatMap((row) => (row.kind === "listItem" ? [row.title] : []));
    expect(titles).toEqual(["Fix login", "Ship plugins"]);
  });

  it("makes a bound row selectable only for an action its binding allowed", () => {
    // Without the allowlist a bound row carried no action at all here, so a
    // collection-driven fleet was inert in the TUI while it was live on iOS.
    const collections: PluginPaneCollectionMap = new Map([
      [
        bindingKey({ collection: "fleet" }),
        [
          { key: "1", value: { title: "allowed", onPress: { action: "open-agent" } } },
          { key: "2", value: { title: "refused", onPress: { action: "delete-everything" } } },
        ],
      ],
    ]);

    const allowed = build(
      panel([{ component: "list", bind: { collection: "fleet", allowActions: ["open-agent"] } }]),
      { collections },
    );
    const selectable = allowed.rows.flatMap((row) =>
      row.kind === "listItem" && row.selection !== null ? [row.title] : [],
    );
    expect(selectable).toEqual(["allowed"]);
    expect(allowed.interactives.flatMap((entry) => (entry.kind === "action" ? [entry.action.action] : [])))
      .toEqual(["open-agent"]);

    // No allowlist keeps the old answer: a bound row names nothing.
    const bare = build(panel([{ component: "list", bind: { collection: "fleet" } }]), { collections });
    expect(bare.rows.every((row) => row.kind !== "listItem" || row.selection === null)).toBe(true);
  });

  it("carries the panel's refresh action so `r` can dispatch it before refetching", () => {
    // Stamped onto the stored schema by the writer, off the manifest. A panel
    // with no declaration keeps `r` the plain refetch it always was.
    expect(build(panel([], { refreshAction: "refresh-fleet" })).refreshAction).toBe("refresh-fleet");
    expect(build(panel([])).refreshAction).toBeNull();

    // Read even when the schema is one this build cannot render: a refresh may
    // be what turns it into one it can, and refusing there strands the reader
    // on the fallback card.
    const unreadable = build(panel([], { v: 99, refreshAction: "refresh-fleet" }));
    expect(unreadable.status).toBe("fallback");
    expect(unreadable.refreshAction).toBe("refresh-fleet");

    // No row at all means no schema to read a declaration off.
    expect(build({ state: "missing" }).refreshAction).toBeNull();
  });

  it("draws a rich row's badge and mono line, and its actions as numbered keys", () => {
    const model = build(panel([{
      component: "list",
      items: [{
        title: "bc-1",
        subtitle: "Fix the login redirect",
        mono: "origin/fix-login-redirect",
        badge: { text: "Running", tone: "accent" },
        onPress: { action: "open-agent" },
        actions: [{ action: "stop", label: "Stop", confirm: "Stop this agent?" }],
        // `overflow` degrades into the same numbered list as `actions`: a
        // terminal pane has no menu, and showing what the row can do beats
        // hiding half of it behind a control the reader cannot open.
        overflow: [{ action: "archive", label: "Archive" }],
      }],
    }]));

    const item = model.rows.find((row) => row.kind === "listItem");
    expect(item?.kind === "listItem" ? item.badge : null).toEqual({ text: "Running", tone: "accent" });
    expect(item?.kind === "listItem" ? item.mono : null).toBe("origin/fix-login-redirect");

    const buttons = model.rows.find((row) => row.kind === "buttons");
    expect(buttons?.kind === "buttons" ? buttons.buttons.map((entry) => entry.label) : [])
      .toEqual(["Stop", "Archive"]);
    // Each one is a real interactive, so `confirm` and the dispatch path are
    // the ones a `button` node already uses.
    expect(model.interactives.map((entry) => (entry.kind === "action" ? entry.action.action : entry.kind)))
      .toEqual(["open-agent", "stop", "archive"]);
    const stop = model.interactives[1];
    expect(stop.kind === "action" ? stop.action.confirm : null).toBe("Stop this agent?");
  });

  it("keeps a hundred rich rows in one list without spending the node budget", () => {
    // The pane draws a row, its mono line and its buttons; the SCHEMA is still
    // one node, which is what the widening bought.
    const items = Array.from({ length: 100 }, (_, index) => ({
      title: `bc-${index}`,
      mono: `origin/agent-${index}`,
      badge: { text: "Running" },
      actions: [{ action: "open", label: "Open", args: { id: `bc-${index}` } }],
    }));
    const model = build(panel([{ component: "list", items }]));
    expect(model.rows.filter((row) => row.kind === "listItem")).toHaveLength(100);
    expect(model.interactives).toHaveLength(100);
    expect(model.status).toBe("ok");
  });

  it("gates a bound row's trailing actions through the binding's allowlist", () => {
    const collections: PluginPaneCollectionMap = new Map([
      [
        bindingKey({ collection: "fleet" }),
        [{
          key: "1",
          value: {
            title: "bc-1",
            actions: [
              { action: "open-agent", label: "Open" },
              { action: "delete-everything", label: "Delete" },
            ],
          },
        }],
      ],
    ]);
    const model = build(
      panel([{ component: "list", bind: { collection: "fleet", allowActions: ["open-agent"] } }]),
      { collections },
    );
    const buttons = model.rows.find((row) => row.kind === "buttons");
    expect(buttons?.kind === "buttons" ? buttons.buttons.map((entry) => entry.label) : [])
      .toEqual(["Open"]);
  });

  it("shows the node's own empty text when a binding has no rows", () => {
    const model = build(panel([
      { component: "list", bind: { collection: "issues" }, emptyText: "No issues assigned." },
    ]));
    expect(model.rows).toEqual([
      { kind: "note", key: "body[0]", indent: 0, text: "No issues assigned." },
    ]);
  });

  it("draws a bound cell the way the app does, not as a blank", () => {
    // The two surfaces used to disagree: a numeric `42` rendered as 42 in the
    // app and as an empty value here, from two coercers that each claimed to
    // mirror the other. Both now read the vocabulary's own.
    const collections: PluginPaneCollectionMap = new Map([
      [
        bindingKey({ collection: "stats" }),
        [
          { key: "1", value: { key: "Open", value: 42 } },
          { key: "2", value: { key: "Passing", value: true } },
        ],
      ],
    ]);
    const model = build(panel([{ component: "keyValue", bind: { collection: "stats" } }]), { collections });
    const values = model.rows.flatMap((row) => (row.kind === "keyValue" ? [`${row.label}=${row.value}`] : []));
    expect(values).toEqual(["Open=42", "Passing=Yes"]);
  });

  it("names a component it cannot draw instead of leaving a gap", () => {
    const model = build(panel([
      { component: "chart", kind: "line", series: [{ id: "s", points: [{ x: 1, y: 2 }] }], title: "Throughput" },
      { component: "video", src: "file:///clip.mp4" },
      { component: "hologram", whatever: true },
    ]));

    const placeholders = model.rows.flatMap((row) => (row.kind === "placeholder" ? [row] : []));
    expect(placeholders.map((row) => row.label)).toEqual(["Chart · Throughput", "Video", "hologram"]);
    // The panel declared a deeplink, so the hint points at it.
    expect(placeholders[0]?.hint).toBe("Ctrl+Y copies a link that opens it");
    expect(placeholders[2]?.hint).toBe("This ADE version does not draw it yet");
    expect(model.warnings).toHaveLength(1);
  });

  it("tells the user to open the app when the panel has no link", () => {
    const model = build(panel([{ component: "video", src: "file:///clip.mp4" }], {
      fallback: { title: "Clip", text: "A recording." },
    }));
    const row = model.rows[0];
    expect(row?.kind === "placeholder" && row.hint).toBe("Run ade open to view it in the app");
  });

  it("falls back to the plugin's own words when the schema cannot be parsed", () => {
    const model = build({
      state: "ok",
      record: {
        pluginId: "graph",
        panelId: "main",
        // Vocabulary v2 from a newer plugin: unrenderable, but the fallback reads.
        title: "Graph",
        schema: { v: 2, fallback: FALLBACK, body: [] },
        vocabVersion: 2,
        updatedAt: null,
      },
    });

    expect(model.status).toBe("fallback");
    expect(model.rows.length).toBeGreaterThan(0);
    expect(model.rows[0]).toEqual({
      kind: "text",
      key: "fallback.title",
      indent: 0,
      text: "Graph",
      variant: "subtitle",
      tone: "neutral",
    });
    expect(model.interactives).toEqual([]);
  });

  it("never renders a blank pane, even for a schema with no fallback at all", () => {
    const model = build({
      state: "ok",
      record: {
        pluginId: "graph",
        panelId: "main",
        title: null,
        schema: { v: 1, body: [] },
        vocabVersion: 1,
        updatedAt: null,
      },
    });
    expect(model.status).toBe("fallback");
    expect(model.rows).not.toHaveLength(0);
  });

  it("says so plainly when the host cannot serve panels", () => {
    const model = build({ state: "unsupported" });
    expect(model.rows[0]?.kind).toBe("note");
    expect(model.rows[0]?.kind === "note" && model.rows[0].text).toMatch(/does not serve plugin panels/);
  });

  it("distinguishes a missing panel from a broken one", () => {
    const missing = build({ state: "missing" });
    expect(missing.rows[0]?.kind === "note" && missing.rows[0].text).toMatch(/has not published a "main" panel/);
    const failed = build({ state: "error", message: "socket closed" });
    expect(failed.rows[0]?.kind === "note" && failed.rows[0].text).toBe("socket closed");
  });
});

describe("plugin pane forms", () => {
  const formPanel = panel([
    {
      component: "form",
      fields: [
        { kind: "text", id: "name", label: "Name", placeholder: "lane name" },
        { kind: "toggle", id: "draft", label: "Draft", value: true },
        {
          kind: "select",
          id: "base",
          label: "Base",
          options: [{ value: "main" }, { value: "dev", label: "Develop" }],
          value: "main",
        },
      ],
      submit: { label: "Create", onPress: { action: "createLane" } },
    },
  ]);

  it("lays a form out as value rows plus a submit, all selectable", () => {
    const model = build(formPanel);
    expect(model.rows.map((row) => row.kind)).toEqual(["field", "field", "field", "submit"]);
    expect(model.interactives.map((entry) => entry.kind)).toEqual(["field", "field", "field", "submit"]);
    const rows = model.rows.flatMap((row) => (row.kind === "field" ? [row.display] : []));
    expect(rows).toEqual(["lane name", "on", "main"]);
  });

  it("shows typed values and masks a secret", () => {
    const secretPanel = panel([
      {
        component: "form",
        fields: [{ kind: "secret", id: "token", label: "Token" }],
        submit: { label: "Save", onPress: { action: "save" } },
      },
    ]);
    const withValue = build(secretPanel, { values: { [pluginFormValueKey("body[0]", "token")]: "hunter2" } });
    const row = withValue.rows[0];
    expect(row?.kind === "field" && row.display).toBe("••••••••");
  });

  it("marks the field that owns the composer", () => {
    const model = build(formPanel, { editing: 0 });
    const rows = model.rows.flatMap((row) => (row.kind === "field" ? [row.editing] : []));
    expect(rows).toEqual([true, false, false]);
  });

  it("cycles toggles and selects without a text input", () => {
    const toggle: VocabField = { kind: "toggle", id: "draft", label: "Draft" };
    expect(cyclePluginFieldValue(toggle, "false", 1)).toBe("true");
    expect(cyclePluginFieldValue(toggle, "true", 1)).toBe("false");

    const select: VocabField = {
      kind: "select",
      id: "base",
      label: "Base",
      options: [{ value: "main" }, { value: "dev" }, { value: "next" }],
    };
    expect(cyclePluginFieldValue(select, "main", 1)).toBe("dev");
    expect(cyclePluginFieldValue(select, "main", -1)).toBe("next");

    expect(pluginFieldUsesComposer("text")).toBe(true);
    expect(pluginFieldUsesComposer("secret")).toBe(true);
    expect(pluginFieldUsesComposer("number")).toBe(true);
    expect(pluginFieldUsesComposer("toggle")).toBe(false);
    expect(pluginFieldUsesComposer("select")).toBe(false);
  });

  it("prefers a typed value over the schema's default", () => {
    const field: VocabField = { kind: "text", id: "name", label: "Name", value: "from-schema" };
    expect(pluginFieldRawValue(field, "body[0]", {})).toBe("from-schema");
    expect(pluginFieldRawValue(field, "body[0]", { [pluginFormValueKey("body[0]", "name")]: "typed" }))
      .toBe("typed");
  });
});

/* ── Client-evaluated panel state ─────────────────────────────────────────── */

const FLEET_ROWS = [
  { key: "1", value: { title: "bc-1f4a", statusGroup: "active", archivedGroup: "live" } },
  { key: "2", value: { title: "bc-90de", statusGroup: "active", archivedGroup: "live" } },
  { key: "3", value: { title: "bc-77b2", statusGroup: "failed", archivedGroup: "live" } },
  { key: "4", value: { title: "bc-3ac1", statusGroup: "finished", archivedGroup: "live" } },
  { key: "5", value: { title: "bc-0092", statusGroup: "finished", archivedGroup: "archived" } },
];

function fleet(): PluginPaneCollectionMap {
  return new Map([[bindingKey({ collection: "agents" }), FLEET_ROWS]]);
}

const STATUS_CONTROL = {
  component: "segmented",
  stateKey: "statusFilter",
  label: "Status",
  default: "",
  options: [
    { value: "", label: "All", badge: "5" },
    { value: "active", label: "Active", badge: "2" },
    { value: "failed", label: "Failed", badge: "1" },
  ],
};

/** A list of the fleet filtered by whatever `statusFilter` currently holds. */
function statusFilteredList(extra: Record<string, unknown> = {}) {
  return {
    component: "list",
    bind: {
      collection: "agents",
      where: [{ field: "statusGroup", equals: { $state: "statusFilter" } }],
      ...extra,
    },
    emptyText: "No agents match this filter.",
  };
}

function listTitles(model: PluginPaneModel): string[] {
  return model.rows.flatMap((row) => (row.kind === "listItem" ? [row.title] : []));
}

describe("plugin pane panel state", () => {
  it("draws a segmented control as one row of options, with the default in force", () => {
    const model = build(panel([STATUS_CONTROL]));

    expect(model.rows.map((row) => row.kind)).toEqual(["segmented"]);
    const row = model.rows[0];
    expect(row?.kind === "segmented" && row.label).toBe("Status");
    expect(row?.kind === "segmented" && row.options.map((option) => option.label)).toEqual([
      "All",
      "Active",
      "Failed",
    ]);
    // The default is the one in force, and every option is reachable in one
    // keystroke rather than by cycling to it.
    expect(row?.kind === "segmented" && row.options.map((option) => option.selected)).toEqual([
      true,
      false,
      false,
    ]);
    expect(model.interactives).toEqual([
      { kind: "state", stateKey: "statusFilter", label: "All", value: "" },
      { kind: "state", stateKey: "statusFilter", label: "Active", value: "active" },
      { kind: "state", stateKey: "statusFilter", label: "Failed", value: "failed" },
    ]);
    expect(model.state).toEqual({ statusFilter: "" });
  });

  it("keeps every row while the filter is unset, and filters once it is not", () => {
    const body = [STATUS_CONTROL, statusFilteredList()];

    // "All" is the empty value, so the clause is INACTIVE rather than false: an
    // unset filter shows everything instead of hiding everything.
    const unset = build(panel(body), { collections: fleet() });
    expect(listTitles(unset)).toEqual(["bc-1f4a", "bc-90de", "bc-77b2", "bc-3ac1", "bc-0092"]);

    const active = build(panel(body), {
      collections: fleet(),
      state: { statusFilter: "active" },
      stateSignature: unset.stateSignature,
    });
    expect(listTitles(active)).toEqual(["bc-1f4a", "bc-90de"]);
  });

  it("treats a state key no control declares as inactive, not as false", () => {
    const model = build(panel([
      {
        component: "list",
        bind: {
          collection: "agents",
          where: [{ field: "statusGroup", equals: { $state: "nobodyDeclaredThis" } }],
        },
      },
    ]), { collections: fleet() });

    expect(listTitles(model)).toHaveLength(5);
  });

  it("filters on literals and on composed clauses", () => {
    const model = build(panel([
      {
        component: "list",
        bind: {
          collection: "agents",
          where: [
            {
              or: [
                { field: "statusGroup", in: ["failed"] },
                {
                  and: [
                    { field: "statusGroup", equals: "finished" },
                    { field: "archivedGroup", notEquals: "archived" },
                  ],
                },
              ],
            },
          ],
        },
      },
    ]), { collections: fleet() });

    expect(listTitles(model)).toEqual(["bc-77b2", "bc-3ac1"]);
  });

  it("drops a clause nested past the depth limit rather than the rows it guarded", () => {
    const model = build(panel([
      {
        component: "list",
        bind: {
          collection: "agents",
          where: [
            { and: [{ or: [{ not: { field: "statusGroup", equals: "active" } }] }] },
          ],
        },
      },
    ]), { collections: fleet() });

    // A `where` that cannot be read filters nothing: a broken filter that shows
    // too much is visible, one that silently hides rows is not.
    expect(listTitles(model)).toHaveLength(5);
    expect(model.warnings.join(" ")).toContain("nest at most");
  });

  it("filters before it caps, so a limited list is not a filtered window", () => {
    const model = build(panel([STATUS_CONTROL, statusFilteredList({ limit: 2 })]), {
      collections: fleet(),
      state: { statusFilter: "finished" },
      stateSignature: build(panel([STATUS_CONTROL])).stateSignature,
    });

    // The two finished agents sit fourth and fifth. Capping first would have
    // filtered the first two rows and found nothing.
    expect(listTitles(model)).toEqual(["bc-3ac1", "bc-0092"]);
  });

  it("reads the panel's own state back through the `$state` collection", () => {
    const model = build(panel([
      STATUS_CONTROL,
      { component: "keyValue", bind: { collection: "$state" } },
    ]), { state: { statusFilter: "active" }, stateSignature: build(panel([STATUS_CONTROL])).stateSignature });

    const row = model.rows.find((entry) => entry.kind === "keyValue");
    // The OPTION'S LABEL, not the raw value: a reader wants "Status: Active".
    expect(row?.kind === "keyValue" && [row.label, row.value]).toEqual(["Status", "Active"]);
  });

  it("answers a `$state` binding at render rather than at the fetch", async () => {
    const fetchRows = vi.fn(async () => [{ key: "k", value: "v" }]);
    const rows = await pluginPaneBindingRows({ collection: "$state" }, null, fetchRows);
    expect(rows).toEqual([]);
    expect(fetchRows).not.toHaveBeenCalled();
  });

  it("carries a selection across a republish of the same controls", () => {
    const first = build(panel([STATUS_CONTROL, statusFilteredList()]), { collections: fleet() });
    const chosen = pluginPaneStateChange(first, "statusFilter", "failed");

    const republished = build(panel([STATUS_CONTROL, statusFilteredList()]), {
      collections: fleet(),
      state: chosen,
      stateSignature: first.stateSignature,
    });

    expect(republished.state).toEqual({ statusFilter: "failed" });
    expect(listTitles(republished)).toEqual(["bc-77b2"]);
  });

  it("reconciles a selection the republished controls no longer offer", () => {
    const first = build(panel([STATUS_CONTROL]));
    const chosen = pluginPaneStateChange(first, "statusFilter", "failed");

    const narrowed = build(panel([
      {
        ...STATUS_CONTROL,
        options: [
          { value: "", label: "All" },
          { value: "active", label: "Active" },
        ],
      },
    ]), { state: chosen, stateSignature: first.stateSignature });

    expect(narrowed.stateSignature).not.toBe(first.stateSignature);
    expect(narrowed.state).toEqual({ statusFilter: "" });
  });

  it("refuses a value the control never offered, and cycles through the ones it did", () => {
    const model = build(panel([STATUS_CONTROL]));

    expect(pluginPaneStateChange(model, "statusFilter", "invented")).toEqual(model.state);
    expect(pluginPaneStateChange(model, "noSuchKey", "active")).toEqual(model.state);
    expect(pluginPaneStateCycle(model, "statusFilter", 1)).toEqual({ statusFilter: "active" });
    // Wrapping: one step back from the first option is the last one.
    expect(pluginPaneStateCycle(model, "statusFilter", -1)).toEqual({ statusFilter: "failed" });
  });

  it("reports the reader's selections as an action's `state` payload", () => {
    const model = build(panel([STATUS_CONTROL]));
    expect(pluginPaneStatePayload(model.state)).toEqual({ statusFilter: "" });
    expect(pluginPaneStatePayload(pluginPaneStateChange(model, "statusFilter", "active")))
      .toEqual({ statusFilter: "active" });
    // A panel with no controls sends nothing rather than an empty object.
    expect(pluginPaneStatePayload(build(panel([{ component: "text", text: "hi" }])).state)).toBeNull();
  });

  it("puts the reader back on a filter an action reset", () => {
    const first = build(panel([STATUS_CONTROL]));
    const model = build(panel([STATUS_CONTROL]), {
      state: pluginPaneStateChange(first, "statusFilter", "active"),
      stateSignature: first.stateSignature,
    });

    expect(pluginPaneStateReset(model, { resetState: true })).toEqual({ statusFilter: "" });
    expect(pluginPaneStateReset(model, { resetState: ["statusFilter"] })).toEqual({ statusFilter: "" });
    expect(pluginPaneStateReset(model, { resetState: ["someoneElse"] })).toEqual({ statusFilter: "active" });
    // An action that said nothing about state leaves it alone.
    expect(pluginPaneStateReset(model, { ok: true })).toBeNull();
  });

  it("dispatches an `onChange` beside the local write, never instead of it", () => {
    const model = build(panel([{ ...STATUS_CONTROL, onChange: { action: "filterChanged" } }]));
    expect(model.interactives[1]).toEqual({
      kind: "state",
      stateKey: "statusFilter",
      label: "Active",
      value: "active",
      onChange: { action: "filterChanged" },
    });
  });

  it("draws the app's own filtered-rows fixture, filtered the same way", () => {
    const fixture = PLUGIN_FIXTURES.find((entry) => entry.id === "filtered-rows");
    if (!fixture) throw new Error("the filtered-rows fixture is what pins client parity");
    // The rows the fixture ships, keyed exactly as the pane keys a real fetch.
    const collections: PluginPaneCollectionMap = new Map(
      (fixture.rows ?? []).map((group) => [
        bindingKey({
          collection: group.collection,
          ...(group.keyPrefix !== undefined ? { keyPrefix: group.keyPrefix } : {}),
        }),
        group.items.map((value, index) => ({ key: String(index), value })),
      ]),
    );
    const record: PluginPanelFetch = {
      state: "ok",
      record: {
        pluginId: "graph",
        panelId: "main",
        title: "Filtered rows",
        schema: fixture.schema,
        vocabVersion: 1,
        updatedAt: null,
      },
    };

    const opened = build(record, { collections });
    expect(opened.warnings).toEqual([]);
    expect(opened.rows.some((row) => row.kind === "segmented")).toBe(true);
    // Two controls, and the fixture's second one defaults to hiding archived
    // rows — so the first list opens on the four live agents.
    expect(opened.declarations.map((entry) => entry.stateKey)).toEqual(["statusFilter", "archived"]);
    expect(listTitles(opened).slice(0, 4)).toEqual(["bc-1f4a", "bc-90de", "bc-77b2", "bc-3ac1"]);

    const failed = build(record, {
      collections,
      state: { ...opened.state, statusFilter: "failed" },
      stateSignature: opened.stateSignature,
    });
    expect(listTitles(failed).slice(0, 1)).toEqual(["bc-77b2"]);
  });

  it("keeps the control the reader is standing on inside the window", () => {
    const body: unknown[] = [];
    for (let index = 0; index < 20; index += 1) {
      body.push({ component: "text", text: `line ${index}` });
    }
    body.push(STATUS_CONTROL);
    const model = build(panel(body));

    // The control's options are the last interactives, and the pane has no
    // scrollbar: moving the selection is what scrolls.
    const window = pluginPaneWindow(model, model.interactives.length - 1, 6);
    expect(window.rows.some((row) => row.kind === "segmented")).toBe(true);
  });

  it("identifies a state option by what it sets, not by its label", () => {
    const model = build(panel([STATUS_CONTROL]));
    const renamed = build(panel([{
      ...STATUS_CONTROL,
      options: [
        { value: "", label: "All" },
        { value: "active", label: "Running" },
        { value: "failed", label: "Failed" },
      ],
    }]));

    const key = (source: PluginPaneModel, index: number) =>
      pluginInteractiveKey(source, source.interactives[index]!);
    expect(key(renamed, 1)).toBe(key(model, 1));
    expect(key(model, 2)).not.toBe(key(model, 1));
  });
});

describe("plugin pane selection and layout", () => {
  const listPanel = panel([
    {
      component: "list",
      items: [
        { title: "one", onPress: { action: "a" } },
        { title: "two", onPress: { action: "b" } },
        { title: "three", onPress: { action: "c" } },
      ],
    },
  ]);

  it("wraps selection in both directions", () => {
    const model = build(listPanel);
    expect(movePluginPaneSelection(model, 0, 1)).toBe(1);
    expect(movePluginPaneSelection(model, 2, 1)).toBe(0);
    expect(movePluginPaneSelection(model, 0, -1)).toBe(2);
  });

  it("identifies an interactive by what it does, not by where it sits", () => {
    // What the armed confirm remembers between the two Enter presses. A poll can
    // land in that gap and rebuild the panel, so remembering the index would
    // point the confirmation at whatever moved into that slot.
    const remove = {
      component: "button",
      label: "Delete lane",
      onPress: { action: "deleteLane", args: { id: "a" }, confirm: "This deletes lane a." },
    };
    const armed = build(panel([remove]));
    const refreshed = build(panel([{ component: "button", label: "Rebuild", onPress: { action: "rebuild" } }, remove]));

    const key = pluginInteractiveKey(armed, armed.interactives[0]!);
    expect(pluginInteractiveKey(refreshed, refreshed.interactives[1]!)).toBe(key);
    expect(pluginInteractiveKey(refreshed, refreshed.interactives[0]!)).not.toBe(key);

    // Same action, different target: not the thing the user confirmed.
    const other = build(panel([{ ...remove, onPress: { ...remove.onPress, args: { id: "b" } } }]));
    expect(pluginInteractiveKey(other, other.interactives[0]!)).not.toBe(key);
  });

  it("clamps a stale index instead of jumping to nothing", () => {
    const model = build(listPanel);
    expect(movePluginPaneSelection(model, 99, 1)).toBe(0);
    expect(movePluginPaneSelection(build(panel([{ component: "text", text: "read only" }])), 3, 1)).toBe(0);
  });

  it("scrolls the window to keep the selected row on screen", () => {
    const model = build(panel([
      {
        component: "list",
        items: Array.from({ length: 20 }, (_, index) => ({
          title: `row-${index}`,
          onPress: { action: "open", args: { index } },
        })),
      },
    ]));

    const top = pluginPaneWindow(model, 0, 5);
    expect(top.hiddenBefore).toBe(0);
    expect(top.rows).toHaveLength(5);
    expect(top.hiddenAfter).toBe(15);

    const deep = pluginPaneWindow(model, 12, 5);
    const titles = deep.rows.flatMap((row) => (row.kind === "listItem" ? [row.title] : []));
    expect(titles).toContain("row-12");
    expect(deep.hiddenBefore).toBe(11);
  });

  it("fits table columns inside the pane rather than wrapping a row", () => {
    const columns = [
      { key: "name", label: "Name" },
      { key: "note", label: "Note" },
    ];
    const rows = [["short", "a very long note that would wrap the row if it were not truncated"]];
    const widths = pluginTableWidths(columns, rows, 30);
    expect(widths.reduce((sum, width) => sum + width, 0) + 1).toBeLessThanOrEqual(30);
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(3);
  });

  it("leaves narrow tables at their natural width", () => {
    const widths = pluginTableWidths(
      [{ key: "a", label: "A" }, { key: "b", label: "B" }],
      [["one", "two"]],
      60,
    );
    expect(widths).toEqual([3, 3]);
  });
});

describe("plugin lookup", () => {
  function summary(overrides: Partial<PluginSummary>): PluginSummary {
    return {
      pluginId: "graph",
      version: "1.0.0",
      displayName: "Graph",
      description: "",
      icon: null,
      accent: null,
      enabled: true,
      status: "running",
      warnings: [],
      errors: [],
      source: { kind: "builtin" },
      installedAt: "2026-08-11T00:00:00.000Z",
      hasEntry: true,
      surfaces: [],
      cli: [],
      restartCount: 0,
      lastCrashAt: null,
      theme: null,
      ...overrides,
    };
  }

  const plugins = [
    summary({ pluginId: "graph", displayName: "Graph" }),
    summary({ pluginId: "grafana", displayName: "Grafana" }),
    summary({ pluginId: "notes", displayName: "Sticky Notes" }),
  ];

  it("matches an id, a display name, and a unique prefix", () => {
    expect(resolvePluginByName(plugins, "graph")?.pluginId).toBe("graph");
    expect(resolvePluginByName(plugins, "Sticky Notes")?.pluginId).toBe("notes");
    expect(resolvePluginByName(plugins, "sticky")?.pluginId).toBe("notes");
  });

  it("refuses an ambiguous prefix rather than opening the wrong plugin", () => {
    expect(resolvePluginByName(plugins, "gra")).toBeNull();
    expect(resolvePluginByName(plugins, "")).toBeNull();
    expect(resolvePluginByName(plugins, "nope")).toBeNull();
  });

  it("opens the plugin's first tab surface, defaulting to main", () => {
    expect(defaultPluginPanelId(summary({
      surfaces: [{ kind: "tab", id: "graph", title: "Graph", panelId: "overview" }],
    }))).toBe("overview");
    expect(defaultPluginPanelId(summary({ surfaces: [] }))).toBe("main");
  });
});

/**
 * A `navigate` that names a placement the terminal has no places for.
 *
 * `target` chooses between the desktop's plugin tab and its Work tools rail.
 * `ade code` has one plugin pane and opens the panel there whatever the answer
 * says, so the contract is that the field is read and then ignored — never that
 * it takes the navigation with it. The three call sites in `app.tsx` read
 * `panelId` and `context` off this reader and nothing else, which is what makes
 * that true; this pins the reader half.
 */
describe("plugin pane navigation from an action", () => {
  it("keeps the panel whatever placement the plugin asked for", () => {
    for (const target of ["tools-pane", "tab", "invented-later", 7, null]) {
      expect(readPluginActionNavigation({ navigate: { panelId: "main", target } }))
        .toMatchObject({ panelId: "main" });
    }
  });

  it("still carries the context the pane loads with", () => {
    expect(readPluginActionNavigation({
      navigate: { panelId: "detail", target: "tools-pane", context: { issue: "ISS-14" } },
    })).toMatchObject({ panelId: "detail", context: { issue: "ISS-14" } });
  });
});

/**
 * The `{prompt}` verb — the one that comes back.
 *
 * `dispatchPluginAction` below is the loop app.tsx runs around every plugin
 * action (a row press, a panel button, a keyboard chord, a declared refresh),
 * written out of the same two exported functions those four call sites use:
 * `pluginPromptOutcome` decides whether a question may be asked, and
 * `pluginPromptAnswerArgs` builds the re-invocation. What the tests pin is the
 * round trip's shape — SAME action, SAME arguments plus `args.prompt` — because
 * that shape is what a plugin handler is written against and what the desktop,
 * the phone and the terminal have to agree on.
 */
function promptConnection(results: readonly unknown[]) {
  const calls: { pluginId: unknown; action: unknown; args: Record<string, unknown> }[] = [];
  const connection = {
    action: async (_domain: string, _action: string, args?: Record<string, unknown>) => {
      calls.push({
        pluginId: args?.pluginId,
        action: args?.action,
        args: (args?.args ?? {}) as Record<string, unknown>,
      });
      return results[calls.length - 1] ?? {};
    },
  } as unknown as AdeCodeConnection;
  return { connection, calls };
}

async function dispatchPluginAction(input: {
  connection: AdeCodeConnection;
  args: Record<string, unknown>;
  /** What the reader types at each question. `null` presses Esc. */
  answers: readonly (string | null)[];
}): Promise<{ followed: unknown[]; notices: string[] }> {
  const followed: unknown[] = [];
  const notices: string[] = [];
  const pluginId = "journal";
  const actionId = "logNote";
  const label = "Log it";
  let args = input.args;
  let result = await invokePluginAction(input.connection, pluginId, actionId, args);
  for (let asked = 0; ; asked += 1) {
    const outcome = pluginPromptOutcome({ result, pluginId, displayName: "Work Journal", actionId, args, label });
    if (outcome.kind === "ignored") notices.push("second question ignored");
    if (outcome.kind === "unreadable") notices.push("question unreadable");
    if (outcome.kind !== "ask") {
      followed.push(result);
      return { followed, notices };
    }
    const typed = input.answers[asked] ?? null;
    // Esc. Nothing is invoked and no follow-up runs.
    if (typed === null) return { followed, notices };
    const next = pluginPromptAnswerArgs(outcome.request, typed);
    if (!next) {
      notices.push(pluginPromptTooLongNotice(outcome.request));
      return { followed, notices };
    }
    args = next;
    result = await invokePluginAction(
      input.connection,
      outcome.request.pluginId,
      outcome.request.actionId,
      args,
    );
  }
}

const NOTE_PROMPT = {
  prompt: {
    id: "note",
    title: "What are you working on?",
    placeholder: "One line",
    submitLabel: "Log",
    context: { laneId: "lane-1" },
  },
};

describe("the plugin action prompt", () => {
  it("re-invokes the same action with the same arguments plus the answer", async () => {
    const { connection, calls } = promptConnection([NOTE_PROMPT, { navigate: { panelId: "journal" } }]);

    const run = await dispatchPluginAction({
      connection,
      args: { context: { kind: "lane", id: "lane-1" } },
      answers: ["shipping the badge fix"],
    });

    expect(calls).toHaveLength(2);
    // Same plugin, same verb: a button that asks is not a different button.
    expect(calls[1]?.pluginId).toBe(calls[0]?.pluginId);
    expect(calls[1]?.action).toBe(calls[0]?.action);
    expect(calls[1]?.args).toEqual({
      context: { kind: "lane", id: "lane-1" },
      prompt: { id: "note", text: "shipping the badge fix", context: { laneId: "lane-1" } },
    });
    // The first invocation is untouched by the round trip.
    expect(calls[0]?.args).toEqual({ context: { kind: "lane", id: "lane-1" } });
    // Only the SECOND result reaches the call site's follow-up: the first was a
    // request for an answer, not a finished action.
    expect(run.followed).toEqual([{ navigate: { panelId: "journal" } }]);
  });

  it("carries the prompt's own context back, and leaves it off when there was none", async () => {
    const { connection, calls } = promptConnection([{ prompt: { id: "note" } }]);

    await dispatchPluginAction({ connection, args: {}, answers: ["no context here"] });

    expect(calls[1]?.args).toEqual({ prompt: { id: "note", text: "no context here" } });
  });

  it("invokes nothing at all when the reader presses Esc", async () => {
    const { connection, calls } = promptConnection([NOTE_PROMPT]);

    const run = await dispatchPluginAction({ connection, args: {}, answers: [null] });

    expect(calls).toHaveLength(1);
    expect(run.followed).toEqual([]);
  });

  it("ignores a second question the re-invocation asks — one hop, never a wizard", async () => {
    const { connection, calls } = promptConnection([
      NOTE_PROMPT,
      { prompt: { id: "blocker", title: "And what is blocking you?" } },
    ]);

    const run = await dispatchPluginAction({
      connection,
      args: {},
      answers: ["first answer", "second answer"],
    });

    expect(calls).toHaveLength(2);
    expect(run.notices).toEqual(["second question ignored"]);
    // The ignored question is still a RESULT: its other verbs would run.
    expect(run.followed).toEqual([{ prompt: { id: "blocker", title: "And what is blocking you?" } }]);
  });

  it("refuses an over-ceiling answer instead of truncating it", async () => {
    const { connection, calls } = promptConnection([NOTE_PROMPT]);

    const run = await dispatchPluginAction({
      connection,
      args: {},
      answers: ["x".repeat(4097)],
    });

    expect(calls).toHaveLength(1);
    expect(run.notices).toEqual([
      "What are you working on?: that answer is too long to send. Shorten it and press enter again.",
    ]);
    // 4096 bytes is inside the ceiling and goes through.
    const ok = promptConnection([NOTE_PROMPT, {}]);
    await dispatchPluginAction({ connection: ok.connection, args: {}, answers: ["x".repeat(4096)] });
    expect(ok.calls).toHaveLength(2);
  });

  it("counts the ceiling in bytes, not characters", async () => {
    // "é" is two UTF-8 bytes, so 2049 of them are 4098 bytes.
    const { connection, calls } = promptConnection([NOTE_PROMPT]);
    await dispatchPluginAction({ connection, args: {}, answers: ["é".repeat(2049)] });

    expect(calls).toHaveLength(1);
  });

  it("sends an empty answer rather than treating Enter on a blank field as a cancel", async () => {
    const { connection, calls } = promptConnection([NOTE_PROMPT, {}]);

    await dispatchPluginAction({ connection, args: {}, answers: [""] });

    expect(calls).toHaveLength(2);
    expect(calls[1]?.args).toMatchObject({ prompt: { id: "note", text: "" } });
  });

  it("says so rather than silently doing nothing when the question is malformed", async () => {
    const { connection, calls } = promptConnection([{ prompt: { id: "not a valid id!" } }]);

    const run = await dispatchPluginAction({ connection, args: {}, answers: ["ignored"] });

    expect(calls).toHaveLength(1);
    expect(run.notices).toEqual(["question unreadable"]);
  });

  it("draws the plugin's words, and its own only where the plugin left a gap", () => {
    const asked = pluginPromptOutcome({
      result: NOTE_PROMPT,
      pluginId: "journal",
      displayName: "Work Journal",
      actionId: "logNote",
      args: {},
      label: "Log it",
    });
    const bare = pluginPromptOutcome({
      result: { prompt: { id: "note" } },
      pluginId: "journal",
      displayName: "Work Journal",
      actionId: "logNote",
      args: {},
      label: "Log it",
    });
    if (asked.kind !== "ask" || bare.kind !== "ask") throw new Error("expected both to ask");

    expect(pluginPromptTitle(asked.request)).toBe("What are you working on?");
    expect(pluginPromptPlaceholder(asked.request)).toBe("One line");
    expect(pluginPromptHint(asked.request)).toBe("↵ Log · esc cancel");
    // No title: the control's own label is the question, never a blank line.
    expect(pluginPromptTitle(bare.request)).toBe("Log it");
    expect(pluginPromptPlaceholder(bare.request)).toBe("");
    expect(pluginPromptHint(bare.request)).toBe("↵ Submit · esc cancel");
  });
});
