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
  pluginPaneClearSelection,
  pluginPaneNavigationPlacement,
  pluginPaneSettingsNotice,
  pluginPaneSeededRefresh,
  pluginPaneSeededRefreshKey,
  pluginPaneSelectionPayload,
  pluginPaneSelectionReset,
  pluginPaneShowMore,
  pluginPaneToggleGroup,
  pluginPaneToggleRow,
  pluginPaneStateChange,
  pluginPaneStateCycle,
  pluginPaneStatePayload,
  pluginPaneStateReset,
  pluginPaneWindow,
  pluginTableWidths,
  PLUGIN_TERMINAL_PROFILE_NODES,
  isTerminalProfileNode,
  type PluginPaneCollectionMap,
  type PluginPaneInput,
  type PluginPaneModel,
  type PluginPanelFetch,
} from "../pluginPane";
import { defaultPluginPanelId, invokePluginAction, resolvePluginByName } from "../adeApi";
import {
  pluginPromptAnswerArgs,
  pluginPromptChoiceLines,
  pluginPromptHiddenChoiceCount,
  pluginPromptHint,
  PLUGIN_PROMPT_MAX_VISIBLE_CHOICES,
  pluginPromptOutcome,
  pluginPromptPlaceholder,
  pluginPromptResolveChoice,
  pluginPromptTitle,
  pluginPromptTooLongNotice,
  pluginPromptUnknownChoiceNotice,
} from "../pluginPrompt";
import type { AdeCodeConnection } from "../types";
import { PLUGIN_FIXTURES } from "../../../../desktop/src/renderer/components/plugins/pluginFixtures";
import {
  PLUGIN_ACTION_NAVIGATION_TARGETS,
  readPluginActionNavigation,
  readPluginActionOpenSettings,
  type PluginSummary,
} from "../../../../desktop/src/shared/plugins/sdk";
import { VOCAB_LIMITS, vocabListPagesToCeiling } from "../../../../desktop/src/shared/plugins/vocabulary";
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
    selection?: Record<string, readonly string[]>;
    selectionSignature?: string;
    openGroups?: Record<string, boolean>;
    listPages?: Record<string, number>;
    brandIcons?: readonly { key: string; value: unknown }[];
    width?: number;
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
    ...(options.selection !== undefined ? { selection: options.selection } : {}),
    ...(options.selectionSignature !== undefined
      ? { selectionSignature: options.selectionSignature }
      : {}),
    ...(options.openGroups !== undefined ? { openGroups: options.openGroups } : {}),
    ...(options.listPages !== undefined ? { listPages: options.listPages } : {}),
    ...(options.brandIcons !== undefined ? { brandIcons: options.brandIcons } : {}),
    width: options.width ?? 40,
  };
  return buildPluginPaneModel(input);
}

describe("plugin pane model", () => {
  it("renders the terminal profile as rows in schema order", () => {
    const model = build(panel([
      { component: "text", text: "Overview", variant: "title" },
      { component: "badge", text: "12 nodes", tone: "accent" },
      { component: "divider", label: "Lanes" },
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

  it("carries the panel's view action so opening the pane can ack a tab badge", () => {
    expect(build(panel([], { viewAction: "ackTabBadge" })).viewAction).toBe("ackTabBadge");
    expect(build(panel([])).viewAction).toBeNull();

    const unreadable = build(panel([], { v: 99, viewAction: "ackTabBadge" }));
    expect(unreadable.status).toBe("fallback");
    expect(unreadable.viewAction).toBe("ackTabBadge");

    expect(build({ state: "missing" }).viewAction).toBeNull();
  });

  it("runs a seeded panel's declared refresh once when the pane opens", () => {
    // The defect this exists for: every plugin tab drew the manifest's
    // "Loading…" card and sat on it, because only `r` ran the fetch.
    const invoked = new Set<string>();
    const seeded = build(panel([], { seeded: true, refreshAction: "refresh-fleet" }));
    expect(seeded.seeded).toBe(true);

    const first = pluginPaneSeededRefresh(seeded, invoked);
    expect(first?.action).toBe("refresh-fleet");
    invoked.add(first!.key);

    // Re-opening the pane on the SAME still-seeded row asks the plugin nothing
    // a second time.
    const reopened = build(panel([], { seeded: true, refreshAction: "refresh-fleet" }));
    expect(pluginPaneSeededRefresh(reopened, invoked)).toBeNull();

    // A row the plugin has published over is not seeded, so an open dispatches
    // nothing — the panel is already showing real content.
    const published = build(panel([], { refreshAction: "refresh-fleet" }));
    expect(published.seeded).toBe(false);
    expect(pluginPaneSeededRefresh(published, new Set())).toBeNull();

    // A seeded row whose panel declared no refresh has nothing to run, and a
    // panel with no row at all has nothing to run it against.
    expect(pluginPaneSeededRefresh(build(panel([], { seeded: true })), new Set())).toBeNull();
    expect(pluginPaneSeededRefresh(build({ state: "missing" }), new Set())).toBeNull();
  });

  it("keys the seeded refresh on the row, so a changed row may ask again", () => {
    const seededAt = (updatedAt: string | null): PluginPaneModel => build({
      state: "ok",
      record: {
        pluginId: "graph",
        panelId: "main",
        title: "Graph",
        schema: { v: 1, fallback: FALLBACK, body: [], seeded: true, refreshAction: "refresh-fleet" },
        vocabVersion: 1,
        updatedAt,
      },
    });

    const invoked = new Set<string>();
    const first = pluginPaneSeededRefresh(seededAt("2026-09-03T10:00:00.000Z"), invoked);
    expect(first).not.toBeNull();
    invoked.add(first!.key);
    expect(pluginPaneSeededRefresh(seededAt("2026-09-03T10:00:00.000Z"), invoked)).toBeNull();

    // A row that actually changed — and is still seeded, because the host
    // re-materialized the manifest schema — is a new key and may ask again.
    const later = pluginPaneSeededRefresh(seededAt("2026-09-03T10:05:00.000Z"), invoked);
    expect(later?.action).toBe("refresh-fleet");
    expect(later?.key).not.toBe(first!.key);

    // A host that sends no `updated_at` still gets a stable identity off the
    // schema rather than re-asking on every open.
    const nullFirst = pluginPaneSeededRefresh(seededAt(null), invoked);
    expect(nullFirst).not.toBeNull();
    invoked.add(nullFirst!.key);
    expect(pluginPaneSeededRefresh(seededAt(null), invoked)).toBeNull();
    expect(pluginPaneSeededRefreshKey("graph", "main", null))
      .not.toBe(pluginPaneSeededRefreshKey("graph", "other", null));
  });

  it("reads the seeded stamp even off a schema this build cannot render", () => {
    // Same reason the refresh action is read there: a seeded card the client
    // cannot parse is exactly the card a first refresh is meant to replace.
    const unreadable = build(panel([], { v: 99, seeded: true, refreshAction: "refresh-fleet" }));
    expect(unreadable.status).toBe("fallback");
    expect(pluginPaneSeededRefresh(unreadable, new Set())?.action).toBe("refresh-fleet");
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

  it("draws avatar initials on a list row, the one place the profile keeps a face", () => {
    // The `avatar` NODE is frozen; a list row's avatar is part of `list` and
    // still draws, which is where every real panel puts a face anyway.
    const model = build(panel([
      { component: "list", items: [{ title: "ENG-1", avatar: { name: "Linear" } }] },
    ]));
    const item = model.rows.find((row) => row.kind === "listItem");
    expect(item?.kind === "listItem" ? item.avatar : null).toBe("L");
    expect(item?.kind === "listItem" ? item.title : null).toBe("ENG-1");
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

  it("names a component it cannot draw instead of leaving a gap", () => {
    const model = build(panel([
      { component: "chart", kind: "line", series: [{ id: "s", points: [{ x: 1, y: 2 }] }], title: "Throughput" },
      { component: "video", src: "file:///clip.mp4" },
      { component: "hologram", whatever: true },
    ]));

    const placeholders = model.rows.flatMap((row) => (row.kind === "placeholder" ? [row] : []));
    expect(placeholders.map((row) => row.label)).toEqual([
      "chart is not drawn in the terminal",
      "video is not drawn in the terminal",
      "hologram",
    ]);
    // The panel declared a deeplink, so the hint points at it — behind the
    // chart's own title, which is the thing the reader came for.
    expect(placeholders[0]?.hint).toBe("Throughput · Ctrl+Y copies a link that opens it");
    // A name this build has never heard of is not a frozen component, and says
    // the other true sentence.
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

/* ── The frozen terminal profile ───────────────────────────────────── */

/**
 * The freeze itself (`docs/reports/plugin-page-tier-spec.md` section 1).
 *
 * Two halves have to agree: {@link PLUGIN_TERMINAL_PROFILE_NODES} is what the
 * vocabulary SAYS the terminal draws, and the switch inside the pane's walk is
 * what it actually draws. A test written against a hand-copied list would let
 * the two drift silently, so both halves are walked from the one constant.
 */
describe("the frozen terminal profile", () => {
  /** One minimal VALID node per component, so nothing degrades as `__invalid`. */
  const NODE: Record<string, Record<string, unknown>> = {
    stack: {
      component: "stack",
      direction: "vertical",
      children: [{ component: "text", text: "inside" }],
    },
    group: {
      component: "group",
      title: "Lanes",
      children: [{ component: "text", text: "inside" }],
    },
    text: { component: "text", text: "Overview" },
    badge: { component: "badge", text: "12" },
    button: { component: "button", label: "Rebuild", onPress: { action: "rebuild" } },
    list: { component: "list", items: [{ title: "lane-a" }] },
    emptyState: { component: "emptyState", title: "Nothing yet" },
    divider: { component: "divider", label: "Lanes" },
    markdown: { component: "markdown", text: "# Heading" },
    table: { component: "table", columns: [{ key: "a", label: "A" }], rows: [{ a: "1" }] },
    keyValue: { component: "keyValue", rows: [{ key: "Branch", value: "main" }] },
    form: {
      component: "form",
      fields: [{ kind: "text", id: "name", label: "Name" }],
      submit: { label: "Save", onPress: { action: "save" } },
    },
    segmented: {
      component: "segmented",
      stateKey: "filter",
      label: "Status",
      options: [{ value: "", label: "All" }, { value: "active", label: "Active" }],
    },
    canvas: { component: "canvas", engine: "graph", bind: { collection: "nodes" } },
    avatar: { component: "avatar", name: "Jane Doe" },
    video: { component: "video", src: "https://ade.dev/clip.mp4", title: "The run" },
    image: { component: "image", src: "https://ade.dev/a.png", alt: "a chart" },
    chart: { component: "chart", kind: "line", series: [{ id: "s", points: [{ x: 1, y: 2 }] }] },
  };

  /** Everything the vocabulary still parses and the terminal no longer paints. */
  const FROZEN = [
    "markdown",
    "table",
    "keyValue",
    "form",
    "segmented",
    "canvas",
    "avatar",
    "video",
    "image",
    "chart",
  ] as const;

  it("draws every node the profile names, and marks none of them", () => {
    for (const component of PLUGIN_TERMINAL_PROFILE_NODES) {
      const node = NODE[component];
      if (!node) throw new Error(`the profile names ${component} and this test has no node for it`);
      const model = build(panel([node]));
      expect(model.status).toBe("ok");
      expect(model.rows.length).toBeGreaterThan(0);
      expect(model.rows.some((row) => row.kind === "placeholder")).toBe(false);
      expect(model.warnings).toEqual([]);
    }
  });

  it("marks every frozen node with the sentence that names it", () => {
    for (const component of FROZEN) {
      const node = NODE[component];
      if (!node) throw new Error(`no node for ${component}`);
      const model = build(panel([node]));
      // One row, never a marker beside a half-drawn node.
      expect(model.rows).toHaveLength(1);
      const marker = model.rows[0];
      if (marker?.kind !== "placeholder") throw new Error(`${component} did not degrade to the marker`);
      expect(marker.label).toBe(`${component} is not drawn in the terminal`);
      // The escape hatch is untouched: this panel declared a deeplink.
      expect(marker.hint.endsWith("Ctrl+Y copies a link that opens it")).toBe(true);
      // And nothing behind a frozen node is reachable by the keyboard.
      expect(model.interactives).toEqual([]);
    }
  });

  it("still names the thing, not only its kind, where the node carried one", () => {
    const hint = (component: string): string => {
      const row = build(panel([NODE[component]!])).rows[0];
      return row?.kind === "placeholder" ? row.hint : "";
    };
    const link = "Ctrl+Y copies a link that opens it";
    expect(hint("video")).toBe(`The run · ${link}`);
    expect(hint("image")).toBe(`a chart · ${link}`);
    expect(hint("avatar")).toBe(`Jane Doe · ${link}`);
    expect(hint("segmented")).toBe(`Status · ${link}`);
    // A node with nothing to name offers only the way out.
    expect(hint("table")).toBe(link);
  });

  it("agrees with the vocabulary about which names it draws", () => {
    for (const component of PLUGIN_TERMINAL_PROFILE_NODES) {
      expect(isTerminalProfileNode(component)).toBe(true);
    }
    for (const component of FROZEN) expect(isTerminalProfileNode(component)).toBe(false);
    // The two lists together are the whole v1 vocabulary. A component added in
    // v2 without a terminal decision fails here rather than degrading in
    // silence, which is the whole point of freezing rather than deleting.
    expect([...PLUGIN_TERMINAL_PROFILE_NODES, ...FROZEN].sort()).toEqual(Object.keys(NODE).sort());
  });

  it("keeps a button armed, which is how the terminal takes input now that `form` is frozen", () => {
    const model = build(panel([
      NODE.form!,
      { component: "button", label: "Rename lane", onPress: { action: "rename" } },
    ]));
    expect(model.rows.map((row) => row.kind)).toEqual(["placeholder", "buttons"]);
    expect(model.interactives).toEqual([
      { kind: "action", label: "Rename lane", action: { action: "rename" } },
    ]);
  });

  it("leaves the two internal names their own sentences, which the freeze never touches", () => {
    // A name this build has never heard of: forward compatibility, not a freeze.
    const unknown = build(panel([{ component: "hologram" }])).rows[0];
    expect(unknown?.kind === "placeholder" && unknown.label).toBe("hologram");
    expect(unknown?.kind === "placeholder" && unknown.hint).toBe("This ADE version does not draw it yet");
    // A node the author got wrong still reads as the author's mistake.
    const invalid = build(panel([{ component: "text" }])).rows[0];
    expect(invalid?.kind === "note" && invalid.text.startsWith("text could not be rendered")).toBe(true);
  });
});

/**
 * The `form` node is frozen out of the terminal profile, but its value helpers
 * are not: the frozen arm still reads them, and the sweep that deletes the arm
 * is the thing that should delete these too.
 */
describe("plugin pane field helpers", () => {
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
    // The control itself is frozen out of the terminal, but the state it
    // declares is not: the filter it names still selects the rows below it.
    expect(opened.rows.some((row) => row.kind === "segmented")).toBe(false);
    expect(opened.rows.some(
      (row) => row.kind === "placeholder" && row.label === "segmented is not drawn in the terminal",
    )).toBe(true);
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
    body.push({ component: "button", label: "Rebuild", onPress: { action: "rebuild" } });
    const model = build(panel(body));

    // The button is the last interactive, and the pane has no scrollbar: moving
    // the selection is what scrolls.
    const window = pluginPaneWindow(model, model.interactives.length - 1, 6);
    expect(window.rows.some((row) => row.kind === "buttons")).toBe(true);
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

  it("opens the plugin's rail surface, webview included, defaulting to main", () => {
    expect(defaultPluginPanelId(summary({
      surfaces: [{ kind: "tab", id: "graph", title: "Graph", panelId: "overview" }],
    }))).toBe("overview");
    expect(defaultPluginPanelId(summary({ surfaces: [] }))).toBe("main");

    // A webview IS a rail surface, and manifest order decides. The terminal used
    // to take the first `kind === "tab"` and skip the webview, so this plugin
    // opened `overview` here and `console` on the desktop, from one manifest.
    expect(defaultPluginPanelId(summary({
      surfaces: [
        { kind: "webview", id: "console", title: "Console", panelId: "console" },
        { kind: "tab", id: "graph", title: "Graph", panelId: "overview" },
      ],
    }))).toBe("console");

    // A non-rail surface never wins the address, whatever order it sits in.
    expect(defaultPluginPanelId(summary({
      surfaces: [
        { kind: "settings", id: "prefs", title: "Prefs", panelId: "prefs" },
        { kind: "tab", id: "graph", title: "Graph", panelId: "overview" },
      ],
    }))).toBe("overview");
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

describe("plugin pane openSettings from an action", () => {
  it("reads the Cursor provider page and drops anything else", () => {
    expect(readPluginActionOpenSettings({ openSettings: "agents.provider.cursor" }))
      .toEqual({ kind: "entry", entryId: "agents.provider.cursor" });
    expect(readPluginActionOpenSettings({ openSettings: "secrets.secrets" }))
      .toEqual({ kind: "entry", entryId: "secrets.secrets" });
    expect(readPluginActionOpenSettings({ openSettings: "billing.plans" })).toBeNull();
  });

  it("reads a plugin's own settings section, which the terminal only names", () => {
    // The TUI draws no settings surface, so both halves of the verb end the
    // same way: a notice saying where the thing is. What it must not do is
    // fail to parse the newer shape and say nothing at all.
    expect(readPluginActionOpenSettings({ openSettings: { socketId: "connection" } }))
      .toEqual({ kind: "socket", socketId: "connection" });
    expect(readPluginActionOpenSettings({ openSettings: { socketId: "not a socket id" } }))
      .toBeNull();
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
    const resolved = pluginPromptResolveChoice(outcome.request, typed);
    if (resolved === null) {
      notices.push(pluginPromptUnknownChoiceNotice(outcome.request));
      return { followed, notices };
    }
    const next = pluginPromptAnswerArgs(outcome.request, resolved);
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

  it("resolves a picker by value, label, or unique prefix, and refuses the rest", () => {
    const asked = pluginPromptOutcome({
      result: {
        prompt: {
          id: "lane",
          title: "Link to a lane",
          options: [
            { value: "lane-1", label: "Alpha" },
            { value: "lane-2", label: "Beta" },
            { value: "other", label: "Also" },
          ],
        },
      },
      pluginId: "linear",
      displayName: "Linear",
      actionId: "linkToLane",
      args: {},
      label: "Link to a lane",
    });
    if (asked.kind !== "ask") throw new Error("expected a picker");
    expect(pluginPromptHint(asked.request)).toBe("type a number or a name · ↵ Submit · esc cancel");
    expect(pluginPromptPlaceholder(asked.request)).toBe("type a name from the list");
    expect(pluginPromptResolveChoice(asked.request, "lane-2")).toBe("lane-2");
    expect(pluginPromptResolveChoice(asked.request, "alpha")).toBe("lane-1");
    expect(pluginPromptResolveChoice(asked.request, "Be")).toBe("lane-2");
    expect(pluginPromptResolveChoice(asked.request, "al")).toBeNull();
    expect(pluginPromptResolveChoice(asked.request, "nope")).toBeNull();
    expect(pluginPromptAnswerArgs(asked.request, "nope")).toBeNull();
  });

  it("draws the choices a closed question offers, numbered, and marks the typed one", () => {
    // The bug this pins: the terminal used to draw the title and the hint and
    // nothing else, so "type a name from the list" named a list the reader had
    // never seen.
    const asked = pluginPromptOutcome({
      result: {
        prompt: {
          id: "lane",
          title: "Link to a lane",
          options: [
            { value: "lane-1", label: "Alpha" },
            { value: "lane-2", label: "Beta" },
            { value: "lane-3" },
          ],
        },
      },
      pluginId: "linear",
      displayName: "Linear",
      actionId: "linkToLane",
      args: {},
      label: "Link to a lane",
    });
    if (asked.kind !== "ask") throw new Error("expected a picker");

    expect(pluginPromptChoiceLines(asked.request)).toEqual([
      { value: "lane-1", number: 1, text: "Alpha", selected: false },
      { value: "lane-2", number: 2, text: "Beta", selected: false },
      // No label: the value is the words, never a blank row.
      { value: "lane-3", number: 3, text: "lane-3", selected: false },
    ]);

    // Partial typing marks the row it already resolves to.
    expect(pluginPromptChoiceLines(asked.request, { text: "Be" }).map((line) => line.selected))
      .toEqual([false, true, false]);
    expect(pluginPromptChoiceLines(asked.request, { text: "nope" }).map((line) => line.selected))
      .toEqual([false, false, false]);

    // The number is an answer.
    expect(pluginPromptResolveChoice(asked.request, "2")).toBe("lane-2");
    expect(pluginPromptResolveChoice(asked.request, "4")).toBeNull();
    expect(pluginPromptResolveChoice(asked.request, "0")).toBeNull();

    // A free-text question draws no list at all.
    const free = pluginPromptOutcome({
      result: NOTE_PROMPT,
      pluginId: "journal",
      displayName: "Work Journal",
      actionId: "logNote",
      args: {},
      label: "Log it",
    });
    if (free.kind !== "ask") throw new Error("expected a question");
    expect(pluginPromptChoiceLines(free.request)).toEqual([]);
    expect(pluginPromptHiddenChoiceCount(free.request)).toBe(0);
  });

  it("stops drawing a long option list and counts the rest, without refusing them", () => {
    const asked = pluginPromptOutcome({
      result: {
        prompt: {
          id: "lane",
          title: "Link to a lane",
          options: Array.from({ length: 12 }, (_unused, index) => ({ value: `lane-${index + 1}` })),
        },
      },
      pluginId: "linear",
      displayName: "Linear",
      actionId: "linkToLane",
      args: {},
      label: "Link to a lane",
    });
    if (asked.kind !== "ask") throw new Error("expected a picker");

    expect(pluginPromptChoiceLines(asked.request)).toHaveLength(PLUGIN_PROMPT_MAX_VISIBLE_CHOICES);
    expect(pluginPromptHiddenChoiceCount(asked.request)).toBe(12 - PLUGIN_PROMPT_MAX_VISIBLE_CHOICES);
    // An undrawn choice is still answerable by name — the list is a convenience,
    // never the set of legal answers.
    expect(pluginPromptResolveChoice(asked.request, "lane-12")).toBe("lane-12");
  });

  it("lets an option keep its own digit as a value or a label", () => {
    const asked = pluginPromptOutcome({
      result: {
        prompt: {
          id: "pick",
          title: "Pick one",
          options: [
            { value: "alpha", label: "2" },
            { value: "beta", label: "Beta" },
          ],
        },
      },
      pluginId: "journal",
      displayName: "Work Journal",
      actionId: "pick",
      args: {},
      label: "Pick one",
    });
    if (asked.kind !== "ask") throw new Error("expected a picker");

    // "2" is the first option's LABEL, and an exact label beats the row number.
    expect(pluginPromptResolveChoice(asked.request, "2")).toBe("alpha");
  });

  it("re-invokes a picker with the option value, not the typed label", async () => {
    const { connection, calls } = promptConnection([
      {
        prompt: {
          id: "lane",
          title: "Link to a lane",
          options: [{ value: "lane-2", label: "Beta" }],
        },
      },
      { message: "Linked 1 issue." },
    ]);

    const run = await dispatchPluginAction({
      connection,
      args: { issueId: "issue-1" },
      answers: ["beta"],
    });

    expect(calls[1]?.args).toEqual({
      issueId: "issue-1",
      prompt: { id: "lane", text: "lane-2" },
    });
    expect(run.followed).toEqual([{ message: "Linked 1 issue." }]);
  });

  it("refuses a picker answer that is not a choice, rather than sending it", async () => {
    const { connection, calls } = promptConnection([{
      prompt: {
        id: "lane",
        title: "Link to a lane",
        options: [{ value: "lane-1", label: "One" }],
      },
    }]);

    const run = await dispatchPluginAction({
      connection,
      args: {},
      answers: ["nope"],
    });

    expect(calls).toHaveLength(1);
    expect(run.notices).toEqual([
      "Link to a lane: that is not one of the choices. Type a number or a name from the list and press enter.",
    ]);
  });
});

/**
 * The `markdown` NODE is frozen out of the terminal profile. A list row's own
 * markdown is not: it belongs to `list`, which the profile keeps, and it is the
 * one place a panel's prose still reaches a terminal reader.
 */
describe("list-row markdown in the terminal", () => {
  /** Every markdown row of a model, as `prefix + text`, in reading order. */
  function lines(model: PluginPaneModel): string[] {
    return model.rows.flatMap((row) =>
      row.kind === "markdown"
        ? [`${row.prefix}${row.parts.map((span) => span.text).join("")}`]
        : []);
  }

  it("draws list-row markdown under the row rather than as a separate body node", () => {
    const model = build(panel([{
      component: "list",
      items: [{ title: "kai", markdown: "The fix is in `sessionRedirect.ts`." }],
    }]));
    expect(model.rows.some((row) => row.kind === "listItem" && row.title === "kai")).toBe(true);
    expect(lines(model).some((line) => line.includes("sessionRedirect.ts"))).toBe(true);
  });
});

describe("the group node in the terminal", () => {
  const GROUP = panel([
    {
      component: "group",
      title: "Backlog",
      badge: 3,
      children: [{ component: "text", text: "ISS-1" }],
    },
  ]);

  it("draws a header row and hides its children when it is closed", () => {
    // Absent `defaultOpen` means open — a section nobody has touched shows its
    // contents — and the reader's own close is a client-local override.
    const open = build(GROUP);
    expect(open.rows.map((row) => row.kind)).toEqual(["group", "text"]);
    const header = open.rows[0];
    expect(header?.kind === "group" && header.title).toBe("Backlog");
    expect(header?.kind === "group" && header.badge).toBe("3");
    expect(header?.kind === "group" && header.open).toBe(true);
    // Children sit one level in, so the fold reads as a fold.
    expect(open.rows[1]?.indent).toBe(1);

    const closed = build(GROUP, { openGroups: { Backlog: false } });
    expect(closed.rows.map((row) => row.kind)).toEqual(["group"]);
    expect(closed.rows[0]?.kind === "group" && closed.rows[0].open).toBe(false);
  });

  it("opens on the author's `defaultOpen` until the reader says otherwise", () => {
    const shut = panel([
      { component: "group", title: "Done", defaultOpen: false, children: [{ component: "text", text: "old" }] },
    ]);
    expect(build(shut).rows.map((row) => row.kind)).toEqual(["group"]);
    expect(build(shut, { openGroups: { Done: true } }).rows.map((row) => row.kind))
      .toEqual(["group", "text"]);
  });

  it("remembers a section by its key, never by where it sits", () => {
    const model = build(panel([
      {
        component: "group",
        title: "Backlog",
        groupKey: "backlog",
        children: [{ component: "text", text: "ISS-1" }],
      },
    ]));
    // The first press folds a section that was open; a `defaultOpen: false`
    // section reads its answer off the drawn row, so its first press opens it.
    expect(pluginPaneToggleGroup(model, "backlog")).toEqual({ backlog: false });
    const folded = build(panel([
      { component: "text", text: "a new row above" },
      {
        component: "group",
        title: "Backlog",
        groupKey: "backlog",
        children: [{ component: "text", text: "ISS-1" }],
      },
    ]), { openGroups: { backlog: false } });
    // The group moved down the panel and stayed closed: identity is the key,
    // not the position a republish shifted.
    expect(folded.rows.map((row) => row.kind)).toEqual(["text", "group"]);
    expect(pluginPaneToggleGroup(folded, "backlog")).toEqual({ backlog: true });
  });

  it("keeps a group's disclosure a client-local press that dispatches nothing", () => {
    const model = build(GROUP);
    expect(model.interactives).toEqual([{ kind: "group", groupKey: "Backlog", label: "Backlog" }]);
    // Open/closed is not panel state: it never enters the state map, never
    // signs, and never reaches the `state` payload an action carries.
    expect(model.state).toEqual({});
    expect(model.stateSignature).toBe(build(panel([])).stateSignature);
    expect(pluginPaneStatePayload(model.state)).toBeNull();
  });

  it("declares a segmented control inside a closed group, and still filters with it", () => {
    // The load-bearing case for `vocabChildNodes`: declarations and bindings are
    // collected off the PARSED tree, not off this render walk, so folding a
    // section cannot silently drop a filter or a fetch.
    const collections: PluginPaneCollectionMap = new Map([
      [
        bindingKey({ collection: "issues" }),
        [
          { key: "1", value: { title: "Open one", status: "open" } },
          { key: "2", value: { title: "Done one", status: "done" } },
        ],
      ],
    ]);
    const model = build(panel([
      {
        component: "group",
        title: "Filters",
        defaultOpen: false,
        children: [
          {
            component: "segmented",
            stateKey: "status",
            options: [{ value: "", label: "All" }, { value: "open", label: "Open" }],
            default: "open",
          },
        ],
      },
      {
        component: "list",
        bind: { collection: "issues", where: [{ field: "status", equals: { $state: "status" } }] },
      },
    ]), { collections });

    expect(model.declarations.map((entry) => entry.stateKey)).toEqual(["status"]);
    expect(model.state).toEqual({ status: "open" });
    // The control is not drawn — that is what closed means — and the list it
    // filters is.
    expect(model.rows.some((row) => row.kind === "segmented")).toBe(false);
    expect(listTitles(model)).toEqual(["Open one"]);
  });
});

describe("a selectable list in the terminal", () => {
  const BATCH = panel([
    {
      component: "list",
      selectable: {
        stateKey: "batch",
        actions: [{ action: "createLanes", label: "Create lanes" }],
      },
      items: [
        { title: "ISS-1", key: "iss-1" },
        { title: "ISS-2", key: "iss-2" },
        // No key: a title is not an identity and two issues can share one.
        { title: "Untitled row" },
      ],
    },
  ]);

  it("ticks only the rows that have a key", () => {
    const model = build(BATCH);
    expect(model.rows.flatMap((row) => (row.kind === "listItem" ? [[row.title, row.tick !== null]] : [])))
      .toEqual([["ISS-1", true], ["ISS-2", true], ["Untitled row", false]]);
    expect(model.interactives.flatMap((entry) => (entry.kind === "selection" ? [entry.rowKey] : [])))
      .toEqual(["iss-1", "iss-2"]);
    expect(model.selectionDeclarations)
      .toEqual([{ stateKey: "batch", max: 100, actionIds: ["createLanes"] }]);
  });

  it("draws no bulk bar until something visible is ticked", () => {
    const empty = build(BATCH);
    expect(empty.selection).toEqual({ batch: [] });
    expect(empty.rows.some((row) => row.kind === "bulkBar")).toBe(false);

    const ticked = build(BATCH, {
      selection: { batch: ["iss-2"] },
      selectionSignature: empty.selectionSignature,
    });
    const bar = ticked.rows.find((row) => row.kind === "bulkBar");
    expect(bar?.kind === "bulkBar" && bar.count).toBe(1);
    // The plugin's verbs, then the bar's own Clear — which no schema should
    // have to remember to offer.
    expect(bar?.kind === "bulkBar" && bar.buttons.map((button) => button.label))
      .toEqual(["Create lanes", "Clear"]);
    expect(ticked.rows.flatMap((row) => (row.kind === "listItem" ? [row.tick?.checked ?? null] : [])))
      .toEqual([false, true, null]);
  });

  it("pins one bulk bar for the pane even when two lists have ticks", () => {
    const schema = panel([
      {
        component: "list",
        items: [{ title: "a", key: "a" }],
        selectable: { stateKey: "left", actions: [{ action: "go", label: "Go" }] },
      },
      {
        component: "list",
        items: [{ title: "b", key: "b" }],
        selectable: { stateKey: "right", actions: [{ action: "run", label: "Run" }] },
      },
    ]);
    const empty = build(schema);
    const model = build(schema, {
      selection: { left: ["a"], right: ["b"] },
      selectionSignature: empty.selectionSignature,
    });
    const bars = model.rows.filter((row) => row.kind === "bulkBar");
    expect(bars).toHaveLength(1);
    expect(bars[0]?.kind === "bulkBar" && bars[0].count).toBe(1);
    expect(model.chromeFooterCount).toBeGreaterThanOrEqual(1);
    expect(model.rows[model.rows.length - 1]?.kind).toBe("bulkBar");
  });

  it("unions ticks across grouped lists that share a selection key", () => {
    const schema = panel([
      {
        component: "group",
        title: "Started",
        children: [{
          component: "list",
          items: [{ title: "a", key: "a" }],
          selectable: { stateKey: "batch", actions: [{ action: "go", label: "Go" }] },
        }],
      },
      {
        component: "group",
        title: "Todo",
        children: [{
          component: "list",
          items: [{ title: "b", key: "b" }],
          selectable: { stateKey: "batch", actions: [{ action: "go", label: "Go" }] },
        }],
      },
    ]);
    const empty = build(schema);
    const model = build(schema, {
      selection: { batch: ["a", "b"] },
      selectionSignature: empty.selectionSignature,
    });
    const bars = model.rows.filter((row) => row.kind === "bulkBar");
    expect(bars).toHaveLength(1);
    expect(bars[0]?.kind === "bulkBar" && bars[0].count).toBe(2);
    expect(pluginPaneSelectionPayload(model, "batch")).toEqual(["a", "b"]);
  });

  it("leaves a ticked row the filter hid out of the batch, without unticking it", () => {
    const collections: PluginPaneCollectionMap = new Map([
      [
        bindingKey({ collection: "issues" }),
        [
          { key: "1", value: { title: "Open one", status: "open" } },
          { key: "2", value: { title: "Done one", status: "done" } },
        ],
      ],
    ]);
    const schema = panel([
      {
        component: "segmented",
        stateKey: "status",
        options: [{ value: "", label: "All" }, { value: "open", label: "Open" }],
      },
      {
        component: "list",
        bind: { collection: "issues", where: [{ field: "status", equals: { $state: "status" } }] },
        selectable: { stateKey: "batch", actions: [{ action: "archive", label: "Archive" }] },
      },
    ]);
    const both = build(schema, { collections, selection: { batch: ["1", "2"] } });
    expect(pluginPaneSelectionPayload(both, "batch")).toEqual(["1", "2"]);

    const filtered = build(schema, {
      collections,
      selection: { batch: ["1", "2"] },
      state: { status: "open" },
      stateSignature: both.stateSignature,
    });
    // Acting on a row nobody can see is the one outcome a selection must never
    // produce, so the batch is what the reader is looking at…
    expect(listTitles(filtered)).toEqual(["Open one"]);
    expect(pluginPaneSelectionPayload(filtered, "batch")).toEqual(["1"]);
    expect(filtered.rows.find((row) => row.kind === "bulkBar"))
      .toMatchObject({ kind: "bulkBar", count: 1 });
    // …and the hidden tick is kept, so moving the filter back brings it with it.
    expect(filtered.selection).toEqual({ batch: ["1", "2"] });
  });

  it("inherits a bound row's identity from the collection row's own key", () => {
    const collections: PluginPaneCollectionMap = new Map([
      [bindingKey({ collection: "issues" }), [{ key: "iss-9", value: { title: "Ship it" } }]],
    ]);
    const model = build(panel([
      {
        component: "list",
        bind: { collection: "issues" },
        selectable: { stateKey: "batch", actions: [{ action: "archive", label: "Archive" }] },
      },
    ]), { collections });
    // A plugin that already writes `{title}` rows gets selection for free —
    // repeating the key inside the value would be a second identity that can
    // disagree with the first.
    expect(model.interactives).toEqual([
      { kind: "selection", stateKey: "batch", rowKey: "iss-9", label: "Ship it" },
    ]);
  });

  it("toggles one row, refuses a tick past the cap, and clears from the bar", () => {
    const model = build(panel([
      {
        component: "list",
        selectable: {
          stateKey: "batch",
          max: 1,
          actions: [{ action: "archive", label: "Archive" }],
        },
        items: [{ title: "ISS-1", key: "iss-1" }, { title: "ISS-2", key: "iss-2" }],
      },
    ]));
    expect(pluginPaneToggleRow(model, "batch", "iss-1")).toEqual({ batch: ["iss-1"] });
    // A key belonging to no declared list changes nothing.
    expect(pluginPaneToggleRow(model, "nope", "iss-1")).toBe(model.selection);

    const full = build(panel([
      {
        component: "list",
        selectable: {
          stateKey: "batch",
          max: 1,
          actions: [{ action: "archive", label: "Archive" }],
        },
        items: [{ title: "ISS-1", key: "iss-1" }, { title: "ISS-2", key: "iss-2" }],
      },
    ]), { selection: { batch: ["iss-1"] } });
    // At the cap a new tick is REFUSED rather than evicting the oldest: a row
    // vanishing from a batch the reader believes they assembled is not a
    // gesture they have. Unticking always works.
    expect(pluginPaneToggleRow(full, "batch", "iss-2")).toBe(full.selection);
    expect(pluginPaneToggleRow(full, "batch", "iss-1")).toEqual({ batch: [] });
    expect(pluginPaneClearSelection(full, "batch")).toEqual({ batch: [] });
  });

  it("carries the ticks across a republish and drops a list the schema no longer declares", () => {
    const first = build(BATCH, { selection: { batch: ["iss-1"] } });
    expect(first.selection).toEqual({ batch: ["iss-1"] });
    // Row keys are deliberately absent from the signature: a plugin
    // republishing its rows every ten seconds must not empty a batch the reader
    // is still assembling.
    const republished = build(BATCH, {
      selection: first.selection,
      selectionSignature: first.selectionSignature,
    });
    expect(republished.selection).toEqual({ batch: ["iss-1"] });

    const renamed = build(panel([
      {
        component: "list",
        selectable: { stateKey: "other", actions: [{ action: "createLanes", label: "Create lanes" }] },
        items: [{ title: "ISS-1", key: "iss-1" }],
      },
    ]), { selection: first.selection, selectionSignature: first.selectionSignature });
    expect(renamed.selection).toEqual({ other: [] });
  });

  it("puts the batch back to nothing when an action asks for a reset", () => {
    const ticked = build(BATCH, { selection: { batch: ["iss-1", "iss-2"] } });
    expect(pluginPaneSelectionReset(ticked, { resetState: true })).toEqual({ batch: [] });
    expect(pluginPaneSelectionReset(ticked, { resetState: ["batch"] })).toEqual({ batch: [] });
    expect(pluginPaneSelectionReset(ticked, { ok: true })).toBeNull();
  });

  it("identifies a tick by its row and a bulk verb by its action, not by their labels", () => {
    const ticked = build(BATCH, { selection: { batch: ["iss-1"] } });
    const tick = ticked.interactives.find((entry) => entry.kind === "selection");
    const verbs = ticked.interactives.filter((entry) => entry.kind === "bulk");
    if (!tick) throw new Error("expected a tick interactive");
    expect(pluginInteractiveKey(ticked, tick))
      .toBe(JSON.stringify(["graph", "main", "selection", "batch", "iss-1"]));
    expect(verbs.map((verb) => pluginInteractiveKey(ticked, verb))).toEqual([
      JSON.stringify(["graph", "main", "bulk", "batch", "createLanes", []]),
      // Clear carries no action, and says so rather than borrowing one.
      JSON.stringify(["graph", "main", "bulk", "batch", "", []]),
    ]);
    // Ticking a second row must not re-ask a confirm armed on the first: the
    // verb is the same verb over the same list.
    const more = build(BATCH, {
      selection: { batch: ["iss-1", "iss-2"] },
      selectionSignature: ticked.selectionSignature,
    });
    const again = more.interactives.find((entry) => entry.kind === "bulk");
    if (!again || !verbs[0]) throw new Error("expected a bulk interactive");
    expect(pluginInteractiveKey(more, again)).toBe(pluginInteractiveKey(ticked, verbs[0]));
  });
});

describe("collection-bound segmented options in the terminal", () => {
  function projects(count: number): PluginPaneCollectionMap {
    return new Map([
      [
        bindingKey({ collection: "projects" }),
        Array.from({ length: count }, (_unused, index) => ({
          key: `row-${index}`,
          value: { id: `p${index}`, name: `Project ${index}` },
        })),
      ],
    ]);
  }

  const BOUND = (extra: Record<string, unknown> = {}) => panel([
    {
      component: "segmented",
      stateKey: "project",
      label: "Project",
      options: [{ value: "", label: "All projects" }],
      optionsFrom: { collection: "projects", valueField: "id", labelField: "name" },
      ...extra,
    },
  ]);

  it("is a working control on its All when the rows have not landed", () => {
    const model = build(BOUND());
    expect(model.declarations[0]?.options).toEqual([{ value: "", label: "All projects" }]);
    // And the signature does not move when they do, so the reader's filter
    // survives that transition.
    expect(model.stateSignature).toBe(build(BOUND(), { collections: projects(3) }).stateSignature);
  });

  it("filters a list against an option the collection supplied", () => {
    const collections = projects(12);
    collections.set(bindingKey({ collection: "issues" }), [
      { key: "1", value: { title: "In p0", project: "p0" } },
      { key: "2", value: { title: "In p1", project: "p1" } },
    ]);
    const model = build(panel([
      {
        component: "segmented",
        stateKey: "project",
        options: [{ value: "", label: "All projects" }],
        optionsFrom: { collection: "projects", valueField: "id", labelField: "name" },
      },
      {
        component: "list",
        bind: { collection: "issues", where: [{ field: "project", equals: { $state: "project" } }] },
      },
    ]), { collections, state: { project: "p1" } });
    expect(listTitles(model)).toEqual(["In p1"]);
  });
});

/**
 * List paging in the pane — the terminal's half of B3.
 *
 * A terminal has no scrollbar and no pull, so the only way to ask for more rows
 * is to select something. What is drawn when there is nothing left to ask for
 * matters just as much: a list that stopped at the ceiling and said nothing is
 * indistinguishable from a complete one, which is the half of D7 a bigger
 * number alone would not have fixed.
 */
describe("plugin pane list paging", () => {
  const listPanel = (count: number) =>
    panel([{
      component: "list",
      items: Array.from({ length: count }, (_, index) => ({
        title: `row-${index}`,
        key: `k${index}`,
      })),
    }]);

  const listRows = (model: PluginPaneModel) =>
    model.rows.filter((row) => row.kind === "listItem");

  const pageRow = (model: PluginPaneModel) =>
    model.rows.find((row) => row.kind === "listPage");

  it("draws one page and offers the rest as a numbered row", () => {
    const model = build(listPanel(143));
    expect(listRows(model)).toHaveLength(VOCAB_LIMITS.listPageSize);
    const row = pageRow(model);
    expect(row?.kind).toBe("listPage");
    if (row?.kind !== "listPage") return;
    expect(row.label).toBe("Showing 100 of 143 · Show more");
    expect(row.selection).not.toBeNull();
    expect(model.interactives[row.selection ?? -1]).toMatchObject({
      kind: "listPage",
      total: 143,
    });
  });

  it("extends by one page and then has nothing left to offer", () => {
    const first = build(listPanel(143));
    const row = pageRow(first);
    if (row?.kind !== "listPage" || row.selection === null) return expect.fail("expected a control");
    const interactive = first.interactives[row.selection];
    if (interactive?.kind !== "listPage") return expect.fail("expected a page control");

    const listPages = pluginPaneShowMore(first, interactive.listKey, interactive.total);
    expect(listPages[interactive.listKey]).toBe(2);

    const second = build(listPanel(143), { listPages });
    expect(listRows(second)).toHaveLength(143);
    expect(pageRow(second)).toBeUndefined();
    // A press with nothing left to draw returns the map unchanged, so the caller
    // can skip the rebuild rather than growing a number the list cannot spend.
    expect(pluginPaneShowMore(second, interactive.listKey, 143)).toBe(second.listPages);
  });

  it("says a list stopped at the ceiling, with no control beside it", () => {
    const model = build(listPanel(VOCAB_LIMITS.maxListItems), {
      listPages: { "items:k0": vocabListPagesToCeiling() },
    });
    const row = pageRow(model);
    if (row?.kind !== "listPage") return expect.fail("expected a page row");
    expect(row.label).toBe(`Showing the first ${VOCAB_LIMITS.maxListItems}`);
    expect(row.selection).toBeNull();
  });

  it("says nothing at all about a list that fits on one page", () => {
    expect(pageRow(build(listPanel(12)))).toBeUndefined();
  });

  it("filters before it pages, so a page never reaches a rejected row", () => {
    const rows = Array.from({ length: 200 }, (_, index) => ({
      key: `k${index}`,
      value: { title: `row-${index}`, status: index < 30 ? "open" : "closed" },
    }));
    const collections: PluginPaneCollectionMap = new Map([
      [bindingKey({ collection: "issues" }), rows],
    ]);
    const model = build(
      panel([
        {
          component: "segmented",
          stateKey: "status",
          default: "open",
          options: [{ value: "all", label: "All" }, { value: "open", label: "Open" }],
        },
        {
          component: "list",
          bind: {
            collection: "issues",
            where: [{ field: "status", equals: { $state: "status" } }],
          },
        },
      ]),
      { collections },
    );
    // Thirty rows survived the filter, so the page is over thirty and not over
    // two hundred — and there is nothing left to page to.
    expect(listRows(model)).toHaveLength(30);
    expect(pageRow(model)).toBeUndefined();
  });

  it("keys a page control by its list, never by the count in its label", () => {
    // The label carries a number that moves with every row the plugin
    // publishes; an armed confirm keyed by it would re-ask on the next poll.
    const model = build(listPanel(143));
    const row = pageRow(model);
    if (row?.kind !== "listPage" || row.selection === null) return expect.fail("expected a control");
    const interactive = model.interactives[row.selection];
    if (!interactive) return expect.fail("expected an interactive");
    const key = pluginInteractiveKey(model, interactive);

    const grown = build(listPanel(190));
    const grownRow = pageRow(grown);
    if (grownRow?.kind !== "listPage" || grownRow.selection === null) {
      return expect.fail("expected a control");
    }
    const grownInteractive = grown.interactives[grownRow.selection];
    if (!grownInteractive) return expect.fail("expected an interactive");
    expect(pluginInteractiveKey(grown, grownInteractive)).toBe(key);
  });

  it("carries the reader's pages across a republish and drops them on a new panel", () => {
    // The same terms a folded section is held on: a plugin republishing its rows
    // every ten seconds must not put the reader back on the first hundred.
    const listPages = { "items:k0": 2 };
    expect(listRows(build(listPanel(143), { listPages }))).toHaveLength(143);
    // A panel that never asked for a page draws its first one, whatever some
    // other panel's map happens to hold.
    expect(listRows(build(listPanel(143)))).toHaveLength(VOCAB_LIMITS.listPageSize);
  });
});

describe("panel chrome", () => {
  it("pins search and nav actions, walks the footer, and names a group icon", () => {
    const model = build(panel(
      [
        { component: "group", title: "Started", icon: "circle", children: [{ component: "text", text: "a" }] },
        { component: "list", bind: { collection: "issues", where: [{ field: "title", contains: { $state: "q" } }] } },
      ],
      {
        chrome: {
          search: { stateKey: "q", placeholder: "Filter issues", onChange: { action: "search" } },
          navActions: [{ action: "openLinear", label: "Open in Linear" }],
          footer: [{ component: "button", label: "New issue", onPress: { action: "create" } }],
        },
      },
    ), {
      collections: new Map([[bindingKey({ collection: "issues" }), [
        { key: "1", value: { title: "ISS-1 login" } },
        { key: "2", value: { title: "Other" } },
      ]]]),
      state: { q: "login" },
    });

    expect(model.rows[0]).toMatchObject({ kind: "search", placeholder: "Filter issues", value: "login" });
    expect(model.rows.some((row) => row.kind === "buttons" && row.buttons.some((button) => button.label === "Open in Linear"))).toBe(true);
    expect(model.rows[model.rows.length - 1]).toMatchObject({ kind: "buttons" });
    expect(model.chromeHeaderCount).toBeGreaterThan(0);
    expect(model.chromeFooterCount).toBeGreaterThan(0);
    expect(model.declarations.map((entry) => entry.stateKey)).toEqual(["q"]);
    const group = model.rows.find((row) => row.kind === "group");
    expect(group).toMatchObject({ kind: "group", title: "Started", icon: "circle" });
    expect(model.rows.filter((row) => row.kind === "listItem").map((row) => row.kind === "listItem" ? row.title : ""))
      .toEqual(["ISS-1 login"]);

    const windowed = pluginPaneWindow(model, 0, 4);
    expect(windowed.rows[0]?.kind).toBe("search");
    expect(windowed.rows[windowed.rows.length - 1]?.kind).toBe("buttons");
  });
});

/**
 * A thing the terminal used to drop on its way from a schema to a row: the pane
 * knew something and printed a worse version of it. A `brand:linear` token
 * printed as the literal text `brand:linear`.
 */
describe("what the terminal used to drop", () => {
  it("never prints a brand token, and says when nobody shipped the mark", () => {
    const glyph = { viewBox: "0 0 24 24", paths: [{ d: "M0 0h24v24H0z" }] };
    const withIcon = build(
      panel([
        { component: "group", title: "Issues", icon: "brand:linear", children: [] },
        { component: "badge", text: "Open", icon: "brand:linear" },
        { component: "button", label: "Sync", icon: "brand:linear", onPress: { action: "sync" } },
        {
          component: "list",
          items: [{ title: "ENG-1", icon: "brand:linear" }],
        },
        { component: "emptyState", title: "Nothing linked", icon: "brand:linear" },
      ]),
      { brandIcons: [{ key: "linear", value: glyph }] },
    );

    const rendered = JSON.stringify(withIcon.rows);
    expect(rendered).not.toContain("brand:linear");

    const group = withIcon.rows.find((row) => row.kind === "group");
    expect(group?.kind === "group" ? group.icon : null).toBe("◆");
    const badge = withIcon.rows.find((row) => row.kind === "inline");
    expect(badge?.kind === "inline" ? badge.parts[0]?.icon : null).toBe("◆");
    const buttons = withIcon.rows.find((row) => row.kind === "buttons");
    expect(buttons?.kind === "buttons" ? buttons.buttons[0]?.icon : null).toBe("◆");
    const item = withIcon.rows.find((row) => row.kind === "listItem");
    expect(item?.kind === "listItem" ? item.icon : null).toBe("◆");
    const empty = withIcon.rows.find((row) => row.kind === "text" && row.text.includes("Nothing linked"));
    expect(empty?.kind === "text" ? empty.text : "").toBe("◆ Nothing linked");

    // Nobody shipped the mark: the puzzle piece, never the token.
    const without = build(panel([
      { component: "group", title: "Issues", icon: "brand:linear", children: [] },
    ]));
    const bare = without.rows.find((row) => row.kind === "group");
    expect(bare?.kind === "group" ? bare.icon : null).toBe("◇");

    // ADE ships these five itself, so they resolve with no plugin collection.
    const shipped = build(panel([
      { component: "group", title: "Repo", icon: "brand:github", children: [] },
    ]));
    const known = shipped.rows.find((row) => row.kind === "group");
    expect(known?.kind === "group" ? known.icon : null).toBe("◆");

    // A generic catalogue token is words already, and keeps printing them.
    const generic = build(panel([
      { component: "group", title: "Repo", icon: "git-branch", children: [] },
    ]));
    const plain = generic.rows.find((row) => row.kind === "group");
    expect(plain?.kind === "group" ? plain.icon : null).toBe("git-branch");
  });
});

/**
 * Where a `{navigate}` lands in a terminal.
 *
 * The TUI has one place to draw a plugin panel, so every target answers the
 * same. The value of these assertions is the SWITCH behind them: `popover`
 * reached this client for free once — the SDK reader widened, nothing broke,
 * and nobody decided anything — and the exhaustive switch is what makes the
 * fourth target a compile error rather than a silent drop.
 */
describe("pluginPaneNavigationPlacement", () => {
  it("puts every target in the right pane", () => {
    expect(pluginPaneNavigationPlacement(undefined)).toBe("pane");
    expect(pluginPaneNavigationPlacement("tab")).toBe("pane");
    expect(pluginPaneNavigationPlacement("tools-pane")).toBe("pane");
    expect(pluginPaneNavigationPlacement("popover")).toBe("pane");
  });

  it("answers for every target the SDK declares, with none left out", () => {
    // The parity assertion: a target added to the shared list with no case here
    // fails the typecheck, and this fails if the list itself grows unread.
    for (const target of PLUGIN_ACTION_NAVIGATION_TARGETS) {
      expect(pluginPaneNavigationPlacement(target)).toBe("pane");
    }
    expect(PLUGIN_ACTION_NAVIGATION_TARGETS).toContain("popover");
  });
});

/**
 * What the terminal says about an `{openSettings}`.
 *
 * The branch that matters is the suppression: a plugin with no client
 * discriminator answers with `{openSettings}` for the clients that have a
 * Settings page and `{navigate}` for the ones that do not, and the terminal is
 * the second kind. Naming a page on the Mac and then opening a perfectly good
 * pane contradicts what the reader just watched happen.
 */
describe("pluginPaneSettingsNotice", () => {
  it("names ADE's own pages, which the terminal cannot open", () => {
    expect(pluginPaneSettingsNotice({ openSettings: "agents.provider.cursor" }, "Connect"))
      .toContain("Cursor API key");
    expect(pluginPaneSettingsNotice({ openSettings: "secrets.secrets" }, "Connect"))
      .toContain("Secrets");
  });

  it("names the plugin's own section for the newer shape", () => {
    expect(pluginPaneSettingsNotice({ openSettings: { socketId: "connection" } }, "Linear"))
      .toBe("Linear: open this plugin's section in ADE Settings on the Mac that holds it.");
  });

  it("says nothing when a navigation beside it answers better", () => {
    expect(pluginPaneSettingsNotice({
      openSettings: { socketId: "connection" },
      navigate: { panelId: "settings" },
    }, "Linear")).toBeNull();
    // The same for ADE's own pages: the pair is one destination written twice,
    // and this client takes the half it can honour.
    expect(pluginPaneSettingsNotice({
      openSettings: "secrets.secrets",
      navigate: { panelId: "settings" },
    }, "Connect")).toBeNull();
  });

  it("still reports a malformed request, navigation or not", () => {
    // An authoring fault, which a fallback beside it does not fix.
    expect(pluginPaneSettingsNotice({ openSettings: "billing.plans" }, "Connect"))
      .toContain("does not open");
    expect(pluginPaneSettingsNotice({
      openSettings: "billing.plans",
      navigate: { panelId: "settings" },
    }, "Connect")).toContain("does not open");
  });

  it("says nothing at all for a result that asked for no settings page", () => {
    expect(pluginPaneSettingsNotice({ navigate: { panelId: "settings" } }, "Linear")).toBeNull();
    expect(pluginPaneSettingsNotice({ message: "Saved." }, "Linear")).toBeNull();
  });
});
