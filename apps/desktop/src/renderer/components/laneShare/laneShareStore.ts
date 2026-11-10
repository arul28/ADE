import { useEffect, useMemo } from "react";
import { create } from "zustand";
import type { OpenProjectBinding } from "../../../shared/types";
import type { LaneShareGivenEntry } from "../../../shared/types/laneShare";
import { useAppStore, useRootAppStore } from "../../state/appStore";
import { laneShareProblem, type LaneShareProblem } from "./laneShareModel";
import { logRendererDebugEvent } from "../../lib/debugLog";

/**
 * The owner's share list, read once per machine runtime and kept fresh from
 * that runtime's `lane_share_event` stream. Lane marks, the lane menu, the
 * share sheet and the chat's share line all read this one cache, so a lane
 * with no share costs no extra call.
 *
 * The cache key is the pin's key, or the tab's binding key for unpinned
 * calls. A pin is the lane's machine; null is the machine the tab is bound to.
 * An unpinned call goes to the ACTIVE tab's machine, so an unpinned list
 * loads only while its tab is the active one (a parked tab waits).
 */

export type LaneShareListEntry = {
  status: "loading" | "ready" | "error";
  shares: LaneShareGivenEntry[];
  problem: LaneShareProblem | null;
};

/** What the sheet host opens. */
export type LaneShareSheetRequest = {
  /** The opener's list key (`useLaneShareList().key`): the sheet reads the same cache. */
  listKey: string | null;
  laneId: string;
  laneName: string;
  pin: OpenProjectBinding | null;
  /** Shown when the lane's machine is not the tab's. */
  machineName: string | null;
  /** Open on this guest; omitted opens the invite form. */
  grantId?: string | null;
};

type LaneShareStoreState = {
  lists: Record<string, LaneShareListEntry>;
  sheet: LaneShareSheetRequest | null;
  /**
   * Grants closed on their machine whose directory revoke failed this
   * session: "removed here, the directory will follow". A second revoke
   * finishes it.
   */
  revokePending: Record<string, true>;
};

export const useLaneShareStore = create<LaneShareStoreState>(() => ({ lists: {}, sheet: null, revokePending: {} }));

const EMPTY: LaneShareGivenEntry[] = [];
const inFlight = new Map<string, Promise<void>>();
const retained = new Map<string, { count: number; release: () => void }>();
const reloadTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; dueAt: number }>();
/** A share changed: read soon, so a burst of events costs one read. */
const CHANGE_RELOAD_MS = 400;
/**
 * A guest device came or went: the list is read for its "here now" count
 * only, so presence waits longer and a guest that reconnects in a loop costs
 * one directory read per window, not one per event.
 */
const PRESENCE_RELOAD_MS = 5_000;

/** The cache key for a pin; null when there is no machine to ask (no pin, no bound tab). */
export function laneShareListKey(pin: OpenProjectBinding | null | undefined, boundKey: string | null | undefined): string | null {
  return pin?.key ?? boundKey ?? null;
}

function setEntry(key: string, entry: LaneShareListEntry): void {
  useLaneShareStore.setState((state) => ({ lists: { ...state.lists, [key]: entry } }));
}

/** Reads the list again. Concurrent calls for one key share one request. */
export function loadLaneShares(key: string, pin: OpenProjectBinding | null): Promise<void> {
  const running = inFlight.get(key);
  if (running) return running;
  const previous = useLaneShareStore.getState().lists[key];
  if (!previous) setEntry(key, { status: "loading", shares: EMPTY, problem: null });
  const request = (async () => {
    try {
      const result = await window.ade.laneShare.list({}, pin);
      setEntry(key, { status: "ready", shares: Array.isArray(result?.shares) ? result.shares : EMPTY, problem: null });
    } catch (error) {
      setEntry(key, { status: "error", shares: previous?.shares ?? EMPTY, problem: laneShareProblem(error, { pin }) });
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, request);
  return request;
}

/** A reload after an event; an earlier one already scheduled covers it. */
function scheduleReload(key: string, pin: OpenProjectBinding | null, delayMs: number): void {
  const dueAt = Date.now() + delayMs;
  const pending = reloadTimers.get(key);
  if (pending && pending.dueAt <= dueAt) return;
  if (pending) clearTimeout(pending.timer);
  reloadTimers.set(key, {
    dueAt,
    timer: setTimeout(() => {
      reloadTimers.delete(key);
      void loadLaneShares(key, pin);
    }, delayMs),
  });
}

/**
 * Keeps one key's list loaded and listening while something shows it. The
 * first holder loads it and subscribes to that runtime's events; the last
 * release unsubscribes (the data stays for the next holder).
 */
function retainLaneShares(key: string, pin: OpenProjectBinding | null): () => void {
  const existing = retained.get(key);
  if (existing) {
    existing.count += 1;
  } else {
    // An unpinned subscription follows the active tab's runtime, like the call.
    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe = window.ade?.laneShare?.onEvent((event) => {
        if (event.type === "lane_share_changed") scheduleReload(key, pin, CHANGE_RELOAD_MS);
        else if (event.type === "lane_share_presence_changed") scheduleReload(key, pin, PRESENCE_RELOAD_MS);
      }, pin) ?? null;
    } catch (error) {
      // No event stream (an older runtime): the list is read on mount and on actions only.
      logRendererDebugEvent("lane_share.owner_events_unavailable", { error: error instanceof Error ? error.message : String(error) });
      unsubscribe = null;
    }
    retained.set(key, { count: 1, release: () => unsubscribe?.() });
    if (!useLaneShareStore.getState().lists[key]) void loadLaneShares(key, pin);
  }
  return () => {
    const holder = retained.get(key);
    if (!holder) return;
    holder.count -= 1;
    if (holder.count > 0) return;
    retained.delete(key);
    holder.release();
  };
}

/**
 * The share list of the lane's machine. `pin` is the lane's machine, or null
 * for the tab's own. The effect is keyed on the pin's key, never the object.
 */
export function useLaneShareList(
  pin: OpenProjectBinding | null | undefined,
  options: { listKey?: string | null; enabled?: boolean } = {},
): {
  key: string | null;
  entry: LaneShareListEntry | null;
  reload: () => Promise<void>;
} {
  const boundKey = useAppStore((s) => s.projectBinding?.key ?? null);
  const activeKey = useRootAppStore((s) => s.projectBinding?.key ?? null);
  const key = options.listKey ?? laneShareListKey(pin, boundKey);
  const entry = useLaneShareStore((s) => (key ? s.lists[key] ?? null : null));
  const pinKey = pin?.key ?? null;
  // Unpinned: only while this tab's machine is the one an unpinned call reaches.
  const reachable = options.enabled !== false && Boolean(key) && (pinKey != null || key === activeKey);
  useEffect(() => {
    if (!key || !reachable) return;
    return retainLaneShares(key, pin ?? null);
    // `pin` is read through its key: a rebuilt pin with the same key must not resubscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, pinKey, reachable]);
  const reload = useMemo(() => async () => {
    if (key && reachable) await loadLaneShares(key, pin ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, pinKey, reachable]);
  return { key, entry, reload };
}

/** Reload one list now (after this window changed a share). */
export function reloadLaneShares(key: string | null, pin: OpenProjectBinding | null | undefined): Promise<void> {
  return key ? loadLaneShares(key, pin ?? null) : Promise.resolve();
}

export function markLaneShareRevokePending(grantId: string, pending: boolean): void {
  useLaneShareStore.setState((state) => {
    const next = { ...state.revokePending };
    if (pending) next[grantId] = true;
    else delete next[grantId];
    return { revokePending: next };
  });
}

export function openLaneShareSheet(request: LaneShareSheetRequest): void {
  useLaneShareStore.setState({ sheet: request });
}

export function closeLaneShareSheet(): void {
  useLaneShareStore.setState({ sheet: null });
}
