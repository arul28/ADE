import { useEffect, useRef, useState } from "react";
import type { OpenProjectBinding } from "../../../shared/types";

/**
 * The tools grid card's one fact about the Apple tool: which device this lane
 * owns, and whether it is up.
 *
 * `deviceList` is the cheapest question in the Apple surface — it reads the
 * lanes DB row and one `simctl list`, not a helper round-trip — which is why
 * this polls it rather than `getStatus`. It polls rather than listens because
 * a device can be created on the CLI, on another chat's turn, or on a remote
 * Mac, none of which reach this renderer's event feed; the boot event is
 * listened for anyway, because "Starting" is the one state a 6-second poll
 * would miss entirely.
 */

const POLL_MS = 6_000;

export type AppleLaneDeviceCard = {
  name: string;
  state: "starting" | "running" | "off";
};

export function useAppleLaneDeviceCard(args: {
  laneId: string | null;
  runtimePin: OpenProjectBinding | null;
  enabled: boolean;
}): AppleLaneDeviceCard | null {
  const { laneId, runtimePin, enabled } = args;
  const [card, setCard] = useState<AppleLaneDeviceCard | null>(null);
  const [starting, setStarting] = useState(false);
  const pinRef = useRef(runtimePin);
  pinRef.current = runtimePin;

  useEffect(() => {
    if (!enabled || !laneId) {
      setCard(null);
      return undefined;
    }
    let cancelled = false;
    const read = async () => {
      const api = window.ade?.iosSimulator;
      if (!api?.deviceList) {
        if (!cancelled) setCard(null);
        return;
      }
      const listed = await api
        .deviceList({ laneId, installed: true }, pinRef.current)
        .catch(() => null);
      if (cancelled) return;
      const lane = listed?.lane ?? null;
      if (!lane) {
        setCard(null);
        return;
      }
      const booted = listed?.installed.find((entry) => entry.udid === lane.udid)?.state === "Booted";
      setCard({ name: lane.name, state: booted ? "running" : "off" });
    };
    void read();
    const timer = window.setInterval(() => void read(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, laneId]);

  useEffect(() => {
    if (!enabled || !laneId) return undefined;
    const unsubscribe = window.ade?.iosSimulator?.onEvent?.((event) => {
      if (event.type !== "apple.device.state") return;
      if (event.laneId && event.laneId !== laneId) return;
      setStarting(event.phase === "starting" || event.phase === "booted");
    }, pinRef.current);
    return unsubscribe;
  }, [enabled, laneId]);

  if (!card) return null;
  return starting && card.state !== "running" ? { ...card, state: "starting" } : card;
}
