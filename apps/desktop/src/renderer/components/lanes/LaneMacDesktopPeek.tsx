import { useMacDesktopFrame } from "../chat/macDesktopFrameStore";

/**
 * The lane row's hover peek at that lane's macOS screen.
 *
 * Costs nothing when there is nothing to show, which is the whole design. It
 * subscribes to one key of `macDesktopFrameStore` and renders `null` unless a
 * frame is already there — no `getStatus`, no screenshot call, no timer. The
 * frames come from whichever surface last held the decoder (the Work pane's
 * panel), so a lane nobody has opened the tool for stays invisible here rather
 * than provoking a capture to fill a hover.
 *
 * Visibility is CSS on the row's existing `group`, so hovering a row does not
 * write React state and cannot re-render the list.
 */
export function LaneMacDesktopPeek({ laneId }: { laneId: string }) {
  const frame = useMacDesktopFrame(laneId);
  if (!frame) return null;
  return (
    <div
      aria-hidden
      data-testid="lane-mac-desktop-peek"
      className="pointer-events-none absolute left-full top-1/2 z-[220] ml-2 hidden -translate-y-1/2 overflow-hidden rounded-[8px] border border-border bg-black/80 shadow-float group-hover:block"
      style={{ width: 224 }}
    >
      <img src={frame.dataUrl} alt="" className="block h-auto w-full" />
      {frame.caption ? (
        <p className="truncate px-2 py-1 text-[10px] text-muted-fg">{frame.caption}</p>
      ) : null}
    </div>
  );
}
