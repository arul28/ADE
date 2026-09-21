import { createContext, useContext } from "react";

/**
 * The Work tools pane, blown up to the whole window.
 *
 * A tool's own "full screen" used to portal just its picture over the window,
 * so the tool tabs across the top vanished with it: the Mac Desktop went big
 * and the way back to Browser or Terminal went with it. Maximise is a state of
 * the PANE instead: the same header, the same tabs, the same tool, at window
 * size. Esc or the header button puts it back.
 *
 * Provided by `WorkSidebar`. Absent (null) where there is no sidebar to
 * maximise, such as a floating card or the web client, and a tool then falls
 * back to whatever it did before.
 */
export type WorkToolsMaximize = {
  maximized: boolean;
  setMaximized: (next: boolean) => void;
};

export const WorkToolsMaximizeContext = createContext<WorkToolsMaximize | null>(null);

export function useWorkToolsMaximize(): WorkToolsMaximize | null {
  return useContext(WorkToolsMaximizeContext);
}

/** Above every pane surface and the Mac Desktop's own overlay. */
export const WORK_TOOLS_MAXIMIZED_Z = 39_000;
