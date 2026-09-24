import { useSyncExternalStore } from "react";

/**
 * App-wide state of the project sidebar: one width for every tab, and whether
 * the sidebar is hidden. The top bar toggles it and sits above the per-project
 * store, so this lives in a small module store and not in `appStore`.
 */

export const PROJECT_SIDEBAR_DEFAULT_WIDTH = 300;
// Four icon tabs plus the open "Automations" tab need about 258px.
export const PROJECT_SIDEBAR_MIN_WIDTH = 260;
export const PROJECT_SIDEBAR_MAX_WIDTH = 440;

const WIDTH_KEY = "ade.shell.projectSidebar.width";
const HIDDEN_KEY = "ade.shell.projectSidebar.hidden";

export type ProjectSidebarPrefs = {
  width: number;
  hidden: boolean;
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

function readInitialPrefs(): ProjectSidebarPrefs {
  const rawWidth = readStorage(WIDTH_KEY);
  return {
    width: rawWidth == null ? PROJECT_SIDEBAR_DEFAULT_WIDTH : clampProjectSidebarWidth(Number(rawWidth)),
    hidden: readStorage(HIDDEN_KEY) === "true",
  };
}

let prefs: ProjectSidebarPrefs | null = null;
const listeners = new Set<() => void>();

function current(): ProjectSidebarPrefs {
  if (!prefs) prefs = readInitialPrefs();
  return prefs;
}

function update(next: Partial<ProjectSidebarPrefs>): void {
  const merged = { ...current(), ...next };
  if (merged.width === current().width && merged.hidden === current().hidden) return;
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

export function toggleProjectSidebarHidden(): void {
  setProjectSidebarHidden(!current().hidden);
}

export function useProjectSidebarPrefs(): ProjectSidebarPrefs {
  return useSyncExternalStore(subscribe, current, current);
}

function currentHidden(): boolean {
  return current().hidden;
}

/** Reads only `hidden`, so a width drag does not re-render the caller. */
export function useProjectSidebarHidden(): boolean {
  return useSyncExternalStore(subscribe, currentHidden, currentHidden);
}
