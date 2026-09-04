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
 * an older desktop over a gesture that desktop has no way to make.
 */

import { useEffect, useRef } from "react";

import { bridge } from "../bridge";

export function onHostRefresh(listener: () => void): () => void {
  const api = bridge();
  if (!api) return () => {};
  try {
    return api.events.on("refresh", listener);
  } catch {
    return () => {};
  }
}

export function useHostRefresh(listener: () => void): void {
  const held = useRef(listener);
  held.current = listener;
  useEffect(() => onHostRefresh(() => held.current()), []);
}
