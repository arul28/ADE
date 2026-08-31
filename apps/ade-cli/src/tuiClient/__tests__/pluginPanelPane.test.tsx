import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import {
  bindingKey,
  buildPluginPaneModel,
  type PluginPaneCollectionMap,
  type PluginPaneInput,
  type PluginPanelFetch,
} from "../pluginPane";
import { RightPane } from "../components/RightPane";
import type { RightPaneContent } from "../types";

function content(
  body: unknown[],
  options: {
    values?: Record<string, string>;
    editing?: number | null;
    selection?: Record<string, readonly string[]>;
    openGroups?: Record<string, boolean>;
    collections?: PluginPaneCollectionMap;
  } = {},
): Extract<RightPaneContent, { kind: "plugin-panel" }> {
  const fetch: PluginPanelFetch = {
    state: "ok",
    record: {
      pluginId: "graph",
      panelId: "main",
      title: "Graph",
      schema: {
        v: 1,
        fallback: { title: "Graph", text: "Open ADE to see the graph." },
        body,
      },
      vocabVersion: 1,
      updatedAt: null,
    },
  };
  const state: PluginPaneInput = {
    pluginId: "graph",
    displayName: "Graph",
    panelId: "main",
    fetch,
    collections: options.collections ?? new Map(),
    values: options.values ?? {},
    editing: options.editing ?? null,
    ...(options.selection !== undefined ? { selection: options.selection } : {}),
    ...(options.openGroups !== undefined ? { openGroups: options.openGroups } : {}),
    width: 44,
  };
  return { kind: "plugin-panel", state, model: buildPluginPaneModel(state) };
}

/**
 * A frame with its border and wrapping removed, so an assertion tests the words
 * the pane shows rather than where the 44-column box happened to break them.
 */
function plain(output: string): string {
  return output
    // Colors reset at every line break, so the codes land mid-sentence.
    // eslint-disable-next-line no-control-regex
    .replace(/\[[0-9;]*m/g, "")
    .replace(/[│┌┐└┘─]/g, " ")
    .replace(/\s+/g, " ");
}

function frame(pane: RightPaneContent, selectedIndex = 0, editingValue: string | null = null): string {
  const { lastFrame } = render(
    <RightPane
      content={pane}
      selectedIndex={selectedIndex}
      width={44}
      focused
      pluginEditingValue={editingValue}
    />,
  );
  return lastFrame() ?? "";
}

describe("PluginPanelPane", () => {
  it("draws the panel title and its rows", () => {
    const output = frame(content([
      { component: "text", text: "12 lanes tracked" },
      { component: "keyValue", rows: [{ key: "Branch", value: "main" }] },
      { component: "button", label: "Rebuild", onPress: { action: "rebuild" } },
    ]));

    expect(output).toContain("GRAPH");
    expect(output).toContain("12 lanes tracked");
    expect(output).toContain("Branch");
    expect(output).toContain("[ Rebuild ]");
    expect(output).toContain("enter runs");
  });

  it("marks the selected row and moves the marker with the selection", () => {
    const pane = content([
      {
        component: "list",
        items: [
          { title: "lane-a", onPress: { action: "open", args: { id: "a" } } },
          { title: "lane-b", onPress: { action: "open", args: { id: "b" } } },
        ],
      },
    ]);
    const first = frame(pane, 0).split("\n");
    const second = frame(pane, 1).split("\n");

    const railed = (lines: string[], title: string): boolean =>
      lines.some((line) => line.includes(title) && line.includes("▎"));
    expect(railed(first, "lane-a")).toBe(true);
    expect(railed(first, "lane-b")).toBe(false);
    expect(railed(second, "lane-b")).toBe(true);
  });

  it("echoes the composer into the field being typed", () => {
    const pane = content(
      [
        {
          component: "form",
          fields: [{ kind: "text", id: "name", label: "Name", placeholder: "lane name" }],
          submit: { label: "Create", onPress: { action: "create" } },
        },
      ],
      { editing: 0 },
    );

    expect(frame(pane, 0, "new-lane")).toContain("new-lane");
    expect(frame(pane, 0, "new-lane")).toContain("typing below");
  });

  it("cuts a long paragraph instead of letting it push the panel out of the window", () => {
    // The vocabulary allows 4,000 characters of text, which wraps to a hundred
    // lines in a 44-column pane and would carry the rows below it — and the
    // pane's own footer — off screen.
    const output = frame(content([
      { component: "text", text: "lorem ipsum ".repeat(300) },
      { component: "button", label: "Rebuild", onPress: { action: "rebuild" } },
    ]));

    expect(output.split("\n").length).toBeLessThan(24);
    expect(output).toContain("[ Rebuild ]");
    expect(plain(output)).toContain("r refresh");
  });

  it("names a component it cannot draw rather than leaving the pane blank", () => {
    const output = frame(content([{ component: "video", src: "file:///clip.mp4", title: "Demo" }]));
    expect(output).toContain("Video · Demo");
    expect(plain(output)).toContain("Run ade open to view it in the app");
  });

  it("shows the plugin's own fallback when the schema is unreadable", () => {
    const state: PluginPaneInput = {
      pluginId: "graph",
      displayName: "Graph",
      panelId: "main",
      fetch: {
        state: "ok",
        record: {
          pluginId: "graph",
          panelId: "main",
          title: "Graph",
          schema: { v: 9, fallback: { title: "Graph", text: "Open ADE to see the graph." }, body: [] },
          vocabVersion: 9,
          updatedAt: null,
        },
      },
      collections: new Map(),
      values: {},
      editing: null,
      width: 44,
    };
    const output = frame({ kind: "plugin-panel", state, model: buildPluginPaneModel(state) });

    expect(output).toContain("LIMITED");
    expect(plain(output)).toContain("Open ADE to see the graph.");
  });

  it("explains an old host instead of implying the plugin is broken", () => {
    const state: PluginPaneInput = {
      pluginId: "graph",
      displayName: "Graph",
      panelId: "main",
      fetch: { state: "unsupported" },
      collections: new Map(),
      values: {},
      editing: null,
      width: 44,
    };
    const output = frame({ kind: "plugin-panel", state, model: buildPluginPaneModel(state) });
    expect(plain(output)).toContain("does not serve plugin panels");
  });
});

describe("the markdown node", () => {
  it("draws a document's structure, and prints a link's destination beside it", () => {
    const drawn = plain(frame(content([{
      component: "markdown",
      text: [
        "## Fix the redirect",
        "",
        "- [x] Reproduce",
        "- [ ] Test it",
        "",
        "See [ADE-122](https://linear.app/x).",
      ].join("\n"),
    }])));

    expect(drawn).toContain("Fix the redirect");
    // The checkbox is text and stays text: nothing in this pane can press it.
    expect(drawn).toContain("[x] Reproduce");
    expect(drawn).toContain("[ ] Test it");
    // A terminal cannot hide a destination behind a word, so it does not try.
    expect(drawn).toContain("ADE-122");
    expect(drawn).toContain("https://linear.app/x");
  });

  it("draws a script tag as characters", () => {
    expect(plain(frame(content([{ component: "markdown", text: "<script>alert(1)</script>" }]))))
      .toContain("<script>alert(1)</script>");
  });

  it("folds a group behind the house disclosure glyph", () => {
    const body = [
      { component: "group", title: "Backlog", badge: 3, children: [{ component: "text", text: "ISS-1" }] },
    ];
    const open = plain(frame(content(body)));
    expect(open).toContain("▾ Backlog");
    expect(open).toContain("3");
    expect(open).toContain("ISS-1");

    const closed = plain(frame(content(body, { openGroups: { Backlog: false } })));
    expect(closed).toContain("▸ Backlog");
    expect(closed).not.toContain("ISS-1");
  });

  it("draws tick boxes and the bulk bar the ticks earn", () => {
    const body = [
      {
        component: "list",
        selectable: { stateKey: "batch", actions: [{ action: "createLanes", label: "Create lanes" }] },
        items: [{ title: "ISS-1", key: "iss-1" }, { title: "ISS-2", key: "iss-2" }],
      },
    ];
    const empty = plain(frame(content(body)));
    expect(empty).toContain("[ ] ISS-1");
    expect(empty).not.toContain("selected");

    const ticked = plain(frame(content(body, { selection: { batch: ["iss-1"] } })));
    expect(ticked).toContain("[x] ISS-1");
    expect(ticked).toContain("[ ] ISS-2");
    expect(ticked).toContain("1 selected");
    expect(ticked).toContain("[ Create lanes ]");
    expect(ticked).toContain("[ Clear ]");
  });

  it("draws a menu-styled control as one line rather than a strip of pills", () => {
    const collections: PluginPaneCollectionMap = new Map([
      [
        bindingKey({ collection: "projects" }),
        Array.from({ length: 12 }, (_unused, index) => ({
          key: `row-${index}`,
          value: { id: `p${index}`, name: `Project ${index}` },
        })),
      ],
    ]);
    const output = plain(frame(content([
      {
        component: "segmented",
        stateKey: "project",
        label: "Project",
        options: [{ value: "", label: "All projects" }],
        optionsFrom: { collection: "projects", valueField: "id", labelField: "name" },
      },
    ], { collections })));

    expect(output).toContain("All projects");
    expect(output).toContain("1/13");
    // Not a pill in sight: one line, and the ←→ gesture that moves along it.
    expect(output).not.toContain("[ Project 4 ]");
    expect(output).toContain("←→");
  });
});
