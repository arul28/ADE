/**
 * Client-evaluated panel state: the `segmented` control's state keys, and the
 * `where` predicate a binding filters its rows with.
 *
 * ## Why this exists
 *
 * A panel that wanted a status filter could only express it as a `form` plus a
 * submit button plus a `panels.update()` from the plugin child plus a refetch.
 * That is three taps and a full round trip for every filter change, and the
 * selected value did not survive the re-render unless the plugin baked it back
 * into `field.value`. A fleet list is unusable that way.
 *
 * So the vocabulary gains one primitive and one clause:
 *
 * - a **`segmented` node** owns a named piece of CLIENT state — a closed option
 *   list, a default, and nothing else;
 * - a **`where` clause on a binding** keeps the rows whose fields match, read
 *   either against a literal or against the current value of a state key.
 *
 * ## The second map
 *
 * A batch — "tick eleven issues, create eleven lanes" — is the same lifecycle
 * with a different shape in it: a SET of row keys per selectable list rather
 * than one string per control. It lives in its own map ({@link VocabPanelSelection})
 * because folding a set into the string map would put a delimiter and a parser
 * between a tick and a redraw, and would push a hundred issue ids through
 * `$state` and through the `state` payload, neither of which wants them. Every
 * rule around it is the segmented one: same session-only lifetime, same
 * signature/normalize pair, same `{resetState}` verb.
 *
 * ## The one thing the client computes
 *
 * `since` / `before` compare a row field to an instant, and a `{"$rel": "-24h"}`
 * operand resolves that instant from the CLIENT CLOCK at evaluation time. That
 * is the single exception to "the client only compares strings", and it exists
 * because the alternative was worse: a plugin materializing `today: "today"`
 * onto every row has written a fact that is false by morning, and there is no
 * cheap "the day changed" trigger to rewrite it with.
 *
 * It resolves on RE-RENDER, never on a timer. A panel left open across midnight
 * still shows yesterday's answer until its rows change or the reader pulls the
 * declared `refreshAction`. A timer would re-render every open panel on every
 * surface forever to catch a boundary almost nobody is watching.
 *
 * The clock is a PARAMETER, not a call inside the loop: {@link filterVocabRows}
 * samples `Date.now()` once per pass and hands the same instant to every row, so
 * two rows a microsecond apart cannot land on opposite sides of one boundary,
 * and a test can pin the instant instead of sleeping.
 *
 * ## Rule 3 is intact
 *
 * "Data, never code" (`vocabulary.ts`) forbids expressions, formatting strings,
 * conditionals and host callbacks. A predicate here is none of those. It is a
 * fixed grammar of four comparisons over three composers, with no functions, no
 * regular expressions, no arithmetic, no field-to-field comparison and no way to
 * reach anything but the row it was handed and the state the panel declared.
 * Every value it can read, the plugin wrote itself. The plugin still computes on
 * its own machine — it materializes `status`, `laneId` and `archived` onto each
 * row — and the client still only compares strings.
 *
 * ## Where the module sits
 *
 * `vocabulary.ts → vocabularyNodes.ts → vocabularyState.ts`. This file imports
 * nothing but `parse.ts`, so `vocabularyNodes.ts` can use its parsers inside
 * `parseBinding` and the `segmented` node parser without a cycle. Desktop, the
 * web client and the TUI all evaluate through {@link filterVocabRows} — one
 * implementation, so a filter cannot keep a row on one surface and drop it on
 * another. iOS mirrors it in `PluginVocabularyState.swift` against the same
 * cases.
 *
 * ## Three-valued evaluation
 *
 * A comparison whose state key is unset — the "All" option, or a key no
 * `segmented` declared — is **inactive**, not false. An inactive clause is
 * removed from its enclosing `and`/`or`; a `not` of one is itself inactive; a
 * `where` with nothing active keeps every row. That single rule is what lets a
 * segmented control express "All" as an option with an empty `value` instead of
 * needing a second primitive for "turn this filter off".
 */

import { finite, isRecord, oneOf, trimmed } from "./parse";

/* ── Limits ─────────────────────────────────────────────────────────────── */

/**
 * The ceilings that belong to panel state. Spread into `VOCAB_LIMITS` by
 * `vocabularyNodes.ts` so a schema author reads one table, and declared here so
 * this module owes that one nothing.
 *
 * The numbers are small on purpose. A predicate language with a generous budget
 * is a query language, and a query language is the thing rule 3 exists to keep
 * out of a panel schema.
 */
export const VOCAB_STATE_LIMITS = {
  /**
   * Distinct `segmented` state keys in one panel.
   *
   * Eight rather than four, because four was one filter axis short of the panels
   * people actually write: an issue browser wants state, project, assignee,
   * priority, sort and a text search, and the `group` node (`vocabularyNodes.ts`)
   * deliberately does NOT spend a key, so a panel with seven collapsible groups
   * still has its whole filter budget. Eight is still small enough that every
   * key fits in one `$state` `keyValue` node without scrolling.
   */
  maxStateKeys: 8,
  /** Literal options written into one `segmented` control's `options`. */
  maxStateOptions: 8,
  /**
   * Options one control may hold once `optionsFrom` has resolved.
   *
   * Higher than {@link VOCAB_STATE_LIMITS.maxStateOptions} because the two are
   * different objects. A literal list is read at a glance and drawn as a strip
   * of pills, so eight is where a strip stops fitting; a collection-bound list
   * is a workspace's projects or labels, drawn as a menu, and a real workspace
   * has thirty. Fifty is where a flat menu stops being findable and the honest
   * answer becomes a search field the vocabulary does not have yet — and it sits
   * under `maxKeyValueRows` (60), so no client draws a longer list than one it
   * already draws.
   */
  maxBoundStateOptions: 50,
  /** Top-level clauses on one binding's `where`. They are ANDed. */
  maxWhereClauses: 4,
  /** Nesting depth of `and`/`or`/`not`. A top-level clause is depth 1. */
  maxWhereDepth: 3,
  /** Total clauses in one binding's `where`, counted through the whole tree. */
  maxWhereNodes: 24,
  /** Literal values in one `in` / `notIn` list. */
  maxWhereValues: 20,
  /** A state key, an option value, or a predicate field name. */
  maxStateIdChars: 120,
  /**
   * `list` nodes in one panel that may declare `selectable`.
   *
   * Two, not eight. A selection owns a bar across the panel and one word —
   * "3 selected" — and two lists both claiming that bar is already a panel that
   * needs splitting. Two covers the one shape that is not a mistake: a detail
   * panel offering a batch over its issues and a batch over its pull requests.
   */
  maxSelectionKeys: 2,
  /**
   * Rows selectable at once in one list.
   *
   * The same number as `maxListItems`, on purpose: the ceiling on a selection is
   * the ceiling on what a list can draw, so "select everything on screen" is
   * always expressible and never silently drops the tail.
   */
  maxSelectedRows: 100,
  /**
   * Buttons on one list's bulk-action bar.
   *
   * Four, where a row's own trailing actions stop at three: a row shares its
   * width with its title, subtitle and chip, while the bar has the whole panel
   * and draws the count and Clear itself. A fifth verb over a selection is a
   * menu, and the vocabulary has no menu.
   */
  maxBulkActions: 4,
} as const;

/* ── Panel state ────────────────────────────────────────────────────────── */

/**
 * The live value of every state key a panel declared: one string each.
 *
 * Per-panel, per-viewer, session-scoped. It never reaches sqlite, never syncs,
 * and never leaves the client unless the panel declared `onChange` or the plugin
 * asked for it — see {@link vocabStatePayload}.
 */
export type VocabPanelState = Readonly<Record<string, string>>;

export const EMPTY_VOCAB_PANEL_STATE: VocabPanelState = Object.freeze({});

/**
 * One option of a `segmented` control.
 *
 * An **empty `value` means unset**, which is how a panel writes "All". Every
 * clause reading that key goes inactive and keeps every row, so the option list
 * stays a plain list of strings and the filter needs no second concept.
 */
export type VocabStateOption = {
  value: string;
  label: string;
  /** A small count or chip beside the label, e.g. `12`. Text only. */
  badge?: string;
};

/**
 * Where a control's options come from, when they are not written in the schema.
 *
 * A literal option list caps at {@link VOCAB_STATE_LIMITS.maxStateOptions},
 * which is right for "All / Active / Failed" and useless for "project", because
 * a real workspace has thirty of those and the plugin cannot know their names
 * when it writes the schema. The plugin already materializes them — it is
 * writing them into a collection for the list beside the control — so this
 * points the control at that collection instead of asking the author to inline
 * a list they do not have.
 *
 * It is a `VocabBinding` minus the parts that would make it a second query
 * language: no `limit` (the ceiling is the ceiling), no `where` (a filter over
 * a filter's own options is a puzzle), no `allowActions` (an option presses
 * nothing). The plugin decides which rows are options by which rows it writes.
 */
export type VocabStateOptionsBinding = {
  collection: string;
  /** Restricts to keys with this prefix, exactly as a node binding's does. */
  keyPrefix?: string;
  /** Top-level field of the row holding the option's value. */
  valueField: string;
  /** Top-level field holding the label. Falls back to the value. */
  labelField?: string;
};

/**
 * What a `segmented` node contributes to the panel's state, lifted out of the
 * node tree so a host can build the initial state without walking it twice.
 */
export type VocabStateDeclaration = {
  stateKey: string;
  label?: string;
  /**
   * Every option the control offers: the literal ones first, then whatever
   * {@link optionsFrom} resolved to. Literals first because that is where the
   * "All" sentinel is written, and a reader looks for it at the top.
   */
  options: VocabStateOption[];
  /** The option selected when the panel first renders. Always a declared value. */
  initial: string;
  /** How the author asked for it to be drawn. See {@link vocabStateControlStyle}. */
  style?: VocabSegmentedStyle;
  /** Set when the options came from a collection rather than from the schema. */
  optionsFrom?: VocabStateOptionsBinding;
};

/* ── Selection ──────────────────────────────────────────────────────────── */

/**
 * The rows a reader has ticked, per `selectable` list.
 *
 * A second map beside {@link VocabPanelState} rather than a value inside it,
 * because the two hold different shapes — one string against a closed option
 * list, versus an open set of row keys — and folding a set into a delimited
 * string would put a parser between the reader's tick and the panel's redraw,
 * and would leak into `$state` and into the `state` payload, neither of which
 * wants a hundred issue ids in it.
 *
 * Everything else about the two is deliberately identical: same per-panel,
 * per-viewer, session-only lifetime; same signature/normalize pair; same reset
 * verb. See {@link vocabSelectionSignature}.
 */
export type VocabPanelSelection = Readonly<Record<string, readonly string[]>>;

export const EMPTY_VOCAB_PANEL_SELECTION: VocabPanelSelection = Object.freeze({});

/**
 * What a `list` node's `selectable` contributes, in the shape a host holds.
 *
 * The bulk actions are named by id only. The buttons themselves are node data
 * and live in `vocabularyNodes.ts`, which imports this module and must not be
 * imported back; the ids are all the lifecycle needs, because they are what
 * decides whether a re-published panel is offering the same control.
 */
export type VocabSelectionDeclaration = {
  stateKey: string;
  /** Most rows selectable at once, already clamped to the ceiling. */
  max: number;
  /** The bulk action ids, in the order they are drawn. */
  actionIds: string[];
};

/* ── Predicates ─────────────────────────────────────────────────────────── */

/**
 * A parsed `where` clause.
 *
 * `equals` folds into `in` with a single value and `notEquals` into `notIn`,
 * because they evaluate identically and one code path cannot drift from itself.
 * A comparison reads EITHER `values` (a literal list) or `stateKey` (the current
 * value of a declared state key), never both.
 */
export type VocabPredicate =
  | {
      kind: "compare";
      op: "in" | "notIn";
      /** Top-level field of the bound row. No paths, no nesting. */
      field: string;
      values?: string[];
      stateKey?: string;
    }
  | {
      kind: "time";
      op: "since" | "before";
      /** Top-level field of the bound row, read as a time rather than as text. */
      field: string;
      /** An absolute instant in epoch milliseconds, from a literal operand. */
      at?: number;
      /** An offset from the RENDER clock, from a `{"$rel": …}` operand. */
      relMs?: number;
      /** A state key whose selected value is read as either of the two above. */
      stateKey?: string;
    }
  | { kind: "and"; clauses: VocabPredicate[] }
  | { kind: "or"; clauses: VocabPredicate[] }
  | { kind: "not"; clause: VocabPredicate };

/* ── Times ──────────────────────────────────────────────────────────────── */

/**
 * The one calendar shape a `since` / `before` operand or row field may take.
 *
 * Deliberately narrower than `Date.parse`, which accepts a pile of engine- and
 * locale-specific spellings and reads a zoneless date-time as LOCAL. Four
 * clients evaluate this predicate and a filter that keeps a row on one surface
 * and drops it on another is worse than no filter, so the accepted set is: a
 * bare `YYYY-MM-DD` (read as UTC midnight) or a date-time carrying an EXPLICIT
 * zone. `new Date().toISOString()` — what a plugin actually writes — is in it.
 */
const ISO_TIME_PATTERN =
  /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::(\d{2}))?(?:\.(\d{1,9}))?(Z|z|[+-]\d{2}:?\d{2}))?$/;

/** `-24h`, `+90m`, `-7d`. The sign is REQUIRED — see {@link parseVocabRelOffset}. */
const REL_OFFSET_PATTERN = /^([+-])(\d{1,6})([mhd])$/;

const REL_UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/**
 * `{"$rel": "-24h"}` as an offset in milliseconds, or `null`.
 *
 * The sign is required. A bare `"24h"` is exactly as likely to mean "the last
 * day" as "the next one", and guessing would silently point a filter at the
 * wrong half of the timeline — the one failure this grammar cannot show the
 * reader. Units are lower-case `m`/`h`/`d`: `M` is minutes in one convention and
 * months in another, and nothing here is worth that ambiguity.
 */
export function parseVocabRelOffset(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const match = REL_OFFSET_PATTERN.exec(raw.trim());
  if (match === null) return null;
  const [, sign, digits, unit] = match;
  const magnitude = Number(digits) * REL_UNIT_MS[unit as keyof typeof REL_UNIT_MS];
  return sign === "-" ? -magnitude : magnitude;
}

/**
 * A row field or a literal operand as an instant in epoch milliseconds, or
 * `null` when it is not a time this grammar can read.
 *
 * One reader for both sides, so an operand and the field it is compared against
 * can never be understood differently.
 */
export function vocabTimeValue(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const match = ISO_TIME_PATTERN.exec(raw.trim());
  if (match === null) return null;
  const [, date, clock, seconds, fraction, zone] = match;
  // Rebuilt into the one spelling every client agrees on before it is parsed,
  // so a nanosecond fraction from a Go API and a millisecond one from a browser
  // land on the same instant, and `+0200` and `+02:00` are the same zone.
  const millis = fraction === undefined ? "000" : `${fraction}000`.slice(0, 3);
  const offset =
    zone === undefined ? "Z" : /^[Zz]$/.test(zone) ? "Z" : zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone;
  const normalized =
    clock === undefined
      ? `${date}T00:00:00.000Z`
      : `${date}T${clock}:${seconds ?? "00"}.${millis}${offset}`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A row field as the text a predicate compares against.
 *
 * Deliberately NOT {@link vocabCellText}, which is a DISPLAY coercion: it turns
 * `true` into `"Yes"`, which is the right cell and the wrong operand. A plugin
 * writing `archived: false` and filtering on `"false"` must match, so booleans
 * render as their JSON words here. An object or an array has no text form a
 * plugin could have meant, so it compares as empty and matches only an operand
 * that is itself empty — which is inactive, so in practice it never matches.
 */
export function vocabPredicateFieldText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return "";
}

/** A literal operand as text. Same coercion, applied at parse instead of at read. */
function literalText(value: unknown): string | null {
  if (typeof value === "string") {
    const text = trimmed(value);
    return text === null ? null : text.slice(0, VOCAB_STATE_LIMITS.maxStateIdChars);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return vocabPredicateFieldText(value);
  }
  return null;
}

/** `{"$state":"statusFilter"}` — the one object form an operand may take. */
function stateRef(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const key = trimmed(raw.$state);
  if (key === null) return null;
  return key.slice(0, VOCAB_STATE_LIMITS.maxStateIdChars);
}

type WhereParseBudget = { nodes: number; warn: (message: string) => void };

const COMPARISON_KEYS = ["equals", "notEquals", "in", "notIn"] as const;
type ComparisonKey = (typeof COMPARISON_KEYS)[number];

const TIME_KEYS = ["since", "before"] as const;
type TimeKey = (typeof TIME_KEYS)[number];

const OPERATOR_KEYS = [...COMPARISON_KEYS, ...TIME_KEYS] as const;

/**
 * One `since` / `before` clause.
 *
 * Kept apart from the text comparison because the two read their operand
 * differently and nothing else about them differs: same budget, same one-clause
 * rejection, same place in the tree.
 */
function parseTimeClause(
  op: TimeKey,
  operand: unknown,
  field: string,
  budget: WhereParseBudget,
): VocabPredicate | null {
  // `{"$rel": "-24h"}` before `{"$state": …}`, because both are objects and only
  // one of them names a key.
  if (isRecord(operand) && operand.$rel !== undefined) {
    const relMs = parseVocabRelOffset(operand.$rel);
    if (relMs === null) {
      budget.warn('`$rel` must read `-<n><m|h|d>` or `+<n><m|h|d>`, e.g. `{"$rel": "-24h"}`.');
      return null;
    }
    return { kind: "time", op, field, relMs };
  }
  const fromState = stateRef(operand);
  if (fromState !== null) return { kind: "time", op, field, stateKey: fromState };
  const at = vocabTimeValue(operand);
  if (at === null) {
    budget.warn(
      `\`${op}\` needs an ISO-8601 time, epoch milliseconds, a \`{"$rel": …}\` offset or a \`{"$state": …}\` reference.`,
    );
    return null;
  }
  return { kind: "time", op, field, at };
}

/**
 * One clause, or `null` when it is unusable.
 *
 * Every rejection is node-local: the clause disappears with a warning and the
 * binding keeps the clauses that parsed. A binding whose whole `where` is
 * unusable filters nothing, which shows every row — the safe direction, because
 * a reader can see that a filter did nothing but cannot see rows a broken filter
 * silently removed.
 */
function parseClause(raw: unknown, depth: number, budget: WhereParseBudget): VocabPredicate | null {
  if (!isRecord(raw)) {
    budget.warn("A `where` clause must be an object.");
    return null;
  }
  if (depth > VOCAB_STATE_LIMITS.maxWhereDepth) {
    budget.warn(`A \`where\` clause may nest at most ${VOCAB_STATE_LIMITS.maxWhereDepth} levels.`);
    return null;
  }
  budget.nodes += 1;
  if (budget.nodes > VOCAB_STATE_LIMITS.maxWhereNodes) {
    budget.warn(`A \`where\` may contain at most ${VOCAB_STATE_LIMITS.maxWhereNodes} clauses.`);
    return null;
  }

  if (raw.not !== undefined) {
    const clause = parseClause(raw.not, depth + 1, budget);
    return clause === null ? null : { kind: "not", clause };
  }

  for (const composer of ["and", "or"] as const) {
    if (raw[composer] === undefined) continue;
    if (!Array.isArray(raw[composer])) {
      budget.warn(`\`${composer}\` must be an array of clauses.`);
      return null;
    }
    const clauses: VocabPredicate[] = [];
    for (const entry of raw[composer] as unknown[]) {
      const clause = parseClause(entry, depth + 1, budget);
      if (clause !== null) clauses.push(clause);
    }
    if (clauses.length === 0) return null;
    return { kind: composer, clauses };
  }

  const field = trimmed(raw.field);
  if (field === null) {
    budget.warn("A `where` comparison needs a `field`.");
    return null;
  }
  const present = OPERATOR_KEYS.filter((key) => raw[key] !== undefined);
  if (present.length !== 1) {
    // Two operators on one clause is not a clause the author meant either way,
    // and picking one for them would filter rows nobody asked to hide.
    budget.warn(
      present.length === 0
        ? "A `where` comparison needs one of `equals`, `notEquals`, `in`, `notIn`, `since` or `before`."
        : "A `where` comparison may declare only one operator.",
    );
    return null;
  }
  const name = present[0] as ComparisonKey | TimeKey;
  const operand = raw[name];
  const fieldName = field.slice(0, VOCAB_STATE_LIMITS.maxStateIdChars);

  if (name === "since" || name === "before") {
    return parseTimeClause(name, operand, fieldName, budget);
  }

  const key = name;
  const op: "in" | "notIn" = key === "equals" || key === "in" ? "in" : "notIn";

  const fromState = stateRef(operand);
  if (fromState !== null) {
    return {
      kind: "compare",
      op,
      field: fieldName,
      stateKey: fromState,
    };
  }

  // A scalar under `in`, or an array under `equals`, is read as the list it
  // obviously means rather than dropped: `op` has already folded the two
  // operators into one operation, so there is nothing left for the shape of the
  // operand to disambiguate.
  const rawValues = Array.isArray(operand) ? operand : [operand];
  const values: string[] = [];
  for (const entry of rawValues.slice(0, VOCAB_STATE_LIMITS.maxWhereValues)) {
    const text = literalText(entry);
    if (text !== null && !values.includes(text)) values.push(text);
  }
  if (values.length === 0) {
    budget.warn(`\`${key}\` needs at least one literal value or a \`{"$state": …}\` reference.`);
    return null;
  }
  return { kind: "compare", op, field: fieldName, values };
}

/**
 * A binding's `where`: an array of clauses, ANDed.
 *
 * `undefined` — not `[]` — when nothing usable was declared, so a binding that
 * declared no filter and a binding whose filter was all garbage are the same
 * thing to every caller: an unfiltered binding.
 */
export function parseVocabWhere(
  raw: unknown,
  onWarning?: (message: string) => void,
): VocabPredicate[] | undefined {
  if (raw === undefined) return undefined;
  const warn = onWarning ?? (() => {});
  const entries = Array.isArray(raw) ? raw : [raw];
  const budget: WhereParseBudget = { nodes: 0, warn };
  const clauses: VocabPredicate[] = [];
  for (const entry of entries.slice(0, VOCAB_STATE_LIMITS.maxWhereClauses)) {
    const clause = parseClause(entry, 1, budget);
    if (clause !== null) clauses.push(clause);
  }
  return clauses.length > 0 ? clauses : undefined;
}

/** The state keys a `where` reads, so a host can warn about one nothing declares. */
export function vocabWhereStateKeys(where: readonly VocabPredicate[] | undefined): string[] {
  const found = new Set<string>();
  const walk = (clause: VocabPredicate) => {
    switch (clause.kind) {
      case "compare":
      case "time":
        // A `since` written against a literal or a `{"$rel": …}` declares no key
        // at all, which is the honest answer: it reads the clock, not the panel.
        if (clause.stateKey !== undefined) found.add(clause.stateKey);
        return;
      case "not":
        walk(clause.clause);
        return;
      default:
        for (const child of clause.clauses) walk(child);
    }
  };
  for (const clause of where ?? []) walk(clause);
  return [...found];
}

/* ── Evaluation ─────────────────────────────────────────────────────────── */

/**
 * One clause against one row. `null` is INACTIVE — see the module comment.
 *
 * Total by construction: there is no input that throws and no input that loops.
 * A clause reads exactly two things, the row field it names and the state key it
 * names, and both are already strings by the time they get here.
 */
function evaluateClause(
  clause: VocabPredicate,
  row: Record<string, unknown>,
  state: VocabPanelState,
  now: number,
): boolean | null {
  switch (clause.kind) {
    case "compare": {
      let values = clause.values;
      if (clause.stateKey !== undefined) {
        const selected = state[clause.stateKey];
        // Unset, or a key no `segmented` declared. Inactive rather than false:
        // an "All" option and a typo both mean "this filter is not filtering",
        // and hiding every row would be the worst reading of either.
        if (selected === undefined || selected === "") return null;
        values = [selected];
      }
      if (!values || values.length === 0) return null;
      return values.includes(vocabPredicateFieldText(row[clause.field])) === (clause.op === "in");
    }
    case "time": {
      const at = timeOperand(clause, state, now);
      if (at === null) return null;
      const value = vocabTimeValue(row[clause.field]);
      // A row with no readable time cannot answer the question, so it fails the
      // comparison — exactly as a row with no `statusGroup` already fails an
      // `equals`. INACTIVE belongs to the operand side of the grammar (an unset
      // `$state`, an author's typo); a missing field has always been the row's
      // problem and has always dropped it.
      if (value === null) return false;
      return clause.op === "since" ? value >= at : value < at;
    }
    case "and": {
      let result: boolean | null = null;
      for (const child of clause.clauses) {
        const value = evaluateClause(child, row, state, now);
        if (value === null) continue;
        if (!value) return false;
        result = true;
      }
      return result;
    }
    case "or": {
      let result: boolean | null = null;
      for (const child of clause.clauses) {
        const value = evaluateClause(child, row, state, now);
        if (value === null) continue;
        if (value) return true;
        result = false;
      }
      return result;
    }
    case "not": {
      const value = evaluateClause(clause.clause, row, state, now);
      return value === null ? null : !value;
    }
  }
}

/**
 * The instant a `since` / `before` clause compares against, or `null` when the
 * clause is INACTIVE.
 *
 * A `{"$state": …}` operand goes inactive exactly where a text comparison does —
 * unset, or a value the reader's control cannot express as a time — so a
 * segmented control can offer `""` / `-24h` / `-7d` as "All / Today / This week"
 * with no second concept for turning the filter off.
 */
function timeOperand(
  clause: Extract<VocabPredicate, { kind: "time" }>,
  state: VocabPanelState,
  now: number,
): number | null {
  if (clause.stateKey !== undefined) {
    const selected = state[clause.stateKey];
    if (selected === undefined || selected === "") return null;
    const offset = parseVocabRelOffset(selected);
    return offset === null ? vocabTimeValue(selected) : now + offset;
  }
  if (clause.relMs !== undefined) return now + clause.relMs;
  return clause.at ?? null;
}

/**
 * Does this row survive the binding's `where`?
 *
 * A row that is not an object cannot answer a field comparison, so an ACTIVE
 * predicate drops it. With no active clause every row is kept, including that
 * one — which is exactly what an unfiltered binding has always done.
 */
export function evaluateVocabWhere(
  where: readonly VocabPredicate[] | undefined,
  row: unknown,
  state: VocabPanelState,
  now?: number,
): boolean {
  if (!where || where.length === 0) return true;
  const record = isRecord(row) ? row : {};
  const instant = now ?? Date.now();
  for (const clause of where) {
    const value = evaluateClause(clause, record, state, instant);
    // Inactive clauses are not votes. Only a clause that actually compared
    // something can drop a row.
    if (value === null) continue;
    if (!value || !isRecord(row)) return false;
  }
  return true;
}

/** Keep the rows a binding's `where` admits, in order. */
export function filterVocabRows(
  where: readonly VocabPredicate[] | undefined,
  values: readonly unknown[],
  state: VocabPanelState,
  now?: number,
): unknown[] {
  if (!where || where.length === 0) return [...values];
  // Read once for the whole pass. A `{"$rel": …}` clock sampled per row would
  // let two rows a microsecond apart land on different sides of the same
  // boundary, which is a filter that disagrees with itself.
  const instant = now ?? Date.now();
  return values.filter((value) => evaluateVocabWhere(where, value, state, instant));
}

/* ── Declarations and lifecycle ─────────────────────────────────────────── */

/**
 * A `segmented` node's option list.
 *
 * Duplicate values collapse — two options that set the same state are one
 * option with two labels, and the second would be unreachable. An option with
 * no `label` falls back to its own value, because a control whose choices have
 * no words is not a control; an option whose value is empty ("All") keeps its
 * label, which is the whole point of it.
 */
export function parseVocabStateOptions(raw: unknown): VocabStateOption[] {
  if (!Array.isArray(raw)) return [];
  const options: VocabStateOption[] = [];
  const seen = new Set<string>();
  for (const entry of raw.slice(0, VOCAB_STATE_LIMITS.maxStateOptions)) {
    if (!isRecord(entry)) continue;
    if (typeof entry.value !== "string") continue;
    const value = entry.value.trim().slice(0, VOCAB_STATE_LIMITS.maxStateIdChars);
    if (seen.has(value)) continue;
    const label = trimmed(entry.label)?.slice(0, VOCAB_STATE_LIMITS.maxStateIdChars)
      ?? (value === "" ? null : value);
    if (label === null) continue;
    seen.add(value);
    const badge = vocabStateBadgeText(entry.badge);
    options.push({ value, label, ...(badge !== undefined ? { badge } : {}) });
  }
  return options;
}

/** A state key. Same shape as a collection name, minus the `$` ADE reserves. */
export function parseVocabStateKey(raw: unknown): string | undefined {
  const key = trimmed(raw);
  if (key === null || key.startsWith("$")) return undefined;
  return key.slice(0, VOCAB_STATE_LIMITS.maxStateIdChars);
}

/**
 * A control's `optionsFrom`, or `undefined` when it is not a usable binding.
 *
 * `collection` and `valueField` are both required: without the first there is
 * nothing to read and without the second every row would resolve to the same
 * empty value, which is one option, not thirty. A malformed binding degrades to
 * "this control has only its literal options", which is a control that still
 * works — the same direction a broken `where` degrades in.
 */
export function parseVocabStateOptionsBinding(raw: unknown): VocabStateOptionsBinding | undefined {
  if (!isRecord(raw)) return undefined;
  const collection = trimmed(raw.collection)?.slice(0, VOCAB_STATE_LIMITS.maxStateIdChars);
  const valueField = trimmed(raw.valueField)?.slice(0, VOCAB_STATE_LIMITS.maxStateIdChars);
  if (collection === undefined || valueField === undefined) return undefined;
  const keyPrefix = trimmed(raw.keyPrefix)?.slice(0, VOCAB_STATE_LIMITS.maxStateIdChars);
  const labelField = trimmed(raw.labelField)?.slice(0, VOCAB_STATE_LIMITS.maxStateIdChars);
  return {
    collection,
    valueField,
    ...(keyPrefix !== undefined ? { keyPrefix } : {}),
    ...(labelField !== undefined ? { labelField } : {}),
  };
}

/**
 * A collection's rows as a control's options.
 *
 * Reads exactly two top-level fields of each row and coerces them the way a
 * predicate reads a field, not the way a cell is displayed — an option's value
 * is compared against a row's field by `where`, and `true` must compare as
 * `"true"` on both sides rather than as `"Yes"` on one of them.
 *
 * A row with no readable value is dropped rather than becoming a blank option:
 * the empty value is the "All" sentinel and a collection cannot be allowed to
 * mint a second one. Duplicates collapse, first row winning, exactly as a
 * literal list's do.
 */
export function vocabResolveStateOptions(
  binding: VocabStateOptionsBinding,
  rows: readonly { value: unknown }[] | null | undefined,
): VocabStateOption[] {
  if (!rows) return [];
  const options: VocabStateOption[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row.value)) continue;
    const value = vocabPredicateFieldText(row.value[binding.valueField])
      .slice(0, VOCAB_STATE_LIMITS.maxStateIdChars);
    if (value === "" || seen.has(value)) continue;
    const label = binding.labelField === undefined
      ? value
      : (trimmed(row.value[binding.labelField])?.slice(0, VOCAB_STATE_LIMITS.maxStateIdChars) ?? value);
    seen.add(value);
    const badge = vocabStateBadgeText(row.value.badge);
    options.push({ value, label, ...(badge !== undefined ? { badge } : {}) });
    if (options.length >= VOCAB_STATE_LIMITS.maxBoundStateOptions) break;
  }
  return options;
}

/**
 * The literal options and the resolved ones as one list, capped.
 *
 * Literals first because that is where the "All" sentinel lives and a reader
 * looks for it at the top; a resolved value that repeats a literal one loses,
 * because the literal is the option the author wrote a label for.
 */
export function vocabMergeStateOptions(
  literal: readonly VocabStateOption[],
  resolved: readonly VocabStateOption[],
): VocabStateOption[] {
  const options = [...literal];
  const seen = new Set(literal.map((option) => option.value));
  for (const option of resolved) {
    if (seen.has(option.value)) continue;
    seen.add(option.value);
    options.push(option);
    if (options.length >= VOCAB_STATE_LIMITS.maxBoundStateOptions) break;
  }
  return options;
}

/** How a segmented control is drawn. `toggle` needs exactly two options. */
export type VocabSegmentedStyle = "segmented" | "toggle";

/**
 * What a client actually draws for a state control, including the one form an
 * author cannot ask for.
 *
 * `menu` is computed, never declared. A strip of pills is the right picture for
 * three states and the wrong one for thirty projects, and the author of a
 * collection-bound control cannot know which they will get — the row count is
 * the reader's workspace, not the schema. So the decision is made from the
 * resolved list, here, once, and every surface reads it: over
 * {@link VOCAB_STATE_LIMITS.maxStateOptions} the control is a menu that names
 * the current choice, under it the strip it has always been.
 */
export type VocabStateControlStyle = VocabSegmentedStyle | "menu";

export function vocabStateControlStyle(
  declaration: Pick<VocabStateDeclaration, "options" | "style">,
): VocabStateControlStyle {
  if (declaration.options.length > VOCAB_STATE_LIMITS.maxStateOptions) return "menu";
  return declaration.style ?? "segmented";
}

export function parseVocabSegmentedStyle(
  raw: unknown,
  optionCount: number,
): VocabSegmentedStyle | undefined {
  const style = oneOf(typeof raw === "string" ? raw.trim() : raw, ["segmented", "toggle"] as const);
  if (style === null) return undefined;
  // A "toggle" with three options is a segmented control the author mislabelled.
  // Drawing it as a switch would hide an option, so the declaration loses.
  return style === "toggle" && optionCount !== 2 ? "segmented" : style;
}

/**
 * The initial value for one control: its `default` when that names a real
 * option, else the first option's value.
 *
 * Never `undefined`, so no client has to invent "nothing selected" — a closed
 * option list always has something selected, even when that something is the
 * empty "All".
 */
export function vocabStateInitial(options: readonly VocabStateOption[], raw: unknown): string {
  const declared = typeof raw === "string" ? raw.trim() : null;
  if (declared !== null && options.some((option) => option.value === declared)) return declared;
  return options[0]?.value ?? "";
}

/**
 * Every state key a panel declares, first declaration wins.
 *
 * First rather than last because the first one is the control the reader sees
 * highest on the page, and its default is the one they will assume is in force.
 * Over {@link VOCAB_STATE_LIMITS.maxStateKeys} the extras are dropped: their
 * controls still render and still set state, they simply share nothing with a
 * `where`, which is the honest failure for a panel that declared too many.
 */
export function vocabStateDeclarations(
  found: readonly VocabStateDeclaration[],
): VocabStateDeclaration[] {
  const byKey = new Map<string, VocabStateDeclaration>();
  for (const declaration of found) {
    if (byKey.has(declaration.stateKey)) continue;
    byKey.set(declaration.stateKey, declaration);
    if (byKey.size >= VOCAB_STATE_LIMITS.maxStateKeys) break;
  }
  return [...byKey.values()];
}

/** The state a freshly opened panel starts in. */
export function vocabInitialPanelState(
  declarations: readonly VocabStateDeclaration[],
): VocabPanelState {
  const state: Record<string, string> = {};
  for (const declaration of declarations) state[declaration.stateKey] = declaration.initial;
  return state;
}

/**
 * Identity of a panel's CONTROLS, not of its data.
 *
 * State is session-scoped and must survive a re-publish: a plugin that refreshes
 * its fleet rows republishes the whole panel every few seconds, and resetting
 * the filter on each one would make the control unusable. It must NOT survive a
 * change to the controls themselves, because an option that no longer exists
 * cannot stay selected. The signature is exactly the controls — keys, option
 * values, and their order — so a schema whose rows changed keeps the selection
 * and a schema whose filter changed starts over.
 *
 * A control whose options came from a collection signs its BINDING instead of
 * its resolved values, and that difference is the whole reason `optionsFrom` is
 * usable. Its options are data: a project created in another window, or the
 * second page of a fetch landing, would otherwise change the signature and drop
 * the reader's filter — an unusable control, for a change they did not make and
 * cannot see. The binding is what the author declared, so it moves only when the
 * schema does. The fine reconciliation still applies: a value that is no longer
 * an option falls back through {@link vocabNormalizePanelState}.
 */
export function vocabStateSignature(declarations: readonly VocabStateDeclaration[]): string {
  return JSON.stringify(
    declarations.map((declaration) => [
      declaration.stateKey,
      declaration.optionsFrom
        ? [
            "$from",
            declaration.optionsFrom.collection,
            declaration.optionsFrom.keyPrefix ?? "",
            declaration.optionsFrom.valueField,
            declaration.optionsFrom.labelField ?? "",
          ]
        : [declaration.initial, declaration.options.map((option) => option.value)],
    ]),
  );
}

/**
 * Carry a reader's selections onto a newly parsed panel.
 *
 * Keys the new schema does not declare are dropped, and a value that is no
 * longer an option falls back to that control's initial. Callers that also
 * compare {@link vocabStateSignature} get the coarse reset; this is the fine one,
 * and both are needed — the signature catches a control that vanished, this
 * catches a value inside one that did not.
 */
export function vocabNormalizePanelState(
  state: VocabPanelState | undefined,
  declarations: readonly VocabStateDeclaration[],
): VocabPanelState {
  const next: Record<string, string> = {};
  for (const declaration of declarations) {
    const current = state?.[declaration.stateKey];
    next[declaration.stateKey] = declaration.options.some((option) => option.value === current)
      ? (current as string)
      : declaration.initial;
  }
  return next;
}

/** Set one key, refusing a value the control never offered. */
export function vocabApplyStateChange(
  state: VocabPanelState,
  declaration: VocabStateDeclaration,
  value: string,
): VocabPanelState {
  if (!declaration.options.some((option) => option.value === value)) return state;
  if (state[declaration.stateKey] === value) return state;
  return { ...state, [declaration.stateKey]: value };
}

/**
 * The next option, wrapping. What ←/→ does in the TUI and what a tap on a
 * two-option toggle does everywhere.
 */
export function vocabCycleStateValue(
  declaration: VocabStateDeclaration,
  current: string,
  delta: number,
): string {
  const options = declaration.options;
  if (options.length === 0) return current;
  const index = options.findIndex((option) => option.value === current);
  const next = (((index < 0 ? 0 : index) + delta) % options.length + options.length) % options.length;
  return options[next]?.value ?? current;
}

/* ── Selection lifecycle ────────────────────────────────────────────────── */

/**
 * Every selectable list a panel declares, first declaration wins.
 *
 * The same rule and the same reason as {@link vocabStateDeclarations}: the first
 * one is the list the reader sees highest on the page, and a list past
 * {@link VOCAB_STATE_LIMITS.maxSelectionKeys} still draws its rows — it simply
 * draws no ticks and no bar, which is the honest failure for a panel that asked
 * for three selections.
 */
export function vocabSelectionDeclarations(
  found: readonly VocabSelectionDeclaration[],
): VocabSelectionDeclaration[] {
  const byKey = new Map<string, VocabSelectionDeclaration>();
  for (const declaration of found) {
    if (byKey.has(declaration.stateKey)) continue;
    byKey.set(declaration.stateKey, declaration);
    if (byKey.size >= VOCAB_STATE_LIMITS.maxSelectionKeys) break;
  }
  return [...byKey.values()];
}

/** The selection a freshly opened panel starts in: every list, nothing ticked. */
export function vocabInitialPanelSelection(
  declarations: readonly VocabSelectionDeclaration[],
): VocabPanelSelection {
  const selection: Record<string, readonly string[]> = {};
  for (const declaration of declarations) selection[declaration.stateKey] = [];
  return selection;
}

/**
 * Identity of a panel's selectable LISTS, not of their rows.
 *
 * Row keys are deliberately absent. A plugin republishing its rows every few
 * seconds changes which rows exist constantly, and a selection that emptied on
 * each of those would make a batch impossible to assemble — the same argument
 * that keeps {@link vocabStateSignature} off the data. What resets a selection
 * is the CONTROL changing: a different state key, a different cap, or a
 * different set of bulk actions, all of which mean the panel is offering
 * something other than what the reader ticked rows for.
 */
export function vocabSelectionSignature(
  declarations: readonly VocabSelectionDeclaration[],
): string {
  return JSON.stringify(
    declarations.map((declaration) => [declaration.stateKey, declaration.max, declaration.actionIds]),
  );
}

/**
 * Carry a reader's ticks onto a newly parsed panel.
 *
 * Keys the new schema does not declare are dropped and the cap is re-applied,
 * so a republish that lowered `max` cannot leave more rows ticked than the
 * control now allows. Row keys the panel no longer holds are NOT pruned here —
 * see {@link vocabSelectedRowKeys}, which is where a selection meets the rows
 * that actually rendered.
 */
export function vocabNormalizePanelSelection(
  selection: VocabPanelSelection | undefined,
  declarations: readonly VocabSelectionDeclaration[],
): VocabPanelSelection {
  const next: Record<string, readonly string[]> = {};
  for (const declaration of declarations) {
    const current = selection?.[declaration.stateKey] ?? [];
    const kept: string[] = [];
    for (const key of current) {
      if (typeof key !== "string" || key === "" || kept.includes(key)) continue;
      kept.push(key);
      if (kept.length >= declaration.max) break;
    }
    next[declaration.stateKey] = kept;
  }
  return next;
}

/**
 * Tick or untick one row.
 *
 * At the cap, ticking a new row is REFUSED rather than evicting the oldest one.
 * A silent eviction would take a row out of a batch the reader believes they
 * assembled, and the count on the bar is the only thing that could have told
 * them — untick is a gesture they have, a row vanishing from under them is not.
 * Unticking always works, cap or no cap.
 */
export function vocabToggleRowSelection(
  selection: VocabPanelSelection,
  declaration: VocabSelectionDeclaration,
  rowKey: string,
): VocabPanelSelection {
  if (rowKey === "") return selection;
  const current = selection[declaration.stateKey] ?? [];
  if (current.includes(rowKey)) {
    return { ...selection, [declaration.stateKey]: current.filter((key) => key !== rowKey) };
  }
  if (current.length >= declaration.max) return selection;
  return { ...selection, [declaration.stateKey]: [...current, rowKey] };
}

/**
 * Tick every row of a range, keeping what was already ticked.
 *
 * A union rather than a replacement: shift-clicking a second range must not
 * throw away the first one, which is what a reader assembling a batch out of
 * two clusters is doing. Fills to the cap and stops there, for the same reason
 * {@link vocabToggleRowSelection} refuses — the rows it could not take are the
 * tail of the range the reader can see, not rows it silently swapped out.
 */
export function vocabSelectRowRange(
  selection: VocabPanelSelection,
  declaration: VocabSelectionDeclaration,
  rowKeys: readonly string[],
): VocabPanelSelection {
  const current = selection[declaration.stateKey] ?? [];
  const next = [...current];
  for (const key of rowKeys) {
    if (key === "" || next.includes(key)) continue;
    if (next.length >= declaration.max) break;
    next.push(key);
  }
  return next.length === current.length
    ? selection
    : { ...selection, [declaration.stateKey]: next };
}

/** Untick everything in one list. What the bar's own Clear does. */
export function vocabClearRowSelection(
  selection: VocabPanelSelection,
  declaration: VocabSelectionDeclaration,
): VocabPanelSelection {
  const current = selection[declaration.stateKey] ?? [];
  if (current.length === 0) return selection;
  return { ...selection, [declaration.stateKey]: [] };
}

/**
 * The inclusive slice between two rows, in the order they are drawn.
 *
 * The range-anchor half of shift-click, shared rather than left to each client,
 * because "between" has two answers when the reader drags upwards and a client
 * that picked the other one would tick a different set from the same gesture.
 * An anchor or a target that is not on screen yields just the target, which is
 * what a plain click does — the honest reading of "extend from a row that is no
 * longer there".
 */
export function vocabRowRange(
  rowKeys: readonly string[],
  anchorKey: string | null | undefined,
  targetKey: string,
): string[] {
  const target = rowKeys.indexOf(targetKey);
  if (target < 0) return [];
  const anchor = anchorKey === null || anchorKey === undefined ? -1 : rowKeys.indexOf(anchorKey);
  if (anchor < 0) return [targetKey];
  const from = Math.min(anchor, target);
  const to = Math.max(anchor, target);
  return rowKeys.slice(from, to + 1);
}

/**
 * The ticked rows that are actually on screen, in the order they are drawn.
 *
 * What the bar counts and what a bulk action is handed, and the reason the
 * stored set is allowed to keep a key whose row is gone. A reader ticks four
 * rows, moves a filter that hides two of them, and presses "Create lanes": the
 * two they can see are the batch, because acting on a row nobody can see is the
 * one outcome a selection must never produce. Moving the filter back brings the
 * other two — and their ticks — with it, which a prune at filter time would not.
 */
export function vocabSelectedRowKeys(
  selection: VocabPanelSelection | undefined,
  stateKey: string,
  rowKeys: readonly string[],
): string[] {
  const ticked = selection?.[stateKey];
  if (!ticked || ticked.length === 0) return [];
  const wanted = new Set(ticked);
  return rowKeys.filter((key) => wanted.has(key));
}

/**
 * Apply a `{resetState}` to the selection.
 *
 * One verb for both maps. A plugin answering a bulk action with
 * `{resetState: true}` has almost always just acted on every ticked row, and
 * leaving them ticked would offer to do it again to rows that have moved on.
 * A named list resets only that key, exactly as a named state key does.
 */
export function vocabResetPanelSelection(
  selection: VocabPanelSelection,
  declarations: readonly VocabSelectionDeclaration[],
  reset: "all" | readonly string[],
): VocabPanelSelection {
  if (reset === "all") return vocabInitialPanelSelection(declarations);
  const next: Record<string, readonly string[]> = { ...selection };
  for (const key of reset) {
    if (declarations.some((declaration) => declaration.stateKey === key)) next[key] = [];
  }
  return next;
}

/* ── `$state` as a binding ──────────────────────────────────────────────── */

/**
 * The reserved collection name a panel binds to READ its own state.
 *
 * Rule 3 forbids interpolation, so a panel had no way to say "Showing: Active"
 * beside a filtered list — the words are in the option list and nothing could
 * reach them. `$state` reads like any other collection, so a `keyValue` bound to
 * it renders the current selection with the components that already exist. The
 * leading `$` is illegal in a real collection name (`PLUGIN_COLLECTION_NAME_PATTERN`),
 * so nothing can shadow it, exactly as with `$context`.
 */
export const VOCAB_STATE_COLLECTION = "$state";

/**
 * The state as bindable rows: one per declared key, in declaration order.
 *
 * The row's `key` is the control's label and its `value` is the SELECTED
 * OPTION'S label, not the raw value — a reader wants "Showing: Active", and
 * "Showing: FINISHED_WITH_ERROR" is the machine's half of the same fact.
 */
export function vocabStateRows(
  declarations: readonly VocabStateDeclaration[],
  state: VocabPanelState,
): { key: string; value: string }[] {
  return declarations.map((declaration) => {
    const current = state[declaration.stateKey] ?? declaration.initial;
    const option = declaration.options.find((entry) => entry.value === current);
    return {
      key: declaration.label ?? declaration.stateKey,
      value: option?.label ?? current,
    };
  });
}

/* ── Reporting state to the plugin ──────────────────────────────────────── */

/**
 * What rides on an action invoke under `state`, or `null` when the panel has
 * none.
 *
 * Reported so a "Refresh" button can respect the filter the reader is looking
 * at: without it the plugin refetches the whole fleet and the client re-filters,
 * which is correct but wasteful, and a plugin paginating an API cannot page the
 * filtered set at all. It travels as an ordinary flat-scalar object beside
 * `context`, so it adds no capability — the plugin already receives every
 * argument the panel declared.
 */
export function vocabStatePayload(state: VocabPanelState | undefined): Record<string, string> | null {
  if (!state) return null;
  const entries = Object.entries(state).filter(([, value]) => typeof value === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/**
 * `{resetState}` on an action result: `true` for every key, or a list of keys.
 *
 * The explicit reset in the lifecycle. A plugin that just archived everything
 * the "Active" filter was showing can put the reader back on "All" rather than
 * leaving them staring at an empty list they have to debug. Lives here rather
 * than in `sdk.ts` because it is a statement about panel state, and the panel
 * state contract is this module's.
 */
export function readPluginActionResetState(result: unknown): "all" | string[] | null {
  if (!isRecord(result)) return null;
  const raw = result.resetState;
  if (raw === true) return "all";
  if (!Array.isArray(raw)) return null;
  const keys: string[] = [];
  for (const entry of raw.slice(0, VOCAB_STATE_LIMITS.maxStateKeys)) {
    const key = parseVocabStateKey(entry);
    if (key !== undefined && !keys.includes(key)) keys.push(key);
  }
  return keys.length > 0 ? keys : null;
}

/** Apply a `{resetState}` to the current state. Unknown keys are ignored. */
export function vocabResetPanelState(
  state: VocabPanelState,
  declarations: readonly VocabStateDeclaration[],
  reset: "all" | readonly string[],
): VocabPanelState {
  if (reset === "all") return vocabInitialPanelState(declarations);
  const next: Record<string, string> = { ...state };
  for (const key of reset) {
    const declaration = declarations.find((entry) => entry.stateKey === key);
    if (declaration) next[key] = declaration.initial;
  }
  return next;
}

/**
 * An option's badge as text.
 *
 * A badge is almost always a COUNT, and a plugin that writes `badge: 12` means
 * `"12"`. Reading only strings there would silently drop the one thing the field
 * exists for, which is why it does not go through the plain string reader.
 */
export function vocabStateBadgeText(raw: unknown): string | undefined {
  const text = trimmed(raw);
  if (text !== null) return text.slice(0, VOCAB_STATE_LIMITS.maxStateIdChars);
  const value = finite(raw);
  return value === null ? undefined : String(value);
}
