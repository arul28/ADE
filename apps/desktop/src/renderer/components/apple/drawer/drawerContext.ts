import type { MutableRefObject } from "react";
import type { AppleLaneDevice, OpenProjectBinding } from "../../../../shared/types";
import type { AppleDrawerActions, AppleDrawerScope } from "./useAppleDrawerActions";

/**
 * What every section receives from the drawer: the lane and device, the pin
 * every IPC call is made with, the one serialized `act`, and the app in the
 * foreground (the App, Permissions, Push and Event log sections all key off
 * it).
 */
export type AppleDrawerContext = {
  scope: AppleDrawerScope;
  device: AppleLaneDevice;
  pinRef: MutableRefObject<OpenProjectBinding | null>;
  visible: boolean;
  actions: AppleDrawerActions;
  /** The bundle id the device is showing, as far as ADE knows. Null = `—`. */
  foregroundApp: string | null;
  setForegroundApp: (bundleId: string | null) => void;
};
