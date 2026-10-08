import { createContext, useContext } from "react";
import type { HomePullRequests, RecentStats } from "../projects/ProjectWelcomeHome";

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
};

export const HomeDataContext = createContext<HomeData | null>(null);

export function useHomeData(): HomeData {
  const data = useContext(HomeDataContext);
  if (!data) throw new Error("useHomeData outside the home page");
  return data;
}
