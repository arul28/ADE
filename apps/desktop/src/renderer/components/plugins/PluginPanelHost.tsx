import React from "react";

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
  bindingKey,
  distinctBindings,
  vocabContextRows,
  type VocabAction,
} from "../../../shared/plugins/vocabulary";
import {
  readPluginActionMessage,
  readPluginActionNavigation,
  readPluginPanelRefreshAction,
  type PluginActionMessage,
} from "../../../shared/plugins/sdk";
import { applyPluginDialogEdit } from "./sockets/dialogTarget";
import { applyPluginActionOpenUrl } from "./pluginActionOpenUrl";

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
  const activeRef = React.useRef(active);
  activeRef.current = active;
  const contextRef = React.useRef(renderContext ?? null);
  contextRef.current = renderContext ?? null;

  React.useEffect(() => {
    setState(INITIAL_STATE);
    setActionMessage(null);
  }, [pluginId, panelId]);

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
              const fetched = await readPluginCollection(pluginId, panelId, binding.collection, {
                ...(binding.keyPrefix !== undefined ? { keyPrefix: binding.keyPrefix } : {}),
                ...(binding.limit !== undefined ? { limit: binding.limit } : {}),
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
    async (action: VocabAction, extraArgs?: VocabActionArgs) => {
      // One `context` field, filled by whichever the panel has: a socket's typed
      // surface context when it is mounted at a socket, otherwise the context it
      // was opened with. A panel is never both at once, and sending two shapes
      // under one name would make the plugin guess which it received.
      const context = surfaceContext ?? renderContext ?? null;
      // Cleared before the call, not after it: the outcome on screen must
      // belong to the press the reader is waiting on, never to the one before.
      setActionMessage(null);
      const result = await invokePluginAction(pluginId, action.action, {
        ...action.args,
        ...extraArgs,
        ...(context ? { context } : {}),
      });
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
      const navigation = readPluginActionNavigation(result);
      if (navigation) onNavigate?.(navigation);
    },
    [onNavigate, pluginId, renderContext, surfaceContext],
  );

  const context = React.useMemo(
    () => ({ pluginId, rowsByBinding: state.rows, dispatch, active }),
    [active, dispatch, pluginId, state.rows],
  );

  // Declared on the manifest and stamped onto the stored schema by the writer,
  // so a plugin cannot mint the gesture for an action it never declared.
  const refreshAction = readPluginPanelRefreshAction(state.record?.schema);

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
    <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
      {/* The refresh control, for a panel whose manifest declared a refresh
          action. Here rather than in `PluginPageShell`'s header because a panel
          is hosted in six places — a tab, a detail section, a settings section,
          a file viewer, a chat card, a webview overlay — and only one of them
          has that header. Rendered by whoever renders the panel, so the gesture
          exists wherever the panel does. */}
      {refreshAction ? (
        <div style={{ display: "flex", justifyContent: "flex-end", minWidth: 0 }}>
          <PanelRefreshButton
            pending={refreshing}
            onRefresh={() => void refresh()}
          />
        </div>
      ) : null}
      <PluginPanelView
        schema={state.record.schema}
        context={context}
        recoveryAction={recoveryAction}
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
