/**
 * The node half of plugin vocabulary v1: the component types, their limits, and
 * the parser for each one.
 *
 * Split out of `vocabulary.ts`, which keeps the panel-level contract — version,
 * fallback, ceilings, `parsePluginPanel` — and re-exports everything here so no
 * importer has to know the seam exists. The split follows the degradation ladder
 * in that module's comment: panel-fatal damage is decided there, node-local
 * damage is decided here.
 *
 * The dependency runs one way only, `vocabulary.ts → vocabularyNodes.ts`, so
 * this module imports nothing from it. That is what lets `sockets.ts` keep
 * importing tones from `vocabulary.ts` without a cycle.
 *
 * {@link NODE_PARSERS} is the single list of what v1 renders. Every derived fact
 * — the component-name list, the known-component test, the parse dispatch — is
 * read off it, so adding a component is one entry rather than three edits that
 * can drift apart.
 */

import { bounded, finite, isRecord, oneOf, trimmed } from "./parse";
import {
  VOCAB_STATE_LIMITS,
  evaluateVocabWhere,
  parseVocabSegmentedStyle,
  parseVocabStateKey,
  parseVocabStateOptions,
  parseVocabWhere,
  vocabStateInitial,
  type VocabPanelState,
  type VocabPredicate,
  type VocabSegmentedStyle,
  type VocabStateDeclaration,
  type VocabStateOption,
} from "./vocabularyState";

/**
 * The client-state half of the contract — the `where` grammar, its evaluator and
 * the `segmented` control's option rules — re-exported so every client keeps
 * importing the vocabulary from one place. The dependency runs one way,
 * `vocabularyNodes.ts → vocabularyState.ts`, so that module imports nothing from
 * here.
 */
export * from "./vocabularyState";

/** Bumped only for a change old clients cannot safely interpret. */
export const VOCAB_VERSION = 1;

/**
 * Hard ceilings. Enforced identically on every surface so a schema that renders
 * on desktop cannot be rejected on iOS. Writers enforce the byte budget too —
 * see the `plugin_panels` budget in `dbMaintenanceApi.ts`.
 */
export const VOCAB_LIMITS = {
  /**
   * The panel-state ceilings — state keys, segmented options, and the `where`
   * predicate's depth, size and value list. Declared in `vocabularyState.ts`,
   * spread in here so a schema author reads one table rather than two.
   */
  ...VOCAB_STATE_LIMITS,
  /** Total nodes in a panel, counted through the whole tree. */
  maxNodes: 200,
  /** Nesting depth. Root `body` entries are depth 1. */
  maxDepth: 8,
  /** Serialized schema size. Matches the `schema_json` column budget. */
  maxSchemaBytes: 65_536,
  maxSelectOptions: 40,
  maxTableRows: 100,
  maxTableColumns: 8,
  maxListItems: 100,
  /**
   * Trailing buttons on one list row.
   *
   * Three, because a row is read at a glance and a fourth button is where a row
   * stops being a row. Anything past three belongs under
   * {@link VOCAB_LIMITS.maxListItemOverflow}, which is what it is for.
   *
   * A row's actions are NOT nodes — they cost nothing against `maxNodes`, which
   * is the whole point of putting them on the item instead of asking a panel to
   * hand-build a stack of buttons per row. A hundred rows of three buttons is
   * one node.
   */
  maxListItemActions: 3,
  /** Actions behind a row's overflow control. */
  maxListItemOverflow: 6,
  maxKeyValueRows: 60,
  maxChartSeries: 3,
  maxChartPoints: 200,
  maxFormFields: 24,
  maxTextChars: 4_000,
  maxLabelChars: 200,
  maxValueChars: 1_000,
  maxIdChars: 120,
  maxActionArgs: 16,
  /**
   * Action ids one binding may allow its rows to name. Large enough for a row
   * that offers a press plus a full set of trailing and overflow actions,
   * small enough that the allowlist stays something a reader could audit.
   */
  maxBindingAllowActions: 16,
  /**
   * A media `src` or `poster`. Its own ceiling, and its own reader — see
   * {@link vocabMediaSrc}.
   *
   * Larger than `maxValueChars` because a `data:` URI is a legitimate source
   * here and an inline thumbnail does not fit in a thousand characters; well
   * under `maxSchemaBytes` because a panel that spends its whole budget on one
   * image has nothing left to say about it.
   */
  maxSrcChars: 8_192,
} as const;

/**
 * Open component-name union. See rule 1 of the stability promise in
 * `vocabulary.ts`: this is deliberately not a closed union, and clients MUST
 * tolerate names they do not know rather than treating them as parse failures.
 */
export type VocabComponentName =
  | "stack"
  | "text"
  | "badge"
  | "button"
  | "list"
  | "table"
  | "form"
  | "chart"
  | "video"
  | "image"
  | "divider"
  | "keyValue"
  | "emptyState"
  | "segmented"
  | (string & {});

/**
 * Semantic tone. No `danger`/red — a failure is amber, the same house rule
 * stated at the top of `../adeCard.ts`. {@link normalizeVocabTone} folds any
 * red-ish value an author invents into `warning` so a payload cannot bypass it.
 */
export type VocabTone = "neutral" | "accent" | "success" | "warning";

export function normalizeVocabTone(value: unknown): VocabTone {
  const tone = typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (tone) {
    case "accent":
    case "info":
      return "accent";
    case "success":
    case "ok":
    case "pass":
    case "passed":
      return "success";
    case "warning":
    case "warn":
    case "danger":
    case "error":
    case "critical":
    case "fail":
    case "failed":
    case "red":
      return "warning";
    default:
      return "neutral";
  }
}

/* ── Data binding ───────────────────────────────────────────────────────── */

/**
 * A reference into the plugin's own `plugin_collections` rows.
 *
 * The rows are expected to already be in render shape for the component that
 * binds them — a `list` binding reads `{title, subtitle?, ...}` values, a
 * `table` binding reads column-keyed records. The renderer does no reshaping:
 * per rule 3, the plugin materializes on its machine and the client draws.
 */
export type VocabBinding = {
  collection: string;
  /** Restricts to keys with this prefix, so one collection can back several panels. */
  keyPrefix?: string;
  /** Client-side cap on rows pulled. Clamped to the component's own limit. */
  limit?: number;
  /**
   * The action ids a row from this collection may name.
   *
   * A bound row used to carry no action at all, because stored data that could
   * mint one would let a collection introduce a button the panel never showed
   * the reader. The allowlist keeps that invariant and makes the row usable:
   * the panel author still chooses every action a reader can press, and the
   * data decides only which of those a given row offers. A row naming an id
   * outside this list is coerced to no action, exactly as before.
   *
   * Absent means the old behaviour — a bound row carries no action.
   */
  allowActions?: string[];
  /**
   * Keep only the rows this predicate admits, evaluated ON THE CLIENT against
   * the panel's own `segmented` state.
   *
   * This is what makes a filter cost zero round trips: the plugin materializes
   * every row once with `status`, `laneId` and `archived` already computed on
   * its machine, and changing the control re-runs nothing but a string compare.
   * The grammar is fixed and data-only — see `vocabularyState.ts` for what it
   * can and cannot express, and why that is still rule 3.
   *
   * Absent means unfiltered, and so does a `where` whose every clause was
   * unusable: a filter that fails shows too much, never too little.
   */
  where?: VocabPredicate[];
};

/**
 * A reference to an action on the owning plugin, dispatched through the single
 * `plugin` action domain as `{pluginId, action, args}` (design decision D1).
 * `args` is flat scalars only — no nesting, nothing that could smuggle code.
 */
export type VocabAction = {
  action: string;
  args?: Record<string, string | number | boolean>;
  /** When set, the client confirms with this sentence before dispatching. */
  confirm?: string;
};

/* ── Nodes ──────────────────────────────────────────────────────────────── */

export type VocabStackNode = {
  component: "stack";
  direction?: "vertical" | "horizontal";
  gap?: "none" | "sm" | "md" | "lg";
  align?: "start" | "center" | "end" | "stretch";
  wrap?: boolean;
  children: VocabNode[];
};

export type VocabTextNode = {
  component: "text";
  text: string;
  /** `code` is the ONLY monospace affordance in the vocabulary. */
  variant?: "title" | "subtitle" | "body" | "caption" | "code";
  tone?: VocabTone;
};

export type VocabBadgeNode = {
  component: "badge";
  text: string;
  tone?: VocabTone;
  icon?: string;
};

export type VocabButtonNode = {
  component: "button";
  label: string;
  onPress: VocabAction;
  kind?: "primary" | "default" | "quiet";
  icon?: string;
  disabled?: boolean;
};

/**
 * A chip beside a list row's title.
 *
 * The same shape as a `badge` node without its component name, so a status chip
 * reads and renders identically whether it stands alone or rides on a row.
 */
export type VocabListItemBadge = {
  text: string;
  tone?: VocabTone;
  icon?: string;
};

/**
 * A trailing or overflow button on a list row: a {@link VocabAction} plus how to
 * draw it.
 *
 * A `label` is required — a button on a row has no other way to say what it
 * does, and an icon alone is a guess. `confirm` rides on the action half, so a
 * destructive row button asks first exactly as a `button` node does.
 */
export type VocabListItemAction = VocabAction & {
  label: string;
  kind?: "primary" | "default" | "quiet";
  icon?: string;
};

/**
 * One row of a `list`. Also the row shape a `list` binding must materialize.
 *
 * A row is deliberately richer than the sum of nodes it would take to build one
 * by hand. A panel that drew a status chip, a monospace id and three buttons per
 * row out of `stack`, `badge`, `text` and `button` nodes spent about seven nodes
 * a row, which meant `maxNodes: 200` capped the panel at roughly 27 rows. As one
 * item it is one node's worth of budget for the whole list, so `maxListItems`
 * (100) becomes the real ceiling — see {@link VOCAB_LIMITS.maxListItemActions}.
 *
 * Every field past `title` is optional, so a row written before any of them
 * existed still parses to exactly what it always did.
 */
export type VocabListItem = {
  title: string;
  subtitle?: string;
  meta?: string;
  tone?: VocabTone;
  icon?: string;
  onPress?: VocabAction;
  /** A chip beside the title. */
  badge?: VocabListItemBadge;
  /** Monospace, under `subtitle`. For an id, a branch, a commit — a thing to compare. */
  mono?: string;
  /** Trailing buttons, up to {@link VOCAB_LIMITS.maxListItemActions}. */
  actions?: VocabListItemAction[];
  /** Behind an overflow control, up to {@link VOCAB_LIMITS.maxListItemOverflow}. */
  overflow?: VocabListItemAction[];
};

export type VocabListNode = {
  component: "list";
  items?: VocabListItem[];
  bind?: VocabBinding;
  emptyText?: string;
};

export type VocabTableColumn = {
  key: string;
  label: string;
  align?: "left" | "right";
};

export type VocabTableNode = {
  component: "table";
  columns: VocabTableColumn[];
  rows?: Record<string, string | number>[];
  bind?: VocabBinding;
  emptyText?: string;
};

export type VocabFieldKind = "text" | "secret" | "select" | "toggle" | "number";

export type VocabSelectOption = { value: string; label?: string };

export type VocabField = {
  kind: VocabFieldKind;
  id: string;
  label: string;
  help?: string;
  placeholder?: string;
  /** `select` only. */
  options?: VocabSelectOption[];
  /** `number` only. */
  min?: number;
  max?: number;
  step?: number;
  value?: string | number | boolean;
};

export type VocabFormNode = {
  component: "form";
  fields: VocabField[];
  submit: { label: string; onPress: VocabAction };
};

export type VocabChartPoint = { x: string | number; y: number };

export type VocabChartSeries = {
  id: string;
  label?: string;
  tone?: VocabTone;
  points: VocabChartPoint[];
};

/**
 * Deliberately sparse: one or a few series, no axes configuration, no legends
 * to lay out. Anything richer belongs in a real analytics surface, not in a
 * schema a phone has to draw.
 */
export type VocabChartNode = {
  component: "chart";
  kind: "line" | "bar";
  series: VocabChartSeries[];
  title?: string;
  emptyText?: string;
};

export type VocabVideoNode = {
  component: "video";
  src: string;
  poster?: string;
  title?: string;
};

export type VocabImageNode = {
  component: "image";
  src: string;
  alt: string;
  maxHeight?: number;
};

export type VocabDividerNode = {
  component: "divider";
  label?: string;
};

export type VocabKeyValueRow = {
  key: string;
  value: string;
  tone?: VocabTone;
};

export type VocabKeyValueNode = {
  component: "keyValue";
  rows?: VocabKeyValueRow[];
  bind?: VocabBinding;
  emptyText?: string;
};

/**
 * A closed set of options with one selected, owning a named piece of CLIENT
 * state.
 *
 * The only node in the vocabulary that holds state, and deliberately the
 * smallest thing that could: an option list, a default, and a key other nodes
 * name. It dispatches nothing by itself — a change re-renders the panel from
 * data already on the client, which is the entire point. `onChange` exists for
 * the plugin that also wants to know, and is not needed for the filter to work.
 *
 * A `toggle` is this node with two options rather than a second component,
 * because a switch and a two-option segmented control are the same choice drawn
 * differently, and two components would be two parsers, two limits and two
 * chances for a client to disagree.
 */
export type VocabSegmentedNode = {
  component: "segmented";
  /** Panel-local state key. Same shape as a collection name; no leading `$`. */
  stateKey: string;
  /** Shown beside the control, and used as the `$state` row's key. */
  label?: string;
  options: VocabStateOption[];
  /** Selected on first render. Falls back to the first option. */
  default?: string;
  style?: VocabSegmentedStyle;
  /** Also dispatch this action on change, for a plugin that wants to know. */
  onChange?: VocabAction;
};

/**
 * A parsed `segmented` node as the state key it declares.
 *
 * The node is what renders and the declaration is what a host holds, and they
 * are deliberately different shapes: a host needs the key, the options and the
 * initial value with nothing optional left to resolve, so that
 * {@link vocabInitialPanelState} and {@link vocabStateSignature} never have to
 * repeat the `default` fallback and never disagree about it.
 */
export function vocabSegmentedDeclaration(node: VocabSegmentedNode): VocabStateDeclaration {
  return {
    stateKey: node.stateKey,
    options: node.options,
    initial: vocabStateInitial(node.options, node.default),
    ...(node.label !== undefined ? { label: node.label } : {}),
  };
}

export type VocabEmptyStateNode = {
  component: "emptyState";
  title: string;
  description?: string;
  icon?: string;
  action?: { label: string; onPress: VocabAction };
};

/**
 * A component name this build does not know. Carries the name so the renderer
 * can say which one, and so a later version can start rendering it without any
 * change to the parse contract. This is the forward-compat path (rule 1).
 */
export type VocabUnknownNode = {
  component: "__unknown";
  /** The name the schema actually used. */
  name: string;
};

/**
 * A known component whose payload failed validation. The node is replaced
 * rather than the panel dropped, so one bad row cannot blank a working panel.
 */
export type VocabInvalidNode = {
  component: "__invalid";
  name: string;
  reason: string;
};

export type VocabNode =
  | VocabStackNode
  | VocabTextNode
  | VocabBadgeNode
  | VocabButtonNode
  | VocabListNode
  | VocabTableNode
  | VocabFormNode
  | VocabChartNode
  | VocabVideoNode
  | VocabImageNode
  | VocabDividerNode
  | VocabKeyValueNode
  | VocabEmptyStateNode
  | VocabSegmentedNode
  | VocabUnknownNode
  | VocabInvalidNode;

/* ── Errors ─────────────────────────────────────────────────────────────── */

export type VocabErrorCode =
  | "not_json"
  | "not_object"
  | "version_unsupported"
  | "schema_too_large"
  | "fallback_missing"
  | "body_missing"
  | "too_many_nodes"
  | "too_deep"
  | "unknown_component"
  | "invalid_node"
  | "invalid_binding";

export type VocabError = {
  code: VocabErrorCode;
  /** JSON-ish path to the offending value, e.g. `body[2].children[0]`. */
  path: string;
  message: string;
};

/* ── Readers ────────────────────────────────────────────────────────────── */

/**
 * A descriptive string, shortened rather than refused.
 *
 * The visible ellipsis is the point: a title cut at 200 characters that ends
 * mid-word reads as data corruption, one that ends in `…` reads as a limit.
 * Built on `parse.ts` so trimming and emptiness mean the same here as in every
 * other plugin contract module.
 */
export function vocabString(value: unknown, maxChars: number): string | undefined {
  const text = trimmed(value);
  if (text === null) return undefined;
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * A media source, REFUSED when it is too long rather than shortened.
 *
 * The one field in the vocabulary where {@link vocabString} was actively
 * harmful. A `data:` URI cut at the value ceiling still begins `data:image/png`,
 * so it passes the renderer's scheme check on every surface and then decodes to
 * nothing — a broken image with no error, from a payload that was fine. The
 * appended ellipsis made it worse by corrupting the base64 even where the
 * truncation happened to land on a byte boundary.
 *
 * So this reader draws the opposite conclusion from the same fact: a source
 * over the ceiling is not a long source, it is an unusable one, and the node
 * parsers turn `undefined` here into their own honest empty state.
 */
export function vocabMediaSrc(value: unknown): string | undefined {
  return bounded(value, VOCAB_LIMITS.maxSrcChars) ?? undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return finite(value) ?? undefined;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return oneOf(typeof value === "string" ? value.trim() : value, allowed) ?? undefined;
}

/* ── Bound rows ─────────────────────────────────────────────────────────── */

/**
 * Stable key for a binding, so one fetch serves every node that reads it.
 *
 * NUL separates the two halves because it is the one character neither a
 * collection name nor a key prefix can contain. With a printable separator,
 * `{collection: "a", keyPrefix: "b:c"}` and `{collection: "a:b", keyPrefix: "c"}`
 * would produce the same key and silently share one fetch.
 */
export function bindingKey(binding: { collection: string; keyPrefix?: string }): string {
  return `${binding.collection}\u0000${binding.keyPrefix ?? ""}`;
}

/**
 * The rows a binding actually yields: filtered by its `where`, then capped by
 * its own `limit`.
 *
 * `null` — not `[]` — when the fetch has not landed, so a component can tell
 * "nothing yet" from "nothing there" and show its `emptyText` only for the
 * second.
 *
 * Filter BEFORE the cap, always. Capping first would filter a truncated window,
 * so a list showing 20 of 100 rows would find three matches in the first twenty
 * and report three — a wrong answer that looks like a right one. Every client
 * calls this one function, so the order cannot differ between them.
 */
export function boundRowValues(
  binding: VocabBinding | undefined,
  rows: readonly { value: unknown }[] | undefined,
  state?: VocabPanelState,
  now?: number,
): unknown[] | null {
  if (!binding || !rows) return null;
  let values = rows.map((row) => row.value);
  if (binding.where && binding.where.length > 0) {
    const current = state ?? {};
    // One clock for the whole pass, so a `since` boundary cannot fall between
    // two rows of the same render. Callers pass `now` only in tests.
    const instant = now ?? Date.now();
    values = values.filter((value) => evaluateVocabWhere(binding.where, value, current, instant));
  }
  const limit = binding.limit;
  return typeof limit === "number" && limit > 0 ? values.slice(0, limit) : values;
}

/**
 * One cell of bound data as text.
 *
 * Bound rows arrive from `plugin_collections` as arbitrary JSON, and every
 * surface used to make up its own mind about the non-string cases: a numeric
 * `42` rendered as `42` on desktop and as blank in the TUI, from two coercers
 * that were each described as mirroring the other. This is the one answer.
 */
export function vocabCellText(value: unknown): string {
  if (typeof value === "string") return value.trim().slice(0, VOCAB_LIMITS.maxValueChars);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return "";
}

/**
 * The action a bound row may carry, or `null`.
 *
 * An action is something a panel schema declares. A collection row that could
 * mint one freely would let stored data introduce a button the panel never
 * showed the reader, so a row's action survives only when the binding's
 * `allowActions` names its id. A binding that declares no allowlist yields no
 * action at all, which is what every bound row did before the allowlist
 * existed.
 *
 * Every client applies this one function, so a bound row cannot be live on one
 * client and inert on another.
 */
export function boundRowAction(
  raw: unknown,
  allowActions: readonly string[] | undefined,
): VocabAction | null {
  if (!allowActions || allowActions.length === 0) return null;
  const action = parseAction(raw);
  if (!action) return null;
  return allowActions.includes(action.action) ? action : null;
}

/**
 * A bound row as a `list` item.
 *
 * Every action on the row — `onPress`, `actions` and `overflow` alike — is read
 * only through {@link boundRowAction}, so a row can press exactly the ids the
 * panel's binding allowed and nothing else. One gate rather than three, because
 * a collection that could reach an undeclared action through a trailing button
 * would have made `onPress` the only door anybody guarded.
 */
export function coerceBoundListItem(
  value: unknown,
  allowActions?: readonly string[],
): VocabListItem | null {
  return readListItem(value, (raw) => boundRowAction(raw, allowActions));
}

/** A bound row as a `keyValue` row. A row with no key is not a row. */
export function coerceBoundKeyValueRow(value: unknown): VocabKeyValueRow | null {
  if (!isRecord(value)) return null;
  const key = vocabString(value.key, VOCAB_LIMITS.maxLabelChars);
  if (key === undefined) return null;
  return {
    key,
    value: vocabCellText(value.value),
    ...(value.tone !== undefined ? { tone: normalizeVocabTone(value.tone) } : {}),
  };
}

/** A bound row as a `table` row: exactly the declared columns, as text. */
export function coerceBoundTableRow(
  value: unknown,
  columns: readonly VocabTableColumn[],
): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const row: Record<string, string> = {};
  for (const column of columns) row[column.key] = vocabCellText(value[column.key]);
  return row;
}

/* ── Node parsing ───────────────────────────────────────────────────────── */

/** Counters shared across a whole panel walk, so a wide panel is capped like a deep one. */
export type VocabParseState = {
  warnings: VocabError[];
  nodeCount: number;
  overflowed: boolean;
};

/**
 * What a node parser is handed besides its own payload.
 *
 * The three callbacks are the only things a parser cannot do on its own: record
 * a warning, recurse (which needs the depth and node budget), and read a
 * binding (which warns on its own path).
 */
export type VocabNodeParseContext = {
  /** JSON-ish path of the node being parsed. */
  path: string;
  /** Replace this node with an explained placeholder. */
  invalid: (reason: string) => VocabInvalidNode;
  /** Parse a child. `null` once a ceiling stopped the walk — stop reading siblings. */
  child: (raw: unknown, index: number) => VocabNode | null;
  /** Read this node's `bind`. `null` when absent or malformed. */
  binding: (raw: unknown) => VocabBinding | null;
};

export type VocabNodeParser = (
  raw: Record<string, unknown>,
  ctx: VocabNodeParseContext,
) => VocabNode;

function parseAction(raw: unknown): VocabAction | null {
  if (!isRecord(raw)) return null;
  const action = vocabString(raw.action, VOCAB_LIMITS.maxIdChars);
  if (action === undefined) return null;
  const confirm = vocabString(raw.confirm, VOCAB_LIMITS.maxTextChars);
  let args: Record<string, string | number | boolean> | undefined;
  if (isRecord(raw.args)) {
    const entries = Object.entries(raw.args).slice(0, VOCAB_LIMITS.maxActionArgs);
    const collected: Record<string, string | number | boolean> = {};
    for (const [key, value] of entries) {
      // Scalars only. A nested object here is the seam where "data, never code"
      // would start to leak, so it is dropped rather than passed through.
      if (typeof value === "string") collected[key] = value.slice(0, VOCAB_LIMITS.maxValueChars);
      else if (typeof value === "number" && Number.isFinite(value)) collected[key] = value;
      else if (typeof value === "boolean") collected[key] = value;
    }
    if (Object.keys(collected).length > 0) args = collected;
  }
  return {
    action,
    ...(args !== undefined ? { args } : {}),
    ...(confirm !== undefined ? { confirm } : {}),
  };
}

/**
 * How a list row's actions are admitted.
 *
 * The one difference between a row a panel declared and a row a collection
 * supplied. A declared row's actions are the panel author's own words, so they
 * pass through {@link parseAction}; a bound row's are stored data, so they pass
 * through {@link boundRowAction} and survive only when the binding allowed the
 * id. Everything else about reading a row is identical, and shared, so the two
 * kinds of row cannot drift into different shapes.
 */
type VocabActionGate = (raw: unknown) => VocabAction | null;

/** A row's status chip. Dropped whole when it has no text to show. */
function parseListItemBadge(raw: unknown): VocabListItemBadge | null {
  if (!isRecord(raw)) return null;
  const text = vocabString(raw.text, VOCAB_LIMITS.maxLabelChars);
  if (text === undefined) return null;
  const icon = vocabString(raw.icon, VOCAB_LIMITS.maxIdChars);
  return {
    text,
    ...(raw.tone !== undefined ? { tone: normalizeVocabTone(raw.tone) } : {}),
    ...(icon !== undefined ? { icon } : {}),
  };
}

/** One trailing or overflow button. Needs both an admitted action and a label. */
function parseListItemAction(raw: unknown, gate: VocabActionGate): VocabListItemAction | null {
  if (!isRecord(raw)) return null;
  const action = gate(raw);
  if (action === null) return null;
  const label = vocabString(raw.label, VOCAB_LIMITS.maxLabelChars);
  if (label === undefined) return null;
  const kind = enumValue(raw.kind, ["primary", "default", "quiet"] as const);
  const icon = vocabString(raw.icon, VOCAB_LIMITS.maxIdChars);
  return {
    ...action,
    label,
    ...(kind !== undefined ? { kind } : {}),
    ...(icon !== undefined ? { icon } : {}),
  };
}

/**
 * A row's `actions` or `overflow`, capped at `max`.
 *
 * The cap counts what SURVIVED rather than what was offered, so a refused entry
 * does not spend a slot a later valid one needed. That matters most for a bound
 * row, where an action the binding did not allow would otherwise silently take
 * the place of one it did. Every client counts the same way.
 *
 * `undefined` rather than `[]` when nothing survived, so a row with an empty
 * `actions` array is indistinguishable from a row that declared none — which is
 * what it is.
 */
function parseListItemActions(
  raw: unknown,
  max: number,
  gate: VocabActionGate,
): VocabListItemAction[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const parsed: VocabListItemAction[] = [];
  for (const entry of raw) {
    const action = parseListItemAction(entry, gate);
    if (action === null) continue;
    parsed.push(action);
    if (parsed.length >= max) break;
  }
  return parsed.length > 0 ? parsed : undefined;
}

/**
 * One list row, however it arrived.
 *
 * Shared by {@link parseListItem} and {@link coerceBoundListItem} so a declared
 * row and a bound row read every field the same way and differ only in `gate`.
 */
function readListItem(raw: unknown, gate: VocabActionGate): VocabListItem | null {
  if (!isRecord(raw)) return null;
  const title = vocabString(raw.title, VOCAB_LIMITS.maxLabelChars);
  if (title === undefined) return null;
  const subtitle = vocabString(raw.subtitle, VOCAB_LIMITS.maxValueChars);
  const meta = vocabString(raw.meta, VOCAB_LIMITS.maxLabelChars);
  const icon = vocabString(raw.icon, VOCAB_LIMITS.maxIdChars);
  const mono = vocabString(raw.mono, VOCAB_LIMITS.maxValueChars);
  const onPress = gate(raw.onPress);
  const badge = parseListItemBadge(raw.badge);
  const actions = parseListItemActions(raw.actions, VOCAB_LIMITS.maxListItemActions, gate);
  const overflow = parseListItemActions(raw.overflow, VOCAB_LIMITS.maxListItemOverflow, gate);
  return {
    title,
    ...(subtitle !== undefined ? { subtitle } : {}),
    ...(meta !== undefined ? { meta } : {}),
    ...(raw.tone !== undefined ? { tone: normalizeVocabTone(raw.tone) } : {}),
    ...(icon !== undefined ? { icon } : {}),
    ...(onPress !== null ? { onPress } : {}),
    ...(badge !== null ? { badge } : {}),
    ...(mono !== undefined ? { mono } : {}),
    ...(actions !== undefined ? { actions } : {}),
    ...(overflow !== undefined ? { overflow } : {}),
  };
}

function parseListItem(raw: unknown): VocabListItem | null {
  return readListItem(raw, parseAction);
}

function parseField(raw: unknown): VocabField | null {
  if (!isRecord(raw)) return null;
  const kind = enumValue(raw.kind, ["text", "secret", "select", "toggle", "number"] as const);
  const id = vocabString(raw.id, VOCAB_LIMITS.maxIdChars);
  const label = vocabString(raw.label, VOCAB_LIMITS.maxLabelChars);
  if (kind === undefined || id === undefined || label === undefined) return null;

  const help = vocabString(raw.help, VOCAB_LIMITS.maxValueChars);
  const placeholder = vocabString(raw.placeholder, VOCAB_LIMITS.maxLabelChars);
  const base = {
    kind,
    id,
    label,
    ...(help !== undefined ? { help } : {}),
    ...(placeholder !== undefined ? { placeholder } : {}),
  };

  if (kind === "select") {
    if (!Array.isArray(raw.options) || raw.options.length === 0) return null;
    if (raw.options.length > VOCAB_LIMITS.maxSelectOptions) return null;
    const options: VocabSelectOption[] = [];
    const seen = new Set<string>();
    for (const entry of raw.options) {
      if (!isRecord(entry)) return null;
      const value = vocabString(entry.value, VOCAB_LIMITS.maxValueChars);
      if (value === undefined || seen.has(value)) return null;
      seen.add(value);
      const optionLabel = vocabString(entry.label, VOCAB_LIMITS.maxLabelChars);
      options.push(optionLabel !== undefined ? { value, label: optionLabel } : { value });
    }
    const value = vocabString(raw.value, VOCAB_LIMITS.maxValueChars);
    return {
      ...base,
      options,
      ...(value !== undefined && options.some((option) => option.value === value) ? { value } : {}),
    };
  }

  if (kind === "number") {
    const min = finiteNumber(raw.min);
    const max = finiteNumber(raw.max);
    const step = finiteNumber(raw.step);
    if (min !== undefined && max !== undefined && min >= max) return null;
    if (step !== undefined && step <= 0) return null;
    const value = finiteNumber(raw.value);
    return {
      ...base,
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      ...(step !== undefined ? { step } : {}),
      ...(value !== undefined ? { value } : {}),
    };
  }

  if (kind === "toggle") {
    return { ...base, ...(typeof raw.value === "boolean" ? { value: raw.value } : {}) };
  }

  // text | secret. A `secret` value is never echoed back into a schema — the
  // host redacts it — so a supplied `value` is ignored for that kind.
  const value = kind === "text" ? vocabString(raw.value, VOCAB_LIMITS.maxValueChars) : undefined;
  return { ...base, ...(value !== undefined ? { value } : {}) };
}

function coerceTableRow(
  row: Record<string, unknown>,
  columns: VocabTableColumn[],
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const column of columns) {
    const value = row[column.key];
    if (typeof value === "string") out[column.key] = value.slice(0, VOCAB_LIMITS.maxValueChars);
    else if (typeof value === "number" && Number.isFinite(value)) out[column.key] = value;
    else if (typeof value === "boolean") out[column.key] = value ? "Yes" : "No";
    else out[column.key] = "";
  }
  return out;
}

/**
 * Every component v1 renders, and how each one reads its payload.
 *
 * Declaration order is the order {@link VOCAB_COMPONENTS_V1} publishes, so it
 * matches the union in {@link VocabComponentName}. Adding a component is one
 * entry here; nothing else needs editing.
 */
export const NODE_PARSERS: Record<string, VocabNodeParser> = {
  stack: (raw, ctx) => {
    const rawChildren = Array.isArray(raw.children) ? raw.children : [];
    const children: VocabNode[] = [];
    for (let index = 0; index < rawChildren.length; index += 1) {
      const child = ctx.child(rawChildren[index], index);
      if (child === null) break;
      children.push(child);
    }
    const direction = enumValue(raw.direction, ["vertical", "horizontal"] as const);
    const gap = enumValue(raw.gap, ["none", "sm", "md", "lg"] as const);
    const align = enumValue(raw.align, ["start", "center", "end", "stretch"] as const);
    return {
      component: "stack",
      ...(direction !== undefined ? { direction } : {}),
      ...(gap !== undefined ? { gap } : {}),
      ...(align !== undefined ? { align } : {}),
      ...(typeof raw.wrap === "boolean" ? { wrap: raw.wrap } : {}),
      children,
    };
  },

  text: (raw, ctx) => {
    const text = vocabString(raw.text, VOCAB_LIMITS.maxTextChars);
    if (text === undefined) return ctx.invalid("`text` is required");
    const variant = enumValue(raw.variant, ["title", "subtitle", "body", "caption", "code"] as const);
    return {
      component: "text",
      text,
      ...(variant !== undefined ? { variant } : {}),
      ...(raw.tone !== undefined ? { tone: normalizeVocabTone(raw.tone) } : {}),
    };
  },

  badge: (raw, ctx) => {
    const text = vocabString(raw.text, VOCAB_LIMITS.maxLabelChars);
    if (text === undefined) return ctx.invalid("`text` is required");
    const icon = vocabString(raw.icon, VOCAB_LIMITS.maxIdChars);
    return {
      component: "badge",
      text,
      tone: normalizeVocabTone(raw.tone),
      ...(icon !== undefined ? { icon } : {}),
    };
  },

  button: (raw, ctx) => {
    const label = vocabString(raw.label, VOCAB_LIMITS.maxLabelChars);
    const onPress = parseAction(raw.onPress);
    if (label === undefined) return ctx.invalid("`label` is required");
    if (onPress === null) return ctx.invalid("`onPress` needs an `action` id");
    const kind = enumValue(raw.kind, ["primary", "default", "quiet"] as const);
    const icon = vocabString(raw.icon, VOCAB_LIMITS.maxIdChars);
    return {
      component: "button",
      label,
      onPress,
      ...(kind !== undefined ? { kind } : {}),
      ...(icon !== undefined ? { icon } : {}),
      ...(typeof raw.disabled === "boolean" ? { disabled: raw.disabled } : {}),
    };
  },

  list: (raw, ctx) => {
    const bind = raw.bind !== undefined ? ctx.binding(raw.bind) : null;
    let items: VocabListItem[] | undefined;
    if (Array.isArray(raw.items)) {
      items = raw.items
        .slice(0, VOCAB_LIMITS.maxListItems)
        .map((entry) => parseListItem(entry))
        .filter((entry): entry is VocabListItem => entry !== null);
    }
    if (items === undefined && bind === null) return ctx.invalid("needs `items` or a `bind`");
    const emptyText = vocabString(raw.emptyText, VOCAB_LIMITS.maxValueChars);
    return {
      component: "list",
      ...(items !== undefined ? { items } : {}),
      ...(bind !== null ? { bind } : {}),
      ...(emptyText !== undefined ? { emptyText } : {}),
    };
  },

  table: (raw, ctx) => {
    if (!Array.isArray(raw.columns) || raw.columns.length === 0) {
      return ctx.invalid("`columns` is required");
    }
    const columns: VocabTableColumn[] = [];
    for (const entry of raw.columns.slice(0, VOCAB_LIMITS.maxTableColumns)) {
      if (!isRecord(entry)) continue;
      const key = vocabString(entry.key, VOCAB_LIMITS.maxIdChars);
      const columnLabel = vocabString(entry.label, VOCAB_LIMITS.maxLabelChars);
      if (key === undefined || columnLabel === undefined) continue;
      const align = enumValue(entry.align, ["left", "right"] as const);
      columns.push({ key, label: columnLabel, ...(align !== undefined ? { align } : {}) });
    }
    if (columns.length === 0) return ctx.invalid("no usable columns");
    const bind = raw.bind !== undefined ? ctx.binding(raw.bind) : null;
    let rows: Record<string, string | number>[] | undefined;
    if (Array.isArray(raw.rows)) {
      rows = raw.rows
        .slice(0, VOCAB_LIMITS.maxTableRows)
        .filter(isRecord)
        .map((row) => coerceTableRow(row, columns));
    }
    if (rows === undefined && bind === null) return ctx.invalid("needs `rows` or a `bind`");
    const emptyText = vocabString(raw.emptyText, VOCAB_LIMITS.maxValueChars);
    return {
      component: "table",
      columns,
      ...(rows !== undefined ? { rows } : {}),
      ...(bind !== null ? { bind } : {}),
      ...(emptyText !== undefined ? { emptyText } : {}),
    };
  },

  form: (raw, ctx) => {
    if (!Array.isArray(raw.fields) || raw.fields.length === 0) {
      return ctx.invalid("`fields` is required");
    }
    const fields: VocabField[] = [];
    const ids = new Set<string>();
    for (const entry of raw.fields.slice(0, VOCAB_LIMITS.maxFormFields)) {
      const field = parseField(entry);
      if (field === null || ids.has(field.id)) continue;
      ids.add(field.id);
      fields.push(field);
    }
    if (fields.length === 0) return ctx.invalid("no usable fields");
    const submit = isRecord(raw.submit) ? raw.submit : null;
    const submitLabel = submit ? vocabString(submit.label, VOCAB_LIMITS.maxLabelChars) : undefined;
    const submitAction = submit ? parseAction(submit.onPress) : null;
    if (submitLabel === undefined || submitAction === null) {
      return ctx.invalid("`submit` needs a `label` and an `onPress` action");
    }
    return { component: "form", fields, submit: { label: submitLabel, onPress: submitAction } };
  },

  chart: (raw, ctx) => {
    const kind = enumValue(raw.kind, ["line", "bar"] as const);
    if (kind === undefined) return ctx.invalid("`kind` must be `line` or `bar`");
    if (!Array.isArray(raw.series)) return ctx.invalid("`series` is required");
    const series: VocabChartSeries[] = [];
    for (const entry of raw.series.slice(0, VOCAB_LIMITS.maxChartSeries)) {
      if (!isRecord(entry)) continue;
      const id = vocabString(entry.id, VOCAB_LIMITS.maxIdChars);
      if (id === undefined || !Array.isArray(entry.points)) continue;
      const points: VocabChartPoint[] = [];
      for (const point of entry.points.slice(0, VOCAB_LIMITS.maxChartPoints)) {
        if (!isRecord(point)) continue;
        const y = finiteNumber(point.y);
        if (y === undefined) continue;
        const x = typeof point.x === "string"
          ? point.x.slice(0, VOCAB_LIMITS.maxLabelChars)
          : finiteNumber(point.x);
        if (x === undefined) continue;
        points.push({ x, y });
      }
      const seriesLabel = vocabString(entry.label, VOCAB_LIMITS.maxLabelChars);
      series.push({
        id,
        points,
        ...(seriesLabel !== undefined ? { label: seriesLabel } : {}),
        ...(entry.tone !== undefined ? { tone: normalizeVocabTone(entry.tone) } : {}),
      });
    }
    if (series.length === 0) return ctx.invalid("no usable series");
    const title = vocabString(raw.title, VOCAB_LIMITS.maxLabelChars);
    const emptyText = vocabString(raw.emptyText, VOCAB_LIMITS.maxValueChars);
    return {
      component: "chart",
      kind,
      series,
      ...(title !== undefined ? { title } : {}),
      ...(emptyText !== undefined ? { emptyText } : {}),
    };
  },

  video: (raw, ctx) => {
    const src = vocabMediaSrc(raw.src);
    if (src === undefined) return ctx.invalid("`src` is required");
    const poster = vocabMediaSrc(raw.poster);
    const title = vocabString(raw.title, VOCAB_LIMITS.maxLabelChars);
    return {
      component: "video",
      src,
      ...(poster !== undefined ? { poster } : {}),
      ...(title !== undefined ? { title } : {}),
    };
  },

  image: (raw, ctx) => {
    const src = vocabMediaSrc(raw.src);
    const alt = vocabString(raw.alt, VOCAB_LIMITS.maxLabelChars);
    if (src === undefined) return ctx.invalid("`src` is required");
    if (alt === undefined) return ctx.invalid("`alt` is required");
    const maxHeight = finiteNumber(raw.maxHeight);
    return {
      component: "image",
      src,
      alt,
      ...(maxHeight !== undefined && maxHeight > 0 ? { maxHeight: Math.floor(maxHeight) } : {}),
    };
  },

  divider: (raw) => {
    const dividerLabel = vocabString(raw.label, VOCAB_LIMITS.maxLabelChars);
    return { component: "divider", ...(dividerLabel !== undefined ? { label: dividerLabel } : {}) };
  },

  keyValue: (raw, ctx) => {
    const bind = raw.bind !== undefined ? ctx.binding(raw.bind) : null;
    let rows: VocabKeyValueRow[] | undefined;
    if (Array.isArray(raw.rows)) {
      rows = [];
      for (const entry of raw.rows.slice(0, VOCAB_LIMITS.maxKeyValueRows)) {
        if (!isRecord(entry)) continue;
        const key = vocabString(entry.key, VOCAB_LIMITS.maxLabelChars);
        if (key === undefined) continue;
        rows.push({
          key,
          value: vocabString(entry.value, VOCAB_LIMITS.maxValueChars) ?? "",
          ...(entry.tone !== undefined ? { tone: normalizeVocabTone(entry.tone) } : {}),
        });
      }
    }
    if (rows === undefined && bind === null) return ctx.invalid("needs `rows` or a `bind`");
    const emptyText = vocabString(raw.emptyText, VOCAB_LIMITS.maxValueChars);
    return {
      component: "keyValue",
      ...(rows !== undefined ? { rows } : {}),
      ...(bind !== null ? { bind } : {}),
      ...(emptyText !== undefined ? { emptyText } : {}),
    };
  },

  segmented: (raw, ctx) => {
    const stateKey = parseVocabStateKey(raw.stateKey);
    if (stateKey === undefined) {
      return ctx.invalid("`stateKey` is required and may not start with `$`");
    }
    const options = parseVocabStateOptions(raw.options);
    // One option is not a choice, and a control the reader cannot change is a
    // filter permanently stuck wherever the author left it. Two is the floor.
    if (options.length < 2) return ctx.invalid("`options` needs at least two distinct values");
    const label = vocabString(raw.label, VOCAB_LIMITS.maxLabelChars);
    const style = parseVocabSegmentedStyle(raw.style, options.length);
    const onChange = parseAction(raw.onChange);
    return {
      component: "segmented",
      stateKey,
      options,
      default: vocabStateInitial(options, raw.default),
      ...(label !== undefined ? { label } : {}),
      ...(style !== undefined ? { style } : {}),
      ...(onChange !== null ? { onChange } : {}),
    };
  },

  emptyState: (raw, ctx) => {
    const title = vocabString(raw.title, VOCAB_LIMITS.maxLabelChars);
    if (title === undefined) return ctx.invalid("`title` is required");
    const description = vocabString(raw.description, VOCAB_LIMITS.maxTextChars);
    const icon = vocabString(raw.icon, VOCAB_LIMITS.maxIdChars);
    const actionRaw = isRecord(raw.action) ? raw.action : null;
    const actionLabel = actionRaw ? vocabString(actionRaw.label, VOCAB_LIMITS.maxLabelChars) : undefined;
    const actionPress = actionRaw ? parseAction(actionRaw.onPress) : null;
    return {
      component: "emptyState",
      title,
      ...(description !== undefined ? { description } : {}),
      ...(icon !== undefined ? { icon } : {}),
      ...(actionLabel !== undefined && actionPress !== null
        ? { action: { label: actionLabel, onPress: actionPress } }
        : {}),
    };
  },
};

/** The components this build renders richly. Anything else degrades — see {@link isKnownVocabComponent}. */
export const VOCAB_COMPONENTS_V1: readonly VocabComponentName[] = Object.keys(NODE_PARSERS);

/**
 * `Object.hasOwn`, not `in` and not a truthy lookup: the name comes from an
 * untrusted manifest, and `"constructor"` or `"toString"` resolve through the
 * prototype chain to functions that are not parsers.
 */
export function isKnownVocabComponent(name: string | null | undefined): boolean {
  if (!name) return false;
  return Object.hasOwn(NODE_PARSERS, name.trim());
}

function invalidNode(
  name: string,
  reason: string,
  path: string,
  state: VocabParseState,
): VocabInvalidNode {
  state.warnings.push({ code: "invalid_node", path, message: `${name}: ${reason}` });
  return { component: "__invalid", name, reason };
}

function parseBinding(raw: unknown, path: string, state: VocabParseState): VocabBinding | null {
  if (!isRecord(raw)) return null;
  const collection = vocabString(raw.collection, VOCAB_LIMITS.maxIdChars);
  if (collection === undefined) {
    state.warnings.push({
      code: "invalid_binding",
      path,
      message: "A binding needs a `collection` name.",
    });
    return null;
  }
  const keyPrefix = vocabString(raw.keyPrefix, VOCAB_LIMITS.maxIdChars);
  const limit = finiteNumber(raw.limit);
  const allowActions = parseAllowActions(raw.allowActions);
  const where = parseVocabWhere(raw.where, (message) => {
    state.warnings.push({ code: "invalid_binding", path: `${path}.where`, message });
  });
  return {
    collection,
    ...(keyPrefix !== undefined ? { keyPrefix } : {}),
    ...(limit !== undefined && limit > 0 ? { limit: Math.floor(limit) } : {}),
    ...(allowActions !== undefined ? { allowActions } : {}),
    ...(where !== undefined ? { where } : {}),
  };
}

/**
 * The action ids a binding's rows may name.
 *
 * Deduplicated so a repeated id does not spend the ceiling twice, and dropped
 * entirely when it is empty, because an empty allowlist and an absent one mean
 * the same thing: no bound row acts.
 */
function parseAllowActions(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  for (const entry of raw) {
    const id = vocabString(entry, VOCAB_LIMITS.maxIdChars);
    if (id === undefined) continue;
    seen.add(id);
    if (seen.size >= VOCAB_LIMITS.maxBindingAllowActions) break;
  }
  return seen.size > 0 ? [...seen] : undefined;
}

/**
 * Parse one node, recursing through `stack` children.
 *
 * `null` means a ceiling stopped the walk, which is panel-fatal and is decided
 * by the caller in `vocabulary.ts` — everything else degrades in place.
 */
export function parseVocabNode(
  raw: unknown,
  path: string,
  depth: number,
  state: VocabParseState,
): VocabNode | null {
  if (state.nodeCount >= VOCAB_LIMITS.maxNodes) {
    state.overflowed = true;
    return null;
  }
  if (depth > VOCAB_LIMITS.maxDepth) {
    state.overflowed = true;
    return null;
  }
  if (!isRecord(raw)) {
    state.nodeCount += 1;
    return invalidNode("node", "not an object", path, state);
  }
  const name = typeof raw.component === "string" ? raw.component.trim() : "";
  if (!name) {
    state.nodeCount += 1;
    return invalidNode("node", "missing `component`", path, state);
  }
  state.nodeCount += 1;

  if (!Object.hasOwn(NODE_PARSERS, name)) {
    state.warnings.push({
      code: "unknown_component",
      path,
      message: `\`${name}\` is not part of vocabulary v${VOCAB_VERSION}.`,
    });
    return { component: "__unknown", name };
  }

  return NODE_PARSERS[name]!(raw, {
    path,
    invalid: (reason) => invalidNode(name, reason, path, state),
    child: (childRaw, index) =>
      parseVocabNode(childRaw, `${path}.children[${index}]`, depth + 1, state),
    binding: (bindRaw) => parseBinding(bindRaw, `${path}.bind`, state),
  });
}
