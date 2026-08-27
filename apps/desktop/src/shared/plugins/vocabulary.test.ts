import { describe, expect, it } from "vitest";

import {
  VOCAB_COMPONENTS_V1,
  VOCAB_LIMITS,
  VOCAB_VERSION,
  bindingKey,
  boundRowValues,
  coerceBoundKeyValueRow,
  coerceBoundListItem,
  coerceBoundTableRow,
  collectVocabBindings,
  countVocabNodes,
  distinctBindings,
  isKnownVocabComponent,
  normalizeVocabTone,
  parsePluginPanel,
  readVocabFallback,
  vocabFallbackText,
  type VocabNode,
} from "./vocabulary";

const FALLBACK = { title: "Graph", text: "3 lanes, 1 conflict.", deeplink: "ade://lane/abc" };

function panel(body: unknown[], overrides: Record<string, unknown> = {}) {
  return { v: VOCAB_VERSION, fallback: FALLBACK, body, ...overrides };
}

describe("parsePluginPanel — valid schemas", () => {
  it("parses every v1 component in one panel", () => {
    const result = parsePluginPanel(
      panel([
        { component: "text", text: "Overview", variant: "title" },
        { component: "divider", label: "Status" },
        { component: "badge", text: "3 open", tone: "accent" },
        { component: "button", label: "Refresh", onPress: { action: "refresh" } },
        { component: "list", items: [{ title: "lane-a", subtitle: "2 commits" }] },
        {
          component: "table",
          columns: [{ key: "name", label: "Name" }, { key: "n", label: "Count", align: "right" }],
          rows: [{ name: "a", n: 2 }],
        },
        {
          component: "form",
          fields: [
            { kind: "text", id: "name", label: "Name" },
            { kind: "secret", id: "token", label: "Token" },
            { kind: "select", id: "lane", label: "Lane", options: [{ value: "a" }, { value: "b" }] },
            { kind: "toggle", id: "auto", label: "Auto", value: true },
            { kind: "number", id: "n", label: "Count", min: 0, max: 10 },
          ],
          submit: { label: "Save", onPress: { action: "save" } },
        },
        { component: "chart", kind: "line", series: [{ id: "a", points: [{ x: 0, y: 1 }] }] },
        { component: "video", src: "file:///clip.mp4" },
        { component: "image", src: "file:///shot.png", alt: "Screenshot" },
        { component: "keyValue", rows: [{ key: "Branch", value: "main" }] },
        { component: "emptyState", title: "Nothing yet" },
        { component: "stack", children: [{ component: "text", text: "nested" }] },
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
    expect(result.panel.body.map((node) => node.component)).toEqual([
      "text",
      "divider",
      "badge",
      "button",
      "list",
      "table",
      "form",
      "chart",
      "video",
      "image",
      "keyValue",
      "emptyState",
      "stack",
    ]);
  });

  it("accepts the schema as a JSON string, the shape stored in plugin_panels", () => {
    const result = parsePluginPanel(JSON.stringify(panel([{ component: "text", text: "hi" }])));
    expect(result.ok).toBe(true);
  });

  it("folds red-ish tones to warning so a payload cannot introduce a red state", () => {
    const result = parsePluginPanel(panel([{ component: "badge", text: "Failed", tone: "danger" }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.panel.body[0]).toMatchObject({ component: "badge", tone: "warning" });
    expect(normalizeVocabTone("error")).toBe("warning");
    expect(normalizeVocabTone("nonsense")).toBe("neutral");
  });

  it("reports every binding so a host can fetch exactly what a panel reads", () => {
    const result = parsePluginPanel(
      panel([
        {
          component: "stack",
          children: [{ component: "list", bind: { collection: "issues", keyPrefix: "open:" } }],
        },
        { component: "keyValue", bind: { collection: "meta" } },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(collectVocabBindings(result.panel.body)).toEqual([
      { collection: "issues", keyPrefix: "open:" },
      { collection: "meta" },
    ]);
    expect(countVocabNodes(result.panel.body)).toBe(3);
  });
});

describe("parsePluginPanel — panel-fatal damage", () => {
  it("rejects a schema that is not JSON", () => {
    const result = parsePluginPanel("{not json");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("not_json");
  });

  it("rejects a version this build cannot interpret", () => {
    const result = parsePluginPanel(panel([], { v: 99 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("version_unsupported");
    // The fallback still survives, so the failure card shows the plugin's words.
    expect(result.fallback).toEqual(FALLBACK);
  });

  it("rejects a panel with no fallback — rule 2 of the contract", () => {
    const result = parsePluginPanel({ v: VOCAB_VERSION, body: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("fallback_missing");
    expect(result.fallback).toBeNull();
  });

  it("rejects an oversized schema", () => {
    const filler = "x".repeat(VOCAB_LIMITS.maxSchemaBytes);
    const result = parsePluginPanel(
      JSON.stringify(panel([{ component: "text", text: filler }])),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("schema_too_large");
  });

  it("rejects a panel over the node ceiling", () => {
    const body = Array.from({ length: VOCAB_LIMITS.maxNodes + 1 }, (_, index) => ({
      component: "text",
      text: `row ${index}`,
    }));
    const result = parsePluginPanel(panel(body));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("too_many_nodes");
  });

  it("rejects a panel nested past the depth ceiling", () => {
    let node: Record<string, unknown> = { component: "text", text: "leaf" };
    for (let depth = 0; depth <= VOCAB_LIMITS.maxDepth; depth += 1) {
      node = { component: "stack", children: [node] };
    }
    const result = parsePluginPanel(panel([node]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("too_deep");
  });

  it("accepts a panel exactly at the depth ceiling", () => {
    let node: Record<string, unknown> = { component: "text", text: "leaf" };
    for (let depth = 1; depth < VOCAB_LIMITS.maxDepth; depth += 1) {
      node = { component: "stack", children: [node] };
    }
    expect(parsePluginPanel(panel([node])).ok).toBe(true);
  });
});

describe("parsePluginPanel — node-local degradation", () => {
  it("keeps an unknown component as a placeholder instead of failing the panel", () => {
    const result = parsePluginPanel(
      panel([
        { component: "text", text: "before" },
        { component: "hologram", whatever: true },
        { component: "text", text: "after" },
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.panel.body).toHaveLength(3);
    expect(result.panel.body[1]).toEqual({ component: "__unknown", name: "hologram" });
    expect(result.warnings[0]?.code).toBe("unknown_component");
    expect(result.warnings[0]?.path).toBe("body[1]");
    expect(isKnownVocabComponent("hologram")).toBe(false);
  });

  it("replaces a malformed known component without blanking its siblings", () => {
    const result = parsePluginPanel(
      panel([
        { component: "button", label: "No action here" },
        { component: "text", text: "still rendered" },
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.panel.body[0]).toMatchObject({ component: "__invalid", name: "button" });
    expect(result.panel.body[1]).toMatchObject({ component: "text" });
    expect(result.warnings[0]?.code).toBe("invalid_node");
  });

  it("flags a malformed binding and invalidates only the node that needed it", () => {
    const result = parsePluginPanel(panel([{ component: "list", bind: { keyPrefix: "open:" } }]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.map((error) => error.code)).toContain("invalid_binding");
    expect(result.panel.body[0]).toMatchObject({ component: "__invalid", name: "list" });
  });

  it("drops non-scalar action args rather than passing structure through", () => {
    const result = parsePluginPanel(
      panel([
        {
          component: "button",
          label: "Run",
          onPress: { action: "run", args: { laneId: "a", count: 2, nested: { evil: true } } },
        },
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const node = result.panel.body[0] as Extract<VocabNode, { component: "button" }>;
    expect(node.onPress.args).toEqual({ laneId: "a", count: 2 });
  });

  it("rejects a select field whose options collide, without failing the panel", () => {
    const result = parsePluginPanel(
      panel([
        {
          component: "form",
          fields: [{ kind: "select", id: "lane", label: "Lane", options: [{ value: "a" }, { value: "a" }] }],
          submit: { label: "Save", onPress: { action: "save" } },
        },
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.panel.body[0]).toMatchObject({ component: "__invalid", name: "form" });
  });
});

describe("fallback helpers", () => {
  it("recovers a fallback from an otherwise unusable schema", () => {
    expect(readVocabFallback({ v: 4, fallback: { title: "T", text: "B" } })).toEqual({
      title: "T",
      text: "B",
    });
    expect(readVocabFallback("nonsense")).toBeNull();
    expect(readVocabFallback({ fallback: { title: "T" } })).toBeNull();
  });

  it("appends the deeplink for surfaces that render one line", () => {
    expect(vocabFallbackText(FALLBACK)).toBe("3 lanes, 1 conflict. · ade://lane/abc");
    expect(vocabFallbackText({ title: "T", text: "B" })).toBe("B");
  });
});

describe("the component list", () => {
  it("is derived from the parsers, so a name cannot be published without one", () => {
    expect(VOCAB_COMPONENTS_V1).toContain("stack");
    for (const name of VOCAB_COMPONENTS_V1) {
      expect(isKnownVocabComponent(name), `${name} is published but unparseable`).toBe(true);
    }
  });

  it("does not recognize a name that only exists on Object's prototype", () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(isKnownVocabComponent(name), `${name} was treated as a component`).toBe(false);
      const result = parsePluginPanel(panel([{ component: name, text: "x" }]));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.panel.body[0]).toEqual({ component: "__unknown", name });
    }
  });
});

describe("bindings a host must fetch", () => {
  it("fetches the larger limit when two nodes read one collection", () => {
    const bindings = distinctBindings(panel([
      { component: "list", bind: { collection: "issues", limit: 10 } },
      { component: "keyValue", bind: { collection: "issues", limit: 100 } },
      { component: "table", columns: [{ key: "a", label: "A" }], bind: { collection: "issues", limit: 5 } },
    ]));

    // One fetch, sized for the hungriest reader. Last-wins would have left the
    // 100-row list showing five rows with nothing on screen saying so.
    expect(bindings).toEqual([{ collection: "issues", limit: 100 }]);
  });

  it("keeps a key prefix distinct from the collection name it follows", () => {
    expect(bindingKey({ collection: "a", keyPrefix: "b:c" }))
      .not.toBe(bindingKey({ collection: "a:b", keyPrefix: "c" }));
    expect(distinctBindings(panel([
      { component: "list", bind: { collection: "issues", keyPrefix: "open:" } },
      { component: "list", bind: { collection: "issues", keyPrefix: "closed:" } },
    ]))).toHaveLength(2);
  });

  it("returns nothing for a schema that will not parse", () => {
    expect(distinctBindings("{not json")).toEqual([]);
  });
});

describe("bound rows", () => {
  it("reads a numeric cell the same way for every surface", () => {
    // The divergence this replaced: desktop rendered `42`, the TUI rendered
    // nothing, from two coercers each documented as mirroring the other.
    expect(coerceBoundKeyValueRow({ key: "Open", value: 42 })).toEqual({ key: "Open", value: "42" });
    expect(coerceBoundKeyValueRow({ key: "Passing", value: true })).toEqual({ key: "Passing", value: "Yes" });
    expect(coerceBoundKeyValueRow({ key: "Note", value: { nested: 1 } })).toEqual({ key: "Note", value: "" });
    expect(coerceBoundKeyValueRow({ value: "orphan" })).toBeNull();
  });

  it("keeps a list row's icon and refuses to mint an action from stored data", () => {
    expect(coerceBoundListItem({
      title: "  lane-a  ",
      subtitle: "2 commits",
      icon: "git-branch",
      tone: "danger",
      onPress: { action: "delete-everything" },
    })).toEqual({
      title: "lane-a",
      subtitle: "2 commits",
      icon: "git-branch",
      tone: "warning",
    });
    expect(coerceBoundListItem({ subtitle: "no title" })).toBeNull();
  });

  it("lets a bound row act only when the panel's binding allowed that action id", () => {
    // The panel author still chooses every action a reader can press. The data
    // decides only which of them a given row offers.
    const allowed = coerceBoundListItem(
      { title: "bc-1", onPress: { action: "open-agent", args: { id: "bc-1" }, confirm: "Open it?" } },
      ["open-agent", "stop-agent"],
    );
    expect(allowed).toEqual({
      title: "bc-1",
      onPress: { action: "open-agent", args: { id: "bc-1" }, confirm: "Open it?" },
    });

    expect(coerceBoundListItem(
      { title: "bc-1", onPress: { action: "delete-everything" } },
      ["open-agent"],
    )).toEqual({ title: "bc-1" });

    expect(coerceBoundListItem({ title: "bc-1", onPress: { action: "open-agent" } }, []))
      .toEqual({ title: "bc-1" });
  });

  it("reads an allowlist off a binding, deduplicating and capping it", () => {
    const parsed = parsePluginPanel({
      v: 1,
      fallback: FALLBACK,
      body: [{
        component: "list",
        bind: {
          collection: "fleet",
          allowActions: ["open", "open", "  stop  ", 7, "", ...Array.from({ length: 40 }, (_, i) => `a${i}`)],
        },
      }],
    });
    expect(parsed.ok).toBe(true);
    const node = parsed.ok ? parsed.panel.body[0] : null;
    const allow = node && node.component === "list" ? node.bind?.allowActions : undefined;
    expect(allow?.slice(0, 3)).toEqual(["open", "stop", "a0"]);
    expect(allow).toHaveLength(VOCAB_LIMITS.maxBindingAllowActions);
  });

  it("drops an empty or absent allowlist rather than storing one", () => {
    const parsed = parsePluginPanel({
      v: 1,
      fallback: FALLBACK,
      body: [
        { component: "list", bind: { collection: "a", allowActions: [] } },
        { component: "list", bind: { collection: "b" } },
        { component: "list", bind: { collection: "c", allowActions: "open" } },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    for (const node of parsed.panel.body) {
      expect(node.component === "list" ? node.bind?.allowActions : "n/a").toBeUndefined();
    }
  });

  it("reads the rich half of a row: a badge, a mono line, actions and overflow", () => {
    const parsed = parsePluginPanel(panel([{
      component: "list",
      items: [{
        title: "bc-1",
        subtitle: "Fix the login redirect",
        mono: "origin/fix-login-redirect",
        badge: { text: "Running", tone: "accent", icon: "play" },
        actions: [
          { action: "open", label: "Open", kind: "primary", icon: "arrow-right" },
          { action: "stop", label: "Stop", confirm: "Stop this agent?" },
        ],
        overflow: [{ action: "archive", label: "Archive" }],
      }],
    }]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const node = parsed.panel.body[0];
    expect(node.component).toBe("list");
    if (node.component !== "list") return;
    expect(node.items?.[0]).toEqual({
      title: "bc-1",
      subtitle: "Fix the login redirect",
      mono: "origin/fix-login-redirect",
      badge: { text: "Running", tone: "accent", icon: "play" },
      actions: [
        { action: "open", label: "Open", kind: "primary", icon: "arrow-right" },
        { action: "stop", confirm: "Stop this agent?", label: "Stop" },
      ],
      overflow: [{ action: "archive", label: "Archive" }],
    });

    // The whole list is ONE node however rich its rows are — the reason these
    // live on the item instead of being a hand-built stack per row.
    expect(countVocabNodes(parsed.panel.body)).toBe(1);
  });

  it("drops a row action that cannot say what it does", () => {
    const parsed = parsePluginPanel(panel([{
      component: "list",
      items: [{
        title: "bc-1",
        badge: { tone: "accent" },
        actions: [
          { label: "No action id" },
          { action: "no-label" },
          "not an object",
          { action: "ok", label: "Fine" },
        ],
      }],
    }]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const node = parsed.panel.body[0];
    if (node.component !== "list") return expect.fail("expected a list");
    // A refused entry does not spend a slot the valid one needed, and a badge
    // with no text is dropped whole rather than drawn empty.
    expect(node.items?.[0]).toEqual({ title: "bc-1", actions: [{ action: "ok", label: "Fine" }] });
  });

  it("caps a row's actions and overflow, counting what survived", () => {
    const many = (count: number, prefix: string) =>
      Array.from({ length: count }, (_, index) => ({ action: `${prefix}${index}`, label: `${prefix}${index}` }));
    const parsed = parsePluginPanel(panel([{
      component: "list",
      items: [{
        title: "bc-1",
        // Two refusals first: if the cap counted offers rather than survivors,
        // the third and fourth valid entries would never be reached.
        actions: [{ action: "x" }, "nope", ...many(6, "a")],
        overflow: many(12, "o"),
      }],
    }]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const node = parsed.panel.body[0];
    if (node.component !== "list") return expect.fail("expected a list");
    expect(node.items?.[0]?.actions?.map((entry) => entry.action))
      .toEqual(["a0", "a1", "a2"]);
    expect(node.items?.[0]?.actions).toHaveLength(VOCAB_LIMITS.maxListItemActions);
    expect(node.items?.[0]?.overflow).toHaveLength(VOCAB_LIMITS.maxListItemOverflow);
  });

  it("holds a hundred rich rows in one node and under the schema budget", () => {
    // The acceptance the widening exists for. Hand-built out of stack, badge,
    // text and button nodes this row was about seven nodes, so `maxNodes` (200)
    // capped the panel near 27 rows.
    const rows = Array.from({ length: VOCAB_LIMITS.maxListItems }, (_, index) => ({
      title: `bc-${index}`,
      subtitle: "Fix the login redirect on the marketing site",
      mono: `origin/agent-${index}`,
      badge: { text: "Running", tone: "accent" },
      actions: [
        { action: "open", label: "Open", args: { id: `bc-${index}` } },
        { action: "pull", label: "Pull" },
        { action: "stop", label: "Stop", confirm: "Stop this agent?" },
      ],
      overflow: [{ action: "archive", label: "Archive", args: { id: `bc-${index}` } }],
    }));
    const schema = panel([{ component: "list", items: rows }]);
    const parsed = parsePluginPanel(schema);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const node = parsed.panel.body[0];
    if (node.component !== "list") return expect.fail("expected a list");
    expect(node.items).toHaveLength(VOCAB_LIMITS.maxListItems);
    expect(countVocabNodes(parsed.panel.body)).toBe(1);
    expect(Buffer.byteLength(JSON.stringify(schema), "utf8"))
      .toBeLessThan(VOCAB_LIMITS.maxSchemaBytes);
  });

  it("gates every action on a bound row through the binding's allowlist", () => {
    // Not just `onPress`: a collection that could reach an undeclared action
    // through a trailing button would have made `onPress` the only guarded door.
    const row = {
      title: "bc-1",
      mono: "origin/fix-login",
      badge: { text: "Running", tone: "accent" },
      onPress: { action: "open" },
      actions: [
        { action: "open", label: "Open" },
        { action: "delete-everything", label: "Delete" },
      ],
      overflow: [
        { action: "delete-everything", label: "Delete" },
        { action: "stop", label: "Stop" },
      ],
    };
    expect(coerceBoundListItem(row, ["open", "stop"])).toEqual({
      title: "bc-1",
      mono: "origin/fix-login",
      badge: { text: "Running", tone: "accent" },
      onPress: { action: "open" },
      actions: [{ action: "open", label: "Open" }],
      overflow: [{ action: "stop", label: "Stop" }],
    });

    // No allowlist keeps the old answer for the whole row, not only its press.
    expect(coerceBoundListItem(row)).toEqual({
      title: "bc-1",
      mono: "origin/fix-login",
      badge: { text: "Running", tone: "accent" },
    });
  });

  it("shapes a table row to the declared columns and nothing else", () => {
    const columns = [{ key: "name", label: "Name" }, { key: "n", label: "Count" }];
    expect(coerceBoundTableRow({ name: "a", n: 2, secret: "x" }, columns))
      .toEqual({ name: "a", n: "2" });
    expect(coerceBoundTableRow("not a row", columns)).toBeNull();
  });

  it("tells a fetch that has not landed apart from a collection with no rows", () => {
    const bind = { collection: "issues", limit: 2 };
    expect(boundRowValues(bind, undefined)).toBeNull();
    expect(boundRowValues(bind, [])).toEqual([]);
    expect(boundRowValues(bind, [{ value: 1 }, { value: 2 }, { value: 3 }])).toEqual([1, 2]);
    expect(boundRowValues({ collection: "issues" }, [{ value: 1 }, { value: 2 }])).toEqual([1, 2]);
  });
});
