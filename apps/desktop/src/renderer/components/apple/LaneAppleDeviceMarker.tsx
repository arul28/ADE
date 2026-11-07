import { AppleLogo } from "../ui/appleIcons";
import { cn } from "../ui/cn";
import { LaneDeviceMarker, laneDeviceMarkerTone } from "../device/LaneDeviceMarker";
import { laneAppleDeviceLabel, type LaneAppleDevice } from "./useLaneAppleDevices";

/**
 * The small Apple mark beside a lane name: this lane holds a simulator (see
 * `LaneDeviceMarker`). The owner's report that opened the claim-UX round was
 * that a muted mark beside a card reading "Off" read as "the tool is off";
 * the state is the device's, and it now shows.
 */
export function LaneAppleDeviceMarker({ device }: { device: LaneAppleDevice }) {
  return (
    <LaneDeviceMarker
      label={laneAppleDeviceLabel(device)}
      dataAttributes={{
        "data-lane-apple-device": device.udid,
        "data-lane-apple-device-running": device.running == null ? "unknown" : device.running ? "true" : "false",
      }}
      icon={<AppleLogo size={11} aria-hidden className={cn("shrink-0", laneDeviceMarkerTone(device.running))} />}
    />
  );
}
