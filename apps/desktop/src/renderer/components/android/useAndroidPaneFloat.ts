import { useEffect, useMemo, type MutableRefObject } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { AndroidLaneDeviceStatus } from "../../../shared/types/androidEmulator";
import { androidLaneDeviceName } from "./androidDeviceState";
import { noteAndroidMiniPlayerLaneDevice, openAndroidMiniPlayer } from "./androidMiniPlayerStore";

/**
 * The pane's half of the floating player (`androidMiniPlayerStore.ts`).
 *
 * - The cache: the handoff on unmount is synchronous, so the emulator's name
 *   and size are written on every status read, before the pane goes.
 * - "Float over chat": the Android slot of the floating players. Only for this
 *   window's own lanes (`machineName` null); another machine's work copy shows
 *   in the pane only. Undefined when there is nothing to float.
 */
export function useAndroidPaneFloat({
  lane,
  laneId,
  sessionId,
  machineName,
  runtimePinRef,
}: {
  lane: AndroidLaneDeviceStatus | null;
  laneId: string;
  sessionId: string | null;
  machineName: string | null;
  runtimePinRef: MutableRefObject<OpenProjectBinding | null>;
}): (() => void) | undefined {
  useEffect(() => {
    const avdName = lane?.device?.avdName ?? null;
    noteAndroidMiniPlayerLaneDevice({ laneId, runtimePin: runtimePinRef.current }, avdName && lane
      ? {
        avdName,
        deviceName: androidLaneDeviceName(lane),
        lcdWidth: lane.avd?.lcdWidth ?? null,
        lcdHeight: lane.avd?.lcdHeight ?? null,
        booted: lane.state === "booted",
      }
      : null);
  }, [lane, laneId, runtimePinRef]);

  const deviceName = androidLaneDeviceName(lane);
  const avdName = lane?.device?.avdName ?? null;
  const lcdWidth = lane?.avd?.lcdWidth ?? null;
  const lcdHeight = lane?.avd?.lcdHeight ?? null;
  return useMemo(() => {
    if (machineName || !avdName) return undefined;
    return () => openAndroidMiniPlayer({
      laneId,
      chatSessionId: sessionId,
      avdName,
      deviceName,
      lcdWidth,
      lcdHeight,
      runtimePin: runtimePinRef.current,
    });
  }, [avdName, deviceName, laneId, lcdHeight, lcdWidth, machineName, runtimePinRef, sessionId]);
}
