import type { ReactNode } from "react";
import { ArrowsClockwise } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { Button } from "../ui/Button";
import { PaneTooltip } from "../ui/PaneTooltip";
import { WorkToolPickerBackdrop } from "../terminals/WorkToolPickerBackdrop";
import type { DeviceToolId } from "./deviceTool";

/** The column the page is built around — the tools grid's 512 plus one card. */
const COLUMN_MAX_PX = 560;

/** Two cards at 432px of pane, one below it. Mirrors `WorkToolPicker`. */
const CARD_MIN_TRACK_PX = 188;

/** The card grid's columns: as many tracks of `CARD_MIN_TRACK_PX` as fit. */
export const DEVICE_CARD_GRID_COLUMNS = `repeat(auto-fit, minmax(min(100%, ${CARD_MIN_TRACK_PX}px), 1fr))`;

/**
 * A device picker's page: the tools grid's backdrop, its scroller and its
 * column. `tool` names the page's `data-{tool}-picker` marker.
 *
 * Two boxes, for the same reason `WorkToolPicker` uses two — `inset: 0` inside
 * a scroller resolves against the scroll ORIGIN, so a mesh painted inside it
 * ends at the fold.
 */
export function DevicePickerPage({
  tool,
  theme,
  playing,
  children,
}: {
  tool: DeviceToolId;
  theme: Parameters<typeof WorkToolPickerBackdrop>[0]["theme"];
  playing: boolean;
  children: ReactNode;
}) {
  return (
    <div className="ade-pane-chrome relative h-full min-h-0 min-w-0" {...{ [`data-${tool}-picker`]: "" }}>
      <WorkToolPickerBackdrop theme={theme} playing={playing} />
      <div className="relative flex h-full min-h-0 min-w-0 flex-col overflow-y-auto">
        <div
          className="relative mx-auto flex w-full min-w-0 flex-col gap-4 px-5 py-6"
          style={{ maxWidth: COLUMN_MAX_PX }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/** Top right of the page, where a refresh belongs. Icon only; it needs no word. */
export function DevicePickerRefreshButton({
  tool,
  tooltip,
  label,
  refreshing,
  onRefresh,
}: {
  /** Names the button's `data-{tool}-picker-refresh` marker. */
  tool: DeviceToolId;
  tooltip: string;
  label: string;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <PaneTooltip label={tooltip} side="bottom">
      <Button
        variant="ghost"
        size="sm"
        disabled={refreshing}
        aria-label={label}
        {...{ [`data-${tool}-picker-refresh`]: "" }}
        onClick={onRefresh}
        className="h-6 w-6 shrink-0 p-0 text-muted-fg"
      >
        <ArrowsClockwise size={14} className={cn(refreshing && "animate-spin")} />
      </Button>
    </PaneTooltip>
  );
}
