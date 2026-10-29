import { useEffect, useState } from "react";
import type { NewLaneDefaults } from "../../shared/laneStart";
import type { NewLaneDefaultsSnapshot, OpenProjectBinding } from "../../shared/types";

/**
 * The project's new-lane defaults, per machine, read once and shared by every
 * surface that shows them: the auto-create row in the lane picker, the chat
 * launch's predicted stages, Settings. Saving through {@link saveNewLaneDefaults}
 * updates every reader at once; nothing polls.
 */

type Entry = {
  value?: NewLaneDefaultsSnapshot | null;
  promise?: Promise<NewLaneDefaultsSnapshot | null>;
  /** The last read failed (an older brain, a machine that went away). */
  failed?: boolean;
};

const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();

function cacheKey(projectRoot: string | null | undefined, pin: OpenProjectBinding | null | undefined): string {
  const root = projectRoot?.trim() || pin?.rootPath?.trim() || "__no_project__";
  return pin?.key ? `${root}::pin:${pin.key}` : root;
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function getNewLaneDefaultsCached(args: {
  projectRoot?: string | null;
  pin?: OpenProjectBinding | null;
  force?: boolean;
}): Promise<NewLaneDefaultsSnapshot | null> {
  const key = cacheKey(args.projectRoot, args.pin);
  const existing = cache.get(key);
  if (!args.force) {
    if (existing?.value !== undefined) return Promise.resolve(existing.value);
    if (existing?.promise) return existing.promise;
  }
  const read = window.ade?.lanes?.getNewLaneDefaults;
  if (typeof read !== "function") {
    cache.set(key, { failed: true });
    notify();
    return Promise.resolve(null);
  }
  const promise = (args.pin ? read(args.pin) : read())
    .then((value) => {
      cache.set(key, { value });
      notify();
      return value;
    })
    .catch(() => {
      if (cache.get(key)?.promise === promise) cache.set(key, { failed: true });
      notify();
      return null;
    });
  cache.set(key, { ...existing, promise });
  return promise;
}

/** The last read, without any IPC; null when nothing has been read yet. */
export function peekNewLaneDefaultsCached(args: {
  projectRoot?: string | null;
  pin?: OpenProjectBinding | null;
}): NewLaneDefaultsSnapshot | null {
  return cache.get(cacheKey(args.projectRoot, args.pin))?.value ?? null;
}

export async function saveNewLaneDefaults(args: {
  projectRoot?: string | null;
  pin?: OpenProjectBinding | null;
  defaults: NewLaneDefaults;
}): Promise<NewLaneDefaultsSnapshot> {
  const value = args.pin
    ? await window.ade.lanes.setNewLaneDefaults({ defaults: args.defaults }, args.pin)
    : await window.ade.lanes.setNewLaneDefaults({ defaults: args.defaults });
  cache.set(cacheKey(args.projectRoot, args.pin), { value });
  notify();
  return value;
}

/** Reads the defaults on mount (once per machine) and follows later saves. */
export function useNewLaneDefaults(args: {
  projectRoot?: string | null;
  pin?: OpenProjectBinding | null;
  enabled?: boolean;
}): NewLaneDefaultsSnapshot | null {
  return useNewLaneDefaultsState(args).snapshot;
}

/** {@link useNewLaneDefaults} plus whether the read failed, and a retry. */
export function useNewLaneDefaultsState(args: {
  projectRoot?: string | null;
  pin?: OpenProjectBinding | null;
  enabled?: boolean;
}): { snapshot: NewLaneDefaultsSnapshot | null; failed: boolean; retry: () => void } {
  const enabled = args.enabled !== false;
  const key = cacheKey(args.projectRoot, args.pin);
  const read = () => {
    const entry = cache.get(key);
    return { snapshot: entry?.value ?? null, failed: entry?.failed === true };
  };
  const [state, setState] = useState(read);
  useEffect(() => {
    if (!enabled) return;
    const sync = () => setState(read());
    listeners.add(sync);
    sync();
    void getNewLaneDefaultsCached(args);
    return () => {
      listeners.delete(sync);
    };
    // Keyed on the cache key (project root + `pin?.key`), not the pin object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);
  return {
    ...state,
    retry: () => {
      void getNewLaneDefaultsCached({ ...args, force: true });
    },
  };
}
