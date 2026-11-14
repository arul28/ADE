import { useSyncExternalStore } from "react";
import { isWebClientMode } from "../../../lib/webClientMode";

/**
 * App-wide state of the project sidebar: one width for every tab, and whether
 * the sidebar is hidden. The top bar toggles it and sits above the per-project
 * store, so this lives in a small module store and not in `appStore`.
 */

export const PROJECT_SIDEBAR_DEFAULT_WIDTH = 300;
// Four icon tabs plus the open "Automations" tab need about 258px.
export const PROJECT_SIDEBAR_MIN_WIDTH = 260;
export const PROJECT_SIDEBAR_MAX_WIDTH = 440;

/**
 * ADE Web at this width or less (a phone): the sidebar is a drawer over the
 * page, closed until the top bar's toggle opens it, so the page gets the whole
 * width. The desktop keeps its docked sidebar at any size.
 */
export const PROJECT_SIDEBAR_DRAWER_MAX_WIDTH = 720;

const WIDTH_KEY = "ade.shell.projectSidebar.width";
const HIDDEN_KEY = "ade.shell.projectSidebar.hidden";

export type ProjectSidebarPrefs = {
  width: number;
  /** The saved choice for the docked sidebar. */
  hidden: boolean;
  /** ADE Web at phone width: the sidebar is a drawer over the page. */
  drawer: boolean;
  /** The drawer is open. Never saved: a phone starts with it closed. */
  drawerOpen: boolean;
};

export function clampProjectSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return PROJECT_SIDEBAR_DEFAULT_WIDTH;
  return Math.round(Math.min(PROJECT_SIDEBAR_MAX_WIDTH, Math.max(PROJECT_SIDEBAR_MIN_WIDTH, width)));
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (private mode, quota). The in-memory value still applies.
  }
}

let drawerMedia: MediaQueryList | null | undefined;

/** The phone-width query, on ADE Web only; it follows the window as it resizes. */
function drawerMediaQuery(): MediaQueryList | null {
  if (drawerMedia !== undefined) return drawerMedia;
  drawerMedia = isWebClientMode() && typeof window.matchMedia === "function"
    ? window.matchMedia(`(max-width: ${PROJECT_SIDEBAR_DRAWER_MAX_WIDTH}px)`)
    : null;
  drawerMedia?.addEventListener?.("change", (event) => update({ drawer: event.matches, drawerOpen: false }));
  return drawerMedia;
}

function readInitialPrefs(): ProjectSidebarPrefs {
  const rawWidth = readStorage(WIDTH_KEY);
  return {
    width: rawWidth == null ? PROJECT_SIDEBAR_DEFAULT_WIDTH : clampProjectSidebarWidth(Number(rawWidth)),
    hidden: readStorage(HIDDEN_KEY) === "true",
    drawer: drawerMediaQuery()?.matches ?? false,
    drawerOpen: false,
  };
}

let prefs: ProjectSidebarPrefs | null = null;
const listeners = new Set<() => void>();

function current(): ProjectSidebarPrefs {
  if (!prefs) prefs = readInitialPrefs();
  return prefs;
}

function update(next: Partial<ProjectSidebarPrefs>): void {
  const previous = current();
  const merged = { ...previous, ...next };
  if (
    merged.width === previous.width
    && merged.hidden === previous.hidden
    && merged.drawer === previous.drawer
    && merged.drawerOpen === previous.drawerOpen
  ) return;
  prefs = merged;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getProjectSidebarPrefs(): ProjectSidebarPrefs {
  return current();
}

/** Sets the width while dragging. Call `commitProjectSidebarWidth` on release to persist it. */
export function setProjectSidebarWidth(width: number): void {
  update({ width: clampProjectSidebarWidth(width) });
}

export function commitProjectSidebarWidth(): void {
  writeStorage(WIDTH_KEY, String(current().width));
}

export function setProjectSidebarHidden(hidden: boolean): void {
  update({ hidden });
  writeStorage(HIDDEN_KEY, String(hidden));
}

/** Opens or closes the phone-width drawer. It does nothing to the docked sidebar. */
export function setProjectSidebarDrawerOpen(open: boolean): void {
  if (!current().drawer) return;
  update({ drawerOpen: open });
}

/** The top bar's toggle: the drawer at phone width, the saved choice otherwise. */
export function toggleProjectSidebarHidden(): void {
  const { drawer, drawerOpen, hidden } = current();
  if (drawer) {
    update({ drawerOpen: !drawerOpen });
    return;
  }
  setProjectSidebarHidden(!hidden);
}

export function useProjectSidebarPrefs(): ProjectSidebarPrefs {
  return useSyncExternalStore(subscribe, current, current);
}

function currentHidden(): boolean {
  const { drawer, drawerOpen, hidden } = current();
  return drawer ? !drawerOpen : hidden;
}

/**
 * Whether the sidebar is off screen: the saved choice, or a closed drawer at
 * phone width. Reads only that, so a width drag does not re-render the caller.
 */
export function useProjectSidebarHidden(): boolean {
  return useSyncExternalStore(subscribe, currentHidden, currentHidden);
}

export type ProjectSidebarDrawerState = "off" | "open" | "closed";

function currentDrawerState(): ProjectSidebarDrawerState {
  const { drawer, drawerOpen } = current();
  return drawer ? (drawerOpen ? "open" : "closed") : "off";
}

/** "off" with the docked sidebar; "open" or "closed" for the phone-width drawer. */
export function useProjectSidebarDrawerState(): ProjectSidebarDrawerState {
  return useSyncExternalStore(subscribe, currentDrawerState, currentDrawerState);
}
