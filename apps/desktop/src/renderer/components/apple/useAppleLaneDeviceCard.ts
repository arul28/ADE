import { useEffect, useRef, useState } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import { applePowerFromPhase, laneDeviceBooted } from "./appleDeviceState";

/**
 * The tools grid card's one fact about the Apple tool: which device this lane
 * owns, and whether it is up.
 *
 * `deviceList` is the cheapest question in the Apple surface — it reads the
 * lanes DB row and one `simctl list`, not a helper round-trip — which is why
 * this polls it rather than `getStatus`. It polls rather than listens because
 * a device can be created on the CLI, on another chat's turn, or on a remote
 * Mac, none of which reach this renderer's event feed.
 *
 * Every `apple.device.state` event for the lane moves the card at once and
 * re-reads it, the same event the pane listens to. Shutting a device down
 * used to leave the card reading "Running" for up to a poll after the grid
 * came back, because the shutdown lands after the tab closes and only
 * "Starting" was taken from the event.
 */

const POLL_MS = 6_000;

export type AppleLaneDeviceCard = {
  name: string;
  state: "starting" | "running" | "off";
  /**
   * The lane's device udid, and whether ADE created it.
   *
   * Optional so a partial card (a test, an older payload) still typechecks —
   * the hook always sets both from the lane row. The card's action menu needs
   * them: `clone` is ADE's to delete, `attached` is only ever released.
   */
  udid?: string;
  origin?: "clone" | "attached";
};

export function useAppleLaneDeviceCard(args: {
  laneId: string | null;
  runtimePin: OpenProjectBinding | null;
  enabled: boolean;
}): AppleLaneDeviceCard | null {
  const { laneId, runtimePin, enabled } = args;
  const [card, setCard] = useState<AppleLaneDeviceCard | null>(null);
  const [starting, setStarting] = useState(false);
  const [readNonce, setReadNonce] = useState(0);
  const pinRef = useRef(runtimePin);
  pinRef.current = runtimePin;

  // A lane switch during a boot must not leave the next lane showing
  // "starting" until an unrelated event arrives.
  useEffect(() => {
    setStarting(false);
  }, [enabled, laneId]);

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
      setCard({
        name: lane.name,
        state: laneDeviceBooted(listed) ? "running" : "off",
        udid: lane.udid,
        origin: lane.origin,
      });
    };
    void read();
    const timer = window.setInterval(() => void read(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, laneId, readNonce]);

  useEffect(() => {
    if (!enabled || !laneId) return undefined;
    const unsubscribe = window.ade?.iosSimulator?.onEvent?.((event) => {
      if (event.type !== "apple.device.state") return;
      if (event.laneId && event.laneId !== laneId) return;
      setStarting(event.phase === "starting" || event.phase === "booted");
      // Power the card knows from the event itself, ahead of the re-read.
      const power = applePowerFromPhase(event.phase);
      if (power) {
        const state = power === "on" ? "running" : "off";
        setCard((current) => (current && current.state !== state ? { ...current, state } : current));
      }
      // Any phase can change what the lane holds or whether it is up
      // (`released` means the lane gave the device up); read it again now.
      setReadNonce((nonce) => nonce + 1);
    }, pinRef.current);
    return unsubscribe;
  }, [enabled, laneId]);

  if (!card) return null;
  return starting && card.state !== "running" ? { ...card, state: "starting" } : card;
}
