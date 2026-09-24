import { Monitor } from "@phosphor-icons/react";
import { PaneTooltip } from "../ui/PaneTooltip";
import { LANE_MAC_DESKTOP_LABEL } from "./useLaneMacDesktops";

/**
 * The small screen mark beside a lane name: this lane holds a Mac Desktop
 * display. Same size, tone and slot as the Apple mark, and the same glyph the
 * Mac Desktop tool uses.
 */
export function LaneMacDesktopMarker({ laneId }: { laneId: string }) {
  return (
    <PaneTooltip label={LANE_MAC_DESKTOP_LABEL} className="shrink-0 items-center">
      <span
        role="img"
        aria-label={LANE_MAC_DESKTOP_LABEL}
        data-lane-mac-desktop={laneId}
        className="inline-flex shrink-0 items-center"
      >
        <Monitor size={11} weight="regular" aria-hidden className="shrink-0 text-muted-fg/80" />
      </span>
    </PaneTooltip>
  );
}
