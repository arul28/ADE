import { useEffect, useRef, useState } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { AndroidLaneDeviceStatus } from "../../../shared/types/androidEmulator";
import { logRendererDebugEvent } from "../../lib/debugLog";
import { androidLaneDeviceName } from "./androidDeviceState";

/**
 * The tools grid card's one fact about the Android tool: which emulator this
 * lane holds, and whether it is up. The Apple card's twin
 * (`useAppleLaneDeviceCard`).
 *
 * One status read when the card can show, then one again after each Android
 * event for the lane (a start, a stop, an attach or release from the pane,
 * the CLI or an agent). No poll: the brain emits on every lifecycle change,
 * and the hosted web client turns its own status poll into the same events.
 */

/** Events come in bursts (starting, then booted); one read after the burst. */
const EVENT_READ_DELAY_MS = 400;

export type AndroidLaneDeviceCard = {
  /** The lane this reading belongs to. */
  laneId: string;
  name: string;
  state: Exclude<AndroidLaneDeviceStatus["state"], "none">;
  /** The AVD folder name, for the card menu. */
  avdName: string;
  /** `created` = ADE made it for this lane (Delete removes it); `attached` = the user's own AVD. */
  origin: "created" | "attached";
};

export function useAndroidLaneDeviceCard(args: {
  laneId: string | null;
  runtimePin: OpenProjectBinding | null;
  enabled: boolean;
  /** Bump to read again now: the card menu's refresh after it acts (the web client may get no event). */
  refreshKey?: unknown;
}): AndroidLaneDeviceCard | null {
  const { laneId, runtimePin, enabled, refreshKey } = args;
  const [card, setCard] = useState<AndroidLaneDeviceCard | null>(null);
  const pinRef = useRef(runtimePin);
  pinRef.current = runtimePin;
  const pinKey = runtimePin?.key ?? null;

  useEffect(() => {
    if (!enabled || !laneId) {
      setCard(null);
      return undefined;
    }
    const api = window.ade?.androidEmulator;
    if (!api?.getStatus) {
      setCard(null);
      return undefined;
    }
    let cancelled = false;
    let timer: number | null = null;
    const read = async () => {
      let status: Awaited<ReturnType<typeof api.getStatus>>;
      try {
        status = await api.getStatus({ laneId }, pinRef.current);
      } catch (cause: unknown) {
        // A failed read is not "no device": the card keeps what it last read.
        logRendererDebugEvent("android.card_status_failed", { error: cause instanceof Error ? cause.message : String(cause) });
        return;
      }
      if (cancelled) return;
      const lane = status.lane;
      setCard(lane?.device && lane.state !== "none"
        ? { laneId, name: androidLaneDeviceName(lane), state: lane.state, avdName: lane.device.avdName, origin: lane.device.origin }
        : null);
    };
    void read();
    const unsubscribe = api.onEvent?.((event) => {
      const forLane = (event.type === "android.device.state" && event.laneId === laneId) || event.type === "android.inventory.changed";
      if (!forLane) return;
      // The event's own state moves the card at once, ahead of the read.
      if (event.type === "android.device.state" && event.state !== "none") {
        const state = event.state;
        setCard((current) => (current && current.laneId === laneId && current.state !== state ? { ...current, state } : current));
      }
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void read();
      }, EVENT_READ_DELAY_MS);
    }, pinRef.current);
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
      unsubscribe?.();
    };
    // Keyed on the machine, not the pin object.
  }, [enabled, laneId, pinKey, refreshKey]);

  return androidLaneDeviceForLane(card, laneId);
}

/** Only the reading FOR this lane: a menu on the last lane's reading would act on the wrong lane's device. */
export function androidLaneDeviceForLane(
  card: AndroidLaneDeviceCard | null,
  laneId: string | null,
): AndroidLaneDeviceCard | null {
  return card && laneId && card.laneId === laneId ? card : null;
}
