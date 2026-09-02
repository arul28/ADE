import React from "react";
import { useRootAppStore } from "../../state/appStore";

import { ArrowsClockwise } from "@phosphor-icons/react";

import { COLORS, RADII, SANS_FONT } from "../lanes/laneDesignTokens";
import { PluginFallbackCard, PluginPanelView } from "./VocabularyRenderer";
import { type VocabActionArgs } from "./vocabularyComponents";
import { PluginActionBanner } from "./vocabularyPrimitives";
import {
  invokePluginAction,
  readPluginCollection,
  readPluginPanel,
  subscribeToPluginChanges,
  type PluginCollectionRow,
  type PluginPanelRecord,
} from "../../lib/pluginRuntimeBridge";
import type { PluginSurfaceContext } from "../../../shared/plugins/context";
import {
  VOCAB_CONTEXT_COLLECTION,
  VOCAB_PANEL_READ_LIMIT,
  VOCAB_STATE_COLLECTION,
  bindingKey,
  collectVocabSelectionDeclarations,
  collectVocabStateDeclarations,
  distinctBindings,
  parsePluginPanel,
  vocabPanelContentNodes,
  readPluginActionResetState,
  vocabApplyStateChange,
  vocabClearRowSelection,
  vocabContextRows,
  vocabGroupKey,
  vocabInitialPanelSelection,
  vocabListKey,
  vocabListNextPage,
  vocabInitialPanelState,
  vocabNormalizePanelSelection,
  vocabNormalizePanelState,
  vocabResetPanelSelection,
  vocabResetPanelState,
  vocabResolveStateOptions,
  vocabRowRange,
  vocabSelectRowRange,
  vocabSelectionSignature,
  vocabStateOptionsBindingKey,
  vocabStatePayload,
  vocabStateRows,
  vocabStateSignature,
  vocabToggleRowSelection,
  type VocabAction,
  type VocabGroupNode,
  type VocabListNode,
  type VocabPanelSelection,
  type VocabPanelState,
  type VocabSelectionDeclaration,
  type VocabStateDeclaration,
} from "../../../shared/plugins/vocabulary";
import {
  buildPluginActionPromptAnswer,
  hasPluginActionPromptRequest,
  readPluginActionMessage,
  readPluginActionNavigation,
  readPluginActionPrompt,
  readPluginPanelRefreshAction,
  readPluginPanelViewAction,
  type PluginActionMessage,
} from "../../../shared/plugins/sdk";
import { applyPluginDialogEdit } from "./sockets/dialogTarget";
import { applyPluginActionOpenUrl } from "./pluginActionOpenUrl";
import { applyPluginActionOpenSettings } from "./pluginActionOpenSettings";
import { openPluginPrompt, readPluginPromptAnchor } from "./sockets/pluginPromptStore";

/**
 * Data plumbing for one plugin panel.
 *
 * It owns exactly three things: fetching the panel's schema, fetching the
 * collections that schema binds, and dispatching the actions it declares. The
 * interpretation is `VocabularyRenderer`'s job and the page chrome is
 * `PluginTabPage`'s, so this file has no opinion about how a panel looks.
 *
 * Two perf laws from the desktop recon are enforced here rather than trusted to
 * callers:
 *
 * - **Fetch on reveal, not on mount.** ADE keeps surfaces mounted while hidden
 *   (Work and Lanes are permanently mounted; a plugin tab can be behind a
 *   minimized pane). Nothing is fetched until `active` is true, so a panel
 *   nobody is looking at costs nothing.
 * - **Subscriptions are inert while hidden.** The host's change stream only
 *   triggers a refetch for a visible panel; a hidden one refetches once when it
 *   is revealed again, which is the same freshness at a fraction of the churn.
 */

type PanelState = {
  status: "idle" | "loading" | "ready" | "missing" | "error";
  record: PluginPanelRecord | null;
  rows: ReadonlyMap<string, PluginCollectionRow[]>;
  error: string | null;
};

const EMPTY_ROWS: ReadonlyMap<string, PluginCollectionRow[]> = new Map();

const INITIAL_STATE: PanelState = {
  status: "idle",
  record: null,
  rows: EMPTY_ROWS,
  error: null,
};

/** How long an action's outcome banner stays up before it dismisses itself. */
const PLUGIN_ACTION_BANNER_MS = 6_000;

/**
 * The reader's `segmented` selections, plus the identity of the controls they
 * belong to.
 *
 * The signature is what makes the lifecycle correct in the one case that
 * matters: a plugin refreshing its rows republishes the whole panel, often every
 * few seconds, and a filter that reset on each of those would be unusable. Same
 * controls means the same signature, so the selection rides through; a schema
 * that changed its controls gets a new signature and starts over, because an
 * option that no longer exists cannot stay selected.
 */
type PanelStateHolder = { signature: string; values: VocabPanelState };

const EMPTY_STATE_HOLDER: PanelStateHolder = { signature: "", values: {} };

/**
 * The reader's ticked rows, plus the identity of the lists they belong to.
 *
 * The same holder shape as the selections above, for the same reason: the
 * signature is what lets a batch survive the republish that lands while the
 * reader is still assembling it, and what discards one when the panel starts
 * offering a different control.
 *
 * `anchor` is the shift-click memory and is deliberately part of this holder
 * rather than of the shared contract: it is a pointer gesture's private state,
 * no other client has it, and nothing outside this file may read it.
 */
type PanelSelectionHolder = {
  signature: string;
  values: VocabPanelSelection;
  anchor: Readonly<Record<string, string>>;
};

const EMPTY_SELECTION_HOLDER: PanelSelectionHolder = { signature: "", values: {}, anchor: {} };

const NO_DECLARATIONS: readonly VocabStateDeclaration[] = [];

const NO_SELECTION_DECLARATIONS: readonly VocabSelectionDeclaration[] = [];

/** Which `group` sections the reader has folded, against the author's default. */
const NO_GROUP_OVERRIDES: Readonly<Record<string, boolean>> = {};

/**
 * How many pages of each `list` the reader has asked for, by
 * {@link vocabListKey}. An absent key means one page, which is the first draw.
 */
const NO_LIST_PAGES: Readonly<Record<string, number>> = {};

export function PluginPanelHost({
  pluginId,
  panelId,
  active,
  recoveryAction,
  surfaceContext,
  renderContext,
  onNavigate,
}: {
  pluginId: string;
  panelId: string;
  /** False while the hosting surface is mounted but not visible. */
  active: boolean;
  /** Passed through to the fallback card, e.g. a Restart button. */
  recoveryAction?: React.ReactNode;
  /**
   * The context this panel was opened with — from a `plugin` deeplink's `?ctx=`
   * or from the `{navigate:{context}}` an action returned. Readable by the
   * schema through the `$context` binding, and attached to every action the
   * panel dispatches. See `shared/plugins/vocabulary.ts`.
   */
  renderContext?: Record<string, unknown> | null;
  /**
   * Where to send the reader when an action asks for it. Absent means the host
   * cannot navigate — a socket's detail section is already where it is going —
   * and the request is then dropped rather than half-honoured.
   */
  onNavigate?: (navigation: { panelId: string; context?: Record<string, unknown> }) => void;
  /**
   * The typed surface context, when this panel is mounted at a socket rather
   * than as a tab. It rides along on every action the panel dispatches, so a
   * detail section knows which lane or PR its buttons were pressed on.
   */
  surfaceContext?: PluginSurfaceContext;
}) {
  const [state, setState] = React.useState<PanelState>(INITIAL_STATE);
  // Bumped to force a refetch: by a host change event, and by a completed
  // action (a plugin that just did something has usually changed its own data).
  const [refreshToken, setRefreshToken] = React.useState(0);
  // What the last action said about how it went. Held here rather than in the
  // renderer because it belongs to the dispatch, not to the control that fired
  // it: a row that navigates away still owes the reader its sentence.
  const [actionMessage, setActionMessage] = React.useState<PluginActionMessage | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [panelState, setPanelState] = React.useState<PanelStateHolder>(EMPTY_STATE_HOLDER);
  const [panelSelection, setPanelSelection] = React.useState<PanelSelectionHolder>(
    EMPTY_SELECTION_HOLDER,
  );
  // Which sections the reader has folded, against whatever the author's
  // `defaultOpen` said. Overrides only, so a group nobody has touched follows
  // the schema and a group the reader closed stays closed through a republish.
  const [groupOverrides, setGroupOverrides] = React.useState<Readonly<Record<string, boolean>>>(
    NO_GROUP_OVERRIDES,
  );
  // How far down each list the reader has walked. Beside the folds because it is
  // the same kind of thing: client-local, per panel, and never the plugin's.
  const [listPages, setListPages] = React.useState<Readonly<Record<string, number>>>(NO_LIST_PAGES);
  const brandIcons = useRootAppStore(
    (state) => state.installedPlugins.find((plugin) => plugin.pluginId === pluginId)?.brandIcons,
  );
  const activeRef = React.useRef(active);
  activeRef.current = active;
  const contextRef = React.useRef(renderContext ?? null);
  contextRef.current = renderContext ?? null;

  React.useEffect(() => {
    setState(INITIAL_STATE);
    setActionMessage(null);
    // A different panel is a different set of controls. Cleared rather than
    // left to the signature check, so navigating away and back reads as a fresh
    // open rather than as the same panel it happened to match. The ticks and the
    // folds go with them, for the same reason.
    setPanelState(EMPTY_STATE_HOLDER);
    setPanelSelection(EMPTY_SELECTION_HOLDER);
    setGroupOverrides(NO_GROUP_OVERRIDES);
    // And the pages, for the same reason: a reader who walked one panel's list
    // down to 250 rows has not asked anything of the next panel's list.
    setListPages(NO_LIST_PAGES);
  }, [pluginId, panelId]);

  /**
   * The parsed panel, or `null`.
   *
   * Held once because three things now read it — the state controls, the
   * selectable lists, and the option resolution behind an `optionsFrom` — and
   * parsing a 64 KiB schema three times per render for a poll that changed
   * nothing is exactly the kind of work the fetch-on-reveal law exists to avoid.
   * The full panel, not only the body: chrome.search is a state declaration and
   * the footer binds collections the body never names.
   */
  const parsedPanel = React.useMemo(() => {
    const schema = state.record?.schema;
    if (schema === undefined) return null;
    const parsed = parsePluginPanel(schema);
    return parsed.ok ? parsed.panel : null;
  }, [state.record?.schema]);

  const contentNodes = React.useMemo(
    () => (parsedPanel ? vocabPanelContentNodes(parsedPanel) : null),
    [parsedPanel],
  );

  /**
   * The `segmented` controls this schema declares, with any `optionsFrom`
   * already resolved against the rows this host fetched.
   *
   * Parsed off the stored schema rather than threaded down from the renderer:
   * the host needs them before anything renders — to build the initial state, to
   * validate a change, and to fill a `$state` binding — and a callback out of the
   * render tree would make the first paint depend on a second one.
   *
   * It depends on the ROWS as well as the schema, which is new and is what makes
   * a bound control work: the projects arrive after the panel does. The reader's
   * selection survives that arrival because a bound control signs its binding
   * rather than its options — see `vocabStateSignature`.
   */
  const declarations = React.useMemo(() => {
    if (!contentNodes || !parsedPanel) return NO_DECLARATIONS;
    return collectVocabStateDeclarations(
      contentNodes,
      (binding) => vocabResolveStateOptions(
        binding,
        state.rows.get(vocabStateOptionsBindingKey(binding)),
      ),
      parsedPanel.chrome,
    );
  }, [contentNodes, parsedPanel, state.rows]);

  /** The selectable lists this schema declares, with their caps and their verbs. */
  const selectionDeclarations = React.useMemo(() => {
    if (!contentNodes) return NO_SELECTION_DECLARATIONS;
    return collectVocabSelectionDeclarations(contentNodes);
  }, [contentNodes]);

  // Reconcile the held selections against the controls that are actually on
  // screen now. Both halves matter: the signature catches a control that
  // vanished, `vocabNormalizePanelState` catches a value inside one that did not.
  React.useEffect(() => {
    const signature = vocabStateSignature(declarations);
    setPanelState((previous) => {
      if (previous.signature === signature) return previous;
      return {
        signature,
        values: previous.signature === ""
          ? vocabInitialPanelState(declarations)
          : vocabNormalizePanelState(previous.values, declarations),
      };
    });
  }, [declarations]);

  // The same reconciliation for the ticks. The anchor is dropped whenever the
  // controls change, because a row to extend from is only meaningful inside the
  // list the reader was ticking.
  React.useEffect(() => {
    const signature = vocabSelectionSignature(selectionDeclarations);
    setPanelSelection((previous) => {
      if (previous.signature === signature) return previous;
      return {
        signature,
        values: previous.signature === ""
          ? vocabInitialPanelSelection(selectionDeclarations)
          : vocabNormalizePanelSelection(previous.values, selectionDeclarations),
        anchor: {},
      };
    });
  }, [selectionDeclarations]);

  // Read by `dispatch`, which must stay referentially stable: rebuilding it on
  // every filter change would rebuild the render context and re-render the whole
  // panel for a value the dispatcher only reads at press time.
  const panelStateRef = React.useRef(panelState);
  panelStateRef.current = panelState;
  const declarationsRef = React.useRef(declarations);
  declarationsRef.current = declarations;
  const selectionDeclarationsRef = React.useRef(selectionDeclarations);
  selectionDeclarationsRef.current = selectionDeclarations;

  const setStateValue = React.useCallback((stateKey: string, value: string) => {
    const declaration = declarations.find((entry) => entry.stateKey === stateKey);
    if (!declaration) return;
    setPanelState((previous) => {
      const values = vocabApplyStateChange(previous.values, declaration, value);
      return values === previous.values ? previous : { ...previous, values };
    });
  }, [declarations]);

  /**
   * Tick one row, or extend from the anchor when the reader held shift.
   *
   * The two halves of the range live apart on purpose: the list passes the rows
   * it drew and their order, this remembers where the reader last ticked. A
   * plain toggle moves the anchor; an extension does not, so shift-clicking
   * twice widens one range rather than walking it down the list.
   */
  const toggleRow = React.useCallback((
    stateKey: string,
    rowKey: string,
    visibleKeys?: readonly string[],
  ) => {
    const declaration = selectionDeclarations.find((entry) => entry.stateKey === stateKey);
    if (!declaration) return;
    setPanelSelection((previous) => {
      if (visibleKeys) {
        const range = vocabRowRange(visibleKeys, previous.anchor[stateKey], rowKey);
        const values = vocabSelectRowRange(previous.values, declaration, range);
        return values === previous.values ? previous : { ...previous, values };
      }
      const values = vocabToggleRowSelection(previous.values, declaration, rowKey);
      return {
        ...previous,
        values,
        anchor: { ...previous.anchor, [stateKey]: rowKey },
      };
    });
  }, [selectionDeclarations]);

  const clearSelection = React.useCallback((stateKey: string) => {
    const declaration = selectionDeclarations.find((entry) => entry.stateKey === stateKey);
    if (!declaration) return;
    setPanelSelection((previous) => {
      const values = vocabClearRowSelection(previous.values, declaration);
      return values === previous.values ? previous : { ...previous, values };
    });
  }, [selectionDeclarations]);

  const groupOpen = React.useCallback(
    (node: VocabGroupNode) => groupOverrides[vocabGroupKey(node)] ?? node.defaultOpen ?? true,
    [groupOverrides],
  );

  const toggleGroup = React.useCallback((node: VocabGroupNode) => {
    const key = vocabGroupKey(node);
    setGroupOverrides((previous) => ({
      ...previous,
      [key]: !(previous[key] ?? node.defaultOpen ?? true),
    }));
  }, []);

  const listPage = React.useCallback(
    (node: VocabListNode) => listPages[vocabListKey(node)] ?? 1,
    [listPages],
  );

  /**
   * Draw one more page of a list.
   *
   * The clamp lives in `vocabListNextPage` rather than here, so a press past the
   * end changes nothing instead of growing a number the list can never spend.
   * The row count it clamps against is the list's own — the host does not know
   * how many rows survived a `where`, so the list passes it in.
   */
  const showMoreListRows = React.useCallback((node: VocabListNode, total: number) => {
    const key = vocabListKey(node);
    setListPages((previous) => {
      const next = vocabListNextPage(total, previous[key] ?? 1);
      return next === (previous[key] ?? 1) ? previous : { ...previous, [key]: next };
    });
  }, []);

  // Auto-dismiss. An outcome is worth reading once; left up it becomes part of
  // the panel and starts describing a press nobody remembers making. The next
  // dispatch clears it sooner, and a message that arrives while one is showing
  // restarts the clock because `actionMessage` is the effect's own dependency.
  React.useEffect(() => {
    if (!actionMessage) return;
    const timer = setTimeout(() => setActionMessage(null), PLUGIN_ACTION_BANNER_MS);
    return () => clearTimeout(timer);
  }, [actionMessage]);

  // A context that arrives after the panel has loaded — a second deeplink into
  // the same panel — has to re-run the fetch, or `$context` keeps rendering the
  // first one.
  React.useEffect(() => {
    setRefreshToken((token) => token + 1);
  }, [renderContext]);

  React.useEffect(() => {
    if (!active) return;
    let cancelled = false;

    const load = async () => {
      setState((previous) => ({
        ...previous,
        status: previous.status === "ready" ? "ready" : "loading",
        error: null,
      }));
      try {
        const record = await readPluginPanel(pluginId, panelId);
        if (cancelled) return;
        if (!record) {
          setState({ status: "missing", record: null, rows: EMPTY_ROWS, error: null });
          return;
        }

        const bindings = distinctBindings(record.schema);
        const rows = new Map<string, PluginCollectionRow[]>();
        if (bindings.length > 0) {
          const results = await Promise.all(
            bindings.map(async (binding) => {
              // `$context` is not a collection and asking the host for one would
              // be a guaranteed miss — it is the context this panel was opened
              // with, synthesized here so a schema can render it with the
              // components that already exist.
              if (binding.collection === VOCAB_CONTEXT_COLLECTION) {
                return [bindingKey(binding), vocabContextRows(contextRef.current)] as const;
              }
              // `$state` is filled at RENDER, not here. Resolving it with the
              // fetch would tie the reader's own selection to a refetch, which
              // is the round trip this whole feature exists to remove.
              if (binding.collection === VOCAB_STATE_COLLECTION) {
                return [bindingKey(binding), [] as PluginCollectionRow[]] as const;
              }
              const fetched = await readPluginCollection(pluginId, panelId, binding.collection, {
                ...(binding.keyPrefix !== undefined ? { keyPrefix: binding.keyPrefix } : {}),
                // A binding with no `limit` reads up to the vocabulary's own
                // ceiling rather than falling through to the host's default of
                // 200. The two used to agree by accident; now a list may draw
                // 250, and a client that fetched 200 of them would stop the
                // reader 50 rows short with nothing on screen to say why.
                limit: binding.limit ?? VOCAB_PANEL_READ_LIMIT,
              });
              return [bindingKey(binding), fetched] as const;
            }),
          );
          if (cancelled) return;
          for (const [key, fetched] of results) rows.set(key, fetched);
        }

        setState({ status: "ready", record, rows, error: null });
      } catch (cause) {
        if (cancelled) return;
        setState({
          status: "error",
          record: null,
          rows: EMPTY_ROWS,
          error: cause instanceof Error ? cause.message : "Could not read this panel.",
        });
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [active, panelId, pluginId, refreshToken]);

  React.useEffect(() => {
    if (!active) return;
    return subscribeToPluginChanges((event) => {
      if (!activeRef.current) return;
      if (event.pluginId && event.pluginId !== pluginId) return;
      if (event.kind === "panels" && event.panelId && event.panelId !== panelId) return;
      setRefreshToken((token) => token + 1);
    });
  }, [active, panelId, pluginId]);

  const dispatch = React.useCallback(
    // `extraArgs` is wider than `VocabActionArgs` — the node-declared values are
    // scalars, but the host itself adds one object: the answer to a `{prompt}`
    // this same action asked for. Widening the parameter keeps this assignable
    // to `VocabDispatch`, so no node has to know.
    async (action: VocabAction, extraArgs?: Record<string, unknown>) => {
      // One `context` field, filled by whichever the panel has: a socket's typed
      // surface context when it is mounted at a socket, otherwise the context it
      // was opened with. A panel is never both at once, and sending two shapes
      // under one name would make the plugin guess which it received.
      const context = surfaceContext ?? renderContext ?? null;
      // Cleared before the call, not after it: the outcome on screen must
      // belong to the press the reader is waiting on, never to the one before.
      setActionMessage(null);
      // The reader's filter selections ride along under `state`, beside
      // `context`. A "Refresh" that did not know them would refetch the whole
      // fleet for a reader looking at four rows of it, and a plugin paging an
      // API could not page the filtered set at all. Last, so a schema cannot
      // name an argument that would quietly replace it.
      const statePayload = vocabStatePayload(panelStateRef.current.values);
      // Sampled before the round trip, while the pressed control still holds
      // focus — a question this action asks is drawn at the button that asked.
      const promptAnchor = readPluginPromptAnchor();
      const result = await invokePluginAction(pluginId, action.action, {
        ...action.args,
        ...extraArgs,
        ...(context ? { context } : {}),
        ...(statePayload ? { state: statePayload } : {}),
      });
      // A plugin may put the reader back on a filter that still has rows — after
      // archiving everything "Active" was showing, an empty list is a puzzle and
      // "All" is an answer.
      const reset = readPluginActionResetState(result);
      if (reset) {
        setPanelState((previous) => ({
          ...previous,
          values: vocabResetPanelState(previous.values, declarationsRef.current, reset),
        }));
        // The same verb empties the batch. A plugin answering a bulk action with
        // `{resetState: true}` has almost always just acted on every ticked row,
        // and leaving them ticked offers to do it again to rows that have moved
        // on. The anchor goes with them — it points into a list that has changed.
        setPanelSelection((previous) => ({
          ...previous,
          values: vocabResetPanelSelection(previous.values, selectionDeclarationsRef.current, reset),
          anchor: {},
        }));
      }
      // What the action said about how it went. iOS and the TUI have shown this
      // since the verb existed; desktop and the web discarded it, so one line of
      // plugin copy reached two clients out of four.
      setActionMessage(readPluginActionMessage(result));
      // The host publishes a change event for anything it wrote, but an action
      // whose only effect is outside the plugin's own tables would otherwise
      // leave a stale panel on screen.
      setRefreshToken((token) => token + 1);
      // A panel mounted in one of ADE's dialogs may write one allowlisted field
      // of it. Applied here rather than at the socket, because a dialog
      // section's buttons ARE panel buttons — they dispatch through this
      // callback and never through `runPluginSocketAction`. A no-op for every
      // other context, which is every other place a panel is mounted.
      applyPluginDialogEdit(result, {
        context: surfaceContext ?? null,
        pluginId,
        actionId: action.action,
      });
      // An action may ask to send the reader somewhere on the open web — the
      // footer link a panel cannot express as a node, because `text` is never
      // linkified on any client. `https:` only; the reader refuses the rest.
      applyPluginActionOpenUrl(result, { pluginId, actionId: action.action });
      applyPluginActionOpenSettings(result, { pluginId, actionId: action.action });
      const navigation = readPluginActionNavigation(result);
      if (navigation) onNavigate?.(navigation);

      // An action may ask ONE question before it can finish, and a panel button
      // asks it exactly as a socket button does — the same store, the same card,
      // the same one-hop rule: a re-invocation already carries `args.prompt`, so
      // a second question from it is dropped rather than asked.
      if (extraArgs?.prompt !== undefined) return;
      const prompt = readPluginActionPrompt(result);
      if (!prompt) {
        if (hasPluginActionPromptRequest(result)) {
          console.warn("[plugin prompt] ignored a malformed prompt", pluginId, action.action);
        }
        return;
      }
      openPluginPrompt({
        pluginId,
        actionId: action.action,
        prompt,
        // A panel action carries no label of its own — the word is on the node
        // that declared it — so the card falls back to the plugin's name.
        fallbackTitle: null,
        anchor: promptAnchor,
        onSubmit: (text) => {
          const answer = buildPluginActionPromptAnswer(prompt, text);
          // Refused rather than truncated. The card disables its own button at
          // the ceiling, so reaching this branch means something else sent an
          // over-long answer, and half a note is worse than none.
          if (!answer) return;
          void dispatchRef.current?.(action, { ...extraArgs, prompt: answer });
        },
      });
    },
    [onNavigate, pluginId, renderContext, surfaceContext],
  );

  // The dispatcher, reachable from inside its own continuation. A prompt
  // answered later re-invokes the SAME action, and a callback cannot name the
  // callback it is being defined as.
  const dispatchRef = React.useRef<typeof dispatch | null>(null);
  dispatchRef.current = dispatch;

  /**
   * The fetched rows, with every `$state` binding filled from the live
   * selections.
   *
   * Overlaid here rather than fetched, because this is the one collection whose
   * content changes without any data changing. A `keyValue` bound to `$state`
   * renders "Status: Active" and updates on the same press that re-filters the
   * list beside it.
   */
  const rowsByBinding = React.useMemo(() => {
    if (declarations.length === 0) return state.rows;
    // `bindingKey` joins the collection and the key prefix with a NUL, so this
    // matches every `$state` binding whatever prefix it declared — a prefix
    // means nothing for a collection ADE synthesizes.
    const statePrefix = bindingKey({ collection: VOCAB_STATE_COLLECTION });
    const stateBindings = [...state.rows.keys()].filter((key) => key.startsWith(statePrefix));
    if (stateBindings.length === 0) return state.rows;
    const merged = new Map(state.rows);
    const rows = vocabStateRows(declarations, panelState.values).map((row) => ({
      collection: VOCAB_STATE_COLLECTION,
      key: row.key,
      value: row,
      updatedAt: "",
    }));
    for (const key of stateBindings) merged.set(key, rows);
    return merged;
  }, [declarations, panelState.values, state.rows]);

  const context = React.useMemo(
    () => ({
      pluginId,
      brandIcons,
      rowsByBinding,
      dispatch,
      active,
      state: panelState.values,
      setStateValue,
      declarations,
      selection: panelSelection.values,
      selectionDeclarations,
      toggleRow,
      clearSelection,
      groupOpen,
      toggleGroup,
      listPage,
      showMoreListRows,
    }),
    [
      active,
      brandIcons,
      clearSelection,
      declarations,
      dispatch,
      groupOpen,
      listPage,
      panelSelection.values,
      panelState.values,
      pluginId,
      rowsByBinding,
      selectionDeclarations,
      setStateValue,
      showMoreListRows,
      toggleGroup,
      toggleRow,
    ],
  );

  // Declared on the manifest and stamped onto the stored schema by the writer,
  // so a plugin cannot mint the gesture for an action it never declared.
  const refreshAction = readPluginPanelRefreshAction(state.record?.schema);
  const viewAction = readPluginPanelViewAction(state.record?.schema);

  /**
   * Tell the plugin this panel is (or is not) on screen.
   *
   * Silent: a missing handler is `unsupported_method` and must not toast —
   * most plugins never declare `viewAction`. Refcounted on the plugin side so
   * a Work-rail host going idle while the tab host is active does not clear
   * a badge the reader is still looking at.
   */
  React.useEffect(() => {
    if (!viewAction || !active) return;
    void invokePluginAction(pluginId, viewAction, { panelId, viewed: true }).catch(() => {});
    return () => {
      void invokePluginAction(pluginId, viewAction, { panelId, viewed: false }).catch(() => {});
    };
  }, [active, viewAction, pluginId, panelId]);

  /**
   * Run the declared refresh action, then refetch.
   *
   * The refetch happens either way. A refresh that failed still owes the reader
   * whatever the panel holds now, and the failure says so in the banner — the
   * same order iOS uses, so the gesture means one thing on every client.
   */
  const refresh = React.useCallback(async () => {
    if (!refreshAction) return;
    setRefreshing(true);
    try {
      await dispatch({ action: refreshAction });
    } catch (cause) {
      // Caught here rather than left to the caller: a refresh gesture has no
      // control of its own to hang an inline error on, so the failure goes in
      // the banner — the same place a successful refresh's message goes.
      setActionMessage({
        text: cause instanceof Error ? cause.message : "That refresh failed.",
        ok: false,
      });
    } finally {
      setRefreshing(false);
      setRefreshToken((token) => token + 1);
    }
  }, [dispatch, refreshAction]);

  if (state.status === "idle" || (state.status === "loading" && !state.record)) {
    return <PanelSkeleton />;
  }

  if (state.status === "missing") {
    return (
      <PluginFallbackCard
        fallback={{
          title: "Panel not available",
          text: "This plugin hasn’t published this view yet. It appears once the plugin runs on this machine.",
        }}
        action={recoveryAction}
      />
    );
  }

  if (state.status === "error" || !state.record) {
    return (
      <PluginFallbackCard
        fallback={{ title: "Couldn’t load this panel", text: state.error ?? "Something went wrong." }}
        action={recoveryAction}
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0, minHeight: 0, flex: 1 }}>
      <PluginPanelView
        schema={state.record.schema}
        context={context}
        recoveryAction={recoveryAction}
        headerAccessory={refreshAction
          ? (
            <PanelRefreshButton
              pending={refreshing}
              onRefresh={() => void refresh()}
            />
          )
          : null}
      />
      {/* Under the panel, where iOS puts it — the outcome follows the thing it
          is about rather than pushing it down the page on every press. */}
      {actionMessage
        ? <PluginActionBanner text={actionMessage.text} ok={actionMessage.ok} />
        : null}
    </div>
  );
}

/**
 * The refresh gesture on desktop and in the web client.
 *
 * A plain button rather than a pull: a pointer surface has no pull, and the
 * phone's `.refreshable` has no button. Same action, the gesture each client
 * actually has.
 */
function PanelRefreshButton({
  pending,
  onRefresh,
}: {
  pending: boolean;
  onRefresh: () => void;
}) {
  return (
    <button
      type="button"
      disabled={pending}
      onClick={onRefresh}
      aria-label="Refresh this panel"
      title="Refresh this panel"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 8px",
        fontFamily: SANS_FONT,
        fontSize: 11,
        color: COLORS.textMuted,
        background: "transparent",
        border: `1px solid ${COLORS.borderMuted}`,
        borderRadius: RADII.sm,
        cursor: pending ? "default" : "pointer",
        opacity: pending ? 0.55 : 1,
      }}
    >
      <ArrowsClockwise size={12} weight="regular" aria-hidden />
      {pending ? "Refreshing…" : "Refresh"}
    </button>
  );
}

function PanelSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading panel"
      className="motion-safe:animate-pulse"
      style={{ display: "grid", gap: 10, maxWidth: 520 }}
    >
      {[60, 100, 80].map((width, index) => (
        <span
          key={index}
          style={{
            display: "block",
            height: index === 0 ? 14 : 10,
            width: `${width}%`,
            background: COLORS.recessedBg,
            border: `1px solid ${COLORS.borderMuted}`,
            borderRadius: RADII.sm,
          }}
        />
      ))}
      <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textDim }}>Loading…</span>
    </div>
  );
}
