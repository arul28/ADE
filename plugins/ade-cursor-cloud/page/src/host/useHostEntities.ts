/**
 * The two live signals a fleet needs, and neither is a timer.
 *
 * The compiled modal was explicit about this: *"There is deliberately no timer
 * here — freshness comes from the relay or from the user's hand."* A webhook
 * from Cursor woke `onCursorCloudFleetEvent`, and the modal did one soft
 * refresh. That rule is kept exactly, with the two channels a guest has instead:
 *
 * 1. `events.on("changed")` — the plugin's own rows moved. The child writes the
 *    `fleet` collection when a relay delivery lands, so this IS the relay wake,
 *    arriving through the bridge rather than through a renderer event bus.
 * 2. `host.subscribe({kinds})` — an ADE lane or chat moved. An agent's
 *    ownership chip and its lane section come from those, so a lane renamed or
 *    a chat closed changes what this page draws even though no agent did
 *    anything.
 *
 * Both are coalesced by the host at 120 ms, and both are only worth honouring
 * while the reader is looking: a hidden placement that refetched on every frame
 * would be the polling loop the compiled modal refused to have.
 */

import { useEffect, useRef } from "react";

import { bridge, type PluginWebviewHostKind } from "../bridge";

/**
 * Refetch when the plugin's own rows move.
 *
 * `collection` narrows it. Without that the settings write that stores a
 * filter — `ui-state`, written by this very page — would come back as a change
 * frame and refetch the fleet, once per keystroke in the worst case.
 */
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

/**
 * Refetch when one of ADE's own entity families moves.
 *
 * A frame carrying `overflow` means more ids moved than it could name, so the
 * whole page is refetched rather than patched — the same rule the bridge
 * documents. This page never patches by id anyway: the child assembles and
 * groups the fleet, so a partial update would have to re-run its grouping here
 * and could disagree with it.
 */
export function useHostEntities(kinds: PluginWebviewHostKind[], onChange: () => void): void {
  const handler = useRef(onChange);
  handler.current = onChange;
  // Joined so the effect keys on the VALUE rather than on the array identity a
  // caller re-creates each render.
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
        if (wanted.includes(frame.kind)) handler.current();
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
        // A host that cannot follow entities still draws the page it fetched,
        // and the reader's own pull-to-refresh still works.
      });

    return () => {
      stopped = true;
      unsubscribeEvent?.();
      unsubscribeHost?.();
    };
  }, [key]);
}

/**
 * Whether this placement is on screen.
 *
 * The compiled modal checked `document.visibilityState !== "visible"` before
 * acting on a relay event, and a guest keeps that check for the same reason:
 * a background webview answering every wake is work nobody asked for and nobody
 * can see. Written as a subscription rather than a read so a page that was
 * hidden when the event arrived can catch up the moment it is shown again.
 */
export function useVisible(onVisible: () => void): void {
  const handler = useRef(onVisible);
  handler.current = onVisible;
  useEffect(() => {
    if (typeof document === "undefined") return;
    const listener = () => {
      if (document.visibilityState === "visible") handler.current();
    };
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  }, []);
}
