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
import { VOCAB_MARKDOWN_LIMITS } from "./vocabularyMarkdown";
import {
  VOCAB_STATE_LIMITS,
  evaluateVocabWhere,
  parseVocabSegmentedStyle,
  parseVocabStateKey,
  parseVocabStateOptions,
  parseVocabStateOptionsBinding,
  parseVocabWhere,
  vocabMergeStateOptions,
  vocabStateBadgeText,
  vocabStateInitial,
  type VocabPanelState,
  type VocabPredicate,
  type VocabSegmentedStyle,
  type VocabSelectionDeclaration,
  type VocabStateDeclaration,
  type VocabStateOption,
  type VocabStateOptionsBinding,
} from "./vocabularyState";

/**
 * The client-state half of the contract — the `where` grammar, its evaluator and
 * the `segmented` control's option rules — re-exported so every client keeps
 * importing the vocabulary from one place. The dependency runs one way,
 * `vocabularyNodes.ts → vocabularyState.ts`, so that module imports nothing from
 * here.
 */
export * from "./vocabularyState";

/**
 * The `markdown` node's subset — the block and inline types, the ceilings and
 * {@link parseVocabMarkdown} itself — re-exported for the same reason and with
 * the same one-way dependency: `vocabularyNodes.ts → vocabularyMarkdown.ts`.
 */
export * from "./vocabularyMarkdown";

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
  /**
   * The `markdown` node's ceilings — the source length, the block budget, the
   * container depth and the link length. Declared in `vocabularyMarkdown.ts`
   * beside the parser that enforces them, spread in here for the same reason as
   * the state ceilings above: one table.
   */
  ...VOCAB_MARKDOWN_LIMITS,
  /** Total nodes in a panel, counted through the whole tree. */
  maxNodes: 200,
  /** Nesting depth. Root `body` entries are depth 1. */
  maxDepth: 8,
  /** Serialized schema size. Matches the `schema_json` column budget. */
  maxSchemaBytes: 65_536,
  maxSelectOptions: 40,
  maxTableRows: 100,
  maxTableColumns: 8,
  /**
   * Rows one `list` may hold, and the ceiling a client reads a bound
   * collection up to.
   *
   * 250 rather than 100, because 100 was the number that made a plugin's list
   * visibly poorer than the built-in it replaced: the desktop issue browser
   * pages to 500. The byte budget does not object. A BOUND row lives in
   * `plugin_collections` and never touches `maxSchemaBytes`, so 250 bound rows
   * cost the schema one node. An INLINE list is the only one that spends
   * bytes, and there `maxSchemaBytes` was always the real ceiling and still is:
   * a fully dressed row — key, title, subtitle, meta, badge, mono, a press and
   * three trailing actions — measures 580 bytes, so 112 of them fill the whole
   * 64 KiB budget and the writer refuses the panel long before 250. A plain
   * inline row measures 82 bytes, so 250 of those spend 20,750 bytes, under a
   * third of the budget, and leave the rest of the panel room to exist.
   *
   * A client does not draw all 250 at once — see
   * {@link VOCAB_LIMITS.listPageSize}.
   */
  maxListItems: 250,
  /**
   * How many rows a `list` draws before the reader asks for more, and how many
   * one "Show more" adds.
   *
   * Client-local, per list, and never panel state: how far a reader has scrolled
   * a list is a statement about their screen, not about which rows the panel is
   * showing, so it never reaches a `where`, a signature or an action payload —
   * the same terms a folded `group` is held on.
   */
  listPageSize: 100,
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
  /**
   * Buttons in a panel's nav bar (`chrome.navActions`).
   *
   * Four, the same ceiling as a bulk bar: the nav sits beside search and
   * Refresh, and a fifth verb is a menu the vocabulary still does not have.
   * Extra entries are dropped (node-local), never a panel-fatal overflow.
   */
  maxChromeNavActions: 4,
  /**
   * Root nodes in `chrome.footer`.
   *
   * Four, not the body budget: a sticky footer is a strip of actions or a
   * one-line status, and a fifth node is a second body. The nodes that survive
   * still count toward {@link VOCAB_LIMITS.maxNodes}; extras are omitted.
   */
  maxChromeFooterNodes: 4,
} as const;

/**
 * Open component-name union. See rule 1 of the stability promise in
 * `vocabulary.ts`: this is deliberately not a closed union, and clients MUST
 * tolerate names they do not know rather than treating them as parse failures.
 */
export type VocabComponentName =
  | "stack"
  | "group"
  | "text"
  | "markdown"
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

/**
 * A titled section the reader can collapse.
 *
 * A `stack` with a disclosure triangle, and deliberately nothing more. Seven
 * state groups in a fixed rank order — the shape every issue browser has — used
 * to cost seven `segmented` controls whose only job was to hide one section
 * each, which is seven state keys against a ceiling of eight and a filter strip
 * nobody would want to look at.
 *
 * **Open/closed is CLIENT-LOCAL and is not panel state.** It never enters
 * {@link VocabStateDeclaration}, never signs, never reaches a `where`, and never
 * rides on an action — collapsing a section is a statement about the reader's
 * screen, not about which rows the panel is showing, and a `where` that could
 * read it would make the two indistinguishable. That is also what keeps a group
 * free: a panel may hold as many as its node budget allows without spending a
 * state key on any of them.
 *
 * Its identity across a re-publish is {@link groupKey} when the author declared
 * one and the title otherwise — a plugin republishing its rows every few seconds
 * must not re-open a section the reader just closed.
 */
export type VocabGroupNode = {
  component: "group";
  title: string;
  /** Stable identity for the open/closed memory. Falls back to `title`. */
  groupKey?: string;
  /** A count beside the title, e.g. `12`. Text only, like an option's badge. */
  badge?: string;
  /** A named glyph beside the title — the same token a badge or a button uses. */
  icon?: string;
  /** Open on first render. Absent means open — a section nobody has touched shows its contents. */
  defaultOpen?: boolean;
  children: VocabNode[];
};

export type VocabTextNode = {
  component: "text";
  text: string;
  /** `code` is the ONLY monospace affordance in the vocabulary. */
  variant?: "title" | "subtitle" | "body" | "caption" | "code";
  tone?: VocabTone;
};

/**
 * Formatted prose: an issue body, a comment, a release note.
 *
 * The subset is `./vocabularyMarkdown.ts` and is the same on all four clients —
 * headings, emphasis, code, links, lists, quotes and inert task checkboxes.
 * There is no raw HTML anywhere in it, and a link is `https:` only.
 *
 * One field, on purpose. There is no `maxHeight` twin of {@link VocabImageNode}
 * here: an image has an intrinsic pixel size a panel has to bound, prose has a
 * length the ceiling below already bounds, and a height in points is not a thing
 * a terminal can honour — a clamp that meant something on three clients and
 * nothing on the fourth is exactly the per-client drift this node exists to
 * avoid. A panel that wants less prose sends less prose.
 */
export type VocabMarkdownNode = {
  component: "markdown";
  /** Source, already clamped to {@link VOCAB_LIMITS.maxMarkdownChars}. */
  text: string;
  /**
   * Set by the parser when the source was over the ceiling and was cut.
   *
   * A clamped document renders as PLAIN TEXT with a marker rather than as
   * markdown, on every client. That is not squeamishness about length: a cut
   * lands wherever the ceiling falls, which is regularly inside a fence, a link
   * or an emphasis run, so the markdown of a truncated document is not the
   * document's markdown — a half-open fence swallows the rest of it as code.
   * Showing the source says "this was cut" in a way half-parsed prose cannot.
   */
  truncated?: boolean;
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
 * (250) becomes the real ceiling — see {@link VOCAB_LIMITS.maxListItemActions}.
 *
 * Every field past `title` is optional, so a row written before any of them
 * existed still parses to exactly what it always did.
 */
export type VocabListItem = {
  title: string;
  /**
   * The row's identity, and the only thing a selection ever holds.
   *
   * A declared row writes it; a bound row inherits its collection row's own
   * primary key, so a plugin that already writes `{title, subtitle}` rows gets
   * selection for free. A row with no key cannot be ticked — it draws no
   * checkbox at all rather than one that would put an empty string in a batch,
   * because a title is not an identity and two issues can share one.
   */
  key?: string;
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

/**
 * What a `list` needs to carry a multi-row selection.
 *
 * The vocabulary had no concept of one: a panel could press a row, and a reader
 * who wanted eleven lanes pressed eleven rows. This is the smallest thing that
 * fixes that — a state key to hold the ticks, and the verbs to offer once there
 * are any.
 *
 * `actions` reuses {@link VocabListItemAction} exactly, so a bulk verb and a
 * row verb are the same shape parsed by the same reader: `{action, args?,
 * confirm?, label, kind?, icon?}`. `confirm` therefore works on a batch the way
 * it works on a row, which matters more here — a mistake costs eleven lanes.
 *
 * The selection reaches the plugin as `args.selection`, an array of row keys,
 * injected by the HOST at dispatch and last, so a schema cannot name an argument
 * that would replace it. It is the one array in an args object that is otherwise
 * flat scalars, and it is not a hole in rule 3: the client did not compute it,
 * the reader ticked it, and every key in it is one the plugin itself wrote.
 */
export type VocabSelectable = {
  /** Panel-local key holding this list's ticks. Same shape as a `segmented` key. */
  stateKey: string;
  /** The bar's buttons, up to {@link VOCAB_LIMITS.maxBulkActions}. */
  actions: VocabListItemAction[];
  /** Most rows ticked at once, already clamped to {@link VOCAB_LIMITS.maxSelectedRows}. */
  max: number;
};

export type VocabListNode = {
  component: "list";
  items?: VocabListItem[];
  bind?: VocabBinding;
  emptyText?: string;
  /** Ticks on every keyed row, and a bulk bar once any of them is ticked. */
  selectable?: VocabSelectable;
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

/**
 * A form: labelled fields, and how their values reach the plugin.
 *
 * Two ways, and a form needs at least one of them:
 *
 * - `submit` draws a button. The reader fills the form in, presses it once, and
 *   the whole values map goes over in one call. This is the right shape for
 *   anything with a cost — a credential, a deploy, a rename.
 * - `applyOnChange` dispatches on every edit, with the same full values map, and
 *   no button at all. This is the settings shape: "no restart and no Apply
 *   button" was not expressible with `form` before it existed, so a settings
 *   panel had to be rebuilt out of `segmented` controls and lost the field
 *   labels, the help text and the validation a form gives for free.
 *
 * Both together is legal and means what it reads as: changes apply as they are
 * made AND the button is there to re-run the action.
 *
 * `applyOnChange` is an action, not a flag, for the same reason
 * {@link VocabSegmentedNode.onChange} is: one parser idiom, and a form with no
 * button still has to name what to call. A text field applies on COMMIT — blur
 * or Enter — never per keystroke, so a plugin is not invoked once per letter.
 */
export type VocabFormNode = {
  component: "form";
  fields: VocabField[];
  /** The Apply button. Optional only when {@link applyOnChange} is set. */
  submit?: { label: string; onPress: VocabAction };
  /** Dispatched on every committed field change, with the full values map. */
  applyOnChange?: VocabAction;
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
  /**
   * Take the rest of the options from a collection the plugin already writes.
   *
   * For the option list an author cannot inline because they do not know it:
   * a workspace's projects, its labels, its assignees. The literal `options`
   * above are still drawn, first, which is where the "All" sentinel goes — so a
   * bound control declaring `[{value: "", label: "All projects"}]` reads the
   * same as a literal one and needs no second concept for "no filter".
   *
   * A control declaring it is exempt from the two-option floor: its second
   * option is data that has not arrived yet, not an author's mistake.
   */
  optionsFrom?: VocabStateOptionsBinding;
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
export function vocabSegmentedDeclaration(
  node: VocabSegmentedNode,
  /**
   * The options `optionsFrom` resolved to, when the caller has the rows. A host
   * that has not fetched them yet passes nothing and gets the literal options,
   * which is a working control on its "All" — never a control with no options
   * at all.
   */
  resolved?: readonly VocabStateOption[],
): VocabStateDeclaration {
  const options = node.optionsFrom !== undefined && resolved !== undefined
    ? vocabMergeStateOptions(node.options, resolved)
    : node.options;
  return {
    stateKey: node.stateKey,
    options,
    // A bound control opens on the unset "All" unless its declared default is
    // already among the resolved options. Falling back to `options[0]` the way
    // a literal control does would open it on whichever project the collection
    // happened to yield first, which is a filter the reader did not ask for and
    // a different one on every machine.
    initial: node.optionsFrom !== undefined
      ? (options.some((option) => option.value === node.default) ? node.default ?? "" : "")
      : vocabStateInitial(options, node.default),
    ...(node.label !== undefined ? { label: node.label } : {}),
    ...(node.style !== undefined ? { style: node.style } : {}),
    ...(node.optionsFrom !== undefined ? { optionsFrom: node.optionsFrom } : {}),
  };
}

/**
 * A parsed `selectable` as the selection key it declares.
 *
 * The same split as {@link vocabSegmentedDeclaration}: the node holds the
 * buttons a client draws, the declaration holds what the lifecycle needs, and
 * the two are different shapes so the cap and the identity are resolved exactly
 * once. Kept here rather than in `vocabularyState.ts` because the action ids it
 * reads live on a node type, and the dependency runs one way.
 */
export function vocabSelectableDeclaration(
  selectable: VocabSelectable,
): VocabSelectionDeclaration {
  return {
    stateKey: selectable.stateKey,
    max: selectable.max,
    actionIds: selectable.actions.map((action) => action.action),
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
  | VocabGroupNode
  | VocabTextNode
  | VocabMarkdownNode
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

/**
 * The children of a node that has any, and `[]` for one that does not.
 *
 * Every walk over a panel body goes through here — collecting bindings,
 * collecting state declarations, counting nodes, rendering. Before `group`
 * there was one container and each of those walks tested for it by hand, which
 * made adding a second container four separate chances to forget one: a
 * `segmented` inside an unwalked container would declare no state key, and a
 * `list` inside one would bind a collection nobody fetched. Now a container is
 * added here, once.
 */
export function vocabChildNodes(node: VocabNode): readonly VocabNode[] {
  if (node.component === "stack" || node.component === "group") return node.children;
  return [];
}

/**
 * What a client remembers a group's open/closed state under.
 *
 * The declared `groupKey` when there is one, the title otherwise — and never
 * the node's position, which is what a client keying off `body[2]` would use.
 * Position is the wrong identity for the case this has to survive: a plugin
 * republishing its panel with one more group above yours has not opened the
 * section you closed, but a positional key says it has.
 */
export function vocabGroupKey(node: VocabGroupNode): string {
  return node.groupKey ?? node.title;
}

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
  const entries = boundRowEntries(binding, rows, state, now);
  return entries === null ? null : entries.map((entry) => entry.value);
}

/**
 * The same rows, with each row's primary KEY kept beside its value.
 *
 * `keyValue` is the one node that needs it. A collection row is `{key, value}`
 * and a `$context` row is `{key: "Lane", value: "alpha-build"}` — so dropping
 * the key left every scalar-valued row as a bare string, which
 * {@link coerceBoundKeyValueRow} correctly refuses because a row with no key is
 * not a row. The visible result was a `keyValue` bound to `$context` rendering
 * its `emptyText` while the context was right there, on desktop and in the TUI.
 * iOS never had the bug: it merges the entry's key in before coercing, and this
 * is that rule moved into the shared module so all three read one contract.
 */
export function boundRowEntries(
  binding: VocabBinding | undefined,
  rows: readonly { key?: string; value: unknown }[] | undefined,
  state?: VocabPanelState,
  now?: number,
): { key?: string; value: unknown }[] | null {
  if (!binding || !rows) return null;
  let entries = rows.map((row) => ({ ...(row.key !== undefined ? { key: row.key } : {}), value: row.value }));
  if (binding.where && binding.where.length > 0) {
    const current = state ?? {};
    // One clock for the whole pass, so a `since` boundary cannot fall between
    // two rows of the same render. Callers pass `now` only in tests.
    const instant = now ?? Date.now();
    entries = entries.filter((entry) => evaluateVocabWhere(binding.where, entry.value, current, instant));
  }
  const limit = binding.limit;
  return typeof limit === "number" && limit > 0 ? entries.slice(0, limit) : entries;
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
  /**
   * The collection row's own primary key, used as the row's identity when the
   * stored value declares no `key` of its own.
   *
   * The same rule {@link coerceBoundKeyValueRow} already applies for the same
   * reason: a collection row HAS a key, and making a plugin repeat it inside
   * the value just to make its rows selectable would be a second identity that
   * can disagree with the first.
   */
  rowKey?: string,
): VocabListItem | null {
  return readListItem(value, (raw) => boundRowAction(raw, allowActions), rowKey);
}

/**
 * A bound row as a `keyValue` row. A row with no key is not a row.
 *
 * `rowKey` is the collection row's own primary key, which is a key the row
 * already has: a stored value of `"alpha-build"` under the key `Lane` is a
 * usable row, and so is an object value that names no `key` field of its own.
 * Pass it and a scalar-valued collection renders; omit it and only values that
 * carry their own `key` do.
 */
export function coerceBoundKeyValueRow(value: unknown, rowKey?: string): VocabKeyValueRow | null {
  const fallbackKey = vocabString(rowKey, VOCAB_LIMITS.maxLabelChars);
  if (!isRecord(value)) {
    // Arrays and `null` have no text form, so they stay refused: a row reading
    // `Lane —` says less than no row at all.
    if (fallbackKey === undefined || value === null || Array.isArray(value)) return null;
    const text = vocabCellText(value);
    return text.length > 0 ? { key: fallbackKey, value: text } : null;
  }
  const key = vocabString(value.key, VOCAB_LIMITS.maxLabelChars) ?? fallbackKey;
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

/** A plugin action reference. Exported so panel chrome can parse the same shape a node does. */
export function parseVocabAction(raw: unknown): VocabAction | null {
  return parseAction(raw);
}

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
function readListItem(
  raw: unknown,
  gate: VocabActionGate,
  fallbackKey?: string,
): VocabListItem | null {
  if (!isRecord(raw)) return null;
  const title = vocabString(raw.title, VOCAB_LIMITS.maxLabelChars);
  if (title === undefined) return null;
  // `bounded`, never `vocabString`: a key that was shortened at the ceiling —
  // with or without the ellipsis `vocabString` appends — is an identity no row
  // and no plugin holds, and it would ride into a batch naming nothing. So an
  // over-long key is REFUSED, which leaves the row unselectable and visibly so.
  const itemKey = bounded(raw.key, VOCAB_LIMITS.maxIdChars)
    ?? (fallbackKey !== undefined ? bounded(fallbackKey, VOCAB_LIMITS.maxIdChars) : null);
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
    ...(itemKey !== null ? { key: itemKey } : {}),
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

/**
 * A `list` node's `selectable`, or `null`.
 *
 * A selection with no verb is a set of ticks the reader cannot spend, so a
 * `selectable` declaring no usable action is dropped whole rather than drawing
 * checkboxes over an empty bar. The bulk buttons go through the SAME reader a
 * row's trailing buttons do — `parseAction`, not `boundRowAction` — because
 * they are the panel author's own words: a bulk verb is declared on the node,
 * never supplied by a collection row, which is exactly what keeps stored data
 * from minting an action over a hundred rows at once.
 */
function parseSelectable(raw: unknown): VocabSelectable | null {
  if (!isRecord(raw)) return null;
  const stateKey = parseVocabStateKey(raw.stateKey);
  if (stateKey === undefined) return null;
  const actions = parseListItemActions(raw.actions, VOCAB_LIMITS.maxBulkActions, parseAction);
  if (actions === undefined) return null;
  const declaredMax = finiteNumber(raw.max);
  const max = declaredMax !== undefined && declaredMax >= 1
    ? Math.min(Math.floor(declaredMax), VOCAB_LIMITS.maxSelectedRows)
    : VOCAB_LIMITS.maxSelectedRows;
  return { stateKey, actions, max };
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

  group: (raw, ctx) => {
    const title = vocabString(raw.title, VOCAB_LIMITS.maxLabelChars);
    // A disclosure with no word on it is a triangle the reader has to open to
    // find out what they opened, so the title is the one required field.
    if (title === undefined) return ctx.invalid("`title` is required");
    const rawChildren = Array.isArray(raw.children) ? raw.children : [];
    const children: VocabNode[] = [];
    for (let index = 0; index < rawChildren.length; index += 1) {
      const child = ctx.child(rawChildren[index], index);
      if (child === null) break;
      children.push(child);
    }
    const groupKey = vocabString(raw.groupKey, VOCAB_LIMITS.maxIdChars);
    const badge = vocabStateBadgeText(raw.badge);
    const icon = vocabString(raw.icon, VOCAB_LIMITS.maxIdChars);
    return {
      component: "group",
      title,
      ...(groupKey !== undefined ? { groupKey } : {}),
      ...(badge !== undefined ? { badge } : {}),
      ...(icon !== undefined ? { icon } : {}),
      ...(typeof raw.defaultOpen === "boolean" ? { defaultOpen: raw.defaultOpen } : {}),
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

  markdown: (raw, ctx) => {
    // NOT `vocabString`: its ellipsis would be appended INSIDE the document, so
    // a cut that landed in a fence would render `…` as code and the marker the
    // reader needs would be invisible. Over the ceiling the node keeps the text
    // it can and says so in a field, which is what every client reads to decide
    // between drawing prose and drawing the source.
    const source = trimmed(raw.text);
    if (source === null) return ctx.invalid("`text` is required");
    const truncated = source.length > VOCAB_LIMITS.maxMarkdownChars;
    return {
      component: "markdown",
      text: truncated ? source.slice(0, VOCAB_LIMITS.maxMarkdownChars) : source,
      ...(truncated ? { truncated: true as const } : {}),
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
    const selectable = parseSelectable(raw.selectable);
    return {
      component: "list",
      ...(items !== undefined ? { items } : {}),
      ...(bind !== null ? { bind } : {}),
      ...(emptyText !== undefined ? { emptyText } : {}),
      ...(selectable !== null ? { selectable } : {}),
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
    const applyOnChange = parseAction(raw.applyOnChange);
    const hasSubmit = submitLabel !== undefined && submitAction !== null;
    // A `submit` that was WRITTEN and is malformed stays an error even when
    // `applyOnChange` would carry the form: the author asked for a button, and
    // silently dropping it would ship a form missing the control they declared.
    if (submit && !hasSubmit) {
      return ctx.invalid("`submit` needs a `label` and an `onPress` action");
    }
    if (!hasSubmit && applyOnChange === null) {
      return ctx.invalid("needs a `submit`, or an `applyOnChange` action");
    }
    return {
      component: "form",
      fields,
      ...(hasSubmit ? { submit: { label: submitLabel!, onPress: submitAction! } } : {}),
      ...(applyOnChange !== null ? { applyOnChange } : {}),
    };
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
    const optionsFrom = parseVocabStateOptionsBinding(raw.optionsFrom);
    // One option is not a choice, and a control the reader cannot change is a
    // filter permanently stuck wherever the author left it. Two is the floor —
    // but only for a control whose options are all in the schema. A bound
    // control's second option is a row that has not arrived yet, and failing it
    // at parse would make "the collection is empty right now" a broken node.
    if (optionsFrom === undefined && options.length < 2) {
      return ctx.invalid("`options` needs at least two distinct values");
    }
    const label = vocabString(raw.label, VOCAB_LIMITS.maxLabelChars);
    const style = parseVocabSegmentedStyle(raw.style, options.length);
    const onChange = parseAction(raw.onChange);
    // A bound control keeps the author's `default` VERBATIM. Resolving it here
    // against the literal options — which is right for a literal control, where
    // that list is the whole control — would throw away a default naming a row
    // nobody has fetched yet, every time. The resolution moves to
    // {@link vocabSegmentedDeclaration}, which runs where the rows are.
    const boundDefault = typeof raw.default === "string"
      ? raw.default.trim().slice(0, VOCAB_STATE_LIMITS.maxStateIdChars)
      : "";
    return {
      component: "segmented",
      stateKey,
      options,
      default: optionsFrom !== undefined ? boundDefault : vocabStateInitial(options, raw.default),
      ...(optionsFrom !== undefined ? { optionsFrom } : {}),
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
