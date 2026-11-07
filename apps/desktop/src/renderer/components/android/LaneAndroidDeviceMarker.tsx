import { AndroidLogo } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { LaneDeviceMarker, laneDeviceMarkerTone } from "../device/LaneDeviceMarker";
import { laneAndroidDeviceLabel, type LaneAndroidDevice } from "./useLaneAndroidDevices";

/** The small Android mark beside a lane name: this lane holds an emulator (see `LaneDeviceMarker`). */
export function LaneAndroidDeviceMarker({ device }: { device: LaneAndroidDevice }) {
  return (
    <LaneDeviceMarker
      label={laneAndroidDeviceLabel(device)}
      dataAttributes={{
        "data-lane-android-device": device.avdName,
        "data-lane-android-device-running": device.running ? "true" : "false",
      }}
      icon={<AndroidLogo size={11} weight="fill" aria-hidden className={cn("shrink-0", laneDeviceMarkerTone(device.running))} />}
    />
  );
}
