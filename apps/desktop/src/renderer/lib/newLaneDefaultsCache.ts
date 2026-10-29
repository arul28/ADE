import { useEffect, useState } from "react";
import type { NewLaneDefaults } from "../../shared/laneStart";
import type { NewLaneDefaultsSnapshot, OpenProjectBinding } from "../../shared/types";

/**
 * The project's new-lane defaults, per machine, read once and shared by every
 * surface that shows them: the auto-create row in the lane picker, the chat
 * launch's predicted stages, Settings. Saving through {@link saveNewLaneDefaults}
 * updates every reader at once, and a change to the account's settings (another
 * computer or the phone saved them) re-reads what is cached; nothing polls.
 */

type ReadArgs = { projectRoot?: string | null; pin?: OpenProjectBinding | null };

type Entry = {
  value?: NewLaneDefaultsSnapshot | null;
  promise?: Promise<NewLaneDefaultsSnapshot | null>;
  /** The last read failed (an older brain, a machine that went away). */
  failed?: boolean;
  /** What the entry was read with, so an account change can re-read it. */
  args?: ReadArgs;
};

const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
let stopAccountSettingsWatch: (() => void) | null = null;

function cacheKey(projectRoot: string | null | undefined, pin: OpenProjectBinding | null | undefined): string {
  const root = projectRoot?.trim() || pin?.rootPath?.trim() || "__no_project__";
  return pin?.key ? `${root}::pin:${pin.key}` : root;
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Re-read every cached machine when the account's settings change. */
function refreshAllCached(): void {
  for (const entry of cache.values()) {
    if (entry.args) void getNewLaneDefaultsCached({ ...entry.args, force: true });
  }
}

function addListener(listener: () => void): () => void {
  listeners.add(listener);
  if (!stopAccountSettingsWatch) {
    const onChanged = window.ade?.accountSettings?.onChanged;
    if (typeof onChanged === "function") stopAccountSettingsWatch = onChanged(refreshAllCached);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && stopAccountSettingsWatch) {
      stopAccountSettingsWatch();
      stopAccountSettingsWatch = null;
    }
  };
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
  const readArgs: ReadArgs = { projectRoot: args.projectRoot, pin: args.pin };
  const read = window.ade?.lanes?.getNewLaneDefaults;
  if (typeof read !== "function") {
    cache.set(key, { failed: true, args: readArgs });
    notify();
    return Promise.resolve(null);
  }
  const promise: Promise<NewLaneDefaultsSnapshot | null> = (args.pin ? read(args.pin) : read())
    .then((value) => {
      // A save or a newer read landed while this one was in flight; it wins.
      if (cache.get(key)?.promise !== promise) return cache.get(key)?.value ?? value;
      cache.set(key, { value, args: readArgs });
      notify();
      return value;
    })
    .catch((error) => {
      console.warn("new_lane_defaults.read_failed", { pinned: Boolean(args.pin), error });
      const current = cache.get(key);
      if (current?.promise === promise) cache.set(key, { value: current.value, failed: current.value === undefined, args: readArgs });
      notify();
      return current?.value ?? null;
    });
  cache.set(key, { ...existing, promise, args: readArgs });
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
  /** Only the fields that change; the brain keeps the rest. */
  defaults: Partial<NewLaneDefaults>;
}): Promise<NewLaneDefaultsSnapshot> {
  const value = args.pin
    ? await window.ade.lanes.setNewLaneDefaults({ defaults: args.defaults }, args.pin)
    : await window.ade.lanes.setNewLaneDefaults({ defaults: args.defaults });
  cache.set(cacheKey(args.projectRoot, args.pin), { value, args: { projectRoot: args.projectRoot, pin: args.pin } });
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
    const stop = addListener(sync);
    sync();
    void getNewLaneDefaultsCached(args);
    return stop;
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
