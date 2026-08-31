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
 * The per-component types and their parsers live in `./vocabularyNodes.ts` and
 * are re-exported here, so this file stays the single import path every client
 * already uses. What is left in it is the panel level: the version, the
 * fallback, the ceilings that fail a whole schema, and the shared helpers a host
 * needs to fetch a panel's data.
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
 *    schema over `VOCAB_LIMITS` is invalid everywhere, identically, so a plugin
 *    cannot pass review on one surface and blow up another.
 *
 * ## Degradation ladder
 *
 * Parsing distinguishes damage that kills a panel from damage that kills a node:
 *
 * - **Panel-fatal** (bad JSON, unsupported version, missing `fallback`, over the
 *   size/node/depth ceiling) → {@link parsePluginPanel} returns `ok: false` and
 *   the caller renders the fallback card.
 * - **Node-local** (a malformed known component, a malformed binding) → the node
 *   becomes a `VocabInvalidNode` carrying its error, the rest of the panel
 *   renders normally.
 * - **Unknown component** → the node becomes a `VocabUnknownNode` carrying the
 *   name it could not render. This is the forward-compat path and is a warning,
 *   not an error.
 */

import {
  VOCAB_LIMITS,
  VOCAB_VERSION,
  bindingKey,
  parseVocabNode,
  vocabSegmentedDeclaration,
  vocabStateDeclarations,
  vocabString,
  type VocabBinding,
  type VocabError,
  type VocabNode,
  type VocabParseState,
  type VocabPanelState,
  type VocabStateDeclaration,
} from "./vocabularyNodes";
import { VOCAB_STATE_COLLECTION, vocabStateRows } from "./vocabularyState";
import { isRecord } from "./parse";

export * from "./vocabularyNodes";

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

/* ── Render context ─────────────────────────────────────────────────────── */

/**
 * The reserved collection name a panel binds to read the context it was opened
 * with.
 *
 * A panel can arrive carrying a small object: a `plugin` deeplink's `?ctx=`, or
 * the `{navigate:{context}}` an action returned after the user pressed a button
 * on a session row. Rule 3 forbids expressions, so there is no way to
 * interpolate that object into a label — which left it invisible to the schema
 * and useful only to the plugin's own handlers.
 *
 * Exposing it as a *binding* fixes that without adding a language: `$context`
 * reads like any other collection, so a `keyValue` or `list` node bound to it
 * renders "Issue: ISS-14" with the components that already exist. The name
 * starts with `$`, which {@link PLUGIN_COLLECTION_NAME_PATTERN} forbids, so no
 * real collection can ever shadow it and the host never has to guess whether a
 * binding meant the plugin's data or ADE's.
 *
 * The context also rides on every action the panel dispatches, the same way a
 * socket's surface context does, so a button pressed on a context-carrying
 * panel reaches the plugin knowing what it was looking at.
 */
export const VOCAB_CONTEXT_COLLECTION = "$context";

/**
 * The context as bindable rows: one row per top-level key, in declaration
 * order. Values are passed through untouched — the renderer already knows how
 * to draw an arbitrary JSON value in a row, and re-shaping them here would make
 * `$context` render differently from every other collection.
 */
export function vocabContextRows(
  context: Record<string, unknown> | null | undefined,
): { key: string; value: unknown }[] {
  if (!context) return [];
  return Object.entries(context).map(([key, value]) => ({ key, value }));
}

/**
 * Rows for a binding ADE answers itself, or `null` when the plugin owns it.
 *
 * There are two reserved collections and neither exists in the database, so a
 * host that forgot one would send the plugin's store a guaranteed miss and
 * render an empty node with no error. One resolver means a client cannot
 * support `$context` and quietly not support `$state`, which is exactly the
 * drift the four release trains make expensive to discover.
 */
export function vocabReservedRows(
  binding: Pick<VocabBinding, "collection">,
  source: {
    context?: Record<string, unknown> | null;
    declarations?: readonly VocabStateDeclaration[];
    state?: VocabPanelState;
  },
): { key: string; value: unknown }[] | null {
  if (binding.collection === VOCAB_CONTEXT_COLLECTION) {
    return vocabContextRows(source.context);
  }
  if (binding.collection === VOCAB_STATE_COLLECTION) {
    return vocabStateRows(source.declarations ?? [], source.state ?? {});
  }
  return null;
}

/* ── Panel state ────────────────────────────────────────────────────────── */

/**
 * Every state key a parsed panel declares, in reading order.
 *
 * A host calls this once per parse and keeps the result beside the panel: it is
 * what builds the initial state, what validates a change, what fills the
 * `$state` binding, and what decides whether a re-published schema may keep the
 * reader's selection. Walking the tree in each of those places instead would be
 * four chances to disagree about which control owns a key.
 *
 * See `vocabularyState.ts` for the lifecycle: per-panel, per-viewer, session
 * only, surviving a re-publish of the same controls and resetting when they
 * change or when an action returns `{resetState}`.
 */
export function collectVocabStateDeclarations(
  nodes: readonly VocabNode[],
): VocabStateDeclaration[] {
  const found: VocabStateDeclaration[] = [];
  const walk = (list: readonly VocabNode[]) => {
    for (const node of list) {
      if (node.component === "stack") walk(node.children);
      else if (node.component === "segmented") found.push(vocabSegmentedDeclaration(node));
    }
  };
  walk(nodes);
  return vocabStateDeclarations(found);
}

/* ── Parsing ────────────────────────────────────────────────────────────── */

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
  const title = vocabString(fallback.title, VOCAB_LIMITS.maxLabelChars);
  const text = vocabString(fallback.text, VOCAB_LIMITS.maxTextChars);
  if (title === undefined || text === undefined) return null;
  const deeplink = vocabString(fallback.deeplink, VOCAB_LIMITS.maxValueChars);
  return { title, text, ...(deeplink !== undefined ? { deeplink } : {}) };
}

/** One-line description of a panel, for surfaces that cannot render it at all. */
export function vocabFallbackText(fallback: VocabFallback): string {
  return fallback.deeplink ? `${fallback.text} · ${fallback.deeplink}` : fallback.text;
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

  const state: VocabParseState = { warnings: [], nodeCount: 0, overflowed: false };
  const body: VocabNode[] = [];
  for (let index = 0; index < source.body.length; index += 1) {
    const node = parseVocabNode(source.body[index], `body[${index}]`, 1, state);
    if (node === null) break;
    body.push(node);
  }

  if (state.overflowed) {
    return fail([
      {
        code: state.nodeCount >= VOCAB_LIMITS.maxNodes ? "too_many_nodes" : "too_deep",
        path: "body",
        message: state.nodeCount >= VOCAB_LIMITS.maxNodes
          ? `A panel may contain at most ${VOCAB_LIMITS.maxNodes} nodes.`
          : `A panel may nest at most ${VOCAB_LIMITS.maxDepth} levels.`,
      },
    ]);
  }

  const title = vocabString(source.title, VOCAB_LIMITS.maxLabelChars);
  return {
    ok: true,
    panel: {
      v: VOCAB_VERSION,
      ...(title !== undefined ? { title } : {}),
      fallback,
      body,
    },
    warnings: state.warnings,
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

/**
 * Count the component nodes in an UNPARSED schema, with no ceiling.
 *
 * {@link parsePluginPanel} stops counting the moment it passes
 * `VOCAB_LIMITS.maxNodes`, so its state can report "at least 200" and never
 * "400" — which is the number an author needs to know how far over they are.
 * This walks the raw JSON instead and answers the true total.
 *
 * Deliberately structural rather than a second parser: it counts every object
 * carrying a string `component`, wherever it sits. A node can only ever be such
 * an object, so this cannot drift when a new component gains children under a
 * key this function has never heard of — the case a hand-written mirror of
 * {@link parseVocabNode}'s recursion would get wrong.
 */
export function countRawVocabComponents(raw: unknown): number {
  let total = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (!isRecord(value)) return;
    if (typeof value.component === "string" && value.component.trim().length > 0) total += 1;
    for (const entry of Object.values(value)) visit(entry);
  };
  visit(raw);
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

/**
 * The collections a raw schema reads, one entry per {@link bindingKey}.
 *
 * Larger limit wins when two nodes bind the same collection with different
 * caps. Last-wins looked equivalent and is not: the node asking for 100 rows
 * gets 10 whenever a node asking for 10 happens to be declared after it, and
 * the panel renders a truncated list with no sign anything is missing.
 *
 * A `where` on ANY node reading a key drops the fetch's `limit` for all of them.
 * A binding's `limit` caps what it DISPLAYS, and the host applies it before the
 * client filters: a fleet of 300 agents fetched at `limit: 100` would filter 100
 * rows and report "4 failed" when there are eleven. Dropping the cap hands the
 * host's own default instead, and every node still applies its own `limit` to
 * what it draws — see {@link boundRowValues}, which filters before it caps.
 *
 * The `where` itself is NOT part of {@link bindingKey}, because filtering is a
 * client-side reading of rows the host does not interpret. Two nodes filtering
 * one collection differently still share one fetch, which is the point.
 */
export function distinctBindings(schema: unknown): VocabBinding[] {
  const parsed = parsePluginPanel(schema);
  if (!parsed.ok) return [];
  const seen = new Map<string, VocabBinding>();
  const filtered = new Set<string>();
  for (const binding of collectVocabBindings(parsed.panel.body)) {
    const key = bindingKey(binding);
    if (binding.where && binding.where.length > 0) filtered.add(key);
    const existing = seen.get(key);
    if (!existing || (binding.limit ?? Infinity) > (existing.limit ?? Infinity)) {
      seen.set(key, binding);
    }
  }
  return [...seen.entries()].map(([key, binding]) => {
    if (!filtered.has(key) || binding.limit === undefined) return binding;
    const { limit: _limit, ...rest } = binding;
    return rest;
  });
}
