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
