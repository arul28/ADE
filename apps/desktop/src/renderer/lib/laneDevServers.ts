import { useEffect, useState } from "react";
import type { DevServerRecord, OpenProjectBinding } from "../../shared/types";
import { pinKey } from "../state/pinKey";
import { isUnsupportedAdeActionError } from "../../shared/codedError";

/**
 * The dev servers a lane is running, as seen from any machine.
 *
 * The list lives on the runtime that runs the lane (see
 * `work_tools.listDevServers`), so a MacBook showing a Mac Studio lane asks the
 * Studio. Several surfaces want the same answer at once: the Work header, the
 * tools-pane status, every chat tile in a grid. They share one entry per
 * (machine, lane): one read when the first one mounts, one event
 * subscription per machine, and one re-read when that machine says a server
 * started or stopped.
 */

type Entry = {
  pin: OpenProjectBinding | null;
  laneId: string;
  servers: DevServerRecord[];
  listeners: Set<(servers: DevServerRecord[]) => void>;
  loading: Promise<void> | null;
  stale: boolean;
  /** The last read failed (not "unsupported"): re-read on the next re-check. */
  failed?: boolean;
};

type MachineSubscription = {
  refCount: number;
  dispose: () => void;
};

const EMPTY: DevServerRecord[] = [];
/** Burst of events (a server printing two URLs, a scan finding three) → one read. */
const REFRESH_DEBOUNCE_MS = 250;
/**
 * A stopped server sends nothing, so while one is shown the list is checked
 * again now and then, and whenever the window comes back to the front. With
 * nothing shown nothing is checked: a server starting is announced.
 */
const LIT_RECHECK_MS = 60_000;
/** How long a lane's list outlives its last viewer. */
const IDLE_ENTRY_TTL_MS = 30_000;

const entries = new Map<string, Entry>();
const machines = new Map<string, MachineSubscription>();
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
let recheckTimer: ReturnType<typeof setInterval> | null = null;
let stopWindowListeners: (() => void) | null = null;

function recheckLitEntries(): void {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  for (const [key, entry] of entries) {
    if (entry.servers.length > 0 || entry.failed) scheduleRefresh(key, entry.pin, entry.laneId);
  }
}

/** Start or stop the background re-check to match whether anything is lit. */
function syncRecheck(): void {
  const anyLit = [...entries.values()].some((entry) => entry.servers.length > 0 || entry.failed);
  if (anyLit && !recheckTimer) {
    recheckTimer = setInterval(recheckLitEntries, LIT_RECHECK_MS);
  } else if (!anyLit && recheckTimer) {
    clearInterval(recheckTimer);
    recheckTimer = null;
  }
  if (entries.size > 0 && !stopWindowListeners && typeof window !== "undefined") {
    const onFront = () => recheckLitEntries();
    window.addEventListener("focus", onFront);
    document.addEventListener("visibilitychange", onFront);
    stopWindowListeners = () => {
      window.removeEventListener("focus", onFront);
      document.removeEventListener("visibilitychange", onFront);
    };
  } else if (entries.size === 0 && stopWindowListeners) {
    stopWindowListeners();
    stopWindowListeners = null;
  }
}

function entryKey(pin: OpenProjectBinding | null, laneId: string): string {
  return `${pinKey(pin)}|${laneId}`;
}

function sameServers(left: DevServerRecord[], right: DevServerRecord[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((server, index) =>
    server.port === right[index]!.port
    && server.url === right[index]!.url
    // A server gaining its chat (the listener scan read the chat from its env) is a change.
    && server.source.sessionId === right[index]!.source.sessionId);
}

/** Entry lane id for "every lane on the machine". Not a valid lane id. */
const ALL_LANES = "*";

function load(key: string, pin: OpenProjectBinding | null, laneId: string): void {
  const entry = entries.get(key);
  const list = window.ade?.workTools?.listDevServers;
  if (!entry || !list) return;
  if (entry.loading) {
    entry.stale = true;
    return;
  }
  entry.stale = false;
  // `ALL_LANES` is one entry for every lane of the machine (the chat rows).
  entry.loading = Promise.resolve(list(laneId === ALL_LANES ? {} : { laneId }, pin))
    .then((result) => {
      const next = Array.isArray(result?.servers)
        ? result.servers.filter((server) =>
          laneId === ALL_LANES || !server.source.laneId || server.source.laneId === laneId)
        : EMPTY;
      if (entry.failed) {
        entry.failed = false;
        syncRecheck();
      }
      if (sameServers(entry.servers, next)) return;
      entry.servers = next;
      for (const listener of [...entry.listeners]) listener(next);
      syncRecheck();
    })
    .catch((error: unknown) => {
      // Keep what we had. An older runtime has no list to give; anything else
      // (an unreachable machine) is read again on the next re-check, so a row
      // does not stay blank after one failed read.
      const failed = !isUnsupportedAdeActionError(error);
      if (failed && !entry.failed) console.warn("[laneDevServers] list failed", { laneId, error });
      entry.failed = failed;
      syncRecheck();
    })
    .finally(() => {
      entry.loading = null;
      if (entry.stale && entries.get(key) === entry) load(key, pin, laneId);
    });
}

function scheduleRefresh(key: string, pin: OpenProjectBinding | null, laneId: string): void {
  const existing = refreshTimers.get(key);
  if (existing) clearTimeout(existing);
  refreshTimers.set(key, setTimeout(() => {
    refreshTimers.delete(key);
    load(key, pin, laneId);
  }, REFRESH_DEBOUNCE_MS));
}

function retainMachine(pin: OpenProjectBinding | null): () => void {
  const key = pinKey(pin);
  const existing = machines.get(key);
  if (existing) {
    existing.refCount += 1;
  } else {
    const subscribe = window.ade?.workTools?.onDevServer;
    const dispose = subscribe
      ? subscribe((event) => {
        const laneId = event.server.source.laneId;
        const prefix = `${key}|`;
        for (const entryKeyValue of entries.keys()) {
          if (!entryKeyValue.startsWith(prefix)) continue;
          const entryLane = entryKeyValue.slice(prefix.length);
          if (laneId && entryLane !== ALL_LANES && entryLane !== laneId) continue;
          scheduleRefresh(entryKeyValue, pin, entryLane);
        }
      }, pin)
      : () => {};
    machines.set(key, { refCount: 1, dispose });
  }
  return () => {
    const current = machines.get(key);
    if (!current) return;
    current.refCount -= 1;
    if (current.refCount > 0) return;
    machines.delete(key);
    current.dispose();
  };
}

/**
 * The lane's running dev servers, newest first. Empty while loading, for no
 * lane, and on surfaces with no runtime to ask (the web client).
 */
/** Join (or create) the shared entry for one (machine, lane) and listen to it. */
function retainEntry(
  runtimePin: OpenProjectBinding | null,
  laneId: string,
  listener: (servers: DevServerRecord[]) => void,
): () => void {
  const key = entryKey(runtimePin, laneId);
  let entry = entries.get(key);
  // An idle cached entry missed events while nobody listened: read it again.
  const needsLoad = !entry || entry.listeners.size === 0;
  if (!entry) {
    entry = { pin: runtimePin, laneId, servers: EMPTY, listeners: new Set(), loading: null, stale: false };
    entries.set(key, entry);
    syncRecheck();
  }
  const current = entry;
  current.listeners.add(listener);
  listener(current.servers);
  const releaseMachine = retainMachine(runtimePin);
  if (needsLoad) load(key, runtimePin, laneId);
  return () => {
    current.listeners.delete(listener);
    releaseMachine();
    if (current.listeners.size > 0) return;
    // Kept a while after the last viewer leaves, so flipping between chats
    // does not re-ask the lane's machine every time.
    setTimeout(() => {
      if (current.listeners.size > 0 || entries.get(key) !== current) return;
      entries.delete(key);
      const timer = refreshTimers.get(key);
      if (timer) clearTimeout(timer);
      refreshTimers.delete(key);
      syncRecheck();
    }, IDLE_ENTRY_TTL_MS);
  };
}

export function useLaneDevServers(
  laneId: string | null,
  runtimePin: OpenProjectBinding | null,
  enabled = true,
): DevServerRecord[] {
  const [servers, setServers] = useState<DevServerRecord[]>(EMPTY);
  const machine = pinKey(runtimePin);
  useEffect(() => {
    if (!enabled || !laneId) {
      setServers(EMPTY);
      return undefined;
    }
    return retainEntry(runtimePin, laneId, setServers);
    // `machine` stands for `runtimePin`: a new object for the same machine must not resubscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, laneId, machine]);
  return servers;
}

/**
 * The dev servers one chat (or terminal) started, for its row in the Work list.
 *
 * Every row on a machine shares ONE entry for that machine's whole list: one
 * read when the first row mounts, the same event subscription the lane views
 * use, and no timer of its own. Each row keeps only its own servers, and
 * re-renders only when those change.
 */
export function useSessionDevServers(
  sessionId: string | null,
  runtimePin: OpenProjectBinding | null,
  enabled = true,
): DevServerRecord[] {
  const [servers, setServers] = useState<DevServerRecord[]>(EMPTY);
  const machine = pinKey(runtimePin);
  useEffect(() => {
    if (!enabled || !sessionId) {
      setServers(EMPTY);
      return undefined;
    }
    let mine: DevServerRecord[] = EMPTY;
    setServers(EMPTY);
    return retainEntry(runtimePin, ALL_LANES, (all) => {
      const next = all.filter((server) => server.source.sessionId === sessionId);
      if (next.length === 0 && mine.length === 0) return;
      if (sameServers(mine, next)) return;
      mine = next.length === 0 ? EMPTY : next;
      setServers(mine);
    });
    // `machine` stands for `runtimePin`: a new object for the same machine must not resubscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, sessionId, machine]);
  return servers;
}

/**
 * After a Stop: read the machine's lists again now. The runtime publishes a
 * `removed` event too, but a desktop on a runtime that predates it would wait
 * for the next re-check.
 */
export function refreshDevServersForMachine(runtimePin: OpenProjectBinding | null): void {
  const prefix = `${pinKey(runtimePin)}|`;
  for (const [key, entry] of entries) {
    if (key.startsWith(prefix)) scheduleRefresh(key, entry.pin, entry.laneId);
  }
}
