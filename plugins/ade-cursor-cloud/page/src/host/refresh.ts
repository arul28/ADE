/**
 * Pull to refresh.
 *
 * On a phone the reader drags the page down and the host emits `refresh`. It
 * carries nothing — it is a gesture, not a data frame — and the only correct
 * answer is to re-read whatever this surface reads.
 *
 * The name is being added to the bridge in parallel with this page, so every
 * subscription here is wrapped: a host that has never heard of `refresh` may
 * throw from `events.on`, and a page that let that throw would fail to mount on
 * an older desktop over a gesture that desktop has no way to make. The
 * unsubscribe is then a no-op, which is the honest answer — nothing was
 * subscribed.
 */

import { useEffect, useRef } from "react";

import { bridge } from "../bridge";

/** Subscribe to the reader's pull-down. Returns the unsubscribe, always. */
export function onHostRefresh(listener: () => void): () => void {
  const api = bridge();
  if (!api) return () => {};
  try {
    return api.events.on("refresh", listener);
  } catch {
    return () => {};
  }
}

/**
 * The same thing as a hook, with the listener held in a ref.
 *
 * Every surface re-reads on `refresh`, and the callback each one passes closes
 * over state that changes on every keystroke. Subscribing to the host again for
 * each of those would churn a listener the host is coalescing behind a native
 * gesture recogniser, so the subscription is made once and the ref is what
 * moves.
 */
export function useHostRefresh(listener: () => void): void {
  const held = useRef(listener);
  held.current = listener;
  useEffect(() => onHostRefresh(() => held.current()), []);
}
