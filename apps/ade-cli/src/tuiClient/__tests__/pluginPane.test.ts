import { describe, expect, it } from "vitest";

import {
  bindingKey,
  buildPluginPaneModel,
  cyclePluginFieldValue,
  movePluginPaneSelection,
  pluginFieldRawValue,
  pluginFieldUsesComposer,
  pluginFormValueKey,
  pluginInteractiveKey,
  pluginPaneWindow,
  pluginTableWidths,
  type PluginPaneCollectionMap,
  type PluginPaneInput,
  type PluginPaneModel,
  type PluginPanelFetch,
} from "../pluginPane";
import { defaultPluginPanelId, resolvePluginByName } from "../adeApi";
import type { PluginSummary } from "../../../../desktop/src/shared/plugins/sdk";
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
  options: { collections?: PluginPaneCollectionMap; values?: Record<string, string>; editing?: number | null } = {},
): PluginPaneModel {
  const input: PluginPaneInput = {
    pluginId: "graph",
    displayName: "Graph",
    panelId: "main",
    fetch,
    collections: options.collections ?? new Map(),
    values: options.values ?? {},
    editing: options.editing ?? null,
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

    const key = pluginInteractiveKey(armed.interactives[0]!);
    expect(pluginInteractiveKey(refreshed.interactives[1]!)).toBe(key);
    expect(pluginInteractiveKey(refreshed.interactives[0]!)).not.toBe(key);

    // Same action, different target: not the thing the user confirmed.
    const other = build(panel([{ ...remove, onPress: { ...remove.onPress, args: { id: "b" } } }]));
    expect(pluginInteractiveKey(other.interactives[0]!)).not.toBe(key);
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
