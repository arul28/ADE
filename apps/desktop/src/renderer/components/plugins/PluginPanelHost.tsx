import React from "react";

import { COLORS, RADII, SANS_FONT } from "../lanes/laneDesignTokens";
import { PluginFallbackCard, PluginPanelView } from "./VocabularyRenderer";
import { bindingKey, type VocabActionArgs } from "./vocabularyComponents";
import {
  invokePluginAction,
  readPluginCollection,
  readPluginPanel,
  subscribeToPluginChanges,
  type PluginCollectionRow,
  type PluginPanelRecord,
} from "../../lib/pluginRuntimeBridge";
import {
  collectVocabBindings,
  parsePluginPanel,
  type VocabAction,
  type VocabBinding,
} from "../../../shared/plugins/vocabulary";

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

/** Collections a schema reads, de-duplicated so one fetch serves every node. */
function distinctBindings(schema: unknown): VocabBinding[] {
  const parsed = parsePluginPanel(schema);
  if (!parsed.ok) return [];
  const seen = new Map<string, VocabBinding>();
  for (const binding of collectVocabBindings(parsed.panel.body)) {
    const key = bindingKey(binding);
    const existing = seen.get(key);
    // Two nodes may bind the same collection with different limits; fetch the
    // larger so neither is starved.
    if (!existing || (binding.limit ?? Infinity) > (existing.limit ?? Infinity)) {
      seen.set(key, binding);
    }
  }
  return [...seen.values()];
}

export function PluginPanelHost({
  pluginId,
  panelId,
  active,
  recoveryAction,
}: {
  pluginId: string;
  panelId: string;
  /** False while the hosting surface is mounted but not visible. */
  active: boolean;
  /** Passed through to the fallback card, e.g. a Restart button. */
  recoveryAction?: React.ReactNode;
}) {
  const [state, setState] = React.useState<PanelState>(INITIAL_STATE);
  // Bumped to force a refetch: by a host change event, and by a completed
  // action (a plugin that just did something has usually changed its own data).
  const [refreshToken, setRefreshToken] = React.useState(0);
  const activeRef = React.useRef(active);
  activeRef.current = active;

  React.useEffect(() => {
    setState(INITIAL_STATE);
  }, [pluginId, panelId]);

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
              const fetched = await readPluginCollection(pluginId, binding.collection, {
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
      await invokePluginAction(pluginId, action.action, { ...action.args, ...extraArgs });
      // The host publishes a change event for anything it wrote, but an action
      // whose only effect is outside the plugin's own tables would otherwise
      // leave a stale panel on screen.
      setRefreshToken((token) => token + 1);
    },
    [pluginId],
  );

  const context = React.useMemo(
    () => ({ pluginId, rowsByBinding: state.rows, dispatch, active }),
    [active, dispatch, pluginId, state.rows],
  );

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
    <PluginPanelView
      schema={state.record.schema}
      context={context}
      recoveryAction={recoveryAction}
    />
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
