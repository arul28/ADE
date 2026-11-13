import { useSyncExternalStore } from "react";
import { isWebClientMode } from "../../lib/webClientMode";

/**
 * Account projects this computer's Home does not list ("From this list" in
 * the remove window), with when each was hidden (epoch ms). Only this
 * computer's Home changes: the account, the other computers and the tab bar
 * keep the project. Opening the project after that lists it again (the
 * builder compares its last open with this time). ADE Web keeps nothing on disk.
 */
const STORAGE_KEY = "ade.home.hiddenAccountProjects.v1";

let hidden: ReadonlyMap<string, number> = read();
const listeners = new Set<() => void>();

function read(): ReadonlyMap<string, number> {
  if (typeof window === "undefined" || isWebClientMode()) return new Map();
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    return new Map(Object.entries(parsed as Record<string, unknown>)
      .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
  } catch {
    return new Map();
  }
}

function write(next: ReadonlyMap<string, number>): void {
  hidden = next;
  try {
    if (!isWebClientMode()) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(next)));
  } catch {
    // Storage full or unavailable: the choice holds until the window reloads.
  }
  for (const listener of listeners) listener();
}

export function hideFromHome(accountProjectId: string): void {
  const next = new Map(hidden);
  next.set(accountProjectId, Date.now());
  write(next);
}

export function showOnHome(accountProjectId: string): void {
  if (!hidden.has(accountProjectId)) return;
  const next = new Map(hidden);
  next.delete(accountProjectId);
  write(next);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => hidden;

export function useHomeHiddenProjects(): ReadonlyMap<string, number> {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
