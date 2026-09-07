import { useCallback, useMemo } from "react";
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

  return { tool, setTool };
}
