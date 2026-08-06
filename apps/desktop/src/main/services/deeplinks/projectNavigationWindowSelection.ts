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

export type RemoteHostWindowSnapshot = ProjectNavigationWindowSnapshot & {
  /** True when this window is already bound to some remote project. */
  hasRemoteBinding: boolean;
  /** True for the window the user is currently looking at. */
  focused: boolean;
};

/**
 * Which window may host a remote project opened from Activity or a deeplink.
 *
 * The rule the whole feature depends on: NEVER the window the user is working
 * in. Binding a remote project replaces that window's global project context,
 * so clicking a notification about another machine used to throw away whatever
 * the user had open. Only a window with no project of its own — no binding, no
 * active project, no project tabs — may be reused; the focused window qualifies
 * only when it is that empty. `null` means "open a new window".
 */
export function selectRemoteHostWindow(
  windows: readonly RemoteHostWindowSnapshot[],
): number | null {
  const isEmpty = (window: RemoteHostWindowSnapshot): boolean =>
    !window.hasRemoteBinding
    && !window.activeProjectRoot
    && window.openProjectRoots.size === 0;
  // An empty focused window is the best host there is: the user is already
  // looking at it and it has nothing to lose. Otherwise any other empty window.
  const focused = windows.find((window) => window.focused && isEmpty(window));
  return focused?.id ?? windows.find(isEmpty)?.id ?? null;
}
