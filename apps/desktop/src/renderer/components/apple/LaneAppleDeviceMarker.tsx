import { PaneTooltip } from "../ui/PaneTooltip";
import { AppleLogo } from "../ui/appleIcons";
import { cn } from "../ui/cn";
import { laneAppleDeviceLabel, type LaneAppleDevice } from "./useLaneAppleDevices";

/**
 * The small Apple mark beside a lane name: this lane holds a simulator.
 *
 * Muted like the other glyphs on a lane row. A booted device reads a little
 * stronger than one that is off or not yet known. The device name is in the
 * tooltip, not on the row.
 */
export function LaneAppleDeviceMarker({ device }: { device: LaneAppleDevice }) {
  const label = laneAppleDeviceLabel(device);
  return (
    <PaneTooltip label={label} className="shrink-0 items-center">
      <span
        role="img"
        aria-label={label}
        data-lane-apple-device={device.udid}
        data-lane-apple-device-running={device.running == null ? "unknown" : device.running ? "true" : "false"}
        className="inline-flex shrink-0 items-center"
      >
        <AppleLogo
          size={11}
          aria-hidden
          className={cn("shrink-0", device.running ? "text-muted-fg/80" : "text-muted-fg/45")}
        />
      </span>
    </PaneTooltip>
  );
}
