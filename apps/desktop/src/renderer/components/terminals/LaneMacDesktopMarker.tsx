import { Monitor, WindowsLogo } from "@phosphor-icons/react";
import { PaneTooltip } from "../ui/PaneTooltip";
import { WORK_HEADER_ICON_BUTTON_CLASS } from "../work/WorkHeaderPaneToggles";
import type { DesktopSeatKind } from "../../../shared/types/macDesktop";
import { LANE_DESKTOP_LABELS, useLaneDesktopSeat } from "./useLaneMacDesktops";
import { desktopToolProductName, type DesktopWorkTool } from "./workTools";

/**
 * The small screen mark beside a lane name: this lane holds a desktop screen.
 * Same size, tone and slot as the Apple mark, and the same glyph the desktop
 * tool uses on that host — the Mac Desktop monitor, or the Windows logo on a
 * Windows host, whose tooltip says which seat (private or the user's own).
 */
export function LaneMacDesktopMarker({ laneId, kind = "mac" }: { laneId: string; kind?: DesktopSeatKind }) {
  const label = LANE_DESKTOP_LABELS[kind];
  const Icon = kind === "mac" ? Monitor : WindowsLogo;
  return (
    <PaneTooltip label={label} className="shrink-0 items-center">
      <span
        role="img"
        aria-label={label}
        data-lane-mac-desktop={laneId}
        data-lane-desktop-kind={kind}
        className="inline-flex shrink-0 items-center"
      >
        <Icon size={11} weight="regular" aria-hidden className="shrink-0 text-muted-fg/80" />
      </span>
    </PaneTooltip>
  );
}

/**
 * The same mark as a chat-header control: the lane's screen is up, and a click
 * opens it in the tools pane. Absent while the lane holds no screen, like the
 * browser presence button beside it.
 */
export function LaneDesktopHeaderButton({
  laneId,
  onOpen,
}: {
  laneId: string | null | undefined;
  onOpen: (tool: DesktopWorkTool) => void;
}) {
  const kind = useLaneDesktopSeat(laneId);
  if (!kind) return null;
  const label = LANE_DESKTOP_LABELS[kind];
  const Icon = kind === "mac" ? Monitor : WindowsLogo;
  const tool: DesktopWorkTool = kind === "mac" ? "mac-desktop" : "windows-desktop";
  return (
    <button
      type="button"
      data-testid="lane-desktop-header-button"
      data-lane-desktop-kind={kind}
      className={WORK_HEADER_ICON_BUTTON_CLASS}
      title={label}
      aria-label={`Open ${desktopToolProductName(tool)}`}
      onClick={() => onOpen(tool)}
    >
      <Icon size={16} weight="bold" />
    </button>
  );
}
