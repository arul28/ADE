import { PaneTooltip } from "../ui/PaneTooltip";
import { AppleLogo } from "../ui/appleIcons";
import { cn } from "../ui/cn";
import { laneAppleDeviceLabel, type LaneAppleDevice } from "./useLaneAppleDevices";

/**
 * The small Apple mark beside a lane name: this lane holds a simulator.
 *
 * Two things, one mark. The glyph says the lane OWNS a device — it is present
 * whether that device is running or not, because a claim is a claim. The COLOUR
 * says which: green while the device is booted, muted while it is claimed but
 * shut down or not yet known. The owner's report that opened the claim-UX round
 * was that a muted mark beside a card reading "Off" read as "the tool is off";
 * the state is the device's, and it now shows.
 *
 * The device name is in the tooltip, not on the row.
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
          className={cn("shrink-0", device.running ? "text-success" : "text-muted-fg/45")}
        />
      </span>
    </PaneTooltip>
  );
}
