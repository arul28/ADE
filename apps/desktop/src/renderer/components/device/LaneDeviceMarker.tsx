import type { ReactNode } from "react";
import { PaneTooltip } from "../ui/PaneTooltip";

/**
 * The small device mark beside a lane name: this lane holds a device.
 *
 * Two things, one mark. The glyph says the lane OWNS a device: it shows
 * whether that device runs or not, because a claim is a claim. The colour
 * says which: green while the device runs, muted while it is off or not yet
 * known. The device name is in the tooltip, not on the row. Each platform
 * gives its own glyph (coloured by `running`) and its own data attributes.
 */
export function LaneDeviceMarker({
  label,
  dataAttributes,
  icon,
}: {
  label: string;
  dataAttributes: Record<`data-${string}`, string>;
  icon: ReactNode;
}) {
  return (
    <PaneTooltip label={label} className="shrink-0 items-center">
      <span role="img" aria-label={label} {...dataAttributes} className="inline-flex shrink-0 items-center">
        {icon}
      </span>
    </PaneTooltip>
  );
}

/** The glyph's colour: green while the device runs, muted otherwise. */
export function laneDeviceMarkerTone(running: boolean | null | undefined): string {
  return running ? "text-success" : "text-muted-fg/45";
}
