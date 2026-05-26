export type ProjectNavigationWindowSnapshot = {
  id: number;
  activeProjectRoot: string | null;
  openProjectRoots: ReadonlySet<string>;
};

export type ProjectNavigationWindowSelection = {
  windowId: number;
  activateProjectRoot: boolean;
};

export function selectWindowForProjectNavigation(
  targetProjectRoot: string,
  windows: ProjectNavigationWindowSnapshot[],
): ProjectNavigationWindowSelection | null {
  const activeWindow = windows.find(
    (window) => window.activeProjectRoot === targetProjectRoot,
  );
  if (activeWindow) {
    return { windowId: activeWindow.id, activateProjectRoot: false };
  }

  const tabWindow = windows.find((window) =>
    window.openProjectRoots.has(targetProjectRoot),
  );
  if (tabWindow) {
    return { windowId: tabWindow.id, activateProjectRoot: true };
  }

  return null;
}
