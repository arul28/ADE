import { useCallback, type MutableRefObject } from "react";
import type { OpenProjectBinding } from "../../../../shared/types";
import type { AndroidDeviceSettings } from "../../../../shared/types/androidEmulator";
import { useDeviceDrawerActions, useDeviceDrawerGroup, type DeviceDrawerActions } from "../../device/deviceDrawerState";

/*
 * The Android Tools drawer's state: the shared device drawer state (the open
 * group, the settings snapshot, the one serialized `act()`), reading
 * `androidEmulator.getDeviceSettings`.
 */

/** The groups, in the order the drawer stacks them (plan §5). Logs comes in P2. */
export const ANDROID_DRAWER_GROUPS = ["device", "app", "capture", "emulator"] as const;
export type AndroidDrawerGroupId = (typeof ANDROID_DRAWER_GROUPS)[number];

/** Which group is open: per chat, or for the session on a chatless surface. */
export function useAndroidDrawerGroup(chatSessionId: string | null): {
  open: AndroidDrawerGroupId | null;
  toggle: (id: AndroidDrawerGroupId) => void;
} {
  return useDeviceDrawerGroup({ chatSessionId, groups: ANDROID_DRAWER_GROUPS, defaultGroup: "device", storageKey: "androidToolsGroup" });
}

/** `actWithSettings` takes `setDeviceSetting`, which answers with a fresh read. */
export type AndroidDrawerActions = DeviceDrawerActions<AndroidDeviceSettings>;

export function useAndroidDrawerActions({
  laneId,
  pinRef,
  visible,
}: {
  laneId: string;
  pinRef: MutableRefObject<OpenProjectBinding | null>;
  visible: boolean;
}): AndroidDrawerActions {
  const read = useCallback(
    () => window.ade.androidEmulator.getDeviceSettings({ laneId }, pinRef.current),
    [laneId, pinRef],
  );
  return useDeviceDrawerActions({ read, visible });
}

/** What every section gets from the drawer. */
export type AndroidDrawerContext = {
  laneId: string;
  pinRef: MutableRefObject<OpenProjectBinding | null>;
  visible: boolean;
  actions: AndroidDrawerActions;
  /** The machine that runs the emulator, when it is not this one. Files there cannot be revealed here. */
  remoteMachineName: string | null;
};
