import { createContext, useContext, type ReactNode } from "react";
import type { WidgetRenderContext } from "./HomeWidgetGrid";
import type { HomePullRequests, RecentStats } from "../projects/ProjectWelcomeHome";
import type { MachineRow } from "../projects/ProjectWelcomeSidePanels";
import type { PinnedProjectRef } from "./homeFeed";

/**
 * What the home page already loaded, shared with its widgets so a widget never
 * makes a second copy of a read the page made (the usage stats, the PR
 * snapshot). Lazily loaded widgets read it from context.
 */
export type HomeData = {
  stats: RecentStats;
  prs: HomePullRequests;
  projectName: string | null;
  projectRoot: string | null;
  webMode: boolean;
  openPrs?: () => void;
  openActivity: () => void;
  /** Projects pinned in the Projects widget (the recents pin), for "pinned only" views. */
  pinnedProjects: PinnedProjectRef[];
  /** The machine list the Limits & machines card shows. */
  machineRows: MachineRow[];
  /** When each remote machine's current connection opened, by machine key. */
  machineOnlineSince: ReadonlyMap<string, number>;
};

export const HomeDataContext = createContext<HomeData | null>(null);

/** How the page renders a widget; the Add widget gallery uses it for live previews. */
export const HomeRenderWidgetContext = createContext<((ctx: WidgetRenderContext) => ReactNode) | null>(null);

export function useHomeData(): HomeData {
  const data = useContext(HomeDataContext);
  if (!data) throw new Error("useHomeData outside the home page");
  return data;
}
