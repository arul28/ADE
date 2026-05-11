import type { RecentProject } from "../state/globalState";

export type StartupProjectSource = "env" | "pending-open" | "last-project" | "recent-project" | "none";

export type StartupProjectResolution = {
  rootPath: string | null;
  source: StartupProjectSource;
};

export function resolveStartupProject(args: {
  envRoot?: string | null;
  pendingStartupProjectRoot?: string | null;
  validLastProjectRoot?: string | null;
  recentProjects: RecentProject[];
  normalizeProjectPath: (value: string) => string;
}): StartupProjectResolution {
  const envRoot = typeof args.envRoot === "string" ? args.envRoot.trim() : "";
  if (envRoot) {
    return { rootPath: args.normalizeProjectPath(envRoot), source: "env" };
  }

  if (args.pendingStartupProjectRoot) {
    return {
      rootPath: args.normalizeProjectPath(args.pendingStartupProjectRoot),
      source: "pending-open",
    };
  }

  const lastProjectRoot =
    typeof args.validLastProjectRoot === "string"
      ? args.validLastProjectRoot.trim()
      : "";
  if (lastProjectRoot) {
    return {
      rootPath: args.normalizeProjectPath(lastProjectRoot),
      source: "last-project",
    };
  }

  const recentProjectRoot = args.recentProjects.find(
    (project) => typeof project.rootPath === "string" && project.rootPath.trim().length > 0,
  )?.rootPath;
  if (recentProjectRoot) {
    return {
      rootPath: args.normalizeProjectPath(recentProjectRoot),
      source: "recent-project",
    };
  }

  return { rootPath: null, source: "none" };
}
