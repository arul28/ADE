import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkToolId } from "../../../shared/types/workTools";
import {
  laneWorkViewScopeKey,
  selectActiveProjectStateKey,
  useAppStore,
  type WorkProjectViewState,
  type WorkSidebarTab,
} from "../../state/appStore";

/**
 * The scope key is the store's own — `laneWorkViewScopeKey`. Re-exported under
 * the name this module's callers already use; the third hand-rolled copy of
 * `"<project>::<lane>"` is gone.
 */
export { laneWorkViewScopeKey as workToolScopeKey };

/**
 * The one product fact the Work tools pane reports: which tool an installation
 * actually opens.
 *
 * `ade_screen_viewed` already records that the Work screen was reached, and it
 * cannot tell an install that lives in the Browser from one that only ever
 * opens Git — which is the question this pane exists to answer. Emitted here,
 * at the single writer every entry point funnels through (picker card, command
 * palette, the reveal channel a dev-server chip uses), rather than at each of
 * them, so the count cannot depend on how the tool was reached.
 *
 * Coarse and closed: the tool id and nothing else. No lane, project, tab, URL,
 * session, duration, or ordering — a tool id says what was used, and any of
 * those would say what was being worked on. Returning to the picker emits
 * nothing: a null tool is not a tool.
 *
 * A per-tool 24-hour deduplication key holds this to at most SIX accepted
 * events per installation per UTC day (one per id) no matter how often the user
 * flips between panes, which is well inside the existing `ade_feature_used`
 * 140-per-day / 30-per-minute limits and the shared 200-event ceiling. No
 * ceiling was raised. The dashboard spec is deliberately untouched: no card
 * asks this yet.
 */
function captureWorkToolOpened(tool: WorkToolId): void {
  void window.ade?.analytics?.capture({
    event: "ade_feature_used",
    properties: {
      feature: "work",
      action: "tool_opened",
      outcome: `tool_${tool.replace(/-/g, "_")}`,
      source: "renderer_route",
    },
    dedupeKey: `work_tool_opened:${tool}`,
    minimumIntervalMs: 24 * 60 * 60_000,
  }).catch(() => undefined);
}

/**
 * Reads and writes "which tool is open in the Work tools pane".
 *
 * Per LANE, because that is the unit of work: the lane you are shipping a UI
 * change in wants the browser, the lane you are rebasing wants Git, and
 * flipping between them should not make you re-pick. Falls back to the
 * project-scoped copy when no lane is bound — a projectless or personal chat
 * still gets a tool it can return to.
 *
 * Openness and width stay project-wide (`workSidebarOpen`,
 * `workSidebarWidthPct`); only the contents follow the lane.
 */
export function useWorkSidebarTool(laneId: string | null): {
  tool: WorkSidebarTab | null;
  setTool: (tool: WorkSidebarTab | null) => void;
} {
  const projectStateKey = useAppStore(selectActiveProjectStateKey);
  const laneWorkViewByScope = useAppStore((state) => state.laneWorkViewByScope);
  const workViewByProject = useAppStore((state) => state.workViewByProject);
  const setLaneWorkViewState = useAppStore((state) => state.setLaneWorkViewState);
  const setWorkViewState = useAppStore((state) => state.setWorkViewState);

  const scopeKey = laneWorkViewScopeKey(projectStateKey, laneId);

  const tool = useMemo<WorkSidebarTab | null>(() => {
    const scoped: WorkProjectViewState | undefined = scopeKey
      ? laneWorkViewByScope?.[scopeKey]
      : undefined;
    if (scoped) return scoped.workSidebarTool ?? null;
    if (!projectStateKey) return null;
    return workViewByProject?.[projectStateKey]?.workSidebarTool ?? null;
  }, [laneWorkViewByScope, projectStateKey, scopeKey, workViewByProject]);

  const setTool = useCallback(
    (next: WorkSidebarTab | null) => {
      if (!projectStateKey) return;
      if (next) captureWorkToolOpened(next);
      if (laneId) {
        setLaneWorkViewState(projectStateKey, laneId, { workSidebarTool: next });
      } else {
        setWorkViewState(projectStateKey, { workSidebarTool: next });
      }
      // Picking a tool always reveals the pane — every entry point that used to
      // call `setWorkSidebarTab` relied on that, and returning to the picker is
      // not a reason to close it.
      setWorkViewState(projectStateKey, { workSidebarOpen: true });
    },
    [laneId, projectStateKey, setLaneWorkViewState, setWorkViewState],
  );

  usePublishActiveWorkTool(laneId, tool);

  return { tool, setTool };
}

/**
 * How long a tool must stay picked before the phone hears about it.
 *
 * Flicking through the picker is one gesture, not six state changes, and every
 * publish costs a runtime round trip plus a fan-out event to every pinned
 * client. The trailing edge wins, so what lands is always the tool the user
 * stopped on.
 */
export const WORK_TOOL_PUBLISH_DEBOUNCE_MS = 250;

/**
 * Tells the runtime which tool this lane's pane is showing, so iOS and the
 * hosted web client can mirror it read-only.
 *
 * The renderer is the only thing that knows this — it is view state, not
 * runtime state — so it has to be pushed rather than read. The brain holds it
 * in memory only, which is why the effect re-publishes whenever the runtime
 * binding or runtime status changes: a brain that restarted has forgotten, and
 * a phone looking at a stale "Browser active" would be lying about a pane that
 * is no longer open.
 *
 * Failures are swallowed on purpose. This is a mirror for other devices; a
 * runtime that cannot take the publish must not disturb the pane it describes.
 */
function usePublishActiveWorkTool(laneId: string | null, tool: WorkSidebarTab | null): void {
  const latest = useRef<{ laneId: string | null; tool: WorkSidebarTab | null }>({ laneId, tool });
  latest.current = { laneId, tool };
  // Incremented by binding/status changes so a reconnect re-publishes through
  // the same debounced effect instead of duplicating the call.
  const [republishToken, setRepublishToken] = useState(0);

  useEffect(() => {
    const app = window.ade?.app;
    const bump = () => setRepublishToken((token) => token + 1);
    const disposers = [
      app?.onProjectBindingChanged?.(bump),
      app?.onRuntimeStatusChanged?.(bump),
    ];
    return () => {
      for (const dispose of disposers) dispose?.();
    };
  }, []);

  useEffect(() => {
    if (!laneId) return;
    const publish = window.ade?.workTools?.setActiveTool;
    if (!publish) return;
    const timer = window.setTimeout(() => {
      const current = latest.current;
      if (!current.laneId) return;
      void publish(current.laneId, current.tool).catch(() => {});
    }, WORK_TOOL_PUBLISH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [laneId, tool, republishToken]);
}
