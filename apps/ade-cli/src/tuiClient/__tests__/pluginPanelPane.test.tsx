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
      { component: "divider", label: "Lanes" },
      { component: "button", label: "Rebuild", onPress: { action: "rebuild" } },
    ]));

    expect(output).toContain("GRAPH");
    expect(output).toContain("12 lanes tracked");
    expect(output).toContain("Lanes");
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

  it("names a frozen component rather than leaving the pane blank", () => {
    const output = frame(content([{ component: "video", src: "file:///clip.mp4", title: "Demo" }]));
    expect(plain(output)).toContain("video is not drawn in the terminal");
    // The node's own title leads the second line, ahead of the way out. That
    // line is the one the 44-column pane truncates, which is the right one to
    // lose: the sentence above it already answered the question.
    expect(plain(output)).toContain("Demo · Run ade open");
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

/**
 * The two profile nodes with real chrome of their own: a group's disclosure and
 * a selectable list's tick boxes and bulk bar.
 */
describe("the group and the selectable list", () => {
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
});
