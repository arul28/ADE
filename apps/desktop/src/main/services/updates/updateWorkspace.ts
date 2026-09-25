import { pathsEqual } from "../shared/pathCompare";
import type { UpdateWorkspaceState } from "../state/globalState";

export type { UpdateWorkspaceState };

export type UpdateWorkspaceRestore = {
  localRoots: string[];
  activeLocalRoot: string | null;
};

/**
 * Open project tabs to put back after an update relaunch.
 * An explicit launch (env root, or a project the OS handed the app) wins.
 * A normal launch leaves the snapshot unread.
 */
export function selectUpdateWorkspaceRestore(args: {
  recentlyInstalled: boolean;
  explicitLaunch: boolean;
  saved: UpdateWorkspaceState | null | undefined;
  normalizeProjectPath: (value: string) => string;
  isLikelyRepoRoot: (value: string) => boolean;
}): UpdateWorkspaceRestore {
  if (!args.recentlyInstalled || args.explicitLaunch) {
    return { localRoots: [], activeLocalRoot: null };
  }
  const localRoots: string[] = [];
  for (const entry of args.saved?.localRoots ?? []) {
    if (typeof entry !== "string") continue;
    const root = args.normalizeProjectPath(entry);
    if (!root || !args.isLikelyRepoRoot(root) || localRoots.some((existing) => pathsEqual(existing, root))) continue;
    localRoots.push(root);
  }
  const requestedActive = typeof args.saved?.activeLocalRoot === "string"
    ? args.normalizeProjectPath(args.saved.activeLocalRoot)
    : "";
  const activeLocalRoot = localRoots.find((root) => pathsEqual(root, requestedActive))
    ?? localRoots[0]
    ?? null;
  return { localRoots, activeLocalRoot };
}
