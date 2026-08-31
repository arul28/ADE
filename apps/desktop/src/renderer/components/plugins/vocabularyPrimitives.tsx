import { CheckCircle, WarningCircle } from "@phosphor-icons/react";

import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import type { PluginCollectionRow } from "../../lib/pluginRuntimeBridge";
import type {
  VocabAction,
  VocabGroupNode,
  VocabListNode,
  VocabPanelSelection,
  VocabPanelState,
  VocabSelectionDeclaration,
  VocabStateDeclaration,
  VocabTone,
} from "../../../shared/plugins/vocabulary";

/**
 * What every vocabulary leaf renderer shares: the render context it is handed,
 * and the three small pieces more than one of them draws.
 *
 * A leaf module rather than part of `vocabularyComponents`: the chart and the
 * form live in their own files and both need these, and importing them back out
 * of the module that re-exports those components would be an import cycle.
 */

/** Merged into an action's own args when a form submits. */
export type VocabActionArgs = Record<string, string | number | boolean>;

/**
 * `extraArgs` is deliberately wider than {@link VocabActionArgs}.
 *
 * A node's declared `args` are flat scalars and stay that way — that is the seam
 * rule 3 guards. What a CONTROL adds at press time is not schema: a form adds
 * its field values, a bulk bar adds the array of row keys the reader ticked, and
 * the host adds the panel's `context` and `state`. None of those came from the
 * schema, so none of them can smuggle anything into it.
 */
export type VocabDispatch = (
  action: VocabAction,
  extraArgs?: Record<string, unknown>,
) => Promise<void>;

export type VocabRenderContext = {
  pluginId: string;
  /** Rows already fetched for every binding in the panel, keyed by `bindingKey`. */
  rowsByBinding: ReadonlyMap<string, PluginCollectionRow[]>;
  dispatch: VocabDispatch;
  /**
   * The current value of every state key the panel's `segmented` controls
   * declared. Read by a binding's `where` at render, which is what makes a
   * filter change cost no IPC and no fetch.
   */
  state: VocabPanelState;
  /**
   * Change one state key. The host validates the value against the control's
   * declared options, so a caller cannot set a value the reader was never
   * offered — which is also why this takes a key and a value rather than a whole
   * state object.
   */
  setStateValue: (stateKey: string, value: string) => void;
  /**
   * The controls as the HOST resolved them, which is not always what the node
   * says.
   *
   * A `segmented` declaring `optionsFrom` has its real option list only after
   * the collection behind it has been fetched, and the fetch is the host's. So a
   * control renders from its declaration when there is one and from its own node
   * otherwise — the second being a control on its literal "All", which is what a
   * panel shows for the moment before its rows land.
   */
  declarations: readonly VocabStateDeclaration[];
  /** The ticked rows of every `selectable` list, keyed by its state key. */
  selection: VocabPanelSelection;
  /** The selectable lists the host admitted, with their caps and their verbs. */
  selectionDeclarations: readonly VocabSelectionDeclaration[];
  /**
   * Tick or untick one row.
   *
   * `visibleKeys` is the shift-click half, and the two halves of that gesture
   * are split on purpose: the LIST knows the rows it drew and their order, the
   * HOST remembers which row the reader last ticked. Passing the visible keys
   * therefore means "extend from wherever the anchor is" and ticks the whole
   * range; omitting them toggles the one row and moves the anchor to it.
   *
   * Pointer surfaces only. There is no shift on a phone and none in the pane,
   * and both degrade to the plain toggle rather than to a second gesture.
   */
  toggleRow: (stateKey: string, rowKey: string, visibleKeys?: readonly string[]) => void;
  /** Untick everything in one list. What the bar's own Clear does. */
  clearSelection: (stateKey: string) => void;
  /**
   * Whether a `group` is showing its children.
   *
   * Client-local and deliberately not panel state: collapsing a section says
   * something about the reader's screen, not about which rows the panel is
   * showing. It lives on the host rather than in the disclosure's own React
   * state because the node tree is rebuilt on every re-publish, and component
   * state keyed by position would re-open a section the reader closed the moment
   * the plugin inserted a group above it.
   */
  groupOpen: (node: VocabGroupNode) => boolean;
  toggleGroup: (node: VocabGroupNode) => void;
  /**
   * How many pages of one `list` the reader has asked for. 1 is the first draw.
   *
   * Held on the host rather than in the list's own React state for the reason
   * {@link groupOpen} is: the node tree is rebuilt on every republish, and
   * component state keyed by position would put a reader back on page one the
   * moment the plugin inserted a node above the list. Client-local — it is not
   * panel state and never reaches the plugin.
   */
  listPage: (node: VocabListNode) => number;
  /**
   * Draw one more page of a list. Inert once the list is drawing everything.
   *
   * `total` is the row count AFTER the binding's `where` has run, which only the
   * list knows: the host holds the fetched rows, not the filtered ones, so a
   * clamp computed here would let a filtered list page past its own end.
   */
  showMoreListRows: (node: VocabListNode, total: number) => void;
  /**
   * False while the hosting surface is mounted but not visible. Media does not
   * load and animation does not run when false — the hidden-but-mounted perf law.
   */
  active: boolean;
};

export const TONE_COLOR: Record<VocabTone, string> = {
  neutral: COLORS.textMuted,
  accent: COLORS.accent,
  success: COLORS.success,
  warning: COLORS.warning,
};

/** "Nothing here yet" at the size of the component it replaces. */
export function EmptyLine({ text }: { text: string }) {
  return (
    <p style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textDim }}>{text}</p>
  );
}

/**
 * What an action said about how it went, under the panel it was pressed in.
 *
 * iOS and the TUI have shown this since the verb existed — the phone as a
 * coloured banner, the TUI as a notice — while desktop and the web threw the
 * sentence away, so a plugin wrote one line of copy and two of its four clients
 * showed nothing. This is the same banner, with the same tones.
 *
 * `role="status"` rather than `alert`: it reports an outcome the reader asked
 * for by pressing something, so it belongs in the polite queue.
 */
export function PluginActionBanner({ text, ok }: { text: string; ok: boolean }) {
  const color = ok ? COLORS.success : COLORS.warning;
  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: "9px 11px",
        borderRadius: 10,
        // The tone at a tenth, matching `PluginActionMessageView` on iOS.
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
        fontFamily: SANS_FONT,
        fontSize: 11,
        color,
      }}
    >
      {ok
        ? <CheckCircle size={13} weight="regular" aria-hidden style={{ flexShrink: 0, marginTop: 1 }} />
        : <WarningCircle size={13} weight="regular" aria-hidden style={{ flexShrink: 0, marginTop: 1 }} />}
      <span style={{ minWidth: 0 }}>{text}</span>
    </div>
  );
}

export function InlineError({ message }: { message: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontFamily: SANS_FONT,
        fontSize: 11,
        color: COLORS.warning,
      }}
    >
      <WarningCircle size={12} weight="regular" aria-hidden />
      {message}
    </span>
  );
}
