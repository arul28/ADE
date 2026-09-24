import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useMacDesktopFrame } from "../chat/macDesktopFrameStore";
import { ViewportOverlayHost } from "../ui/ViewportOverlayHost";

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
 * Why this is a portal and not `group-hover:block` on an absolute child, which
 * is what it was: the lane rail is a horizontally scrolling strip, and
 * `overflow-x: auto` clips its children on BOTH axes. A 126px-tall thumbnail
 * hanging off a 50px row was sliced down to the row's height — the peek was
 * there, and two thirds of it were invisible. Fixed positioning in a body
 * portal is the only placement no ancestor can crop.
 *
 * The hover state lives here, on a component that renders one thumbnail, so a
 * pointer crossing a row still cannot re-render the lane list.
 */
export function LaneMacDesktopPeek({ laneId }: { laneId: string }) {
  const frame = useMacDesktopFrame(laneId);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    const host = anchorRef.current?.parentElement;
    if (!host) return;
    const show = () => {
      const rect = host.getBoundingClientRect();
      setAt({ left: rect.right + 8, top: rect.top + rect.height / 2 });
    };
    const hide = () => setAt(null);
    host.addEventListener("pointerenter", show);
    host.addEventListener("pointermove", show);
    host.addEventListener("pointerleave", hide);
    // A row that scrolls out from under a held pointer should not leave a
    // thumbnail floating over the app.
    window.addEventListener("scroll", hide, true);
    return () => {
      host.removeEventListener("pointerenter", show);
      host.removeEventListener("pointermove", show);
      host.removeEventListener("pointerleave", hide);
      window.removeEventListener("scroll", hide, true);
    };
  }, [frame?.laneId]);

  if (!frame) return null;

  return (
    <>
      <span ref={anchorRef} aria-hidden className="hidden" />
      {at
        ? createPortal(
            <ViewportOverlayHost layer="tooltip" testId="lane-mac-desktop-peek">
              <div
                aria-hidden
                className="pointer-events-none absolute -translate-y-1/2 overflow-hidden rounded-[8px] border border-border bg-black/80 shadow-float"
                style={{ left: at.left, top: at.top, width: 224 }}
              >
                <img src={frame.dataUrl} alt="" className="block h-auto w-full" />
                {frame.caption ? (
                  <p className="truncate px-2 py-1 text-[10px] text-muted-fg">{frame.caption}</p>
                ) : null}
              </div>
            </ViewportOverlayHost>,
            document.body,
          )
        : null}
    </>
  );
}
