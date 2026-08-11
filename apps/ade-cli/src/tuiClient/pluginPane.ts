// ---------------------------------------------------------------------------
// Plugin panel interpreter for the TUI right pane.
//
// A plugin ships declarative vocabulary JSON (shared/plugins/vocabulary.ts) and
// every ADE surface draws it with its own widgets. This module is the terminal's
// interpreter: it turns a parsed panel into a flat list of render rows plus the
// list of things the user can select, and it knows nothing about Ink. The Ink
// half is components/PluginPanelPane.tsx.
//
// The split follows activityPane.ts / ActivityPaneView.tsx: the model is pure so
// the layout, the selection math and the degradation ladder are unit-testable
// without rendering, and the view stays a memoizable stateless component whose
// only state (the selected index) lives in app.tsx like every other pane's.
//
// Terminal subset (design decision D8). Rendered richly: stack, text, badge,
// button, list, table, keyValue, divider, emptyState, and form via the composer
// funnel. Rendered as a labeled placeholder line: video, image, chart, and any
// component name a future vocabulary version adds. A placeholder is deliberate,
// not a failure — it names what is there and how to see it, because a blank gap
// is indistinguishable from a broken plugin.
// ---------------------------------------------------------------------------

import {
  VOCAB_LIMITS,
  bindingKey,
  boundRowValues,
  coerceBoundKeyValueRow,
  coerceBoundListItem,
  coerceBoundTableRow,
  distinctBindings,
  parsePluginPanel,
  type VocabAction,
  type VocabBinding,
  type VocabFallback,
  type VocabField,
  type VocabFieldKind,
  type VocabKeyValueRow,
  type VocabListItem,
  type VocabNode,
  type VocabTableColumn,
  type VocabTone,
} from "../../../desktop/src/shared/plugins/vocabulary";
import type {
  PluginCollectionRow,
  PluginPanelRecord as HostPluginPanelRecord,
} from "../../../desktop/src/shared/plugins/sdk";

/**
 * The part of a `plugin_collections` row this interpreter reads.
 *
 * Deliberately a structural subset of the host's `PluginCollectionRow`, which
 * also carries `collection` and `updatedAt`: the renderer needs neither, and
 * asking for them would make every fixture and every future wire field the
 * pane's problem.
 */
export type PluginPaneCollectionRow = Pick<PluginCollectionRow, "key" | "value">;

/** Rows already fetched for every binding in the panel, keyed by {@link bindingKey}. */
export type PluginPaneCollectionMap = Map<string, PluginPaneCollectionRow[]>;

/**
 * The binding contract belongs to the vocabulary, not to this pane: the same key
 * function and the same dedup the desktop renderer uses, re-exported because
 * `app.tsx` reaches for the pane rather than into the desktop tree.
 */
export { bindingKey, distinctBindings };

/* ── What the host gave us ──────────────────────────────────────────────── */

/**
 * A `plugin_panels` row, as the `plugin.getPanel` action returns it. `schema` is
 * opaque versioned JSON: parsed here, never inspected by the caller.
 */
export type PluginPanelRecord = HostPluginPanelRecord;

/**
 * The outcome of asking the host for a panel.
 *
 * `unsupported` is its own state rather than an error string because it is the
 * expected answer from a host that predates plugin panels, and the pane says so
 * plainly instead of implying the plugin is broken.
 */
export type PluginPanelFetch =
  | { state: "ok"; record: PluginPanelRecord }
  | { state: "missing" }
  | { state: "unsupported" }
  | { state: "error"; message: string };

/* ── Rows ───────────────────────────────────────────────────────────────── */

export type PluginPaneInlinePart = {
  text: string;
  tone: VocabTone;
  /** Badges get bracketed; plain text does not. */
  badge: boolean;
};

export type PluginPaneButton = {
  label: string;
  kind: "primary" | "default" | "quiet";
  disabled: boolean;
  /** Index into {@link PluginPaneModel.interactives}, or null when disabled. */
  selection: number | null;
};

export type PluginPaneRow =
  | { kind: "text"; key: string; indent: number; text: string; variant: "title" | "subtitle" | "body" | "caption" | "code"; tone: VocabTone }
  | { kind: "inline"; key: string; indent: number; parts: PluginPaneInlinePart[] }
  | { kind: "divider"; key: string; indent: number; label: string | null }
  | { kind: "keyValue"; key: string; indent: number; label: string; value: string; tone: VocabTone }
  | {
      kind: "listItem";
      key: string;
      indent: number;
      title: string;
      subtitle: string | null;
      meta: string | null;
      tone: VocabTone;
      selection: number | null;
    }
  | { kind: "tableHead"; key: string; indent: number; cells: string[]; widths: number[]; aligns: ("left" | "right")[] }
  | { kind: "tableRow"; key: string; indent: number; cells: string[]; widths: number[]; aligns: ("left" | "right")[] }
  | { kind: "buttons"; key: string; indent: number; buttons: PluginPaneButton[] }
  | {
      kind: "field";
      key: string;
      indent: number;
      label: string;
      display: string;
      fieldKind: VocabFieldKind;
      selection: number;
      /** True while this field owns the composer. */
      editing: boolean;
    }
  | { kind: "submit"; key: string; indent: number; label: string; selection: number }
  /** Dim explanatory line: an `emptyText`, a help string, a truncation notice. */
  | { kind: "note"; key: string; indent: number; text: string }
  /** A component this surface does not draw. Names it and says where it lives. */
  | { kind: "placeholder"; key: string; indent: number; label: string; hint: string };

/* ── Interactives ───────────────────────────────────────────────────────── */

export type PluginPaneInteractive =
  | { kind: "action"; label: string; action: VocabAction }
  | { kind: "field"; formKey: string; field: VocabField }
  | { kind: "submit"; formKey: string; label: string; action: VocabAction; fields: VocabField[] };

/**
 * What an interactive *is*, independent of where it currently sits.
 *
 * The selection index is a position in a list the 10s poll rebuilds from
 * scratch, so it is the wrong thing to remember across a refresh: an armed
 * confirm keyed by index re-points at whatever moved into that slot, and the
 * next Enter runs an action the user never confirmed. Two interactives with the
 * same identity here are the same operation with the same arguments, so
 * confirming one legitimately confirms the other.
 *
 * The identity starts at the panel, not at the action: an action id is a
 * plugin's own namespace, so `{action:"deploy"}` in one plugin and the same in
 * another are two different operations that would otherwise share a key — and
 * one Esc back to the picker plus one Enter into a second plugin is all it
 * takes to reach them in that order. Panel id is in there for the same reason
 * within a plugin.
 */
export function pluginInteractiveKey(
  panel: Pick<PluginPaneModel, "pluginId" | "panelId">,
  interactive: PluginPaneInteractive,
): string {
  // JSON rather than a joined string: a plugin id, an action id, a label and an
  // argument value are all free text, and a hand-rolled separator between them
  // is a collision waiting to happen.
  const owner = [panel.pluginId, panel.panelId];
  if (interactive.kind === "field") {
    return JSON.stringify([...owner, "field", interactive.formKey, interactive.field.id]);
  }
  const { action, args } = interactive.action;
  const argIdentity = Object.keys(args ?? {})
    .sort()
    .map((name) => [name, args?.[name]]);
  return interactive.kind === "submit"
    ? JSON.stringify([...owner, "submit", interactive.formKey, action, argIdentity])
    : JSON.stringify([...owner, "action", action, argIdentity, interactive.label]);
}

export type PluginPaneModel = {
  pluginId: string;
  panelId: string;
  /** Panel title if it declared one, else the plugin's display name. */
  title: string;
  rows: PluginPaneRow[];
  interactives: PluginPaneInteractive[];
  /** Non-fatal parse warnings, shown as one summary line. */
  warnings: string[];
  fallback: VocabFallback | null;
  /** `fallback` means the schema could not be rendered and the card is showing. */
  status: "ok" | "fallback";
};

/** Form values live in app.tsx as one flat string map, like every other TUI form. */
export function pluginFormValueKey(formKey: string, fieldId: string): string {
  return `${formKey}::${fieldId}`;
}

/* ── Bound rows ─────────────────────────────────────────────────────────── */

/**
 * Bound rows must already be in render shape (vocabulary rule 3: the plugin
 * materializes on its machine, the client draws). The coercion itself lives in
 * the vocabulary module, so a numeric cell reads the same here as it does in the
 * app instead of each surface inventing its own answer.
 */
function boundValues(
  bind: VocabBinding | undefined,
  collections: PluginPaneCollectionMap,
): unknown[] | null {
  if (!bind) return null;
  return boundRowValues(bind, collections.get(bindingKey(bind)));
}

/* ── Field display ──────────────────────────────────────────────────────── */

export function pluginFieldRawValue(
  field: VocabField,
  formKey: string,
  values: Record<string, string>,
): string {
  const stored = values[pluginFormValueKey(formKey, field.id)];
  if (stored !== undefined) return stored;
  if (field.value === undefined) return field.kind === "toggle" ? "false" : "";
  return typeof field.value === "boolean" ? String(field.value) : String(field.value);
}

function fieldDisplay(field: VocabField, raw: string): string {
  if (field.kind === "toggle") return raw === "true" ? "on" : "off";
  if (field.kind === "secret") return raw ? "••••••••" : (field.placeholder ?? "not set");
  if (field.kind === "select") {
    const option = field.options?.find((entry) => entry.value === raw);
    return option?.label ?? option?.value ?? (field.placeholder ?? "choose one");
  }
  return raw || (field.placeholder ?? "—");
}

/** Next value for a field the user activated without typing (Enter / ← / →). */
export function cyclePluginFieldValue(field: VocabField, raw: string, delta: number): string {
  if (field.kind === "toggle") return raw === "true" ? "false" : "true";
  if (field.kind === "select") {
    const options = field.options ?? [];
    if (options.length === 0) return raw;
    const index = options.findIndex((option) => option.value === raw);
    const next = (index + delta + options.length) % options.length;
    return options[next]?.value ?? raw;
  }
  return raw;
}

/** True for the kinds whose value is typed, which is what the composer funnels. */
export function pluginFieldUsesComposer(kind: VocabFieldKind): boolean {
  return kind === "text" || kind === "secret" || kind === "number";
}

/* ── Placeholders ───────────────────────────────────────────────────────── */

const PLACEHOLDER_LABEL: Record<string, string> = {
  video: "Video",
  image: "Image",
  chart: "Chart",
};

function placeholderLabel(component: string, title?: string): string {
  const base = PLACEHOLDER_LABEL[component] ?? component;
  return title ? `${base} · ${title}` : base;
}

function placeholderHint(hasDeeplink: boolean): string {
  return hasDeeplink ? "Ctrl+Y copies a link that opens it" : "Run ade open to view it in the app";
}

/* ── Table layout ───────────────────────────────────────────────────────── */

/**
 * Column widths that fill the pane without wrapping. Every column keeps at least
 * three characters; the widest content gets the slack. A wrapped table row would
 * push the rest of the panel out of the window, so cells truncate instead.
 */
export function pluginTableWidths(
  columns: VocabTableColumn[],
  rows: string[][],
  inner: number,
): number[] {
  const gaps = Math.max(0, columns.length - 1);
  const budget = Math.max(columns.length * 3, inner - gaps);
  const natural = columns.map((column, index) => {
    const longest = rows.reduce((max, row) => Math.max(max, (row[index] ?? "").length), column.label.length);
    return Math.max(3, longest);
  });
  const total = natural.reduce((sum, width) => sum + width, 0);
  if (total <= budget) return natural;

  // Shrink proportionally, then hand any rounding remainder to the widest column
  // so the row exactly fills the pane rather than leaving a ragged edge.
  const scale = budget / total;
  const shrunk = natural.map((width) => Math.max(3, Math.floor(width * scale)));
  let slack = budget - shrunk.reduce((sum, width) => sum + width, 0);
  while (slack > 0) {
    let widest = 0;
    for (let index = 1; index < shrunk.length; index += 1) {
      if ((natural[index] ?? 0) - (shrunk[index] ?? 0) > (natural[widest] ?? 0) - (shrunk[widest] ?? 0)) widest = index;
    }
    shrunk[widest] = (shrunk[widest] ?? 3) + 1;
    slack -= 1;
  }
  return shrunk;
}

/* ── The walk ───────────────────────────────────────────────────────────── */

type WalkContext = {
  rows: PluginPaneRow[];
  interactives: PluginPaneInteractive[];
  collections: PluginPaneCollectionMap;
  values: Record<string, string>;
  /** Interactive index currently taking typed input, so its row reads as live. */
  editing: number | null;
  inner: number;
  hasDeeplink: boolean;
};

function push(ctx: WalkContext, row: PluginPaneRow): void {
  ctx.rows.push(row);
}

function addInteractive(ctx: WalkContext, interactive: PluginPaneInteractive): number {
  ctx.interactives.push(interactive);
  return ctx.interactives.length - 1;
}

/** Text and badges are the only nodes a horizontal stack can fold onto one line. */
function inlinePart(node: VocabNode): PluginPaneInlinePart | null {
  if (node.component === "text") {
    return { text: node.text, tone: node.tone ?? "neutral", badge: false };
  }
  if (node.component === "badge") {
    return { text: node.text, tone: node.tone ?? "neutral", badge: true };
  }
  return null;
}

function walkNodes(nodes: readonly VocabNode[], path: string, indent: number, ctx: WalkContext): void {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node) walkNode(node, `${path}[${index}]`, indent, ctx);
  }
}

function walkNode(node: VocabNode, key: string, indent: number, ctx: WalkContext): void {
  switch (node.component) {
    case "stack": {
      // A horizontal stack of text/badges becomes one line — that is what the
      // author meant by "horizontal", and stacking them vertically would read as
      // a layout bug. Anything else falls back to vertical, because a terminal
      // cannot put two lists side by side at 30 columns.
      if (node.direction === "horizontal") {
        const parts = node.children.map(inlinePart);
        if (parts.length > 0 && parts.every((part): part is PluginPaneInlinePart => part !== null)) {
          push(ctx, { kind: "inline", key, indent, parts });
          return;
        }
        const buttons = node.children.filter((child) => child.component === "button");
        if (buttons.length === node.children.length && buttons.length > 0) {
          pushButtons(node.children, key, indent, ctx);
          return;
        }
      }
      walkNodes(node.children, `${key}.children`, indent, ctx);
      return;
    }
    case "text": {
      push(ctx, {
        kind: "text",
        key,
        indent,
        text: node.text,
        variant: node.variant ?? "body",
        tone: node.tone ?? "neutral",
      });
      return;
    }
    case "badge": {
      push(ctx, {
        kind: "inline",
        key,
        indent,
        parts: [{ text: node.text, tone: node.tone ?? "neutral", badge: true }],
      });
      return;
    }
    case "divider": {
      push(ctx, { kind: "divider", key, indent, label: node.label ?? null });
      return;
    }
    case "button": {
      pushButtons([node], key, indent, ctx);
      return;
    }
    case "list": {
      const bound = boundValues(node.bind, ctx.collections);
      const items = bound
        ? bound.map(coerceBoundListItem).filter((item): item is VocabListItem => item !== null)
        : (node.items ?? []);
      if (items.length === 0) {
        push(ctx, { kind: "note", key, indent, text: node.emptyText ?? "Nothing here yet." });
        return;
      }
      items.slice(0, VOCAB_LIMITS.maxListItems).forEach((item, index) => {
        const selection = item.onPress
          ? addInteractive(ctx, { kind: "action", label: item.title, action: item.onPress })
          : null;
        push(ctx, {
          kind: "listItem",
          key: `${key}.item[${index}]`,
          indent,
          title: item.title,
          subtitle: item.subtitle ?? null,
          meta: item.meta ?? null,
          tone: item.tone ?? "neutral",
          selection,
        });
      });
      return;
    }
    case "table": {
      const bound = boundValues(node.bind, ctx.collections);
      const source = bound ?? node.rows ?? [];
      const cells = source
        .map((row) => coerceBoundTableRow(row, node.columns))
        .filter((row): row is Record<string, string> => row !== null)
        .slice(0, VOCAB_LIMITS.maxTableRows)
        .map((row) => node.columns.map((column) => row[column.key] ?? ""));
      if (cells.length === 0) {
        push(ctx, { kind: "note", key, indent, text: node.emptyText ?? "No rows yet." });
        return;
      }
      const widths = pluginTableWidths(node.columns, cells, Math.max(12, ctx.inner - indent * 2));
      const aligns = node.columns.map((column) => column.align ?? "left");
      push(ctx, {
        kind: "tableHead",
        key: `${key}.head`,
        indent,
        cells: node.columns.map((column) => column.label),
        widths,
        aligns,
      });
      cells.forEach((row, index) => {
        push(ctx, { kind: "tableRow", key: `${key}.row[${index}]`, indent, cells: row, widths, aligns });
      });
      return;
    }
    case "keyValue": {
      const bound = boundValues(node.bind, ctx.collections);
      const rows = bound
        ? bound.map(coerceBoundKeyValueRow).filter((row): row is VocabKeyValueRow => row !== null)
        : (node.rows ?? []);
      if (rows.length === 0) {
        push(ctx, { kind: "note", key, indent, text: node.emptyText ?? "Nothing to show." });
        return;
      }
      rows.slice(0, VOCAB_LIMITS.maxKeyValueRows).forEach((row, index) => {
        push(ctx, {
          kind: "keyValue",
          key: `${key}.row[${index}]`,
          indent,
          label: row.key,
          value: row.value,
          tone: row.tone ?? "neutral",
        });
      });
      return;
    }
    case "form": {
      // The composer funnel: no pane in this TUI owns a text input, so a field
      // row shows its value and the shared bottom composer edits whichever field
      // is live. One live field at a time, Enter commits and advances.
      node.fields.forEach((field, index) => {
        const selection = addInteractive(ctx, { kind: "field", formKey: key, field });
        const raw = pluginFieldRawValue(field, key, ctx.values);
        push(ctx, {
          kind: "field",
          key: `${key}.field[${index}]`,
          indent,
          label: field.label,
          display: fieldDisplay(field, raw),
          fieldKind: field.kind,
          selection,
          editing: ctx.editing === selection,
        });
        if (field.help) push(ctx, { kind: "note", key: `${key}.help[${index}]`, indent: indent + 1, text: field.help });
      });
      const submit = addInteractive(ctx, {
        kind: "submit",
        formKey: key,
        label: node.submit.label,
        action: node.submit.onPress,
        fields: node.fields,
      });
      push(ctx, { kind: "submit", key: `${key}.submit`, indent, label: node.submit.label, selection: submit });
      return;
    }
    case "emptyState": {
      push(ctx, { kind: "text", key: `${key}.title`, indent, text: node.title, variant: "subtitle", tone: "neutral" });
      if (node.description) {
        push(ctx, { kind: "note", key: `${key}.description`, indent, text: node.description });
      }
      if (node.action) {
        const selection = addInteractive(ctx, {
          kind: "action",
          label: node.action.label,
          action: node.action.onPress,
        });
        push(ctx, {
          kind: "buttons",
          key: `${key}.action`,
          indent,
          buttons: [{ label: node.action.label, kind: "primary", disabled: false, selection }],
        });
      }
      return;
    }
    case "__invalid": {
      // A node the plugin got wrong. Named, not hidden: the author is often the
      // person reading this pane.
      push(ctx, { kind: "note", key, indent, text: `${node.name} could not be rendered — ${node.reason}` });
      return;
    }
    case "__unknown": {
      push(ctx, {
        kind: "placeholder",
        key,
        indent,
        label: placeholderLabel(node.name),
        hint: "This ADE version does not draw it yet",
      });
      return;
    }
    case "video":
    case "image":
    case "chart": {
      const title = node.component === "chart" ? node.title : node.component === "video" ? node.title : node.alt;
      push(ctx, {
        kind: "placeholder",
        key,
        indent,
        label: placeholderLabel(node.component, title),
        hint: placeholderHint(ctx.hasDeeplink),
      });
      return;
    }
    default: {
      // Every known component has an arm above. Reaching here means one was
      // added to the vocabulary without an interpreter, which should read as a
      // placeholder rather than a hole in the panel.
      push(ctx, {
        kind: "placeholder",
        key,
        indent,
        label: placeholderLabel((node as { component: string }).component),
        hint: "This ADE version does not draw it yet",
      });
    }
  }
}

function pushButtons(nodes: readonly VocabNode[], key: string, indent: number, ctx: WalkContext): void {
  const buttons: PluginPaneButton[] = [];
  for (const node of nodes) {
    if (node.component !== "button") continue;
    const disabled = node.disabled === true;
    const selection = disabled
      ? null
      : addInteractive(ctx, { kind: "action", label: node.label, action: node.onPress });
    buttons.push({ label: node.label, kind: node.kind ?? "default", disabled, selection });
  }
  if (buttons.length > 0) push(ctx, { kind: "buttons", key, indent, buttons });
}

/* ── Build ──────────────────────────────────────────────────────────────── */

export type PluginPaneInput = {
  pluginId: string;
  /** Manifest display name, used when the panel declares no title. */
  displayName: string;
  panelId: string;
  fetch: PluginPanelFetch;
  collections: PluginPaneCollectionMap;
  values: Record<string, string>;
  /** Interactive index that currently owns the composer, if any. */
  editing?: number | null;
  /** Pane content width in columns. */
  width: number;
};

/**
 * Build the render model.
 *
 * Never returns an empty pane. Every failure path — a host that cannot serve
 * panels, a panel that does not exist, a schema the parser rejected — produces
 * the plugin's own fallback words when it has them and a designed sentence of
 * ours when it does not. That is rule 2 of the vocabulary's stability promise.
 */
export function buildPluginPaneModel(input: PluginPaneInput): PluginPaneModel {
  const inner = Math.max(16, input.width - 4);
  const base = {
    pluginId: input.pluginId,
    panelId: input.panelId,
    interactives: [] as PluginPaneInteractive[],
    warnings: [] as string[],
  };

  if (input.fetch.state !== "ok") {
    return {
      ...base,
      title: input.displayName,
      status: "fallback",
      fallback: null,
      rows: [fallbackNote(input.fetch, input.pluginId, input.panelId)],
    };
  }

  const record = input.fetch.record;
  const parsed = parsePluginPanel(record.schema);
  if (!parsed.ok) {
    const fallback = parsed.fallback;
    const rows: PluginPaneRow[] = fallback
      ? [
          { kind: "text", key: "fallback.title", indent: 0, text: fallback.title, variant: "subtitle", tone: "neutral" },
          { kind: "note", key: "fallback.text", indent: 0, text: fallback.text },
        ]
      : [
          {
            kind: "note",
            key: "fallback.none",
            indent: 0,
            text: `${input.displayName} sent a panel this version cannot read.`,
          },
        ];
    if (fallback?.deeplink) {
      rows.push({ kind: "note", key: "fallback.deeplink", indent: 0, text: "Ctrl+Y copies a link that opens it" });
    }
    const reason = parsed.errors[0]?.message;
    if (reason) rows.push({ kind: "note", key: "fallback.reason", indent: 0, text: reason });
    return {
      ...base,
      title: record.title ?? input.displayName,
      status: "fallback",
      fallback,
      rows,
    };
  }

  const ctx: WalkContext = {
    rows: [],
    interactives: [],
    collections: input.collections,
    values: input.values,
    editing: input.editing ?? null,
    inner,
    hasDeeplink: Boolean(parsed.panel.fallback.deeplink),
  };
  walkNodes(parsed.panel.body, "body", 0, ctx);
  if (ctx.rows.length === 0) {
    ctx.rows.push({ kind: "note", key: "body.empty", indent: 0, text: parsed.panel.fallback.text });
  }

  return {
    pluginId: input.pluginId,
    panelId: input.panelId,
    title: parsed.panel.title ?? record.title ?? input.displayName,
    rows: ctx.rows,
    interactives: ctx.interactives,
    warnings: parsed.warnings.map((warning) => warning.message),
    fallback: parsed.panel.fallback,
    status: "ok",
  };
}

function fallbackNote(
  fetch: Exclude<PluginPanelFetch, { state: "ok" }>,
  pluginId: string,
  panelId: string,
): PluginPaneRow {
  const text = fetch.state === "unsupported"
    ? "This ADE host does not serve plugin panels yet. Update it to see this panel."
    : fetch.state === "missing"
      ? `${pluginId} has not published a "${panelId}" panel yet.`
      : fetch.message;
  return { kind: "note", key: "fetch", indent: 0, text };
}

/* ── Windowing ──────────────────────────────────────────────────────────── */

export type PluginPaneWindow = {
  rows: PluginPaneRow[];
  hiddenBefore: number;
  hiddenAfter: number;
};

/**
 * The slice of rows to draw, keeping the selected interactive on screen.
 *
 * Mirrors `activityPaneEntries`: the pane has no scrollbar, so moving the
 * selection is what scrolls, and the window follows it.
 */
export function pluginPaneWindow(
  model: PluginPaneModel,
  selectionIndex: number,
  capacity: number,
): PluginPaneWindow {
  const limit = Math.max(1, Math.floor(capacity));
  if (model.rows.length <= limit) {
    return { rows: model.rows, hiddenBefore: 0, hiddenAfter: 0 };
  }
  const anchor = model.rows.findIndex(
    (row) => "selection" in row && row.selection === selectionIndex,
  );
  const buttonAnchor = anchor >= 0
    ? anchor
    : model.rows.findIndex(
        (row) => row.kind === "buttons" && row.buttons.some((button) => button.selection === selectionIndex),
      );
  const focus = buttonAnchor >= 0 ? buttonAnchor : 0;
  // Keep a row of context above the selection so the user can see what they are
  // moving through, not just where they landed.
  const start = Math.max(0, Math.min(focus - 1, model.rows.length - limit));
  return {
    rows: model.rows.slice(start, start + limit),
    hiddenBefore: start,
    hiddenAfter: Math.max(0, model.rows.length - start - limit),
  };
}

/** Move the selection, wrapping. Returns 0 when the panel has nothing to select. */
export function movePluginPaneSelection(model: PluginPaneModel, current: number, delta: number): number {
  const count = model.interactives.length;
  if (count === 0) return 0;
  const safe = Number.isFinite(current) ? Math.max(0, Math.min(Math.floor(current), count - 1)) : 0;
  return (safe + delta + count) % count;
}

/** The one line a pane too narrow to open prints into the chat instead. */
export const PLUGIN_PANE_TOO_NARROW =
  "This terminal is too narrow for plugin panels. Widen the window and run the command again.";
