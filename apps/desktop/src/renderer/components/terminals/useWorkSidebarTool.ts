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
 * Appends a tool to the strip, or leaves it where it already is.
 *
 * Re-picking an open tool must not move its tab: the strip is the user's own
 * ordering, and a picker choice that reshuffled it would make the tabs jump
 * every time you came back to one.
 */
export function openWorkToolTab(
  openTools: readonly WorkSidebarTab[],
  tool: WorkSidebarTab,
): WorkSidebarTab[] {
  return openTools.includes(tool) ? [...openTools] : [...openTools, tool];
}

/**
 * Closes a tab and says what is on screen afterwards.
 *
 * The neighbour to the RIGHT inherits, falling back to the left and then to the
 * picker — the same rule every tabbed editor uses, and the only one where
 * closing a run of tabs left-to-right does not throw you across the strip.
 * Closing a background tab never changes what you are looking at.
 */
export function closeWorkToolTab(
  openTools: readonly WorkSidebarTab[],
  activeTool: WorkSidebarTab | null,
  tool: WorkSidebarTab,
): { openTools: WorkSidebarTab[]; activeTool: WorkSidebarTab | null } {
  const index = openTools.indexOf(tool);
  if (index < 0) return { openTools: [...openTools], activeTool };
  const next = openTools.filter((entry) => entry !== tool);
  if (activeTool !== tool) return { openTools: next, activeTool };
  return { openTools: next, activeTool: next[index] ?? next[index - 1] ?? null };
}

/**
 * Reads and writes the Work tools pane's tab strip.
 *
 * Per LANE, because that is the unit of work: the lane you are shipping a UI
 * change in wants the browser, the lane you are rebasing wants Git, and
 * flipping between them should not make you re-pick. Falls back to the
 * project-scoped copy when no lane is bound — a projectless or personal chat
 * still gets a strip it can return to.
 *
 * `tool` is the tab on screen (null = the picker page, with the strip still
 * showing); `openTools` is the strip itself. `setTool` opens or activates a tab,
 * `closeTool` removes one. Openness and width stay project-wide
 * (`workSidebarOpen`, `workSidebarWidthPct`); only the contents follow the lane.
 */
export function useWorkSidebarTool(laneId: string | null): {
  tool: WorkSidebarTab | null;
  openTools: WorkSidebarTab[];
  setTool: (tool: WorkSidebarTab | null) => void;
  closeTool: (tool: WorkSidebarTab) => void;
} {
  const projectStateKey = useAppStore(selectActiveProjectStateKey);
  const laneWorkViewByScope = useAppStore((state) => state.laneWorkViewByScope);
  const workViewByProject = useAppStore((state) => state.workViewByProject);
  const setLaneWorkViewState = useAppStore((state) => state.setLaneWorkViewState);
  const setWorkViewState = useAppStore((state) => state.setWorkViewState);

  const scopeKey = laneWorkViewScopeKey(projectStateKey, laneId);

  // Both fields come from ONE resolved record: reading the active tool from the
  // lane scope and the strip from the project fallback would produce a strip
  // that does not contain its own active tab.
  const { tool, openTools } = useMemo<{
    tool: WorkSidebarTab | null;
    openTools: WorkSidebarTab[];
  }>(() => {
    const scoped: WorkProjectViewState | undefined = scopeKey
      ? laneWorkViewByScope?.[scopeKey]
      : undefined;
    const view = scoped
      ?? (projectStateKey ? workViewByProject?.[projectStateKey] : undefined);
    const active = view?.workSidebarTool ?? null;
    const strip = view?.workSidebarOpenTools ?? [];
    // A tool on screen is open by definition. State written before the strip
    // existed has an active tool and no strip at all, and a lane that inherited
    // its tool from the project scope has the same shape — both become the
    // one-tab strip that build's pane actually had.
    return {
      tool: active,
      openTools: active && !strip.includes(active) ? [...strip, active] : strip,
    };
  }, [laneWorkViewByScope, projectStateKey, scopeKey, workViewByProject]);

  // The setters are pointer-driven and must not close over a stale render's
  // strip: two clicks inside one commit would otherwise both write against the
  // strip as it was before the first.
  const latestStrip = useRef({ tool, openTools });
  latestStrip.current = { tool, openTools };

  const write = useCallback(
    (next: { workSidebarTool: WorkSidebarTab | null; workSidebarOpenTools: WorkSidebarTab[] }) => {
      if (!projectStateKey) return;
      if (laneId) {
        setLaneWorkViewState(projectStateKey, laneId, next);
      } else {
        setWorkViewState(projectStateKey, next);
      }
      // Picking a tool always reveals the pane — every entry point that used to
      // call `setWorkSidebarTab` relied on that, and returning to the picker is
      // not a reason to close it.
      setWorkViewState(projectStateKey, { workSidebarOpen: true });
    },
    [laneId, projectStateKey, setLaneWorkViewState, setWorkViewState],
  );

  const setTool = useCallback(
    (next: WorkSidebarTab | null) => {
      const current = latestStrip.current;
      if (next) captureWorkToolOpened(next);
      write({
        workSidebarTool: next,
        // Going back to the picker keeps the strip: the tabs are still open, the
        // pane is just showing the page you pick a new one from.
        workSidebarOpenTools: next
          ? openWorkToolTab(current.openTools, next)
          : [...current.openTools],
      });
    },
    [write],
  );

  const closeTool = useCallback(
    (target: WorkSidebarTab) => {
      const current = latestStrip.current;
      const next = closeWorkToolTab(current.openTools, current.tool, target);
      write({
        workSidebarTool: next.activeTool,
        workSidebarOpenTools: next.openTools,
      });
    },
    [write],
  );

  usePublishActiveWorkTool(laneId, tool, openTools);

  return { tool, openTools, setTool, closeTool };
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
 * Tells the runtime which tabs this lane's pane has and which one is showing, so
 * iOS and the hosted web client can mirror it read-only.
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
function usePublishActiveWorkTool(
  laneId: string | null,
  tool: WorkSidebarTab | null,
  openTools: readonly WorkSidebarTab[],
): void {
  const latest = useRef<{
    laneId: string | null;
    tool: WorkSidebarTab | null;
    openTools: readonly WorkSidebarTab[];
  }>({ laneId, tool, openTools });
  latest.current = { laneId, tool, openTools };
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

  // The strip is joined into the dependency rather than compared by identity: a
  // memo rebuilt from an unchanged store still yields a new array on some
  // renders, and publishing on that would defeat the debounce it sits behind.
  const stripKey = openTools.join(",");
  useEffect(() => {
    if (!laneId) return;
    const publish = window.ade?.workTools?.setActiveTool;
    if (!publish) return;
    const timer = window.setTimeout(() => {
      const current = latest.current;
      if (!current.laneId) return;
      void publish(current.laneId, current.tool, [...current.openTools]).catch(() => {});
    }, WORK_TOOL_PUBLISH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [laneId, tool, stripKey, republishToken]);
}
