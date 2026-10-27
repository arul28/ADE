import { useEffect, useMemo, useRef, useState } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { MacDesktopWebApi } from "../../webclient/adapter/macDesktop";
import type { H264StreamSource } from "./h264StreamPlayer";
import {
  createMacDesktopStreamSource,
  randomMacDesktopSubscriptionId,
} from "./macDesktopWebStream";

/**
 * The lane display's live subscription on the hosted web client.
 *
 * Both web panes need the same plumbing — one subscription per re-dial, none
 * while the tab is hidden or the socket is down, a fresh id whenever either
 * comes back — and only their recovery policy differs, so the policy stays
 * with each pane and this owns the transport side once.
 *
 * A subscription belongs to one socket and one visible tab: a hidden tab drops
 * it (nobody is looking, and the host would keep encoding for it), and a
 * socket that closes takes it along, so both ask again when they return.
 */
export function useMacDesktopStreamSubscription(args: {
  /** The web `macDesktop` namespace, as the pane read it. */
  api: Partial<MacDesktopWebApi> | null;
  laneId: string | null;
  /** The lane's machine: every call and listener carries it. */
  runtimePin: OpenProjectBinding | null;
  /** The pane is on screen and the host can stream. Nothing subscribes otherwise. */
  enabled: boolean;
  /** A re-dial counter: every change retires the current subscription. */
  nonce: number;
}): {
  pageVisible: boolean;
  connected: boolean;
  subscriptionId: string | null;
  source: H264StreamSource | null;
} {
  const { api, laneId, runtimePin, enabled, nonce } = args;
  const pinRef = useRef(runtimePin);
  pinRef.current = runtimePin;
  const pinKey = runtimePin?.key ?? null;

  const [pageVisible, setPageVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  const [connected, setConnected] = useState(true);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const onVisibilityChange = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    if (!enabled || !api?.onConnectionChange) return undefined;
    return api.onConnectionChange((next) => setConnected(next), pinRef.current ?? undefined);
  }, [api, enabled, pinKey]);

  const subscriptionId = useMemo(
    () => (laneId ? randomMacDesktopSubscriptionId(laneId) : null),
    // Every re-dial, reconnect and visible-again is a new subscription; the old
    // one was released by our own unsubscribe or by the host with the socket.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [laneId, nonce, pageVisible, connected],
  );

  const wanted = enabled && pageVisible && connected;
  const source = useMemo<H264StreamSource | null>(() => {
    if (!api || !wanted || !laneId || !subscriptionId) return null;
    return createMacDesktopStreamSource({
      api,
      laneId,
      subscriptionId,
      viewerLabel: "ADE Web",
      runtimePin: pinRef.current,
    });
  }, [api, laneId, pinKey, subscriptionId, wanted]);

  return { pageVisible, connected, subscriptionId, source };
}
