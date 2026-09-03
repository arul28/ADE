/**
 * The lanes list, and the live signal that it moved.
 *
 * The compiled quick view read `useAppStore(s => s.lanes)` and re-rendered when
 * the store changed. A guest has no store, so the same two facts arrive
 * separately: the list comes from a plugin action, and the "something moved"
 * comes from `host.subscribe`, coalesced by the host at 120 ms.
 *
 * A frame carrying `overflow` means more ids moved than it could name, so the
 * whole family is refetched rather than patched — the same rule the bridge
 * documents.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { bridge } from "../bridge";
import { getLanes } from "./actions";
import type { PageLane } from "../types";

export type HostLanesState = {
  lanes: PageLane[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

export function useHostLanes(enabled = true): HostLanesState {
  const [lanes, setLanes] = useState<PageLane[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const inFlightRef = useRef(false);
  const againRef = useRef(false);

  /**
   * One read at a time, and one more after it if anything asked while it ran.
   *
   * `pageLanes` is not a cheap call: the child lists the lanes and then asks the
   * host which Linear issues each lane's SESSIONS carry, which is one read per
   * lane. The host already coalesces entity changes at 120 ms, but a rebase or a
   * PR poll sends several of those frames back to back, and answering each one
   * with a fresh fan-out is how a quiet background change becomes a burst of
   * reads. So a refresh that arrives while one is in flight sets a flag instead,
   * and exactly one follow-up runs when the first lands — the reader still ends
   * on the current answer, and the machine does the work once.
   */
  const run = useCallback(() => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    inFlightRef.current = true;
    setLoading(true);
    void getLanes()
      .then((rows) => {
        if (requestRef.current !== requestId) return;
        setLanes(Array.isArray(rows) ? rows : []);
        setError(null);
      })
      .catch((err: unknown) => {
        if (requestRef.current !== requestId) return;
        setError(err instanceof Error ? err.message : "Unable to read the lanes.");
      })
      .finally(() => {
        inFlightRef.current = false;
        if (requestRef.current === requestId) setLoading(false);
        if (againRef.current) {
          againRef.current = false;
          run();
        }
      });
  }, []);

  const refresh = useCallback(() => {
    if (!enabled) return;
    if (inFlightRef.current) {
      againRef.current = true;
      return;
    }
    run();
  }, [enabled, run]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!enabled) return;
    const api = bridge();
    if (!api?.host) return;
    let stopped = false;
    let unsubscribeEvent: (() => void) | null = null;
    let unsubscribeHost: (() => void) | null = null;

    try {
      unsubscribeEvent = api.events.on("host", (frame) => {
        if (frame.kind === "lane" || frame.kind === "session") refresh();
      });
    } catch {
      unsubscribeEvent = null;
    }

    void api.host
      .subscribe({ kinds: ["lane", "session"] })
      .then((stop) => {
        if (stopped) {
          stop();
          return;
        }
        unsubscribeHost = stop;
      })
      .catch(() => {
        // A host that cannot follow entities still draws the list it fetched.
      });

    return () => {
      stopped = true;
      unsubscribeEvent?.();
      unsubscribeHost?.();
    };
  }, [enabled, refresh]);

  return { lanes, loading, error, refresh };
}

/** Refetch whenever the plugin's own rows move. */
export function useCollectionChanges(onChange: () => void, collection?: string): void {
  const handler = useRef(onChange);
  handler.current = onChange;
  useEffect(() => {
    const api = bridge();
    if (!api) return;
    try {
      return api.events.on("changed", (event) => {
        if (collection && event.collection && event.collection !== collection) return;
        handler.current();
      });
    } catch {
      return;
    }
  }, [collection]);
}
