/**
 * Plugin vocabulary v1 — the declarative UI contract every ADE surface renders.
 *
 * A plugin never ships UI code. It ships a **panel schema**: strict, versioned
 * JSON that names components from a fixed set and points at data it has already
 * materialized. Desktop, web, iOS and the TUI each interpret this same JSON with
 * their own native widgets, which is what lets one plugin work across four
 * independent release trains (desktop auto-update, App Store review, npm, web).
 *
 * This module is the all-client shared half: pure types + pure parsing, no
 * React, no Electron, no Node built-ins — the same shape as `../adeCard.ts` and
 * `../chatMosaic.ts`, which are likewise imported by the renderer AND by
 * `apps/ade-cli`.
 *
 * ## The stability promise
 *
 * Four rules hold the contract together. Breaking any of them breaks a client
 * that shipped months ago and cannot be updated in lockstep.
 *
 * 1. **The component name union is OPEN** (`| (string & {})`, the `AdeCardVariant`
 *    idiom). Adding a component in v2 must never be a breaking change for a
 *    client compiled against this file. A name a client does not recognize
 *    renders as a small inline "not supported here" affordance — never a crash,
 *    never a silently dropped subtree.
 * 2. **`fallback` is REQUIRED on every panel.** A client that cannot render the
 *    panel at all — unsupported `v`, oversized schema, structural damage —
 *    renders `fallback.title` + `fallback.text` plus the optional deeplink. That
 *    is the floor: a panel is never blank.
 * 3. **Data, never code.** There are no expressions, no formatting strings, no
 *    conditionals and no host callbacks in a schema. A binding names a
 *    collection the plugin already wrote render-ready rows into; an action names
 *    a plugin action id the host dispatches. Anything a plugin wants computed,
 *    it computes on its own machine and writes as data. (Mosaic's law, kept.)
 * 4. **Limits are part of the contract**, not a client's private defence. A
 *    schema over {@link VOCAB_LIMITS} is invalid everywhere, identically, so a
 *    plugin cannot pass review on one surface and blow up another.
 *
 * ## Degradation ladder
 *
 * Parsing distinguishes damage that kills a panel from damage that kills a node:
 *
 * - **Panel-fatal** (bad JSON, unsupported version, missing `fallback`, over the
 *   size/node/depth ceiling) → {@link parsePluginPanel} returns `ok: false` and
 *   the caller renders the fallback card.
 * - **Node-local** (a malformed known component, a malformed binding) → the node
 *   becomes an {@link VocabInvalidNode} carrying its error, the rest of the panel
 *   renders normally.
 * - **Unknown component** → the node becomes a {@link VocabUnknownNode} carrying
 *   the name it could not render. This is the forward-compat path and is a
 *   warning, not an error.
 */

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
} as const;

/**
 * Open component-name union. See rule 1 of the stability promise: this is
 * deliberately not a closed union, and clients MUST tolerate names they do not
 * know rather than treating them as parse failures.
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

/** The components this build renders richly. Anything else degrades — see {@link isKnownVocabComponent}. */
export const VOCAB_COMPONENTS_V1: readonly VocabComponentName[] = [
  "stack",
  "text",
  "badge",
  "button",
  "list",
  "table",
  "form",
  "chart",
  "video",
  "image",
  "divider",
  "keyValue",
  "emptyState",
];

export function isKnownVocabComponent(name: string | null | undefined): boolean {
  if (!name) return false;
  return VOCAB_COMPONENTS_V1.includes(name.trim() as VocabComponentName);
}

/**
 * Semantic tone. No `danger`/red — a failure is amber, the same house rule
 * stated at the top of `../adeCard.ts`. {@link normalizeVocabTone} folds any
 * red-ish value an author invents into `warning` so a payload cannot bypass it.
 */
export type VocabTone = "neutral" | "accent" | "success" | "warning";

export const VOCAB_TONES: readonly VocabTone[] = ["neutral", "accent", "success", "warning"];

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

/**
 * REQUIRED on every panel. Rule 2: this is what a client renders when it cannot
 * render the panel — and the reason one wire contract is safe to ship across
 * four release trains.
 */
export type VocabFallback = {
  title: string;
  text: string;
  /** `ade://` URL to the fullest version of this content. */
  deeplink?: string;
};

export type VocabPanel = {
  v: typeof VOCAB_VERSION;
  title?: string;
  fallback: VocabFallback;
  body: VocabNode[];
};

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

export type VocabParseResult =
  | {
      ok: true;
      panel: VocabPanel;
      /** Non-fatal: unknown components and dropped nodes. */
      warnings: VocabError[];
    }
  | {
      ok: false;
      errors: VocabError[];
      /**
       * Best-effort fallback recovered from the raw value even though the panel
       * itself is unrenderable, so the fallback card can still show the
       * plugin's own words instead of a generic apology.
       */
      fallback: VocabFallback | null;
    };

/* ── Parsing ────────────────────────────────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim() as T;
  return allowed.includes(trimmed) ? trimmed : undefined;
}

/**
 * Byte size of a schema as it would be stored. Callers that already hold the
 * JSON string should measure that instead — this re-serializes.
 */
export function vocabSchemaBytes(value: unknown): number {
  try {
    const json = typeof value === "string" ? value : JSON.stringify(value);
    if (typeof json !== "string") return 0;
    // TextEncoder is available in every runtime that renders a panel; the
    // fallback keeps this module usable in a bare Node script.
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(json).length;
    return json.length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Dig the fallback out of an arbitrary value without validating anything else.
 *
 * Used on the failure path: a panel too damaged to render usually still carries
 * a readable `fallback`, and showing the plugin's own sentence beats showing
 * ours.
 */
export function readVocabFallback(raw: unknown): VocabFallback | null {
  let source = raw;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source) as unknown;
    } catch {
      return null;
    }
  }
  if (!isRecord(source)) return null;
  const fallback = source.fallback;
  if (!isRecord(fallback)) return null;
  const title = cleanString(fallback.title, VOCAB_LIMITS.maxLabelChars);
  const text = cleanString(fallback.text, VOCAB_LIMITS.maxTextChars);
  if (title === undefined || text === undefined) return null;
  const deeplink = cleanString(fallback.deeplink, VOCAB_LIMITS.maxValueChars);
  return { title, text, ...(deeplink !== undefined ? { deeplink } : {}) };
}

/** One-line description of a panel, for surfaces that cannot render it at all. */
export function vocabFallbackText(fallback: VocabFallback): string {
  return fallback.deeplink ? `${fallback.text} · ${fallback.deeplink}` : fallback.text;
}

type ParseContext = {
  warnings: VocabError[];
  /** Counted across the whole tree so a wide panel is capped like a deep one. */
  nodeCount: number;
  overflowed: boolean;
};

function parseBinding(raw: unknown, path: string, ctx: ParseContext): VocabBinding | null {
  if (!isRecord(raw)) return null;
  const collection = cleanString(raw.collection, VOCAB_LIMITS.maxIdChars);
  if (collection === undefined) {
    ctx.warnings.push({
      code: "invalid_binding",
      path,
      message: "A binding needs a `collection` name.",
    });
    return null;
  }
  const keyPrefix = cleanString(raw.keyPrefix, VOCAB_LIMITS.maxIdChars);
  const limit = finiteNumber(raw.limit);
  return {
    collection,
    ...(keyPrefix !== undefined ? { keyPrefix } : {}),
    ...(limit !== undefined && limit > 0 ? { limit: Math.floor(limit) } : {}),
  };
}

function parseAction(raw: unknown): VocabAction | null {
  if (!isRecord(raw)) return null;
  const action = cleanString(raw.action, VOCAB_LIMITS.maxIdChars);
  if (action === undefined) return null;
  const confirm = cleanString(raw.confirm, VOCAB_LIMITS.maxTextChars);
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
  const title = cleanString(raw.title, VOCAB_LIMITS.maxLabelChars);
  if (title === undefined) return null;
  const subtitle = cleanString(raw.subtitle, VOCAB_LIMITS.maxValueChars);
  const meta = cleanString(raw.meta, VOCAB_LIMITS.maxLabelChars);
  const icon = cleanString(raw.icon, VOCAB_LIMITS.maxIdChars);
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
  const id = cleanString(raw.id, VOCAB_LIMITS.maxIdChars);
  const label = cleanString(raw.label, VOCAB_LIMITS.maxLabelChars);
  if (kind === undefined || id === undefined || label === undefined) return null;

  const help = cleanString(raw.help, VOCAB_LIMITS.maxValueChars);
  const placeholder = cleanString(raw.placeholder, VOCAB_LIMITS.maxLabelChars);
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
      const value = cleanString(entry.value, VOCAB_LIMITS.maxValueChars);
      if (value === undefined || seen.has(value)) return null;
      seen.add(value);
      const optionLabel = cleanString(entry.label, VOCAB_LIMITS.maxLabelChars);
      options.push(optionLabel !== undefined ? { value, label: optionLabel } : { value });
    }
    const value = cleanString(raw.value, VOCAB_LIMITS.maxValueChars);
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
  const value = kind === "text" ? cleanString(raw.value, VOCAB_LIMITS.maxValueChars) : undefined;
  return { ...base, ...(value !== undefined ? { value } : {}) };
}

function invalid(name: string, reason: string, path: string, ctx: ParseContext): VocabInvalidNode {
  ctx.warnings.push({ code: "invalid_node", path, message: `${name}: ${reason}` });
  return { component: "__invalid", name, reason };
}

function parseNode(raw: unknown, path: string, depth: number, ctx: ParseContext): VocabNode | null {
  if (ctx.nodeCount >= VOCAB_LIMITS.maxNodes) {
    ctx.overflowed = true;
    return null;
  }
  if (depth > VOCAB_LIMITS.maxDepth) {
    ctx.overflowed = true;
    return null;
  }
  if (!isRecord(raw)) {
    ctx.nodeCount += 1;
    return invalid("node", "not an object", path, ctx);
  }
  const name = typeof raw.component === "string" ? raw.component.trim() : "";
  if (!name) {
    ctx.nodeCount += 1;
    return invalid("node", "missing `component`", path, ctx);
  }
  ctx.nodeCount += 1;

  if (!isKnownVocabComponent(name)) {
    ctx.warnings.push({
      code: "unknown_component",
      path,
      message: `\`${name}\` is not part of vocabulary v${VOCAB_VERSION}.`,
    });
    return { component: "__unknown", name };
  }

  switch (name) {
    case "stack": {
      const rawChildren = Array.isArray(raw.children) ? raw.children : [];
      const children: VocabNode[] = [];
      for (let index = 0; index < rawChildren.length; index += 1) {
        const child = parseNode(rawChildren[index], `${path}.children[${index}]`, depth + 1, ctx);
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
    }
    case "text": {
      const text = cleanString(raw.text, VOCAB_LIMITS.maxTextChars);
      if (text === undefined) return invalid(name, "`text` is required", path, ctx);
      const variant = enumValue(raw.variant, ["title", "subtitle", "body", "caption", "code"] as const);
      return {
        component: "text",
        text,
        ...(variant !== undefined ? { variant } : {}),
        ...(raw.tone !== undefined ? { tone: normalizeVocabTone(raw.tone) } : {}),
      };
    }
    case "badge": {
      const text = cleanString(raw.text, VOCAB_LIMITS.maxLabelChars);
      if (text === undefined) return invalid(name, "`text` is required", path, ctx);
      const icon = cleanString(raw.icon, VOCAB_LIMITS.maxIdChars);
      return {
        component: "badge",
        text,
        tone: normalizeVocabTone(raw.tone),
        ...(icon !== undefined ? { icon } : {}),
      };
    }
    case "button": {
      const label = cleanString(raw.label, VOCAB_LIMITS.maxLabelChars);
      const onPress = parseAction(raw.onPress);
      if (label === undefined) return invalid(name, "`label` is required", path, ctx);
      if (onPress === null) return invalid(name, "`onPress` needs an `action` id", path, ctx);
      const kind = enumValue(raw.kind, ["primary", "default", "quiet"] as const);
      const icon = cleanString(raw.icon, VOCAB_LIMITS.maxIdChars);
      return {
        component: "button",
        label,
        onPress,
        ...(kind !== undefined ? { kind } : {}),
        ...(icon !== undefined ? { icon } : {}),
        ...(typeof raw.disabled === "boolean" ? { disabled: raw.disabled } : {}),
      };
    }
    case "list": {
      const bind = raw.bind !== undefined ? parseBinding(raw.bind, `${path}.bind`, ctx) : null;
      let items: VocabListItem[] | undefined;
      if (Array.isArray(raw.items)) {
        items = raw.items
          .slice(0, VOCAB_LIMITS.maxListItems)
          .map((entry) => parseListItem(entry))
          .filter((entry): entry is VocabListItem => entry !== null);
      }
      if (items === undefined && bind === null) {
        return invalid(name, "needs `items` or a `bind`", path, ctx);
      }
      const emptyText = cleanString(raw.emptyText, VOCAB_LIMITS.maxValueChars);
      return {
        component: "list",
        ...(items !== undefined ? { items } : {}),
        ...(bind !== null ? { bind } : {}),
        ...(emptyText !== undefined ? { emptyText } : {}),
      };
    }
    case "table": {
      if (!Array.isArray(raw.columns) || raw.columns.length === 0) {
        return invalid(name, "`columns` is required", path, ctx);
      }
      const columns: VocabTableColumn[] = [];
      for (const entry of raw.columns.slice(0, VOCAB_LIMITS.maxTableColumns)) {
        if (!isRecord(entry)) continue;
        const key = cleanString(entry.key, VOCAB_LIMITS.maxIdChars);
        const columnLabel = cleanString(entry.label, VOCAB_LIMITS.maxLabelChars);
        if (key === undefined || columnLabel === undefined) continue;
        const align = enumValue(entry.align, ["left", "right"] as const);
        columns.push({ key, label: columnLabel, ...(align !== undefined ? { align } : {}) });
      }
      if (columns.length === 0) return invalid(name, "no usable columns", path, ctx);
      const bind = raw.bind !== undefined ? parseBinding(raw.bind, `${path}.bind`, ctx) : null;
      let rows: Record<string, string | number>[] | undefined;
      if (Array.isArray(raw.rows)) {
        rows = raw.rows
          .slice(0, VOCAB_LIMITS.maxTableRows)
          .filter(isRecord)
          .map((row) => coerceTableRow(row, columns));
      }
      if (rows === undefined && bind === null) {
        return invalid(name, "needs `rows` or a `bind`", path, ctx);
      }
      const emptyText = cleanString(raw.emptyText, VOCAB_LIMITS.maxValueChars);
      return {
        component: "table",
        columns,
        ...(rows !== undefined ? { rows } : {}),
        ...(bind !== null ? { bind } : {}),
        ...(emptyText !== undefined ? { emptyText } : {}),
      };
    }
    case "form": {
      if (!Array.isArray(raw.fields) || raw.fields.length === 0) {
        return invalid(name, "`fields` is required", path, ctx);
      }
      const fields: VocabField[] = [];
      const ids = new Set<string>();
      for (const entry of raw.fields.slice(0, VOCAB_LIMITS.maxFormFields)) {
        const field = parseField(entry);
        if (field === null || ids.has(field.id)) continue;
        ids.add(field.id);
        fields.push(field);
      }
      if (fields.length === 0) return invalid(name, "no usable fields", path, ctx);
      const submit = isRecord(raw.submit) ? raw.submit : null;
      const submitLabel = submit ? cleanString(submit.label, VOCAB_LIMITS.maxLabelChars) : undefined;
      const submitAction = submit ? parseAction(submit.onPress) : null;
      if (submitLabel === undefined || submitAction === null) {
        return invalid(name, "`submit` needs a `label` and an `onPress` action", path, ctx);
      }
      return { component: "form", fields, submit: { label: submitLabel, onPress: submitAction } };
    }
    case "chart": {
      const kind = enumValue(raw.kind, ["line", "bar"] as const);
      if (kind === undefined) return invalid(name, "`kind` must be `line` or `bar`", path, ctx);
      if (!Array.isArray(raw.series)) return invalid(name, "`series` is required", path, ctx);
      const series: VocabChartSeries[] = [];
      for (const entry of raw.series.slice(0, VOCAB_LIMITS.maxChartSeries)) {
        if (!isRecord(entry)) continue;
        const id = cleanString(entry.id, VOCAB_LIMITS.maxIdChars);
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
        const seriesLabel = cleanString(entry.label, VOCAB_LIMITS.maxLabelChars);
        series.push({
          id,
          points,
          ...(seriesLabel !== undefined ? { label: seriesLabel } : {}),
          ...(entry.tone !== undefined ? { tone: normalizeVocabTone(entry.tone) } : {}),
        });
      }
      if (series.length === 0) return invalid(name, "no usable series", path, ctx);
      const title = cleanString(raw.title, VOCAB_LIMITS.maxLabelChars);
      const emptyText = cleanString(raw.emptyText, VOCAB_LIMITS.maxValueChars);
      return {
        component: "chart",
        kind,
        series,
        ...(title !== undefined ? { title } : {}),
        ...(emptyText !== undefined ? { emptyText } : {}),
      };
    }
    case "video": {
      const src = cleanString(raw.src, VOCAB_LIMITS.maxValueChars);
      if (src === undefined) return invalid(name, "`src` is required", path, ctx);
      const poster = cleanString(raw.poster, VOCAB_LIMITS.maxValueChars);
      const title = cleanString(raw.title, VOCAB_LIMITS.maxLabelChars);
      return {
        component: "video",
        src,
        ...(poster !== undefined ? { poster } : {}),
        ...(title !== undefined ? { title } : {}),
      };
    }
    case "image": {
      const src = cleanString(raw.src, VOCAB_LIMITS.maxValueChars);
      const alt = cleanString(raw.alt, VOCAB_LIMITS.maxLabelChars);
      if (src === undefined) return invalid(name, "`src` is required", path, ctx);
      if (alt === undefined) return invalid(name, "`alt` is required", path, ctx);
      const maxHeight = finiteNumber(raw.maxHeight);
      return {
        component: "image",
        src,
        alt,
        ...(maxHeight !== undefined && maxHeight > 0 ? { maxHeight: Math.floor(maxHeight) } : {}),
      };
    }
    case "divider": {
      const dividerLabel = cleanString(raw.label, VOCAB_LIMITS.maxLabelChars);
      return { component: "divider", ...(dividerLabel !== undefined ? { label: dividerLabel } : {}) };
    }
    case "keyValue": {
      const bind = raw.bind !== undefined ? parseBinding(raw.bind, `${path}.bind`, ctx) : null;
      let rows: VocabKeyValueRow[] | undefined;
      if (Array.isArray(raw.rows)) {
        rows = [];
        for (const entry of raw.rows.slice(0, VOCAB_LIMITS.maxKeyValueRows)) {
          if (!isRecord(entry)) continue;
          const key = cleanString(entry.key, VOCAB_LIMITS.maxLabelChars);
          if (key === undefined) continue;
          rows.push({
            key,
            value: cleanString(entry.value, VOCAB_LIMITS.maxValueChars) ?? "",
            ...(entry.tone !== undefined ? { tone: normalizeVocabTone(entry.tone) } : {}),
          });
        }
      }
      if (rows === undefined && bind === null) {
        return invalid(name, "needs `rows` or a `bind`", path, ctx);
      }
      const emptyText = cleanString(raw.emptyText, VOCAB_LIMITS.maxValueChars);
      return {
        component: "keyValue",
        ...(rows !== undefined ? { rows } : {}),
        ...(bind !== null ? { bind } : {}),
        ...(emptyText !== undefined ? { emptyText } : {}),
      };
    }
    case "emptyState": {
      const title = cleanString(raw.title, VOCAB_LIMITS.maxLabelChars);
      if (title === undefined) return invalid(name, "`title` is required", path, ctx);
      const description = cleanString(raw.description, VOCAB_LIMITS.maxTextChars);
      const icon = cleanString(raw.icon, VOCAB_LIMITS.maxIdChars);
      const actionRaw = isRecord(raw.action) ? raw.action : null;
      const actionLabel = actionRaw ? cleanString(actionRaw.label, VOCAB_LIMITS.maxLabelChars) : undefined;
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
    }
    default:
      // Unreachable: `isKnownVocabComponent` gated every name above. Kept so a
      // component added to the list without a parse arm fails loudly here
      // rather than rendering as a silently empty node.
      return invalid(name, "recognized but not parseable in this build", path, ctx);
  }
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
 * Parse a panel schema. Accepts the JSON string as stored in
 * `plugin_panels.schema_json` or an already-parsed value.
 *
 * See the module comment's degradation ladder for what fails the panel versus
 * what only fails a node.
 */
export function parsePluginPanel(raw: unknown): VocabParseResult {
  const fail = (errors: VocabError[]): VocabParseResult => ({
    ok: false,
    errors,
    fallback: readVocabFallback(raw),
  });

  let source = raw;
  if (typeof source === "string") {
    if (vocabSchemaBytes(source) > VOCAB_LIMITS.maxSchemaBytes) {
      return fail([
        {
          code: "schema_too_large",
          path: "",
          message: `Schema exceeds ${VOCAB_LIMITS.maxSchemaBytes} bytes.`,
        },
      ]);
    }
    try {
      source = JSON.parse(source) as unknown;
    } catch {
      return fail([{ code: "not_json", path: "", message: "Schema is not valid JSON." }]);
    }
  }

  if (!isRecord(source)) {
    return fail([{ code: "not_object", path: "", message: "Schema must be a JSON object." }]);
  }
  if (source.v !== VOCAB_VERSION) {
    return fail([
      {
        code: "version_unsupported",
        path: "v",
        message: `This build renders vocabulary v${VOCAB_VERSION}; the panel declares v${String(source.v)}.`,
      },
    ]);
  }
  if (vocabSchemaBytes(source) > VOCAB_LIMITS.maxSchemaBytes) {
    return fail([
      {
        code: "schema_too_large",
        path: "",
        message: `Schema exceeds ${VOCAB_LIMITS.maxSchemaBytes} bytes.`,
      },
    ]);
  }

  const fallback = readVocabFallback(source);
  if (!fallback) {
    return fail([
      {
        code: "fallback_missing",
        path: "fallback",
        message: "Every panel must declare `fallback` with a `title` and `text`.",
      },
    ]);
  }
  if (!Array.isArray(source.body)) {
    return fail([{ code: "body_missing", path: "body", message: "`body` must be an array." }]);
  }

  const ctx: ParseContext = { warnings: [], nodeCount: 0, overflowed: false };
  const body: VocabNode[] = [];
  for (let index = 0; index < source.body.length; index += 1) {
    const node = parseNode(source.body[index], `body[${index}]`, 1, ctx);
    if (node === null) break;
    body.push(node);
  }

  if (ctx.overflowed) {
    return fail([
      {
        code: ctx.nodeCount >= VOCAB_LIMITS.maxNodes ? "too_many_nodes" : "too_deep",
        path: "body",
        message: ctx.nodeCount >= VOCAB_LIMITS.maxNodes
          ? `A panel may contain at most ${VOCAB_LIMITS.maxNodes} nodes.`
          : `A panel may nest at most ${VOCAB_LIMITS.maxDepth} levels.`,
      },
    ]);
  }

  const title = cleanString(source.title, VOCAB_LIMITS.maxLabelChars);
  return {
    ok: true,
    panel: {
      v: VOCAB_VERSION,
      ...(title !== undefined ? { title } : {}),
      fallback,
      body,
    },
    warnings: ctx.warnings,
  };
}

/** Total nodes in a parsed panel, counted through the whole tree. */
export function countVocabNodes(nodes: readonly VocabNode[]): number {
  let total = 0;
  for (const node of nodes) {
    total += 1;
    if (node.component === "stack") total += countVocabNodes(node.children);
  }
  return total;
}

/** Every binding a panel references, so a host can fetch exactly what it needs. */
export function collectVocabBindings(nodes: readonly VocabNode[]): VocabBinding[] {
  const found: VocabBinding[] = [];
  const walk = (list: readonly VocabNode[]) => {
    for (const node of list) {
      switch (node.component) {
        case "stack":
          walk(node.children);
          break;
        case "list":
        case "table":
        case "keyValue":
          if (node.bind) found.push(node.bind);
          break;
        default:
          break;
      }
    }
  };
  walk(nodes);
  return found;
}
