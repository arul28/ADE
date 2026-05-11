import path from "node:path";
import type { GlobalState, RecentProject } from "../state/globalState";

export type StartupProjectSource = "env" | "pending-open" | "last-project" | "recent-project" | "none";

export type StartupProjectResolution = {
  rootPath: string | null;
  source: StartupProjectSource;
};

export type StartupProjectStateNormalization = {
  state: GlobalState;
  validLastProjectRoot: string;
  recentProjects: RecentProject[];
  changed: boolean;
};

export function normalizeStartupProjectState(args: {
  saved: GlobalState;
  additionalRecentProjects?: RecentProject[];
  isLikelyRepoRoot: (value: string) => boolean;
  normalizeProjectPath: (value: string) => string;
  nowIso?: string;
}): StartupProjectStateNormalization {
  const savedRecentProjects = args.saved.recentProjects ?? [];
  const candidateRecentProjects = [
    ...savedRecentProjects,
    ...(args.additionalRecentProjects ?? []),
  ];
  const baseCleanedRecentProjects = candidateRecentProjects.reduce((acc, entry) => {
    const rootPath =
      typeof entry?.rootPath === "string"
        ? args.normalizeProjectPath(entry.rootPath)
        : "";
    if (!args.isLikelyRepoRoot(rootPath)) return acc;
    if (acc.some((item) => item.rootPath === rootPath)) return acc;
    const displayName =
      typeof entry?.displayName === "string" &&
      entry.displayName.trim().length > 0
        ? entry.displayName
        : path.basename(rootPath);
    const lastOpenedAt =
      typeof entry?.lastOpenedAt === "string" &&
      entry.lastOpenedAt.trim().length > 0
        ? entry.lastOpenedAt
        : args.nowIso ?? new Date().toISOString();
    acc.push({ rootPath, displayName, lastOpenedAt });
    return acc;
  }, [] as RecentProject[]);
  const cleanedLastProjectRoot = args.saved.lastProjectRoot
    ? args.normalizeProjectPath(args.saved.lastProjectRoot)
    : "";
  const validLastProjectRoot = args.isLikelyRepoRoot(cleanedLastProjectRoot)
    ? cleanedLastProjectRoot
    : "";
  const recentProjects =
    validLastProjectRoot &&
    !baseCleanedRecentProjects.some((project) => project.rootPath === validLastProjectRoot)
      ? [
        {
          rootPath: validLastProjectRoot,
          displayName: path.basename(validLastProjectRoot),
          lastOpenedAt: args.nowIso ?? new Date().toISOString(),
        },
        ...baseCleanedRecentProjects,
      ].slice(0, 12)
      : baseCleanedRecentProjects;
  const recentProjectsChanged =
    recentProjects.length !== savedRecentProjects.length ||
    recentProjects.some((project, index) => {
      const savedProject = savedRecentProjects[index];
      return !savedProject ||
        savedProject.rootPath !== project.rootPath ||
        savedProject.displayName !== project.displayName ||
        savedProject.lastOpenedAt !== project.lastOpenedAt;
    });
  const normalizedLastProjectRoot = validLastProjectRoot || undefined;
  const lastProjectRootChanged =
    args.saved.lastProjectRoot !== normalizedLastProjectRoot;
  return {
    state: {
      ...args.saved,
      lastProjectRoot: normalizedLastProjectRoot,
      recentProjects,
    },
    validLastProjectRoot,
    recentProjects,
    changed: recentProjectsChanged || lastProjectRootChanged,
  };
}

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
