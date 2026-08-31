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
  VOCAB_CONTEXT_COLLECTION,
  VOCAB_LIMITS,
  VOCAB_STATE_COLLECTION,
  bindingKey,
  boundRowEntries,
  boundRowValues,
  coerceBoundKeyValueRow,
  coerceBoundListItem,
  coerceBoundTableRow,
  collectVocabStateDeclarations,
  distinctBindings,
  parsePluginPanel,
  readPluginActionResetState,
  vocabApplyStateChange,
  vocabContextRows,
  vocabCycleStateValue,
  vocabInitialPanelState,
  vocabNormalizePanelState,
  vocabResetPanelState,
  vocabStatePayload,
  vocabStateRows,
  vocabStateSignature,
  type VocabAction,
  type VocabBinding,
  type VocabFallback,
  type VocabField,
  type VocabFieldKind,
  type VocabKeyValueRow,
  type VocabListItem,
  type VocabListItemAction,
  type VocabNode,
  type VocabPanelState,
  type VocabStateDeclaration,
  type VocabTableColumn,
  type VocabTone,
} from "../../../desktop/src/shared/plugins/vocabulary";
import { readPluginPanelRefreshAction } from "../../../desktop/src/shared/plugins/sdk";
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

/**
 * Rows for one binding of a panel about to be drawn.
 *
 * `$context` is ADE's, not the plugin's: the host has no collection under that
 * name and asking for one would return nothing. Resolving it here rather than at
 * the fetch site is what keeps the terminal's `$context` the same value the
 * panel's actions carry.
 */
export function pluginPaneBindingRows(
  binding: VocabBinding,
  context: Record<string, unknown> | null | undefined,
  fetchRows: () => Promise<PluginPaneCollectionRow[]>,
): Promise<PluginPaneCollectionRow[]> {
  if (binding.collection === VOCAB_CONTEXT_COLLECTION) {
    return Promise.resolve(vocabContextRows(context));
  }
  // `$state` is the other reserved collection, and it is filled at RENDER rather
  // than here: its rows are the reader's own `segmented` selections, and tying
  // them to a fetch would put a round trip back into the one gesture this
  // feature exists to make free.
  if (binding.collection === VOCAB_STATE_COLLECTION) {
    return Promise.resolve([]);
  }
  return fetchRows();
}

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
      /**
       * The row's status chip, bracketed after the title. No icon: a terminal
       * has no glyph set to promise, and a chip that said `[● Running]` on one
       * font and `[? Running]` on another is worse than one that says
       * `[Running]` everywhere.
       */
      badge: { text: string; tone: VocabTone } | null;
      /**
       * The row's monospace line. Every line here is already monospace, so this
       * is drawn as its own dim line under the subtitle rather than styled —
       * the position is what carries the meaning in a terminal.
       */
      mono: string | null;
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
  | {
      /**
       * A `segmented` control: its options as numbered pills, one of them
       * chosen. Drawn like a `buttons` row rather than like a `field` because
       * every option is reachable in one keystroke, which is what a filter with
       * three states wants in a terminal — a `field` would make the reader cycle
       * through the ones they did not want.
       */
      kind: "segmented";
      key: string;
      indent: number;
      label: string | null;
      options: {
        label: string;
        /** A small count beside the label, e.g. `12`. Text only. */
        badge: string | null;
        /** True for the option currently in force. */
        selected: boolean;
        selection: number;
      }[];
    }
  /** Dim explanatory line: an `emptyText`, a help string, a truncation notice. */
  | { kind: "note"; key: string; indent: number; text: string }
  /** A component this surface does not draw. Names it and says where it lives. */
  | { kind: "placeholder"; key: string; indent: number; label: string; hint: string };

/* ── Interactives ───────────────────────────────────────────────────────── */

export type PluginPaneInteractive =
  | { kind: "action"; label: string; action: VocabAction }
  /**
   * One field of a form. `applyOnChange` and `fields` ride along so a committed
   * edit can dispatch without the form's submit row — a form declaring
   * `applyOnChange` need not have one, and even when it does the change applies
   * before anybody presses it.
   */
  | {
      kind: "field";
      formKey: string;
      field: VocabField;
      applyOnChange?: VocabAction;
      fields: VocabField[];
    }
  | { kind: "submit"; formKey: string; label: string; action: VocabAction; fields: VocabField[] }
  /**
   * One option of a `segmented` control. Selecting it writes one string into
   * panel state and redraws from rows already in memory; `onChange` is dispatched
   * afterwards only when the schema declared it, and never instead of the write.
   */
  | {
      kind: "state";
      stateKey: string;
      label: string;
      value: string;
      onChange?: VocabAction;
    };

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
  // A state option is identified by what it SETS, never by its label: a plugin
  // that renames "Active" to "Running" between two polls has not turned it into
  // a different option, and an armed confirm must survive that.
  if (interactive.kind === "state") {
    return JSON.stringify([...owner, "state", interactive.stateKey, interactive.value]);
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
  /**
   * The `segmented` controls this schema declares, in reading order.
   *
   * Collected once here and kept beside the rows, because everything that
   * touches panel state needs them: the initial values, validating a change,
   * filling a `$state` binding, and deciding whether a re-published schema may
   * keep the reader's selection.
   */
  declarations: VocabStateDeclaration[];
  /**
   * The value of every declared state key right now, already reconciled against
   * the controls above. What a binding's `where` reads and what rides on an
   * action invoke under `state`.
   */
  state: VocabPanelState;
  /**
   * Identity of the CONTROLS, not of the data — see `vocabStateSignature`. A
   * caller carries a selection across a refresh by handing this back with it;
   * a schema whose controls changed gets a new one and the selection is
   * reconciled instead of trusted.
   */
  stateSignature: string;
  /** Non-fatal parse warnings, shown as one summary line. */
  warnings: string[];
  fallback: VocabFallback | null;
  /** `fallback` means the schema could not be rendered and the card is showing. */
  status: "ok" | "fallback";
  /**
   * The plugin action `r` dispatches before it refetches, when the panel's
   * manifest declared one. `null` keeps `r` a plain refetch, which is what it
   * always was.
   *
   * Read off the stored schema even on the fallback path: a panel this build
   * cannot parse may still be one the plugin can refresh into something it can,
   * and refusing the gesture there would strand the reader on the card.
   */
  refreshAction: string | null;
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
function boundValues(bind: VocabBinding | undefined, ctx: WalkContext): unknown[] | null {
  if (!bind) return null;
  // `$state` has no rows in any store: it IS the panel's live selections, so it
  // is built here, at draw time, from the same declarations the controls render
  // from. Everything after this point treats it as an ordinary collection.
  const reserved = bind.collection === VOCAB_STATE_COLLECTION
    ? vocabStateRows(ctx.declarations, ctx.state).map((row) => ({ value: row }))
    : null;
  // The filter and the cap both live in `boundRowValues`, in `shared/plugins`,
  // so the terminal cannot keep a row the app drops from the same schema and the
  // same data.
  return boundRowValues(bind, reserved ?? ctx.collections.get(bindingKey(bind)), ctx.state);
}

/**
 * The same rows for `keyValue`, which needs each row's own key.
 *
 * A collection row is `{key, value}`, so a row whose stored value is plain text
 * — every `$context` row is one — has a key already. Reading only the value
 * threw it away and left the node drawing its `emptyText` beside a context that
 * was right there. iOS keeps the key; this is the terminal doing the same.
 */
function boundKeyedValues(
  bind: VocabBinding | undefined,
  ctx: WalkContext,
): { key?: string; value: unknown }[] | null {
  if (!bind) return null;
  const reserved = bind.collection === VOCAB_STATE_COLLECTION
    ? vocabStateRows(ctx.declarations, ctx.state).map((row) => ({ value: row }))
    : null;
  return boundRowEntries(bind, reserved ?? ctx.collections.get(bindingKey(bind)), ctx.state);
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
  /** The `segmented` controls the panel declared, and their live values. */
  declarations: VocabStateDeclaration[];
  state: VocabPanelState;
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
      const bound = boundValues(node.bind, ctx);
      const items = bound
        ? bound
            .map((row) => coerceBoundListItem(row, node.bind?.allowActions))
            .filter((item): item is VocabListItem => item !== null)
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
          badge: item.badge ? { text: item.badge.text, tone: item.badge.tone ?? "neutral" } : null,
          mono: item.mono ?? null,
        });
        // The row's buttons, on their own indented line beneath it.
        //
        // `overflow` is drawn in the same line as `actions`, not behind a
        // chevron: a terminal pane has no menu, and the honest degradation is
        // to show what the row can do rather than hide half of it behind a
        // control the reader cannot open. They keep their declared order, so a
        // reader comparing the TUI against the desktop sees the same sequence.
        pushRowActions(
          [...(item.actions ?? []), ...(item.overflow ?? [])],
          `${key}.item[${index}].actions`,
          indent + 1,
          ctx,
        );
      });
      return;
    }
    case "table": {
      const bound = boundValues(node.bind, ctx);
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
      const bound = boundKeyedValues(node.bind, ctx);
      const rows = bound
        ? bound
            .map((entry) => coerceBoundKeyValueRow(entry.value, entry.key))
            .filter((row): row is VocabKeyValueRow => row !== null)
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
        const selection = addInteractive(ctx, {
          kind: "field",
          formKey: key,
          field,
          fields: node.fields,
          ...(node.applyOnChange ? { applyOnChange: node.applyOnChange } : {}),
        });
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
      // A form that applies on change has no button to draw. Drawing one anyway
      // would offer a control the schema never declared an action for.
      if (node.submit) {
        const submit = addInteractive(ctx, {
          kind: "submit",
          formKey: key,
          label: node.submit.label,
          action: node.submit.onPress,
          fields: node.fields,
        });
        push(ctx, { kind: "submit", key: `${key}.submit`, indent, label: node.submit.label, selection: submit });
      }
      return;
    }
    case "segmented": {
      // The declaration wins over the node when the panel declared more state
      // keys than the vocabulary allows: past the ceiling a control still draws
      // and still sets its own key, it simply shares nothing with a `where`.
      const declaration = ctx.declarations.find((entry) => entry.stateKey === node.stateKey);
      const options = declaration?.options ?? node.options;
      const current = ctx.state[node.stateKey]
        ?? declaration?.initial
        ?? node.default
        ?? options[0]?.value
        ?? "";
      const drawn = options.map((option) => ({
        label: option.label,
        badge: option.badge ?? null,
        selected: option.value === current,
        selection: addInteractive(ctx, {
          kind: "state",
          stateKey: node.stateKey,
          label: option.label,
          value: option.value,
          ...(node.onChange ? { onChange: node.onChange } : {}),
        }),
      }));
      push(ctx, { kind: "segmented", key, indent, label: node.label ?? null, options: drawn });
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

/**
 * A list row's trailing and overflow actions, as the same numbered pills a
 * `button` node draws.
 *
 * Reuses the `buttons` row rather than inventing a row kind, so a row's action
 * is selected, confirmed and dispatched by exactly the code that already runs a
 * button — including the `confirm` gate and the interactive identity that
 * survives a refresh.
 */
function pushRowActions(
  actions: readonly VocabListItemAction[],
  key: string,
  indent: number,
  ctx: WalkContext,
): void {
  const buttons: PluginPaneButton[] = actions.map((action) => ({
    label: action.label,
    kind: action.kind ?? "default",
    disabled: false,
    selection: addInteractive(ctx, { kind: "action", label: action.label, action }),
  }));
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
  /**
   * What the panel was opened with: a `plugin` deeplink's `?ctx=`, or the
   * `{navigate:{context}}` an action returned. Bindable as `$context` and
   * attached to every action this pane dispatches — see `vocabulary.ts`.
   */
  context?: Record<string, unknown> | null;
  values: Record<string, string>;
  /**
   * The reader's `segmented` selections carried across a rebuild, and the
   * signature of the controls they were made against.
   *
   * `undefined` is a freshly opened panel and starts every control on its
   * declared default. With a value, the model reconciles: the same signature
   * keeps the selections as they are, and a changed one runs them through
   * `vocabNormalizePanelState`, which drops a key the new schema does not
   * declare and resets a value the control no longer offers. Both halves are
   * needed — the signature catches a control that vanished, the normalize
   * catches a value inside one that did not.
   */
  state?: VocabPanelState;
  stateSignature?: string;
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
    // No parsed body means no controls to declare, so a fallback card has no
    // state — and `vocabStateSignature([])` is what a later parse of a panel
    // with no controls produces too, so the two cannot disagree.
    declarations: [] as VocabStateDeclaration[],
    state: {} as VocabPanelState,
    stateSignature: vocabStateSignature([]),
    // No row means no schema to read a declaration off, so `r` stays the plain
    // refetch it has always been.
    refreshAction: null as string | null,
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
      refreshAction: readPluginPanelRefreshAction(record.schema),
    };
  }

  const declarations = collectVocabStateDeclarations(parsed.panel.body);
  const stateSignature = vocabStateSignature(declarations);
  const state = input.state === undefined
    ? vocabInitialPanelState(declarations)
    : input.stateSignature === stateSignature
      ? input.state
      : vocabNormalizePanelState(input.state, declarations);

  const ctx: WalkContext = {
    rows: [],
    interactives: [],
    collections: input.collections,
    declarations,
    state,
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
    declarations,
    state,
    stateSignature,
    warnings: parsed.warnings.map((warning) => warning.message),
    fallback: parsed.panel.fallback,
    status: "ok",
    refreshAction: readPluginPanelRefreshAction(record.schema),
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

/* ── Panel state ────────────────────────────────────────────────────────── */

/**
 * Select one option of a `segmented` control.
 *
 * Validated against the control's own declared options, so nothing can put the
 * panel into a state the reader was never offered — and a key past the
 * `maxStateKeys` ceiling, which declares nothing, changes nothing.
 */
export function pluginPaneStateChange(
  model: PluginPaneModel,
  stateKey: string,
  value: string,
): VocabPanelState {
  const declaration = model.declarations.find((entry) => entry.stateKey === stateKey);
  if (!declaration) return model.state;
  return vocabApplyStateChange(model.state, declaration, value);
}

/** The next option, wrapping. What ←/→ does on a selected control. */
export function pluginPaneStateCycle(
  model: PluginPaneModel,
  stateKey: string,
  delta: number,
): VocabPanelState {
  const declaration = model.declarations.find((entry) => entry.stateKey === stateKey);
  if (!declaration) return model.state;
  const current = model.state[stateKey] ?? declaration.initial;
  return vocabApplyStateChange(model.state, declaration, vocabCycleStateValue(declaration, current, delta));
}

/**
 * The `{resetState}` an action asked for, applied — or `null` when it asked for
 * nothing.
 *
 * A plugin that just archived everything the "Active" filter was showing can put
 * the reader back on a filter that still has rows, rather than leaving them on an
 * empty list they have to debug.
 */
export function pluginPaneStateReset(model: PluginPaneModel, result: unknown): VocabPanelState | null {
  const reset = readPluginActionResetState(result);
  if (!reset) return null;
  return vocabResetPanelState(model.state, model.declarations, reset);
}

/**
 * What rides on an action invoke under `state`, or `null` when the panel has
 * none.
 *
 * So a "Refresh" button can respect the filter the reader is looking at: without
 * it the plugin refetches everything and the client re-filters, and a plugin
 * paging an API cannot page the filtered set at all.
 */
export function pluginPaneStatePayload(state: VocabPanelState | undefined): Record<string, string> | null {
  return vocabStatePayload(state);
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
  // A row whose selection lives in a nested list — a button strip or a
  // `segmented` control — is found by asking the row, not by reading a
  // `selection` field it does not have. Missing one here scrolls the control the
  // reader is standing on off the top of the pane.
  const nestedAnchor = anchor >= 0
    ? anchor
    : model.rows.findIndex((row) => (
      row.kind === "buttons"
        ? row.buttons.some((button) => button.selection === selectionIndex)
        : row.kind === "segmented"
          ? row.options.some((option) => option.selection === selectionIndex)
          : false
    ));
  const focus = nestedAnchor >= 0 ? nestedAnchor : 0;
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
