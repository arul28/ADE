import { AndroidLogo } from "@phosphor-icons/react";
import { PaneTooltip } from "../ui/PaneTooltip";
import { cn } from "../ui/cn";
import { laneAndroidDeviceLabel, type LaneAndroidDevice } from "./useLaneAndroidDevices";

/**
 * The small Android mark beside a lane name: this lane holds an emulator.
 * The twin of `LaneAppleDeviceMarker`: the glyph says the lane holds a device
 * (running or not), and the colour says whether it is up (green) or off
 * (muted). The device name is in the tooltip.
 */
export function LaneAndroidDeviceMarker({ device }: { device: LaneAndroidDevice }) {
  const label = laneAndroidDeviceLabel(device);
  return (
    <PaneTooltip label={label} className="shrink-0 items-center">
      <span
        role="img"
        aria-label={label}
        data-lane-android-device={device.avdName}
        data-lane-android-device-running={device.running ? "true" : "false"}
        className="inline-flex shrink-0 items-center"
      >
        <AndroidLogo
          size={11}
          weight="fill"
          aria-hidden
          className={cn("shrink-0", device.running ? "text-success" : "text-muted-fg/45")}
        />
      </span>
    </PaneTooltip>
  );
}
