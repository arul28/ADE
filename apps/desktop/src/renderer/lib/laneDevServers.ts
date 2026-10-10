import { useEffect, useState } from "react";
import type { DevServerRecord, OpenProjectBinding } from "../../shared/types";
import { pinKey } from "../state/pinKey";

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
    if (entry.servers.length > 0) scheduleRefresh(key, entry.pin, entry.laneId);
  }
}

/** Start or stop the background re-check to match whether anything is lit. */
function syncRecheck(): void {
  const anyLit = [...entries.values()].some((entry) => entry.servers.length > 0);
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
  return left.every((server, index) => server.port === right[index]!.port && server.url === right[index]!.url);
}

function load(key: string, pin: OpenProjectBinding | null, laneId: string): void {
  const entry = entries.get(key);
  const list = window.ade?.workTools?.listDevServers;
  if (!entry || !list) return;
  if (entry.loading) {
    entry.stale = true;
    return;
  }
  entry.stale = false;
  entry.loading = Promise.resolve(list({ laneId }, pin))
    .then((result) => {
      const next = Array.isArray(result?.servers)
        ? result.servers.filter((server) => !server.source.laneId || server.source.laneId === laneId)
        : EMPTY;
      if (sameServers(entry.servers, next)) return;
      entry.servers = next;
      for (const listener of [...entry.listeners]) listener(next);
      syncRecheck();
    })
    .catch(() => {
      // An unreachable machine or an older runtime: keep what we had.
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
          if (laneId && entryLane !== laneId) continue;
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
    current.listeners.add(setServers);
    setServers(current.servers);
    const releaseMachine = retainMachine(runtimePin);
    if (needsLoad) load(key, runtimePin, laneId);
    return () => {
      current.listeners.delete(setServers);
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
    // `machine` stands for `runtimePin`: a new object for the same machine must not resubscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, laneId, machine]);
  return servers;
}
