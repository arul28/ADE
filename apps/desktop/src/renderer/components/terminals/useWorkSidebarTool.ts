import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  selectActiveProjectStateKey,
  useAppStore,
  type WorkProjectViewState,
  type WorkSidebarTab,
} from "../../state/appStore";

/**
 * The scope key a lane's tools-pane state lives under in `laneWorkViewByScope`.
 * Returns "" when either half is missing, which callers read as "no lane scope,
 * use the project scope".
 */
export function workToolScopeKey(
  projectStateKey: string | null,
  laneId: string | null,
): string {
  const project = projectStateKey?.trim() ?? "";
  const lane = laneId?.trim() ?? "";
  if (!project || !lane) return "";
  return `${project}::${lane}`;
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

  const scopeKey = workToolScopeKey(projectStateKey, laneId);

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
