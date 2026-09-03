/**
 * "Something moved" from inside a guest.
 *
 * The compiled pages read a store and re-rendered when it changed. A guest has
 * no store, so the same fact arrives in two halves: the DATA comes from a
 * plugin action, and the SIGNAL comes from `host.subscribe`, coalesced by the
 * host at 120 ms.
 *
 * A frame carrying `overflow` means more ids moved than it could name, so the
 * caller refetches the whole family rather than patching — the same rule the
 * bridge documents. This hook does not read `ids` at all: every caller here
 * refetches, because a lane row is cheap and a wrong row is not.
 */

import { useEffect, useRef } from "react";

import { bridge, type PluginWebviewHostKind } from "../bridge";

/**
 * Run `onChange` whenever the host says one of `kinds` moved.
 *
 * MISSING contract: the `operation` and `conflict` kinds are added by the
 * platform batch of this wave. A host that does not know a kind refuses the
 * whole `subscribe` call, so the kinds are subscribed in ONE request and the
 * failure path still leaves the page drawing what it fetched — it simply stops
 * updating on its own, which is what a refresh button is for.
 */
export function useHostSubscription(
  kinds: PluginWebviewHostKind[],
  onChange: (frame: { kind: PluginWebviewHostKind; ids: string[]; overflow: boolean }) => void,
): void {
  const handler = useRef(onChange);
  handler.current = onChange;
  const key = kinds.join(",");

  useEffect(() => {
    const api = bridge();
    if (!api?.host) return;
    const wanted = key.split(",").filter(Boolean) as PluginWebviewHostKind[];
    if (wanted.length === 0) return;

    let stopped = false;
    let unsubscribeEvent: (() => void) | null = null;
    let unsubscribeHost: (() => void) | null = null;

    try {
      unsubscribeEvent = api.events.on("host", (frame) => {
        if (!wanted.includes(frame.kind)) return;
        handler.current({ kind: frame.kind, ids: frame.ids ?? [], overflow: frame.overflow === true });
      });
    } catch {
      unsubscribeEvent = null;
    }

    void api.host
      .subscribe({ kinds: wanted })
      .then((stop) => {
        if (stopped) {
          stop();
          return;
        }
        unsubscribeHost = stop;
      })
      .catch(() => {
        // A host that cannot follow these kinds still draws what was fetched.
      });

    return () => {
      stopped = true;
      unsubscribeEvent?.();
      unsubscribeHost?.();
    };
  }, [key]);
}

/** Refetch whenever this plugin's own collection rows move. */
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
