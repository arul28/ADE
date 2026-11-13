import { useSyncExternalStore } from "react";
import { isWebClientMode } from "../../lib/webClientMode";
import { captureError } from "../../../shared/sentry/capture";

/**
 * Account projects this computer's Home does not list ("From this list" in
 * the remove window), with when each was hidden (epoch ms). A connected
 * computer's folder that is in no recents is hidden here too, by its location
 * key, when its X removes it. Only this
 * computer's Home changes: the account, the other computers and the tab bar
 * keep the project. Opening the project after that lists it again (the
 * builder compares its last open with this time). ADE Web keeps nothing on disk.
 */
const STORAGE_KEY = "ade.home.hiddenAccountProjects.v1";

/** The stored text `hidden` was read from: a later read that finds the same text keeps the same map. */
let storedText: string | null = null;
let hidden: ReadonlyMap<string, number> = read();
const listeners = new Set<() => void>();

function storedValue(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function read(): ReadonlyMap<string, number> {
  if (typeof window === "undefined" || isWebClientMode()) return new Map();
  storedText = storedValue();
  try {
    const parsed: unknown = JSON.parse(storedText ?? "{}");
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
    if (!isWebClientMode()) {
      const text = JSON.stringify(Object.fromEntries(next));
      window.localStorage.setItem(STORAGE_KEY, text);
      storedText = text;
    }
  } catch (error) {
    // Storage full or unavailable: the choice holds until the window reloads.
    captureError(error, { fingerprint: ["home-projects", "hidden-list-write"], level: "warning", handled: true });
  }
  notify();
}

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Another window of this app hid or showed a project: this window's Home
 * follows, while it shows (the `storage` event) and when it opens again.
 */
function syncFromStorage(): boolean {
  if (typeof window === "undefined" || isWebClientMode() || storedValue() === storedText) return false;
  hidden = read();
  return true;
}

function onStorage(event: StorageEvent): void {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  if (syncFromStorage()) notify();
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
  if (listeners.size === 0 && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
    // React reads the snapshot again after it subscribes, so a change made here shows.
    syncFromStorage();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

const snapshot = () => hidden;

export function useHomeHiddenProjects(): ReadonlyMap<string, number> {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
