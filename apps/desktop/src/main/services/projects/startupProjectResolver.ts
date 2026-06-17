import path from "node:path";
import type { GlobalState, RecentProject } from "../state/globalState";
import { recentProjectKey } from "../state/globalState";

// Keep more than the visible window so pinned-but-stale projects don't crowd
// out fresh ones; pinned entries are retained beyond the cap entirely.
const STARTUP_RECENT_CAP = 24;

export type StartupProjectSource = "env" | "pending-open" | "none";

export type StartupProjectResolution = {
  rootPath: string | null;
  source: StartupProjectSource;
};

export type StartupProjectStateNormalization = {
  state: GlobalState;
  recentProjects: RecentProject[];
  changed: boolean;
};

function recentProjectEntryChanged(
  project: RecentProject,
  savedProject: RecentProject | undefined,
): boolean {
  if (!savedProject) return true;
  const projectRemote = project.remote ?? null;
  const savedRemote = savedProject.remote ?? null;
  return recentProjectKey(savedProject) !== recentProjectKey(project) ||
    savedProject.rootPath !== project.rootPath ||
    savedProject.displayName !== project.displayName ||
    savedProject.lastOpenedAt !== project.lastOpenedAt ||
    savedProject.pinned !== project.pinned ||
    (savedRemote?.targetId ?? null) !== (projectRemote?.targetId ?? null) ||
    (savedRemote?.projectId ?? null) !== (projectRemote?.projectId ?? null) ||
    (savedRemote?.runtimeName ?? null) !== (projectRemote?.runtimeName ?? null) ||
    (savedRemote?.hostname ?? null) !== (projectRemote?.hostname ?? null);
}

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
    const fallbackOpenedAt =
      typeof entry?.lastOpenedAt === "string" &&
      entry.lastOpenedAt.trim().length > 0
        ? entry.lastOpenedAt
        : args.nowIso ?? new Date().toISOString();
    // Remote recents point at projects on another machine — never disk-check,
    // normalize, or strip them. Dedup by their stable remote key.
    if (entry?.remote) {
      const key = recentProjectKey(entry);
      if (acc.some((item) => recentProjectKey(item) === key)) return acc;
      const remoteRoot = typeof entry.rootPath === "string" ? entry.rootPath : "";
      acc.push({
        rootPath: remoteRoot,
        displayName:
          typeof entry.displayName === "string" && entry.displayName.trim().length > 0
            ? entry.displayName
            : path.basename(remoteRoot) || entry.remote.runtimeName,
        lastOpenedAt: fallbackOpenedAt,
        remote: entry.remote,
        ...(entry.pinned ? { pinned: true } : {}),
      });
      return acc;
    }
    const rootPath =
      typeof entry?.rootPath === "string"
        ? args.normalizeProjectPath(entry.rootPath)
        : "";
    if (!args.isLikelyRepoRoot(rootPath)) return acc;
    if (acc.some((item) => !item.remote && item.rootPath === rootPath)) return acc;
    const displayName =
      typeof entry?.displayName === "string" &&
      entry.displayName.trim().length > 0
        ? entry.displayName
        : path.basename(rootPath);
    acc.push({
      rootPath,
      displayName,
      lastOpenedAt: fallbackOpenedAt,
      ...(entry?.pinned ? { pinned: true } : {}),
    });
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
    !baseCleanedRecentProjects.some(
      (project) => !project.remote && project.rootPath === validLastProjectRoot,
    )
      ? [
        {
          rootPath: validLastProjectRoot,
          displayName: path.basename(validLastProjectRoot),
          lastOpenedAt: args.nowIso ?? new Date().toISOString(),
        },
        ...baseCleanedRecentProjects,
      ].filter((entry, index) => entry.pinned || index < STARTUP_RECENT_CAP)
      : baseCleanedRecentProjects;
  const recentProjectsChanged =
    recentProjects.length !== savedRecentProjects.length ||
    recentProjects.some((project, index) =>
      recentProjectEntryChanged(project, savedRecentProjects[index])
    );
  const lastProjectRootChanged =
    args.saved.lastProjectRoot !== undefined;
  const stateWithoutLastProject: GlobalState = { ...args.saved };
  delete stateWithoutLastProject.lastProjectRoot;
  return {
    state: {
      ...stateWithoutLastProject,
      recentProjects,
    },
    recentProjects,
    changed: recentProjectsChanged || lastProjectRootChanged,
  };
}

export function resolveStartupProject(args: {
  envRoot?: string | null;
  pendingStartupProjectRoot?: string | null;
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

  return { rootPath: null, source: "none" };
}
