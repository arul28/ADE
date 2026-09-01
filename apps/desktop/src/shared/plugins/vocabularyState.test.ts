import { describe, expect, it } from "vitest";

import {
  EMPTY_VOCAB_PANEL_SELECTION,
  EMPTY_VOCAB_PANEL_STATE,
  VOCAB_STATE_COLLECTION,
  VOCAB_STATE_LIMITS,
  evaluateVocabWhere,
  filterVocabRows,
  parseVocabSegmentedStyle,
  parseVocabStateKey,
  parseVocabStateOptions,
  parseVocabStateOptionsBinding,
  parseVocabWhere,
  readPluginActionResetState,
  vocabApplyStateChange,
  vocabClearRowSelection,
  vocabCycleStateValue,
  vocabInitialPanelSelection,
  vocabInitialPanelState,
  vocabIsSearchDeclaration,
  vocabMergeStateOptions,
  vocabNormalizePanelSelection,
  vocabNormalizePanelState,
  vocabPredicateFieldText,
  vocabResetPanelSelection,
  vocabResetPanelState,
  vocabResolveStateOptions,
  vocabRowRange,
  vocabSelectRowRange,
  vocabSelectedRowKeys,
  vocabSelectionDeclarations,
  vocabSelectionSignature,
  vocabStateBadgeText,
  vocabStateControlStyle,
  vocabStateDeclarations,
  vocabStateInitial,
  vocabStatePayload,
  vocabStateRows,
  vocabStateSignature,
  vocabToggleRowSelection,
  vocabWhereStateKeys,
  type VocabPanelSelection,
  type VocabPanelState,
  type VocabSelectionDeclaration,
  type VocabStateDeclaration,
  type VocabStateOption,
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

  it("reads `contains` as its own clause, never as membership", () => {
    const { where, warnings } = parseWhere([
      { field: "title", contains: "bc-" },
      { field: "title", contains: { $state: "q" } },
    ]);
    expect(warnings).toEqual([]);
    expect(where).toEqual([
      { kind: "contains", field: "title", needle: "bc-" },
      { kind: "contains", field: "title", stateKey: "q" },
    ]);
    expect(vocabWhereStateKeys(where).sort()).toEqual(["q"]);
    // An empty literal is not a needle — parse drops it, evaluation would have
    // treated it as inactive anyway.
    expect(parseWhere([{ field: "title", contains: "" }]).where).toBeUndefined();
    // Two operators on one clause still drop it.
    expect(parseWhere([{ field: "title", contains: "a", equals: "b" }]).where).toBeUndefined();
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

  it("matches `contains` case-insensitively and treats an empty needle as inactive", () => {
    expect(kept([{ field: "title", contains: "BC-77" }])).toEqual(["bc-77b2"]);
    expect(kept([{ field: "title", contains: { $state: "q" } }], { q: "1f4A" }))
      .toEqual(["bc-1f4a"]);
    // Empty query — typed, whitespace, or missing — is "this filter is off".
    expect(kept([{ field: "title", contains: { $state: "q" } }], { q: "" })).toHaveLength(5);
    expect(kept([{ field: "title", contains: { $state: "q" } }], { q: "   " })).toHaveLength(5);
    expect(kept([{ field: "title", contains: { $state: "q" } }], {})).toHaveLength(5);
    expect(kept([{ field: "title", contains: "" }])).toHaveLength(5);
    // A missing field fails the comparison, the same as `equals`.
    expect(kept([{ field: "missing", contains: "bc" }])).toEqual([]);
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

/* ── Time ───────────────────────────────────────────────────────────────── */

/**
 * The clock is a PARAMETER, never a `Date.now()` buried in the loop, so every
 * case below pins the instant instead of sleeping. `NOW` is noon UTC on a
 * Friday; the rows sit at readable distances from it.
 */
const NOW = Date.parse("2026-08-28T12:00:00.000Z");

const NOTES = [
  { id: "now", ts: "2026-08-28T12:00:00.000Z" },
  { id: "hour", ts: "2026-08-28T11:00:00.000Z" },
  { id: "epoch", ts: Date.parse("2026-08-28T10:00:00.000Z") },
  { id: "yesterday", ts: "2026-08-27T09:00:00.000Z" },
  { id: "week", ts: "2026-08-23T09:00:00.000Z" },
  { id: "unreadable", ts: "yesterday" },
  { id: "absent" },
];

/** The ids a time filter keeps, evaluated against a clock the test owns. */
function keptAt(raw: unknown, now: number, state: VocabPanelState = {}): string[] {
  const { where } = parseWhere(raw);
  return filterVocabRows(where, NOTES, state, now).map((row) => (row as { id: string }).id);
}

describe("since and before", () => {
  it("reads an ISO-8601 operand, epoch milliseconds and a `$rel` offset", () => {
    const { where, warnings } = parseWhere([
      { field: "ts", since: "2026-08-28T00:00:00.000Z" },
      { field: "ts", before: 1_756_000_000_000 },
      { field: "ts", since: { $rel: "-24h" } },
      { field: "ts", before: { $rel: "+1h" } },
      { field: "ts", since: "2026-08-28" },
    ]);
    expect(warnings).toEqual([]);
    // Only `maxWhereClauses` top-level clauses are read; the fifth is the cap,
    // not a rejection, so it raises no warning.
    expect(where).toHaveLength(VOCAB_STATE_LIMITS.maxWhereClauses);
    expect(where?.[0]).toEqual({
      kind: "time",
      op: "since",
      field: "ts",
      at: Date.parse("2026-08-28T00:00:00.000Z"),
    });
    expect(where?.[1]).toEqual({ kind: "time", op: "before", field: "ts", at: 1_756_000_000_000 });
    // A `$rel` is stored as an OFFSET, resolved at evaluation against the clock.
    expect(where?.[2]).toEqual({ kind: "time", op: "since", field: "ts", relMs: -86_400_000 });
    // A positive offset is legal: "before +1h" is a real "due soon" filter.
    expect(where?.[3]).toEqual({ kind: "time", op: "before", field: "ts", relMs: 3_600_000 });

    // A bare date reads as UTC midnight on every client, which is the whole
    // reason the reader is narrower than `Date.parse`.
    const dateOnly = parseWhere([{ field: "ts", since: "2026-08-28" }]).where?.[0];
    expect(dateOnly).toEqual({
      kind: "time",
      op: "since",
      field: "ts",
      at: Date.parse("2026-08-28T00:00:00.000Z"),
    });
  });

  it("resolves a `$rel` operand against the clock it is handed", () => {
    expect(keptAt([{ field: "ts", since: { $rel: "-24h" } }], NOW))
      .toEqual(["now", "hour", "epoch"]);
    expect(keptAt([{ field: "ts", since: { $rel: "-30m" } }], NOW)).toEqual(["now"]);
    expect(keptAt([{ field: "ts", since: { $rel: "-7d" } }], NOW))
      .toEqual(["now", "hour", "epoch", "yesterday", "week"]);

    // The same clause a day later. Nothing about the rows changed; the answer
    // did — which is exactly what the plugin could not express before, and why
    // a panel left open across midnight must be re-rendered to catch up.
    const tomorrow = [{ field: "ts", since: { $rel: "-24h" } }];
    // Inclusive at the boundary, so the newest note survives its own edge...
    expect(keptAt(tomorrow, NOW + 86_400_000)).toEqual(["now"]);
    // ...and one millisecond later the whole day has aged out.
    expect(keptAt(tomorrow, NOW + 86_400_001)).toEqual([]);
  });

  it("samples the wall clock once when no clock is given", () => {
    const rows = [{ id: "fresh", ts: new Date().toISOString() }, { id: "stale", ts: "2001-01-01" }];
    const { where } = parseWhere([{ field: "ts", since: { $rel: "-1h" } }]);
    expect(filterVocabRows(where, rows, {}).map((row) => (row as { id: string }).id))
      .toEqual(["fresh"]);
  });

  it("drops a malformed `$rel` with a warning and keeps the rest of the binding", () => {
    const { where, warnings } = parseWhere([
      // No sign: "24h" is as likely to mean the last day as the next one, and
      // guessing would point the filter at the wrong half of the timeline.
      { field: "ts", since: { $rel: "24h" } },
      { field: "ts", since: { $rel: "-1w" } },
      { field: "ts", since: { $rel: "-24H" } },
      { field: "ts", since: "28/08/2026" },
    ]);
    expect(where).toBeUndefined();
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toContain("$rel");
    expect(warnings[3]).toContain("since");

    // A broken clause is node-local: the binding keeps the clauses that parsed,
    // because a reader can see a filter that did nothing and cannot see rows a
    // broken filter silently removed.
    const mixed = parseWhere([
      { field: "ts", since: { $rel: "nonsense" } },
      { field: "id", equals: "week" },
    ]);
    expect(mixed.where).toHaveLength(1);
    expect(mixed.warnings).toHaveLength(1);
  });

  it("drops a row whose field is missing or unreadable as a time", () => {
    // The one asymmetry worth naming: an unset `$state` is INACTIVE, but a row
    // that cannot answer the comparison is FALSE — the same thing a row with no
    // `statusGroup` has always done against an `equals`.
    expect(keptAt([{ field: "ts", since: "2000-01-01" }], NOW))
      .toEqual(["now", "hour", "epoch", "yesterday", "week"]);
    expect(keptAt([{ field: "ts", before: "2099-01-01" }], NOW))
      .toEqual(["now", "hour", "epoch", "yesterday", "week"]);
    // A zoneless date-time is unreadable on purpose: local-vs-UTC is exactly the
    // disagreement between clients this grammar exists to prevent.
    expect(parseWhere([{ field: "ts", since: "2026-08-28T12:00:00" }]).where).toBeUndefined();
  });

  it("reads `since` as at-or-after and `before` as strictly earlier", () => {
    // The two partition the timeline at the same instant: every row is in
    // exactly one of them, so a pair of controls cannot double-count or lose a row.
    const boundary = "2026-08-28T11:00:00.000Z";
    expect(keptAt([{ field: "ts", since: boundary }], NOW)).toEqual(["now", "hour"]);
    expect(keptAt([{ field: "ts", before: boundary }], NOW))
      .toEqual(["epoch", "yesterday", "week"]);
  });

  it("nests inside and, or and not like any other clause", () => {
    expect(keptAt([
      {
        or: [
          { field: "ts", before: "2026-08-25" },
          { and: [{ field: "ts", since: { $rel: "-24h" } }, { field: "id", notEquals: "epoch" }] },
        ],
      },
    ], NOW)).toEqual(["now", "hour", "week"]);

    // `not` inverts an active time clause and stays inactive over an inactive one.
    expect(keptAt([{ not: { field: "ts", since: { $rel: "-24h" } } }], NOW))
      .toEqual(["yesterday", "week", "unreadable", "absent"]);
    expect(keptAt([{ not: { field: "ts", since: { $state: "range" } } }], NOW, { range: "" }))
      .toHaveLength(NOTES.length);

    // Depth is unchanged: a clause four levels down is refused like any other.
    const deep = parseWhere([{ and: [{ or: [{ and: [{ field: "ts", since: "2000-01-01" }] }] }] }]);
    expect(deep.where).toBeUndefined();
    expect(deep.warnings[0]).toContain("nest at most");
  });

  it("follows a segmented control that offers relative ranges", () => {
    // The point of the whole clause: "All / Today / This week" as three option
    // values, with no field the plugin has to rewrite at midnight.
    const clause = [{ field: "ts", since: { $state: "range" } }];
    expect(keptAt(clause, NOW, { range: "-24h" })).toEqual(["now", "hour", "epoch"]);
    expect(keptAt(clause, NOW, { range: "-7d" }))
      .toEqual(["now", "hour", "epoch", "yesterday", "week"]);
    // An absolute instant is equally legal as an option value.
    expect(keptAt(clause, NOW, { range: "2026-08-28" })).toEqual(["now", "hour", "epoch"]);
    // "All", an undeclared key, and a value that reads as no time at all are
    // inactive rather than false — the house rule, unchanged.
    expect(keptAt(clause, NOW, { range: "" })).toHaveLength(NOTES.length);
    expect(keptAt(clause, NOW, {})).toHaveLength(NOTES.length);
    expect(keptAt(clause, NOW, { range: "sometime" })).toHaveLength(NOTES.length);
  });

  it("spends the same budget as any other comparison", () => {
    const many = (clause: Record<string, unknown>) =>
      parseWhere([{ and: Array.from({ length: VOCAB_STATE_LIMITS.maxWhereNodes }, () => clause) }]);
    const timed = many({ field: "ts", since: { $rel: "-1h" } });
    const text = many({ field: "id", equals: "now" });
    const clauseCount = (parsed: ReturnType<typeof parseWhere>) => {
      const first = parsed.where?.[0];
      return first?.kind === "and" ? first.clauses.length : -1;
    };
    // The composer is node 1, so the last child is the one over the ceiling.
    expect(clauseCount(timed)).toBe(VOCAB_STATE_LIMITS.maxWhereNodes - 1);
    expect(clauseCount(timed)).toBe(clauseCount(text));
    expect(timed.warnings[0]).toContain("at most");

    // Two operators on one clause is still refused, and `since` is now one of them.
    const both = parseWhere([{ field: "ts", since: "2026-08-28", equals: "x" }]);
    expect(both.where).toBeUndefined();
    expect(both.warnings[0]).toContain("only one operator");
  });

  it("declares no state key unless the operand names one", () => {
    const literal = parseWhere([
      { field: "ts", since: { $rel: "-24h" } },
      { field: "ts", before: "2026-08-28" },
    ]).where;
    expect(vocabWhereStateKeys(literal)).toEqual([]);

    const stateful = parseWhere([
      { and: [{ field: "ts", since: { $state: "range" } }, { field: "id", equals: { $state: "who" } }] },
    ]).where;
    expect(vocabWhereStateKeys(stateful).sort()).toEqual(["range", "who"]);
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
      control({ stateKey: "f" }),
      control({ stateKey: "g" }),
      control({ stateKey: "h" }),
      control({ stateKey: "i" }),
    ];
    const declarations = vocabStateDeclarations(found);

    // First rather than last: it is the control highest on the page, and its
    // default is the one a reader assumes is in force.
    expect(declarations.map((entry) => entry.stateKey))
      .toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
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

/* ── Collection-bound options ───────────────────────────────────────────── */

/**
 * A control whose options are data. Mirrored in `PluginVocabGroupSelectionTests`
 * on iOS and in "collection-bound segmented options in the terminal" in the TUI
 * suite, because the rule that matters — a control's identity is its binding,
 * never its rows — is the one that decides whether a reader's filter survives.
 */
describe("collection-bound state options", () => {
  const PROJECTS = [
    { value: { id: "core", name: "Core platform" } },
    { value: { id: "mobile", name: "Mobile" } },
    { value: { id: "core", name: "A duplicate nobody can reach" } },
    { value: { name: "no id" } },
    { value: "not a row" },
  ];

  const binding = { collection: "projects", valueField: "id", labelField: "name" };

  it("reads a binding and refuses one that names nothing to read", () => {
    expect(parseVocabStateOptionsBinding({ collection: "projects", valueField: "id" }))
      .toEqual({ collection: "projects", valueField: "id" });
    expect(parseVocabStateOptionsBinding({ collection: "projects" })).toBeUndefined();
    expect(parseVocabStateOptionsBinding({ valueField: "id" })).toBeUndefined();
    expect(parseVocabStateOptionsBinding("projects")).toBeUndefined();
  });

  it("bound options resolve from the collection and draw after the literal ones", () => {
    const resolved = vocabResolveStateOptions(binding, PROJECTS);
    expect(resolved.map((option) => option.value)).toEqual(["core", "mobile"]);
    expect(resolved.map((option) => option.label)).toEqual(["Core platform", "Mobile"]);

    const merged = vocabMergeStateOptions([{ value: "", label: "All projects" }], resolved);
    // The literal "All" stays first: it is the unset sentinel and the reader
    // looks for it at the top.
    expect(merged.map((option) => option.value)).toEqual(["", "core", "mobile"]);
  });

  it("falls back to the value when no label field is named, and caps the list", () => {
    expect(vocabResolveStateOptions({ collection: "projects", valueField: "id" }, PROJECTS)
      .map((option) => option.label)).toEqual(["core", "mobile"]);

    const many = Array.from(
      { length: VOCAB_STATE_LIMITS.maxBoundStateOptions + 5 },
      (_, index) => ({ value: { id: `p${index}` } }),
    );
    expect(vocabResolveStateOptions({ collection: "projects", valueField: "id" }, many))
      .toHaveLength(VOCAB_STATE_LIMITS.maxBoundStateOptions);
    // A fetch that has not landed is not an empty collection, and neither is a
    // control with no options at all.
    expect(vocabResolveStateOptions(binding, undefined)).toEqual([]);
  });

  it("a bound control's signature does not move when its resolved options change", () => {
    const bound = (options: VocabStateOption[]) => [control({
      stateKey: "project",
      options,
      initial: "",
      optionsFrom: binding,
    })];
    const before = vocabStateSignature(bound([{ value: "", label: "All" }]));
    const after = vocabStateSignature(bound([
      { value: "", label: "All" },
      { value: "core", label: "Core platform" },
    ]));
    // A project created in another window must not drop the reader's filter.
    expect(after).toBe(before);
    // The binding itself IS the identity, so pointing the control somewhere else
    // still starts the reader over.
    expect(vocabStateSignature([control({
      stateKey: "project",
      options: [],
      initial: "",
      optionsFrom: { ...binding, collection: "labels" },
    })])).not.toBe(before);
  });

  it("a control past the strip ceiling draws as a menu", () => {
    const options = (count: number) => Array.from({ length: count }, (_, index) => ({
      value: `v${index}`,
      label: `V${index}`,
    }));
    expect(vocabStateControlStyle({ options: options(3) })).toBe("segmented");
    expect(vocabStateControlStyle({ options: options(2), style: "toggle" })).toBe("toggle");
    expect(vocabStateControlStyle({ options: options(VOCAB_STATE_LIMITS.maxStateOptions) }))
      .toBe("segmented");
    // Thirty projects is not a strip on any surface, whatever the author asked
    // for — the row count is the reader's workspace, not the schema.
    expect(vocabStateControlStyle({
      options: options(VOCAB_STATE_LIMITS.maxStateOptions + 1),
      style: "toggle",
    })).toBe("menu");
  });
});

/* ── Selection ──────────────────────────────────────────────────────────── */

/**
 * The batch half of the lifecycle. Mirrored case for case in
 * `PluginVocabGroupSelectionTests` on iOS and in "a selectable list in the
 * terminal" in the TUI suite.
 */
describe("selection lifecycle", () => {
  const ISSUES: VocabSelectionDeclaration = {
    stateKey: "issues",
    max: 3,
    actionIds: ["create-lanes"],
  };
  const ROWS = ["a", "b", "c", "d", "e"];

  it("opens every list on nothing ticked", () => {
    expect(vocabInitialPanelSelection([ISSUES])).toEqual({ issues: [] });
    expect(vocabInitialPanelSelection([])).toEqual({});
    expect(EMPTY_VOCAB_PANEL_SELECTION).toEqual({});
  });

  it("the cap refuses a tick rather than evicting the oldest", () => {
    let selection: VocabPanelSelection = { issues: [] };
    for (const key of ["a", "b", "c"]) {
      selection = vocabToggleRowSelection(selection, ISSUES, key);
    }
    expect(selection.issues).toEqual(["a", "b", "c"]);

    // A silent eviction would take a row out of a batch the reader believes
    // they assembled, and nothing on screen would say so.
    const full = vocabToggleRowSelection(selection, ISSUES, "d");
    expect(full).toBe(selection);

    // Unticking always works, cap or no cap.
    expect(vocabToggleRowSelection(selection, ISSUES, "b").issues).toEqual(["a", "c"]);
    // A row with no key is not a row.
    expect(vocabToggleRowSelection(selection, ISSUES, "")).toBe(selection);
  });

  it("the range is a union and fills to the cap", () => {
    const one = vocabSelectRowRange({ issues: ["e"] }, ISSUES, vocabRowRange(ROWS, "a", "b"));
    // Shift-clicking a second cluster must not throw away the first.
    expect(one.issues).toEqual(["e", "a", "b"]);

    const overflowing = vocabSelectRowRange({ issues: [] }, ISSUES, ROWS);
    expect(overflowing.issues).toEqual(["a", "b", "c"]);
    // Nothing to add is not a change, so a redraw is not forced.
    expect(vocabSelectRowRange(one, ISSUES, ["a"])).toBe(one);
  });

  it("reads a range in draw order however the reader dragged it", () => {
    expect(vocabRowRange(ROWS, "b", "d")).toEqual(["b", "c", "d"]);
    expect(vocabRowRange(ROWS, "d", "b")).toEqual(["b", "c", "d"]);
    // No anchor, or one whose row has scrolled out of the schema, is a plain
    // click on the row the reader actually hit.
    expect(vocabRowRange(ROWS, null, "c")).toEqual(["c"]);
    expect(vocabRowRange(ROWS, "gone", "c")).toEqual(["c"]);
    expect(vocabRowRange(ROWS, "a", "gone")).toEqual([]);
  });

  it("selectedRowKeys returns only the visible keys in draw order", () => {
    const selection = { issues: ["d", "a"] };
    // The stored set keeps a row a filter has hidden — moving the filter back
    // brings the tick with it — but a batch acts only on what the reader sees.
    expect(vocabSelectedRowKeys(selection, "issues", ROWS)).toEqual(["a", "d"]);
    expect(vocabSelectedRowKeys(selection, "issues", ["a", "b"])).toEqual(["a"]);
    expect(vocabSelectedRowKeys(selection, "prs", ROWS)).toEqual([]);
    expect(vocabSelectedRowKeys(undefined, "issues", ROWS)).toEqual([]);
  });

  it("the selection signature ignores rows and moves on a changed cap or action list", () => {
    const base = vocabSelectionSignature([ISSUES]);
    expect(vocabSelectionSignature([{ ...ISSUES }])).toBe(base);
    expect(vocabSelectionSignature([{ ...ISSUES, max: 4 }])).not.toBe(base);
    expect(vocabSelectionSignature([{ ...ISSUES, actionIds: ["archive"] }])).not.toBe(base);
    expect(vocabSelectionSignature([{ ...ISSUES, stateKey: "prs" }])).not.toBe(base);
  });

  it("carries the ticks across a republish and drops a list the schema no longer declares", () => {
    const carried = vocabNormalizePanelSelection({ issues: ["a", "b"], prs: ["p1"] }, [ISSUES]);
    expect(carried).toEqual({ issues: ["a", "b"] });
    // A republish that lowered the cap cannot leave more ticked than it allows,
    // and a repeated key does not spend the cap twice.
    expect(vocabNormalizePanelSelection({ issues: ["a", "a", "b", "c", "d"] }, [ISSUES]).issues)
      .toEqual(["a", "b", "c"]);
    expect(vocabNormalizePanelSelection(undefined, [ISSUES])).toEqual({ issues: [] });
  });

  it("an action can put the reader back on an empty selection", () => {
    const selection = { issues: ["a"], prs: ["p1"] };
    const prs: VocabSelectionDeclaration = { stateKey: "prs", max: 3, actionIds: ["merge"] };
    expect(vocabResetPanelSelection(selection, [ISSUES, prs], "all"))
      .toEqual({ issues: [], prs: [] });
    expect(vocabResetPanelSelection(selection, [ISSUES, prs], ["issues"]))
      .toEqual({ issues: [], prs: ["p1"] });
    // A key no list declares is ignored rather than invented.
    expect(vocabResetPanelSelection(selection, [ISSUES], ["nothing"])).toEqual(selection);
    expect(vocabClearRowSelection(selection, ISSUES).issues).toEqual([]);
    expect(vocabClearRowSelection({ issues: [] }, ISSUES)).toEqual({ issues: [] });
  });

  it("caps how many lists in one panel may claim the bar", () => {
    const many = Array.from({ length: VOCAB_STATE_LIMITS.maxSelectionKeys + 2 }, (_, index) => ({
      stateKey: `list${index}`,
      max: 10,
      actionIds: ["go"],
    }));
    expect(vocabSelectionDeclarations([...many, many[0]!]))
      .toHaveLength(VOCAB_STATE_LIMITS.maxSelectionKeys);
    // First declaration wins, the same rule the state keys follow.
    expect(vocabSelectionDeclarations([
      { stateKey: "a", max: 3, actionIds: ["x"] },
      { stateKey: "a", max: 9, actionIds: ["y"] },
    ])).toEqual([{ stateKey: "a", max: 3, actionIds: ["x"] }]);
  });
});

describe("chrome.search state", () => {
  const search = (overrides: Partial<VocabStateDeclaration> = {}): VocabStateDeclaration => ({
    stateKey: "q",
    kind: "search",
    options: [],
    initial: "",
    ...overrides,
  });

  it("is a search field, never a strip or a menu", () => {
    expect(vocabIsSearchDeclaration(search())).toBe(true);
    expect(vocabIsSearchDeclaration(control())).toBe(false);
    expect(vocabStateControlStyle(search())).toBe("search");
    // Even a search whose options someone stuffed still draws as a field —
    // the kind is the identity, not the option count.
    expect(vocabStateControlStyle(search({ options: [{ value: "a", label: "A" }] }))).toBe("search");
  });

  it("signs the control, not the typed query", () => {
    const a = vocabStateSignature([search({ placeholder: "Filter issues" })]);
    const b = vocabStateSignature([search({ placeholder: "Filter issues", initial: "ISS" })]);
    expect(a).toBe(b);
    expect(vocabStateSignature([search({ placeholder: "Other" })])).not.toBe(a);
    expect(vocabStateSignature([search({ stateKey: "other" })])).not.toBe(a);
  });

  it("keeps typed text across a republish and clamps it", () => {
    const declaration = search();
    const typed = vocabApplyStateChange({}, declaration, "  Issue  ");
    expect(typed).toEqual({ q: "  Issue  " });
    expect(vocabNormalizePanelState(typed, [declaration])).toEqual({ q: "  Issue  " });
    const tooLong = "x".repeat(VOCAB_STATE_LIMITS.maxSearchChars + 40);
    expect(vocabApplyStateChange({}, declaration, tooLong).q)
      .toHaveLength(VOCAB_STATE_LIMITS.maxSearchChars);
    expect(vocabNormalizePanelState({ q: tooLong }, [declaration]).q)
      .toHaveLength(VOCAB_STATE_LIMITS.maxSearchChars);
    // Arrow keys do not invent an option a search field never offered.
    expect(vocabCycleStateValue(declaration, "abc", 1)).toBe("abc");
  });

  it("reports the typed string through `$state`, not an option label", () => {
    expect(vocabStateRows([search({ placeholder: "Filter" })], { q: "ISS-1" }))
      .toEqual([{ key: "q", value: "ISS-1" }]);
  });
});
