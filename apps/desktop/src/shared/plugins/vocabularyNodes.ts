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

/** Bumped only for a change old clients cannot safely interpret. */
export const VOCAB_VERSION = 1;

/**
 * Hard ceilings. Enforced identically on every surface so a schema that renders
 * on desktop cannot be rejected on iOS. Writers enforce the byte budget too —
 * see the `plugin_panels` budget in `dbMaintenanceApi.ts`.
 */
export const VOCAB_LIMITS = {
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

/** One row of a `list`. Also the row shape a `list` binding must materialize. */
export type VocabListItem = {
  title: string;
  subtitle?: string;
  meta?: string;
  tone?: VocabTone;
  icon?: string;
  onPress?: VocabAction;
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
 * The rows a binding actually yields, capped by its own `limit`.
 *
 * `null` — not `[]` — when the fetch has not landed, so a component can tell
 * "nothing yet" from "nothing there" and show its `emptyText` only for the
 * second.
 */
export function boundRowValues(
  binding: VocabBinding | undefined,
  rows: readonly { value: unknown }[] | undefined,
): unknown[] | null {
  if (!binding || !rows) return null;
  const values = rows.map((row) => row.value);
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
 * A bound row as a `list` item.
 *
 * `onPress` is deliberately not read: an action is something a panel schema
 * declares, and a collection row that could mint one would let stored data
 * introduce a button the panel never showed the reader.
 */
export function coerceBoundListItem(value: unknown): VocabListItem | null {
  if (!isRecord(value)) return null;
  const title = vocabString(value.title, VOCAB_LIMITS.maxLabelChars);
  if (title === undefined) return null;
  const subtitle = vocabString(value.subtitle, VOCAB_LIMITS.maxValueChars);
  const meta = vocabString(value.meta, VOCAB_LIMITS.maxLabelChars);
  const icon = vocabString(value.icon, VOCAB_LIMITS.maxIdChars);
  return {
    title,
    ...(subtitle !== undefined ? { subtitle } : {}),
    ...(meta !== undefined ? { meta } : {}),
    ...(value.tone !== undefined ? { tone: normalizeVocabTone(value.tone) } : {}),
    ...(icon !== undefined ? { icon } : {}),
  };
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

function parseListItem(raw: unknown): VocabListItem | null {
  if (!isRecord(raw)) return null;
  const title = vocabString(raw.title, VOCAB_LIMITS.maxLabelChars);
  if (title === undefined) return null;
  const subtitle = vocabString(raw.subtitle, VOCAB_LIMITS.maxValueChars);
  const meta = vocabString(raw.meta, VOCAB_LIMITS.maxLabelChars);
  const icon = vocabString(raw.icon, VOCAB_LIMITS.maxIdChars);
  const onPress = parseAction(raw.onPress);
  return {
    title,
    ...(subtitle !== undefined ? { subtitle } : {}),
    ...(meta !== undefined ? { meta } : {}),
    ...(raw.tone !== undefined ? { tone: normalizeVocabTone(raw.tone) } : {}),
    ...(icon !== undefined ? { icon } : {}),
    ...(onPress !== null ? { onPress } : {}),
  };
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
  return {
    collection,
    ...(keyPrefix !== undefined ? { keyPrefix } : {}),
    ...(limit !== undefined && limit > 0 ? { limit: Math.floor(limit) } : {}),
  };
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
