import { useEffect, useMemo, useRef, useState } from "react";
import type { OpenProjectBinding } from "../../shared/types";
import type { MachineStats } from "../../shared/types/machineStats";
import { useAppStore } from "./appStore";

/**
 * Machine load and capabilities (`machine_stats.get`), read through each
 * machine's pin. Read when a surface that shows or weighs them opens (Settings
 * › Machines, a machine picker), never on a timer. Answers are shared for 5 s
 * across every surface, as the brain caches its own.
 *
 * The brain answers its slow readings (CLIs, Xcode) in the background; while
 * the first is still running (`slowAt` null) a surface reads once more a few
 * seconds later, and that is the only follow-up.
 */

const TTL_MS = 5_000;
/** Past the brain's own 5 s answer cache, so the follow-up gets a new answer. */
const SLOW_FOLLOW_UP_MS = 6_000;

type Entry = { at: number; value: Promise<MachineStats | null> };
const cache = new Map<string, Entry>();

/**
 * A pin's key, or for the unpinned path the tab's own binding: unpinned calls
 * reach whichever machine the tab is bound to, so two tabs (or one tab after
 * a rebind) must not share an answer.
 */
function cacheKey(pin: OpenProjectBinding | null, tabKey: string | null): string {
  return pin?.key ?? `tab:${tabKey ?? ""}`;
}

/** One machine's stats; null when it cannot answer (an older ADE, no runtime, a failed call). */
export function readMachineStats(
  pin: OpenProjectBinding | null,
  options?: { fresh?: boolean; tabKey?: string | null },
): Promise<MachineStats | null> {
  const key = cacheKey(pin, options?.tabKey ?? null);
  const hit = cache.get(key);
  if (!options?.fresh && hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const api = typeof window === "undefined" ? undefined : window.ade?.machineStats;
  const value = typeof api?.get === "function"
    ? Promise.resolve().then(() => api.get(pin)).catch(() => null)
    : Promise.resolve(null);
  cache.set(key, { at: Date.now(), value });
  return value;
}

export type MachineStatsRequest = {
  id: string;
  /** Null reaches the tab's own machine (the unpinned path). */
  pin: OpenProjectBinding | null;
};

/**
 * Stats for several machines at once, by id: `undefined` while reading,
 * `null` when that machine could not answer. Keyed on the pins' keys, so a
 * rebuilt pin for the same machine does not read again.
 */
export function useMachineStatsMap(
  requests: readonly MachineStatsRequest[],
  active: boolean,
): { stats: ReadonlyMap<string, MachineStats | null>; refresh: () => void } {
  const [stats, setStats] = useState<ReadonlyMap<string, MachineStats | null>>(() => new Map());
  const [epoch, setEpoch] = useState(0);
  const tabKey = useAppStore((state) => state.projectBinding?.key ?? state.project?.rootPath ?? null);
  const requestsRef = useRef(requests);
  requestsRef.current = requests;
  const tabKeyRef = useRef(tabKey);
  tabKeyRef.current = tabKey;
  const signature = requests.map((request) => `${request.id}=${cacheKey(request.pin, tabKey)}`).join("|");
  const freshRef = useRef(false);

  useEffect(() => {
    if (!active || signature === "") return undefined;
    let cancelled = false;
    let followUp: ReturnType<typeof setTimeout> | null = null;
    const fresh = freshRef.current;
    freshRef.current = false;
    const readAll = (forceFresh: boolean) => {
      const current = requestsRef.current;
      return Promise.all(current.map(async (request) => [request.id, await readMachineStats(request.pin, { fresh: forceFresh, tabKey: tabKeyRef.current })] as const))
        .then((rows) => {
          if (cancelled) return rows;
          setStats(new Map(rows));
          return rows;
        });
    };
    void readAll(fresh).then((rows) => {
      if (cancelled || !rows.some(([, value]) => value && value.slowAt == null)) return;
      followUp = setTimeout(() => {
        void readAll(true);
      }, SLOW_FOLLOW_UP_MS);
    });
    return () => {
      cancelled = true;
      if (followUp) clearTimeout(followUp);
    };
  }, [active, signature, epoch]);

  return useMemo(() => ({
    stats,
    refresh: () => {
      freshRef.current = true;
      setEpoch((value) => value + 1);
    },
  }), [stats]);
}
