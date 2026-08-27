import { describe, expect, it } from "vitest";

import {
  EMPTY_VOCAB_PANEL_STATE,
  VOCAB_STATE_COLLECTION,
  VOCAB_STATE_LIMITS,
  evaluateVocabWhere,
  filterVocabRows,
  parseVocabSegmentedStyle,
  parseVocabStateKey,
  parseVocabStateOptions,
  parseVocabWhere,
  readPluginActionResetState,
  vocabApplyStateChange,
  vocabCycleStateValue,
  vocabInitialPanelState,
  vocabNormalizePanelState,
  vocabPredicateFieldText,
  vocabResetPanelState,
  vocabStateBadgeText,
  vocabStateDeclarations,
  vocabStateInitial,
  vocabStatePayload,
  vocabStateRows,
  vocabStateSignature,
  vocabWhereStateKeys,
  type VocabPanelState,
  type VocabStateDeclaration,
} from "./vocabularyState";
import { boundRowValues } from "./vocabularyNodes";

/**
 * The evaluator's own table.
 *
 * Four clients read this module — desktop and the web client directly, the TUI
 * through `boundRowValues`, and iOS through a Swift transcription — so a case
 * that is wrong here is wrong on every surface at once. The names mirror the
 * TUI's (`apps/ade-cli/src/tuiClient/__tests__/pluginPane.test.ts`) and the
 * phone's (`PluginVocabPanelStateTests`) wherever the same rule is under test,
 * so the three suites can be read side by side and a gap in one is visible.
 */

/** The fleet every filter case runs against. Five rows, three status groups. */
const FLEET = [
  { title: "bc-1f4a", statusGroup: "active", archivedGroup: "live" },
  { title: "bc-90de", statusGroup: "active", archivedGroup: "live" },
  { title: "bc-77b2", statusGroup: "failed", archivedGroup: "live" },
  { title: "bc-3ac1", statusGroup: "finished", archivedGroup: "live" },
  { title: "bc-0092", statusGroup: "finished", archivedGroup: "archived" },
];

/** Parse a `where` and keep the warnings, the way `parseBinding` does. */
function parseWhere(raw: unknown): { where: ReturnType<typeof parseVocabWhere>; warnings: string[] } {
  const warnings: string[] = [];
  const where = parseVocabWhere(raw, (message) => warnings.push(message));
  return { where, warnings };
}

/** The titles a `where` keeps out of {@link FLEET}. */
function kept(raw: unknown, state: VocabPanelState = {}): string[] {
  const { where } = parseWhere(raw);
  return filterVocabRows(where, FLEET, state).map((row) => (row as { title: string }).title);
}

const STATUS_OPTIONS = [
  { value: "", label: "All" },
  { value: "active", label: "Active" },
  { value: "failed", label: "Failed" },
];

function control(overrides: Partial<VocabStateDeclaration> = {}): VocabStateDeclaration {
  return { stateKey: "statusFilter", options: STATUS_OPTIONS, initial: "", ...overrides };
}

/* ── The grammar ────────────────────────────────────────────────────────── */

describe("parseVocabWhere", () => {
  it("folds equality into membership and reads a state reference as its own operand", () => {
    const { where, warnings } = parseWhere([
      { field: "statusGroup", equals: "active" },
      { field: "statusGroup", notEquals: ["failed", "failed"] },
      { field: "statusGroup", in: "active" },
      { field: "statusGroup", equals: { $state: "statusFilter" } },
    ]);

    expect(warnings).toEqual([]);
    // `equals` and `in` are one operation, so they parse to one shape — a folded
    // path cannot drift from itself. A repeated literal is one literal.
    expect(where).toEqual([
      { kind: "compare", op: "in", field: "statusGroup", values: ["active"] },
      { kind: "compare", op: "notIn", field: "statusGroup", values: ["failed"] },
      { kind: "compare", op: "in", field: "statusGroup", values: ["active"] },
      { kind: "compare", op: "in", field: "statusGroup", stateKey: "statusFilter" },
    ]);
  });

  it("drops a clause with no operator or with two of them, and warns", () => {
    const none = parseWhere([{ field: "statusGroup" }]);
    expect(none.where).toBeUndefined();
    expect(none.warnings).toHaveLength(1);

    const both = parseWhere([{ field: "statusGroup", equals: "a", in: ["b"] }]);
    expect(both.where).toBeUndefined();
    expect(both.warnings[0]).toContain("only one operator");

    // A comparison with no `field`, and a clause that is not an object at all.
    expect(parseWhere([{ equals: "a" }]).where).toBeUndefined();
    expect(parseWhere(["not a clause"]).where).toBeUndefined();
    // An operand with no usable literal in it is not a filter either.
    expect(parseWhere([{ field: "statusGroup", in: [{ nested: true }] }]).where).toBeUndefined();
  });

  it("keeps the clauses that parsed when one of them does not", () => {
    const { where, warnings } = parseWhere([
      { field: "statusGroup", equals: "active" },
      { field: "statusGroup" },
    ]);
    expect(where).toHaveLength(1);
    expect(warnings).toHaveLength(1);
  });

  it("reads a bare clause as the one-clause list it means", () => {
    expect(parseWhere({ field: "statusGroup", equals: "active" }).where).toHaveLength(1);
    // Absent stays absent: `undefined`, never `[]`, so an unfiltered binding and
    // a binding whose filter was all garbage are the same thing to every caller.
    expect(parseVocabWhere(undefined)).toBeUndefined();
  });

  it("refuses a clause nested past the depth limit and keeps the ceiling itself usable", () => {
    // and → or → not → comparison is depth four.
    const deep = parseWhere([{ and: [{ or: [{ not: { field: "statusGroup", equals: "active" } }] }] }]);
    expect(deep.where).toBeUndefined();
    expect(deep.warnings.join(" ")).toContain(`nest at most ${VOCAB_STATE_LIMITS.maxWhereDepth}`);

    // Depth three is the ceiling, and it parses.
    const ok = parseWhere([{ and: [{ not: { field: "statusGroup", equals: "active" } }] }]);
    expect(ok.where).toHaveLength(1);
    expect(ok.warnings).toEqual([]);
  });

  it("refuses a `where` over the node budget", () => {
    const clause = { field: "statusGroup", equals: "active" };
    // One `or` plus 24 children is 25 nodes against a budget of 24.
    const { where, warnings } = parseWhere([
      { or: Array.from({ length: VOCAB_STATE_LIMITS.maxWhereNodes }, () => clause) },
    ]);
    expect(warnings.join(" ")).toContain(`at most ${VOCAB_STATE_LIMITS.maxWhereNodes} clauses`);
    // The clauses that fit still stand: the budget trims, it does not detonate.
    expect(where?.[0]?.kind).toBe("or");
  });

  it("caps the top-level clauses and the literals in one list", () => {
    const many = parseWhere(
      Array.from({ length: VOCAB_STATE_LIMITS.maxWhereClauses + 3 }, () => ({
        field: "statusGroup",
        equals: "active",
      })),
    );
    expect(many.where).toHaveLength(VOCAB_STATE_LIMITS.maxWhereClauses);

    const values = Array.from({ length: VOCAB_STATE_LIMITS.maxWhereValues + 5 }, (_, index) => `v${index}`);
    const { where } = parseWhere([{ field: "statusGroup", in: values }]);
    const first = where?.[0];
    expect(first?.kind === "compare" && first.values).toHaveLength(VOCAB_STATE_LIMITS.maxWhereValues);
  });

  it("names the state keys a filter reads, so a host can warn about one nothing declares", () => {
    const { where } = parseWhere([
      {
        and: [
          { field: "a", equals: { $state: "first" } },
          { not: { field: "b", equals: { $state: "second" } } },
          { field: "c", equals: "literal" },
        ],
      },
      { or: [{ field: "d", equals: { $state: "first" } }] },
    ]);
    expect(vocabWhereStateKeys(where).sort()).toEqual(["first", "second"]);
    expect(vocabWhereStateKeys(undefined)).toEqual([]);
  });
});

/* ── Evaluation ─────────────────────────────────────────────────────────── */

describe("evaluateVocabWhere", () => {
  it("keeps the rows a literal filter names", () => {
    expect(kept([{ field: "statusGroup", in: ["failed", "finished"] }]))
      .toEqual(["bc-77b2", "bc-3ac1", "bc-0092"]);
    expect(kept([{ field: "archivedGroup", notIn: ["archived"] }]))
      .toEqual(["bc-1f4a", "bc-90de", "bc-77b2", "bc-3ac1"]);
    // Two top-level clauses are ANDed.
    expect(kept([
      { field: "statusGroup", equals: "finished" },
      { field: "archivedGroup", equals: "live" },
    ])).toEqual(["bc-3ac1"]);
  });

  it("follows the reader's selection through a `$state` operand", () => {
    const clause = [{ field: "statusGroup", equals: { $state: "statusFilter" } }];
    expect(kept(clause, { statusFilter: "active" })).toEqual(["bc-1f4a", "bc-90de"]);
    expect(kept(clause, { statusFilter: "failed" })).toEqual(["bc-77b2"]);
  });

  it("treats an unset or undeclared state key as inactive, not as false", () => {
    const clause = [{ field: "statusGroup", equals: { $state: "statusFilter" } }];
    // "All" is the empty value. Inactive, so every row survives — this is what
    // lets one closed option list express "turn this filter off".
    expect(kept(clause, { statusFilter: "" })).toHaveLength(5);
    // A key no `segmented` declared reads the same way: a typo must not hide the
    // whole list, which is the worst reading of either.
    expect(kept(clause, {})).toHaveLength(5);
    expect(kept(clause)).toHaveLength(5);
  });

  it("removes an inactive clause from its composer rather than counting it", () => {
    // `and`: the inactive half drops out and the active half still decides.
    expect(kept([
      {
        and: [
          { field: "statusGroup", equals: { $state: "unset" } },
          { field: "archivedGroup", equals: "archived" },
        ],
      },
    ])).toEqual(["bc-0092"]);

    // `or`: same, and an `or` whose only active clause is false still filters.
    expect(kept([
      {
        or: [
          { field: "statusGroup", equals: { $state: "unset" } },
          { field: "statusGroup", equals: "failed" },
        ],
      },
    ])).toEqual(["bc-77b2"]);

    // A composer with nothing active at all is itself inactive.
    expect(kept([
      {
        and: [
          { field: "statusGroup", equals: { $state: "unset" } },
          { field: "archivedGroup", equals: { $state: "alsoUnset" } },
        ],
      },
    ])).toHaveLength(5);
  });

  it("reads a `not` of an inactive clause as inactive, never as true", () => {
    // Negating "this filter is off" must not start filtering.
    expect(kept([{ not: { field: "statusGroup", equals: { $state: "unset" } } }])).toHaveLength(5);
    expect(kept([{ not: { field: "statusGroup", equals: "active" } }]))
      .toEqual(["bc-77b2", "bc-3ac1", "bc-0092"]);
  });

  it("evaluates composed clauses as they read", () => {
    expect(kept([
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
    ])).toEqual(["bc-77b2", "bc-3ac1"]);
  });

  it("compares a field as its JSON words, and matches nothing against an object", () => {
    const rows = [
      { id: "a", archived: false, count: 3 },
      { id: "b", archived: true, count: 4 },
      { id: "c", nested: { deep: 1 } },
      { id: "d", spaced: "  padded  " },
    ];
    const ids = (raw: unknown, state: VocabPanelState = {}) =>
      filterVocabRows(parseWhere(raw).where, rows, state).map((row) => (row as { id: string }).id);

    // A plugin writing `archived: false` and filtering on `"false"` must match:
    // this is the PREDICATE coercion, not the display one that says "No".
    expect(ids([{ field: "archived", equals: false }])).toEqual(["a"]);
    expect(ids([{ field: "archived", equals: "true" }])).toEqual(["b"]);
    expect(ids([{ field: "count", equals: 3 }])).toEqual(["a"]);
    expect(ids([{ field: "count", equals: "4" }])).toEqual(["b"]);
    // An object or an array has no text form a plugin could have meant.
    expect(ids([{ field: "nested", equals: "deep" }])).toEqual([]);
    // Both sides are trimmed, so a padded row and a padded literal still meet.
    expect(ids([{ field: "spaced", equals: "padded" }])).toEqual(["d"]);
  });

  it("drops a row that is not an object only when a clause is actually comparing", () => {
    const rows = ["not a row", { statusGroup: "active" }];
    const active = filterVocabRows(
      parseWhere([{ field: "statusGroup", equals: "active" }]).where,
      rows,
      {},
    );
    expect(active).toEqual([{ statusGroup: "active" }]);

    // With nothing active, an unfiltered binding keeps everything it was given —
    // including the row it could not have answered a comparison about.
    const inactive = filterVocabRows(
      parseWhere([{ field: "statusGroup", equals: { $state: "unset" } }]).where,
      rows,
      {},
    );
    expect(inactive).toEqual(rows);
  });

  it("answers true for a binding with no filter at all", () => {
    expect(evaluateVocabWhere(undefined, FLEET[0], {})).toBe(true);
    expect(evaluateVocabWhere([], "not a row", {})).toBe(true);
    expect(filterVocabRows(undefined, FLEET, {})).toEqual(FLEET);
  });
});

/* ── Filter, then cap ───────────────────────────────────────────────────── */

describe("filterVocabRows and boundRowValues", () => {
  it("filters before it caps, so a limited list is not a filtered window", () => {
    const rows = FLEET.map((value) => ({ value }));
    const where = parseWhere([{ field: "statusGroup", equals: { $state: "statusFilter" } }]).where;
    const binding = { collection: "agents", limit: 2, ...(where ? { where } : {}) };

    // The two finished agents sit fourth and fifth. Capping first would have
    // filtered a two-row window and reported that nothing finished.
    const finished = boundRowValues(binding, rows, { statusFilter: "finished" });
    expect((finished as { title: string }[]).map((row) => row.title)).toEqual(["bc-3ac1", "bc-0092"]);

    // The cap still applies to what survived the filter.
    const active = boundRowValues({ ...binding, limit: 1 }, rows, { statusFilter: "active" });
    expect((active as { title: string }[]).map((row) => row.title)).toEqual(["bc-1f4a"]);
  });

  it("keeps the rows in the order the plugin wrote them", () => {
    const where = parseWhere([{ field: "archivedGroup", equals: "live" }]).where;
    expect(filterVocabRows(where, FLEET, {}).map((row) => (row as { title: string }).title))
      .toEqual(["bc-1f4a", "bc-90de", "bc-77b2", "bc-3ac1"]);
  });

  it("tells a fetch that has not landed from one that came back empty", () => {
    // `null`, not `[]`, so a component shows its `emptyText` only for the second.
    expect(boundRowValues({ collection: "agents" }, undefined)).toBeNull();
    expect(boundRowValues(undefined, [])).toBeNull();
    expect(boundRowValues({ collection: "agents" }, [])).toEqual([]);
  });
});

/* ── The control's own readers ──────────────────────────────────────────── */

describe("segmented declarations", () => {
  it("collapses duplicate option values and falls back to the value as a label", () => {
    const options = parseVocabStateOptions([
      { value: "", label: "All", badge: 5 },
      { value: "active", label: "Active" },
      { value: "active", label: "A duplicate nobody can reach" },
      { value: "failed" },
      { value: "" },
      "not an option",
      { label: "no value" },
    ]);

    expect(options.map((option) => option.value)).toEqual(["", "active", "failed"]);
    expect(options.map((option) => option.label)).toEqual(["All", "Active", "failed"]);
    // A badge is almost always a count, and a plugin that writes `5` means "5".
    expect(options[0]?.badge).toBe("5");
    expect(options[1]?.badge).toBeUndefined();
  });

  it("caps the option list", () => {
    const many = Array.from({ length: VOCAB_STATE_LIMITS.maxStateOptions + 4 }, (_, index) => ({
      value: `v${index}`,
      label: `V${index}`,
    }));
    expect(parseVocabStateOptions(many)).toHaveLength(VOCAB_STATE_LIMITS.maxStateOptions);
    expect(parseVocabStateOptions("not a list")).toEqual([]);
  });

  it("refuses a state key that would shadow a reserved collection", () => {
    expect(parseVocabStateKey("statusFilter")).toBe("statusFilter");
    expect(parseVocabStateKey("  padded  ")).toBe("padded");
    expect(parseVocabStateKey("$state")).toBeUndefined();
    expect(parseVocabStateKey("")).toBeUndefined();
    expect(parseVocabStateKey(12)).toBeUndefined();
  });

  it("draws a mislabelled toggle as the segmented control it is", () => {
    expect(parseVocabSegmentedStyle("toggle", 2)).toBe("toggle");
    // Drawing three options as a switch would hide one, so the declaration loses.
    expect(parseVocabSegmentedStyle("toggle", 3)).toBe("segmented");
    expect(parseVocabSegmentedStyle("segmented", 4)).toBe("segmented");
    expect(parseVocabSegmentedStyle("switch", 2)).toBeUndefined();
  });

  it("always has something selected, even when that something is the empty All", () => {
    expect(vocabStateInitial(STATUS_OPTIONS, "active")).toBe("active");
    expect(vocabStateInitial(STATUS_OPTIONS, "")).toBe("");
    // A default naming no option falls back to the first one rather than to
    // nothing, so no client has to invent "nothing selected".
    expect(vocabStateInitial(STATUS_OPTIONS, "invented")).toBe("");
    expect(vocabStateInitial(STATUS_OPTIONS, undefined)).toBe("");
    expect(vocabStateInitial([], "anything")).toBe("");
  });

  it("reads a badge that is a number and refuses one that is neither", () => {
    expect(vocabStateBadgeText("12")).toBe("12");
    expect(vocabStateBadgeText(12)).toBe("12");
    expect(vocabStateBadgeText(0)).toBe("0");
    expect(vocabStateBadgeText(Number.NaN)).toBeUndefined();
    expect(vocabStateBadgeText({})).toBeUndefined();
  });

  it("keeps the first declaration of a key and caps how many share a filter", () => {
    const found = [
      control({ stateKey: "a", initial: "first" }),
      control({ stateKey: "a", initial: "second" }),
      control({ stateKey: "b" }),
      control({ stateKey: "c" }),
      control({ stateKey: "d" }),
      control({ stateKey: "e" }),
    ];
    const declarations = vocabStateDeclarations(found);

    // First rather than last: it is the control highest on the page, and its
    // default is the one a reader assumes is in force.
    expect(declarations.map((entry) => entry.stateKey)).toEqual(["a", "b", "c", "d"]);
    expect(declarations[0]?.initial).toBe("first");
    expect(declarations).toHaveLength(VOCAB_STATE_LIMITS.maxStateKeys);
  });
});

/* ── Lifecycle ──────────────────────────────────────────────────────────── */

describe("panel state lifecycle", () => {
  const declarations = [control(), control({ stateKey: "archived", initial: "live", options: [
    { value: "live", label: "Hidden" },
    { value: "", label: "Shown" },
  ] })];

  it("opens every control on its declared default", () => {
    expect(vocabInitialPanelState(declarations)).toEqual({ statusFilter: "", archived: "live" });
    expect(vocabInitialPanelState([])).toEqual({});
    expect(EMPTY_VOCAB_PANEL_STATE).toEqual({});
  });

  it("signs the controls and not the data", () => {
    const signature = vocabStateSignature(declarations);

    // Same keys, same option values, different labels and badges: the panel
    // republished its counts, and the reader's selection must survive that.
    const relabelled = [
      control({ options: [
        { value: "", label: "Everything", badge: "9" },
        { value: "active", label: "Running" },
        { value: "failed", label: "Failed" },
      ] }),
      declarations[1] as VocabStateDeclaration,
    ];
    expect(vocabStateSignature(relabelled)).toBe(signature);

    // An option that no longer exists, a different default, a control that
    // vanished, or two controls in the other order are all new controls.
    expect(vocabStateSignature([control({ options: STATUS_OPTIONS.slice(0, 2) }), declarations[1] as VocabStateDeclaration]))
      .not.toBe(signature);
    expect(vocabStateSignature([control({ initial: "active" }), declarations[1] as VocabStateDeclaration]))
      .not.toBe(signature);
    expect(vocabStateSignature([control()])).not.toBe(signature);
    expect(vocabStateSignature([declarations[1] as VocabStateDeclaration, control()])).not.toBe(signature);
  });

  it("carries a selection across a republish and reconciles one the controls no longer offer", () => {
    // Still an option: kept.
    expect(vocabNormalizePanelState({ statusFilter: "failed", archived: "live" }, declarations))
      .toEqual({ statusFilter: "failed", archived: "live" });
    // No longer an option: back to that control's own default, not to nothing.
    expect(vocabNormalizePanelState({ statusFilter: "vanished", archived: "live" }, declarations))
      .toEqual({ statusFilter: "", archived: "live" });
    // A key the new schema does not declare goes away; a key it declares and the
    // old state never had arrives at its default.
    expect(vocabNormalizePanelState({ statusFilter: "active", gone: "x" }, declarations))
      .toEqual({ statusFilter: "active", archived: "live" });
    expect(vocabNormalizePanelState(undefined, declarations))
      .toEqual({ statusFilter: "", archived: "live" });
  });

  it("refuses a value the reader was never offered", () => {
    const state: VocabPanelState = { statusFilter: "" };
    expect(vocabApplyStateChange(state, control(), "active")).toEqual({ statusFilter: "active" });
    expect(vocabApplyStateChange(state, control(), "invented")).toBe(state);
    // Setting the value it already holds is not a change, and returns the same
    // object so a caller can skip the re-render.
    expect(vocabApplyStateChange(state, control(), "")).toBe(state);
  });

  it("cycles through the options, wrapping in both directions", () => {
    expect(vocabCycleStateValue(control(), "", 1)).toBe("active");
    expect(vocabCycleStateValue(control(), "failed", 1)).toBe("");
    expect(vocabCycleStateValue(control(), "", -1)).toBe("failed");
    // A value the control does not hold starts from the first option.
    expect(vocabCycleStateValue(control(), "invented", 1)).toBe("active");
    expect(vocabCycleStateValue(control({ options: [] }), "x", 1)).toBe("x");
  });
});

/* ── `$state` and the plugin-facing verbs ───────────────────────────────── */

describe("$state and what reaches the plugin", () => {
  const declarations = [
    control({ label: "Status", initial: "active" }),
    control({ stateKey: "archived", options: [
      { value: "live", label: "Hidden" },
      { value: "", label: "Shown" },
    ], initial: "live" }),
  ];

  it("reads the panel's own state back as rows carrying the chosen option's label", () => {
    // The OPTION'S LABEL, not the raw value: a reader wants "Status: Active",
    // and "Status: active" is the machine's half of the same fact.
    expect(vocabStateRows(declarations, { statusFilter: "active", archived: "" })).toEqual([
      { key: "Status", value: "Active" },
      { key: "archived", value: "Shown" },
    ]);
    // With nothing selected yet, each control reports its own initial.
    expect(vocabStateRows(declarations, {})).toEqual([
      { key: "Status", value: "Active" },
      { key: "archived", value: "Hidden" },
    ]);
    expect(VOCAB_STATE_COLLECTION).toBe("$state");
  });

  it("reports the reader's selections as an action's `state` payload", () => {
    expect(vocabStatePayload({ statusFilter: "active" })).toEqual({ statusFilter: "active" });
    // A panel with no controls sends nothing rather than an empty object, so a
    // plugin can tell "no filter" from "a filter set to nothing".
    expect(vocabStatePayload({})).toBeNull();
    expect(vocabStatePayload(undefined)).toBeNull();
  });

  it("reads a `{resetState}` in both shapes and ignores everything else", () => {
    expect(readPluginActionResetState({ resetState: true })).toBe("all");
    expect(readPluginActionResetState({ resetState: ["statusFilter", "statusFilter", "archived"] }))
      .toEqual(["statusFilter", "archived"]);
    // `false`, an empty list, a key that is not one, and nothing at all all mean
    // "the action said nothing about state" — which is almost every action.
    expect(readPluginActionResetState({ resetState: false })).toBeNull();
    expect(readPluginActionResetState({ resetState: [] })).toBeNull();
    expect(readPluginActionResetState({ resetState: ["$state"] })).toBeNull();
    expect(readPluginActionResetState({ message: "done" })).toBeNull();
    expect(readPluginActionResetState(null)).toBeNull();
    expect(readPluginActionResetState("true")).toBeNull();
  });

  it("puts the reader back on a filter an action reset", () => {
    const chosen: VocabPanelState = { statusFilter: "failed", archived: "" };

    expect(vocabResetPanelState(chosen, declarations, "all"))
      .toEqual({ statusFilter: "active", archived: "live" });
    expect(vocabResetPanelState(chosen, declarations, ["statusFilter"]))
      .toEqual({ statusFilter: "active", archived: "" });
    // A key nothing declares changes nothing.
    expect(vocabResetPanelState(chosen, declarations, ["nobodyDeclaredThis"])).toEqual(chosen);
  });
});

/* ── The coercion both halves share ─────────────────────────────────────── */

describe("vocabPredicateFieldText", () => {
  it("gives a plugin back the words it wrote, and nothing for a shape it did not", () => {
    expect(vocabPredicateFieldText("  active  ")).toBe("active");
    expect(vocabPredicateFieldText(3)).toBe("3");
    expect(vocabPredicateFieldText(3.5)).toBe("3.5");
    expect(vocabPredicateFieldText(true)).toBe("true");
    expect(vocabPredicateFieldText(false)).toBe("false");
    // Not "Yes" — that is the DISPLAY coercion, and it would be the wrong
    // operand for a plugin filtering on what it stored.
    expect(vocabPredicateFieldText(Number.NaN)).toBe("");
    expect(vocabPredicateFieldText(null)).toBe("");
    expect(vocabPredicateFieldText(undefined)).toBe("");
    expect(vocabPredicateFieldText({ a: 1 })).toBe("");
    expect(vocabPredicateFieldText([1, 2])).toBe("");
  });
});
