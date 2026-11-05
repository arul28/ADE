import { useCallback, type MutableRefObject } from "react";
import type { IosSimulatorDeviceSettings, OpenProjectBinding } from "../../../../shared/types";
import { useDeviceDrawerActions, type DeviceDrawerActions } from "../../device/deviceDrawerState";

/**
 * The Apple drawer's one serialized `act()` and settings snapshot: the shared
 * device drawer state, reading `iosSimulator.getDeviceSettings`.
 */

export type AppleDrawerScope = {
  laneId: string;
  deviceUdid: string;
  chatSessionId: null;
};

export type AppleDrawerActions = DeviceDrawerActions<IosSimulatorDeviceSettings>;

export function useAppleDrawerActions({
  scope,
  pinRef,
  visible,
}: {
  scope: AppleDrawerScope;
  pinRef: MutableRefObject<OpenProjectBinding | null>;
  visible: boolean;
}): AppleDrawerActions {
  const { laneId, deviceUdid } = scope;
  const read = useCallback(
    () => window.ade.iosSimulator.getDeviceSettings({ laneId, deviceUdid, chatSessionId: null }, pinRef.current),
    [deviceUdid, laneId, pinRef],
  );
  return useDeviceDrawerActions({ read, visible });
}
