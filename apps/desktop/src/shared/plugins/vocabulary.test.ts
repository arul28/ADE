import { describe, expect, it } from "vitest";

import {
  VOCAB_COMPONENTS_V1,
  VOCAB_LIMITS,
  VOCAB_PANEL_READ_LIMIT,
  VOCAB_VERSION,
  bindingKey,
  boundRowEntries,
  boundRowValues,
  coerceBoundKeyValueRow,
  coerceBoundListItem,
  coerceBoundTableRow,
  collectVocabBindings,
  collectVocabSelectionDeclarations,
  collectVocabStateDeclarations,
  countVocabNodes,
  distinctBindings,
  isKnownVocabComponent,
  normalizeVocabTone,
  parsePluginPanel,
  readVocabFallback,
  vocabAvatarInitials,
  vocabChildNodes,
  vocabFallbackText,
  vocabGroupKey,
  vocabListKey,
  vocabListNextPage,
  vocabListPage,
  vocabListPageLabel,
  vocabListPagesToCeiling,
  vocabPanelContentNodes,
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
        { component: "avatar", name: "Jane Doe" },
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
      "avatar",
      "keyValue",
      "emptyState",
      "stack",
    ]);
  });

  it("accepts the schema as a JSON string, the shape stored in plugin_panels", () => {
    const result = parsePluginPanel(JSON.stringify(panel([{ component: "text", text: "hi" }])));
    expect(result.ok).toBe(true);
  });

  it("admits destructive as red and folds danger/error/failed onto it", () => {
    const result = parsePluginPanel(panel([{ component: "badge", text: "Failed", tone: "danger" }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.panel.body[0]).toMatchObject({ component: "badge", tone: "destructive" });
    expect(normalizeVocabTone("error")).toBe("destructive");
    expect(normalizeVocabTone("destructive")).toBe("destructive");
    expect(normalizeVocabTone("warning")).toBe("warning");
    expect(normalizeVocabTone("nonsense")).toBe("neutral");
  });

  it("parses an avatar and falls a missing photo to initials", () => {
    const result = parsePluginPanel(panel([
      { component: "avatar", name: "Jane Doe", src: "https://example.test/j.png", size: "lg" },
      { component: "avatar", name: "  " },
      {
        component: "list",
        items: [{ title: "ENG-1", avatar: { name: "Linear", src: "https://example.test/l.png" } }],
      },
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.panel.body[0]).toMatchObject({
      component: "avatar",
      name: "Jane Doe",
      src: "https://example.test/j.png",
      size: "lg",
    });
    expect(result.panel.body[1]).toMatchObject({ component: "__invalid", name: "avatar" });
    const list = result.panel.body[2];
    expect(list?.component === "list" ? list.items?.[0]?.avatar : null).toEqual({
      name: "Linear",
      src: "https://example.test/l.png",
    });
    expect(vocabAvatarInitials("Jane Doe")).toBe("JD");
    expect(vocabAvatarInitials("Linear")).toBe("L");
    expect(vocabAvatarInitials("   ")).toBe("?");
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

  it("holds eighty select options and refuses an eighty-first", () => {
    const options = Array.from({ length: VOCAB_LIMITS.maxSelectOptions }, (_, i) => ({ value: `m${i}` }));
    const ok = parsePluginPanel(panel([{
      component: "form",
      fields: [{ kind: "select", id: "model", label: "Model", options }],
      submit: { label: "Go", onPress: { action: "go" } },
    }]));
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.panel.body[0]).toMatchObject({ component: "form" });

    const over = parsePluginPanel(panel([{
      component: "form",
      fields: [{
        kind: "select",
        id: "model",
        label: "Model",
        options: [...options, { value: "extra" }],
      }],
      submit: { label: "Go", onPress: { action: "go" } },
    }]));
    expect(over.ok).toBe(true);
    if (!over.ok) return;
    expect(over.panel.body[0]).toMatchObject({ component: "__invalid", name: "form" });
  });

  /**
   * "No restart and no Apply button" was not expressible with `form` while
   * `submit` was required, so a settings panel had to be rebuilt out of
   * `segmented` controls and lost the labels, help text and validation a form
   * gives for free. `applyOnChange` is the settings shape.
   */
  describe("a form that applies on change", () => {
    const withApply = (over: Record<string, unknown>) => parsePluginPanel(
      panel([{
        component: "form",
        fields: [{ kind: "toggle", id: "digest", label: "Weekly digest" }],
        ...over,
      }]),
    );

    it("parses with no submit at all", () => {
      const result = withApply({ applyOnChange: { action: "apply" } });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.panel.body[0]).toMatchObject({
        component: "form",
        applyOnChange: { action: "apply" },
      });
      expect((result.panel.body[0] as { submit?: unknown }).submit).toBeUndefined();
    });

    it("allows both, which means changes apply AND the button re-runs the action", () => {
      const result = withApply({
        submit: { label: "Save", onPress: { action: "save" } },
        applyOnChange: { action: "apply" },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.panel.body[0]).toMatchObject({
        component: "form",
        submit: { label: "Save", onPress: { action: "save" } },
        applyOnChange: { action: "apply" },
      });
    });

    it("still refuses a form that offers neither way to send its values", () => {
      const result = withApply({});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.panel.body[0]).toMatchObject({ component: "__invalid", name: "form" });
    });

    it("refuses a malformed submit even when applyOnChange could carry the form", () => {
      // The author asked for a button. Dropping it silently would ship a form
      // missing a control they declared.
      const result = withApply({
        submit: { label: "Save" },
        applyOnChange: { action: "apply" },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.panel.body[0]).toMatchObject({ component: "__invalid", name: "form" });
    });
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

  /**
   * A collection row is `{key, value}`, so a row whose stored value is plain
   * text has a key already — it is the row's own. Reading only the value threw
   * it away, which made every `$context` row unrenderable: a `keyValue` bound to
   * `$context` drew its `emptyText` beside a context that was right there, on
   * desktop and in the TUI. iOS merged the key in and was the only client that
   * got this right.
   */
  it("uses the collection row's own key when the value carries none", () => {
    expect(coerceBoundKeyValueRow("alpha-build", "Lane")).toEqual({ key: "Lane", value: "alpha-build" });
    expect(coerceBoundKeyValueRow(42, "Open")).toEqual({ key: "Open", value: "42" });
    expect(coerceBoundKeyValueRow({ value: "alpha-build" }, "Lane")).toEqual({ key: "Lane", value: "alpha-build" });
    // The value's own key still wins: a row that named itself is not renamed.
    expect(coerceBoundKeyValueRow({ key: "Branch", value: "main" }, "Lane"))
      .toEqual({ key: "Branch", value: "main" });
    // No key from either side, or nothing with a text form, is still not a row.
    expect(coerceBoundKeyValueRow("alpha-build")).toBeNull();
    expect(coerceBoundKeyValueRow(null, "Lane")).toBeNull();
    expect(coerceBoundKeyValueRow(["a"], "Lane")).toBeNull();
  });

  it("carries each row's key through the filter and the cap", () => {
    const rows = [{ key: "Lane", value: "a" }, { key: "Logged", value: "b" }, { key: "By", value: "c" }];
    expect(boundRowEntries({ collection: "$context", limit: 2 }, rows))
      .toEqual([{ key: "Lane", value: "a" }, { key: "Logged", value: "b" }]);
    expect(boundRowEntries({ collection: "$context" }, undefined)).toBeNull();
    // The value-only reader is the same walk, so the two can never disagree.
    expect(boundRowValues({ collection: "$context", limit: 2 }, rows)).toEqual(["a", "b"]);
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
      tone: "destructive",
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

  /**
   * Which ceiling actually binds a list, and where.
   *
   * The row widening exists so a list is ONE node: hand-built out of stack,
   * badge, text and button nodes each of these rows was about seven, so
   * `maxNodes` (200) capped the panel near 27 rows. That part is unchanged. What
   * changed with `maxListItems: 250` is which ceiling a full list meets first,
   * and the two halves are genuinely different:
   *
   * - A BOUND list holds its rows in `plugin_collections`, so 250 of them cost
   *   the schema one node and no bytes at all. This is the case D7 and M9 are
   *   about, and it is why 250 is safe.
   * - An INLINE list is the only one that spends bytes, and there
   *   `maxSchemaBytes` was always the real ceiling and still is. A rich row of
   *   this shape measures about 375 bytes, so the budget runs out somewhere
   *   under 200 rows and the writer refuses the panel — which is the correct
   *   answer, not a regression: the row data belongs in a collection.
   */
  const richRow = (index: number) => ({
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
  });

  it("holds a hundred rich rows in one node and under the schema budget", () => {
    const rows = Array.from({ length: VOCAB_LIMITS.listPageSize }, (_, index) => richRow(index));
    const schema = panel([{ component: "list", items: rows }]);
    const parsed = parsePluginPanel(schema);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const node = parsed.panel.body[0];
    if (node.component !== "list") return expect.fail("expected a list");
    expect(node.items).toHaveLength(VOCAB_LIMITS.listPageSize);
    expect(countVocabNodes(parsed.panel.body)).toBe(1);
    expect(Buffer.byteLength(JSON.stringify(schema), "utf8"))
      .toBeLessThan(VOCAB_LIMITS.maxSchemaBytes);
  });

  it("lets the byte budget, not `maxListItems`, stop an inline list of rich rows", () => {
    const rows = Array.from({ length: VOCAB_LIMITS.maxListItems }, (_, index) => richRow(index));
    const schema = panel([{ component: "list", items: rows }]);
    expect(Buffer.byteLength(JSON.stringify(schema), "utf8"))
      .toBeGreaterThan(VOCAB_LIMITS.maxSchemaBytes);
    const parsed = parsePluginPanel(JSON.stringify(schema));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors[0]?.code).toBe("schema_too_large");
  });

  it("costs one node and no bytes to bind two hundred and fifty rows", () => {
    const schema = panel([{ component: "list", bind: { collection: "agents" } }]);
    const parsed = parsePluginPanel(schema);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(countVocabNodes(parsed.panel.body)).toBe(1);
    // The rows the binding will carry never enter the schema, which is the
    // whole reason the ceiling could be raised at all.
    const rows = Array.from({ length: VOCAB_LIMITS.maxListItems }, (_, index) => ({
      value: richRow(index),
    }));
    expect(boundRowValues({ collection: "agents" }, rows)).toHaveLength(VOCAB_LIMITS.maxListItems);
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

/* ── Groups ─────────────────────────────────────────────────────────────── */

/**
 * The `group` node, and the invariant that pays for it: a container the walkers
 * do not know about is a container whose controls declare nothing and whose
 * bindings nobody fetches. Every case here is mirrored in
 * `PluginVocabGroupSelectionTests` on iOS and in "the group node in the
 * terminal" in `pluginPane.test.ts`.
 */
describe("the group node", () => {
  it("a group parses and its children count against the node budget", () => {
    const result = parsePluginPanel(panel([
      {
        component: "group",
        title: "In Progress",
        groupKey: "started",
        badge: 4,
        defaultOpen: false,
        children: [
          { component: "text", text: "inside" },
          { component: "list", items: [{ title: "bc-1" }] },
        ],
      },
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const group = result.panel.body[0];
    expect(group).toMatchObject({
      component: "group",
      title: "In Progress",
      groupKey: "started",
      badge: "4",
      defaultOpen: false,
    });
    // One for the group and one for each child: a folded section is cheap to
    // draw, never cheap to declare.
    expect(countVocabNodes(result.panel.body)).toBe(3);
  });

  it("refuses a group with no title and keeps its siblings", () => {
    const result = parsePluginPanel(panel([
      { component: "group", children: [{ component: "text", text: "orphan" }] },
      { component: "text", text: "after" },
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.panel.body[0]).toMatchObject({ component: "__invalid", name: "group" });
    expect(result.panel.body[1]).toMatchObject({ component: "text", text: "after" });
  });

  it("a segmented inside a group still declares its state key", () => {
    const result = parsePluginPanel(panel([
      {
        component: "group",
        title: "Filters",
        defaultOpen: false,
        children: [{
          component: "segmented",
          stateKey: "statusFilter",
          options: [{ value: "", label: "All" }, { value: "active", label: "Active" }],
        }],
      },
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Declared off the parsed tree, not off whatever a client chose to draw —
    // which is what lets a folded section hold a working filter.
    expect(collectVocabStateDeclarations(result.panel.body).map((entry) => entry.stateKey))
      .toEqual(["statusFilter"]);
  });

  it("fetches a collection a group holds, folded or not", () => {
    const schema = panel([
      {
        component: "group",
        title: "Backlog",
        defaultOpen: false,
        children: [{ component: "list", bind: { collection: "issues", keyPrefix: "backlog:" } }],
      },
    ]);
    expect(distinctBindings(schema)).toEqual([{ collection: "issues", keyPrefix: "backlog:" }]);
  });

  it("remembers a section by its key, never by where it sits", () => {
    const result = parsePluginPanel(panel([
      { component: "group", title: "In Progress", groupKey: "started", children: [] },
      { component: "group", title: "Done", children: [] },
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [first, second] = result.panel.body;
    expect(first?.component === "group" ? vocabGroupKey(first) : null).toBe("started");
    // No `groupKey` falls back to the title, which is still an identity a
    // republish that inserted a section above it cannot move.
    expect(second?.component === "group" ? vocabGroupKey(second) : null).toBe("Done");
  });

  it("names the children of every container in one place", () => {
    const result = parsePluginPanel(panel([
      { component: "group", title: "G", children: [{ component: "text", text: "a" }] },
      { component: "stack", children: [{ component: "text", text: "b" }] },
      { component: "text", text: "c" },
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.panel.body.map((node) => vocabChildNodes(node).length)).toEqual([1, 1, 0]);
  });
});

/* ── Selection ──────────────────────────────────────────────────────────── */

describe("a selectable list", () => {
  const bulk = { action: "create-lanes", label: "Create lanes" };

  it("parses a selectable and caps its bulk actions", () => {
    const result = parsePluginPanel(panel([{
      component: "list",
      items: [{ title: "bc-1", key: "1" }],
      selectable: {
        stateKey: "issues",
        max: 40,
        actions: [
          bulk,
          { action: "b", label: "B" },
          { action: "c", label: "C" },
          { action: "d", label: "D" },
          { action: "e", label: "E" },
        ],
      },
    }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const list = result.panel.body[0];
    expect(list?.component === "list" ? list.selectable : null).toMatchObject({
      stateKey: "issues",
      max: 40,
    });
    expect(list?.component === "list" ? list.selectable?.actions.length : null)
      .toBe(VOCAB_LIMITS.maxBulkActions);
  });

  it("clamps a declared cap to the ceiling and falls back to it", () => {
    const read = (max: unknown) => {
      const result = parsePluginPanel(panel([{
        component: "list",
        items: [{ title: "t" }],
        selectable: { stateKey: "issues", actions: [bulk], max },
      }]));
      if (!result.ok) return null;
      const list = result.panel.body[0];
      return list?.component === "list" ? list.selectable?.max ?? null : null;
    };
    expect(read(9_000)).toBe(VOCAB_LIMITS.maxSelectedRows);
    expect(read(undefined)).toBe(VOCAB_LIMITS.maxSelectedRows);
    expect(read(0)).toBe(VOCAB_LIMITS.maxSelectedRows);
    expect(read(12)).toBe(12);
  });

  it("a selectable with no usable action is dropped", () => {
    const result = parsePluginPanel(panel([{
      component: "list",
      items: [{ title: "t" }],
      // A tick the reader cannot spend is a checkbox over an empty bar.
      selectable: { stateKey: "issues", actions: [{ action: "go" }] },
    }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const list = result.panel.body[0];
    expect(list?.component).toBe("list");
    expect(list?.component === "list" ? list.selectable : "unset").toBeUndefined();
  });

  it("only two lists in one panel may claim the bar", () => {
    const list = (stateKey: string) => ({
      component: "list",
      items: [{ title: stateKey }],
      selectable: { stateKey, actions: [bulk] },
    });
    const result = parsePluginPanel(panel([
      list("a"),
      { component: "group", title: "G", children: [list("b")] },
      list("c"),
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(collectVocabSelectionDeclarations(result.panel.body).map((entry) => entry.stateKey))
      .toEqual(["a", "b"]);
  });

  it("an over-long item key is refused rather than truncated", () => {
    const long = "x".repeat(VOCAB_LIMITS.maxIdChars + 1);
    const result = parsePluginPanel(panel([{
      component: "list",
      items: [{ title: "kept", key: long }, { title: "keyed", key: "bc-1" }],
    }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const list = result.panel.body[0];
    const items = list?.component === "list" ? list.items ?? [] : [];
    // The row still renders; it simply cannot be ticked, because an identity cut
    // at the ceiling names nothing.
    expect(items[0]).toMatchObject({ title: "kept" });
    expect(items[0]?.key).toBeUndefined();
    expect(items[1]?.key).toBe("bc-1");
  });

  it("a bound list's rows inherit their collection key", () => {
    const row = { title: "bc-1", subtitle: "Fix the login redirect" };
    expect(coerceBoundListItem(row, undefined, "issue-14")?.key).toBe("issue-14");
    // A value that names its own key keeps it: the row is the authority on its
    // own identity when it has said what it is.
    expect(coerceBoundListItem({ ...row, key: "own" }, undefined, "issue-14")?.key).toBe("own");
    expect(coerceBoundListItem(row)?.key).toBeUndefined();
  });
});

/**
 * List paging — the B3 half of D7/M9.
 *
 * The arithmetic and the wording both live in `vocabularyPaging.ts` so four
 * clients cannot disagree about how many rows are on screen or what to call the
 * rest of them, which makes this the one place either can be pinned.
 */
describe("list paging", () => {
  it("draws one page first and says how many of how many", () => {
    const page = vocabListPage(143, 1);
    expect(page.drawn).toBe(VOCAB_LIMITS.listPageSize);
    expect(page.total).toBe(143);
    expect(page.hasMore).toBe(true);
    expect(page.totalIsFloor).toBe(false);
    expect(vocabListPageLabel(page)).toBe("Showing 100 of 143");
  });

  it("extends by exactly one page and stops at the rows it holds", () => {
    const second = vocabListPage(143, 2);
    expect(second.drawn).toBe(143);
    expect(second.hasMore).toBe(false);
    // Nothing left to explain: a list drawing everything it holds says nothing.
    expect(vocabListPageLabel(second)).toBeNull();
    expect(vocabListNextPage(143, 2)).toBe(2);
    expect(vocabListNextPage(143, 1)).toBe(2);
  });

  it("stops claiming a total once the read came back saturated", () => {
    // The client holds as many rows as it may, so the collection may have more
    // and there is no count read to ask. A number here would be a guess dressed
    // as a fact.
    const page = vocabListPage(VOCAB_LIMITS.maxListItems, 1);
    expect(page.totalIsFloor).toBe(true);
    expect(vocabListPageLabel(page)).toBe("Showing 100");
  });

  it("says a list stopped at the ceiling rather than stopping in silence", () => {
    // The half a bigger number alone would not have fixed: a truncated list
    // that says nothing is indistinguishable from a complete one.
    const page = vocabListPage(VOCAB_LIMITS.maxListItems, vocabListPagesToCeiling());
    expect(page.drawn).toBe(VOCAB_LIMITS.maxListItems);
    expect(page.hasMore).toBe(false);
    expect(vocabListPageLabel(page)).toBe(`Showing the first ${VOCAB_LIMITS.maxListItems}`);
  });

  it("never draws past the ceiling however many pages are asked for", () => {
    expect(vocabListPage(10_000, 99).drawn).toBe(VOCAB_LIMITS.maxListItems);
  });

  it("stops offering more once the ceiling is drawn, however many rows are held", () => {
    // A node combining literal `items` with a `bind` holds more rows than the
    // ceiling allows. Offering a "Show more" there would be a control that does
    // nothing, and `vocabListNextPage` would keep growing a number the list
    // cannot spend.
    const pages = vocabListPagesToCeiling();
    const held = VOCAB_LIMITS.maxListItems * 2;
    const page = vocabListPage(held, pages);
    expect(page.drawn).toBe(VOCAB_LIMITS.maxListItems);
    expect(page.hasMore).toBe(false);
    expect(vocabListPageLabel(page)).toBe(`Showing the first ${VOCAB_LIMITS.maxListItems}`);
    expect(vocabListNextPage(held, pages)).toBe(pages);
  });

  it("reads a lost or nonsense page count as the first page", () => {
    expect(vocabListPage(143, 0).drawn).toBe(VOCAB_LIMITS.listPageSize);
    expect(vocabListPage(143, -4).drawn).toBe(VOCAB_LIMITS.listPageSize);
    expect(vocabListPage(-1, 1).drawn).toBe(0);
  });

  it("filters before it pages, so a page never reaches a rejected row", () => {
    // The ordering rule every client shares. `boundRowEntries` has already run
    // the `where` by the time a page is computed, so the count the reader is
    // shown is a count of rows they can actually see.
    const rows = Array.from({ length: 200 }, (_, index) => ({
      key: `k${index}`,
      value: { title: `row ${index}`, status: index < 30 ? "open" : "closed" },
    }));
    const kept = boundRowEntries(
      {
        collection: "issues",
        where: [{ kind: "compare", op: "in", field: "status", stateKey: "status" }],
      },
      rows,
      { status: "open" },
    );
    expect(kept).toHaveLength(30);
    const page = vocabListPage(kept?.length ?? 0, 1);
    expect(page.drawn).toBe(30);
    expect(page.hasMore).toBe(false);
    expect(vocabListPageLabel(page)).toBeNull();
  });

  it("keys a list by what it reads, never by where it sits", () => {
    // Same reason `vocabGroupKey` is content-derived: a plugin republishing its
    // panel with one more node above the list has not put the reader back on
    // page one.
    const bound = vocabListPage(1, 1);
    expect(bound).toBeDefined();
    expect(vocabListKey({ component: "list", bind: { collection: "issues" } }))
      .toBe(vocabListKey({ component: "list", bind: { collection: "issues" } }));
    expect(vocabListKey({ component: "list", bind: { collection: "issues", keyPrefix: "ade/" } }))
      .not.toBe(vocabListKey({ component: "list", bind: { collection: "issues" } }));
    expect(vocabListKey({
      component: "list",
      selectable: { stateKey: "picked", actions: [], max: VOCAB_LIMITS.maxSelectedRows },
    })).toBe("sel:picked");
    expect(vocabListKey({ component: "list", items: [{ title: "One", key: "a" }] }))
      .toBe("items:a");
  });

  it("reads a bound collection up to the same ceiling a list may draw", () => {
    // A client that drew the ceiling but fetched the host default of 200 would
    // page into rows it does not have and stop early with nothing on screen to
    // say why.
    expect(VOCAB_PANEL_READ_LIMIT).toBe(VOCAB_LIMITS.maxListItems);
  });

  it("parses a row preview without counting it as a body node", () => {
    const result = parsePluginPanel(panel([{
      component: "list",
      items: [{
        title: "ISS-1",
        preview: { title: "Login fails", text: "Assigned to you" },
      }],
    }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const node = result.panel.body[0];
    expect(node).toMatchObject({
      component: "list",
      items: [{ title: "ISS-1", preview: { title: "Login fails", text: "Assigned to you" } }],
    });
    expect(countVocabNodes(result.panel.body)).toBe(1);
  });

  it("parses list-row markdown without counting it as a body node", () => {
    const result = parsePluginPanel(panel([{
      component: "list",
      items: [{
        title: "kai",
        markdown: "The fix is in `sessionRedirect.ts`.",
      }],
    }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const list = result.panel.body[0];
    if (list.component !== "list") throw new Error("expected a list");
    expect(list.items?.[0]).toMatchObject({
      title: "kai",
      markdown: "The fix is in `sessionRedirect.ts`.",
    });
    expect(countVocabNodes(result.panel.body)).toBe(1);
  });
});

describe("panel chrome", () => {
  it("parses search, nav actions, a footer, and a group icon", () => {
    const result = parsePluginPanel(panel(
      [{ component: "list", bind: { collection: "issues", where: [{ field: "title", contains: { $state: "q" } }] } }],
      {
        chrome: {
          search: { stateKey: "q", placeholder: "Filter issues", onChange: { action: "search" } },
          navActions: [{ action: "openLinear", label: "Open in Linear", icon: "arrow-square-out" }],
          footer: [{ component: "button", label: "New issue", onPress: { action: "create" } }],
        },
      },
    ));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
    expect(result.panel.chrome).toEqual({
      search: { stateKey: "q", placeholder: "Filter issues", onChange: { action: "search" } },
      navActions: [{ action: "openLinear", label: "Open in Linear", icon: "arrow-square-out" }],
      footer: [{ component: "button", label: "New issue", onPress: { action: "create" } }],
    });
    const group = parsePluginPanel(panel([{ component: "group", title: "Started", icon: "circle", children: [] }]));
    expect(group.ok).toBe(true);
    if (!group.ok) return;
    expect(group.panel.body[0]).toMatchObject({ component: "group", title: "Started", icon: "circle" });
  });

  it("declares search first and walks the footer for bindings", () => {
    const result = parsePluginPanel(panel(
      [{
        component: "segmented",
        stateKey: "status",
        options: [{ value: "", label: "All" }, { value: "active", label: "Active" }],
      }],
      {
        chrome: {
          search: { stateKey: "q" },
          footer: [{ component: "list", bind: { collection: "drafts" } }],
        },
      },
    ));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(collectVocabStateDeclarations(
      vocabPanelContentNodes(result.panel),
      undefined,
      result.panel.chrome,
    ).map((entry) => entry.stateKey)).toEqual(["q", "status"]);
    expect(distinctBindings(panel(
      [{ component: "text", text: "body" }],
      { chrome: { footer: [{ component: "list", bind: { collection: "drafts" } }] } },
    ))).toEqual([{ collection: "drafts" }]);
  });

  it("omits malformed chrome pieces and extra nav/footer entries, without failing the panel", () => {
    const result = parsePluginPanel(panel([], {
      chrome: {
        search: { placeholder: "no key" },
        navActions: [
          { action: "a", label: "One" },
          { action: "b", label: "Two" },
          { action: "c", label: "Three" },
          { action: "d", label: "Four" },
          { action: "e", label: "Five" },
          { label: "no action" },
        ],
        footer: "not-an-array",
      },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.panel.chrome?.search).toBeUndefined();
    expect(result.panel.chrome?.navActions).toHaveLength(VOCAB_LIMITS.maxChromeNavActions);
    expect(result.panel.chrome?.footer).toBeUndefined();
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
