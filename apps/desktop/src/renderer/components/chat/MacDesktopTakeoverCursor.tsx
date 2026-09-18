import { useEffect, useRef } from "react";
import { Cursor } from "@phosphor-icons/react";

import type { MacDesktopDisplay } from "../../../shared/types/macDesktop";
import { displayPointToViewPoint, type ViewRect } from "./macDesktopGeometry";

/**
 * The pointer the person who took control is actually moving.
 *
 * There are two of them, and that is deliberate. The captured one is the real
 * system cursor: the driver turns `SCStreamConfiguration.showsCursor` on for as
 * long as a `user` holds the lease, so the picture shows the arrow the window
 * server is drawing, with the right shape for whatever is under it — an I-beam
 * over text, a resize handle on an edge. It is the truth, and it is a whole
 * round trip behind the hand on the mouse: the move is posted, the display
 * redraws, the frame is encoded, sent, decoded, painted. On a remote lane that
 * is comfortably over a hundred milliseconds, and a pointer that lags its own
 * mouse by that much does not feel slow, it feels broken.
 *
 * So this draws a second, local one at the browser's own hover point, on the
 * frame the browser already has. It is never late because it never waits for
 * anything, and when the captured cursor catches up the two sit on top of each
 * other. The OS cursor over the pane is hidden while control is held (see
 * {@link MAC_DESKTOP_TAKEOVER_CURSOR_HIDDEN_CLASS}) so the user sees one arrow
 * on the screen they are driving rather than one on theirs and one on the
 * lane's.
 *
 * Positions arrive through a feed rather than through props, and the glyph
 * moves by writing `transform` on its own node. A pointer move is up to sixty
 * events a second: as React state it would re-render the whole Mac Desktop
 * panel — the strip, the window rail, the observation row — sixty times a
 * second, for a thing that is one arrow moving.
 */

export type MacDesktopCursorPoint = { x: number; y: number };

export type MacDesktopTakeoverCursorFeed = {
  /** Latest position in GLOBAL display points, or null to hide the glyph. */
  publish: (point: MacDesktopCursorPoint | null) => void;
  subscribe: (listener: (point: MacDesktopCursorPoint | null) => void) => () => void;
  /** What the last publish said, for a subscriber that mounts mid-gesture. */
  readonly current: MacDesktopCursorPoint | null;
};

export function createMacDesktopTakeoverCursorFeed(): MacDesktopTakeoverCursorFeed {
  const listeners = new Set<(point: MacDesktopCursorPoint | null) => void>();
  let current: MacDesktopCursorPoint | null = null;
  return {
    publish(point) {
      current = point;
      for (const listener of listeners) listener(point);
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(current);
      return () => {
        listeners.delete(listener);
      };
    },
    get current() {
      return current;
    },
  };
}

/**
 * The class the surface wears while this client holds control.
 *
 * Only while it holds control: hiding the OS cursor over a pane nobody is
 * driving would leave the user with no pointer and no way to know why.
 */
export const MAC_DESKTOP_TAKEOVER_CURSOR_HIDDEN_CLASS = "cursor-none";

export function MacDesktopTakeoverCursor(props: {
  feed: MacDesktopTakeoverCursorFeed;
  /** The pane's own rectangle, the same one `toDisplayPoint` is built from. */
  rect: ViewRect;
  display: Pick<MacDesktopDisplay, "width" | "height" | "origin"> | null;
  /** This client holds the lease. Nothing is drawn otherwise. */
  active: boolean;
}): JSX.Element | null {
  const { active, display, feed, rect } = props;
  const nodeRef = useRef<HTMLSpanElement | null>(null);
  // Read inside the subscription rather than closed over: the pane resizes
  // while a gesture is in flight, and a stale rect would put the glyph where
  // the picture used to be.
  const geometryRef = useRef({ rect, display });
  geometryRef.current = { rect, display };

  useEffect(() => {
    if (!active) return;
    return feed.subscribe((point) => {
      const node = nodeRef.current;
      if (!node) return;
      const { display: currentDisplay, rect: currentRect } = geometryRef.current;
      const view = point && currentDisplay
        ? displayPointToViewPoint({ x: point.x, y: point.y, rect: currentRect, display: currentDisplay })
        : null;
      if (!view) {
        // Keep the last place the pointer was. Publishing null (letterbox,
        // or a warp-induced leave) is what made the yellow arrow vanish
        // while `cursor-none` had already hidden the OS cursor.
        return;
      }
      node.style.opacity = "1";
      node.style.transform = `translate(${view.x}px, ${view.y}px)`;
    });
  }, [active, feed]);

  if (!active) return null;
  return (
    <span
      ref={nodeRef}
      aria-hidden
      data-testid="mac-desktop-takeover-cursor"
      className="pointer-events-none absolute left-0 top-0 z-[11] opacity-0 text-amber-300 drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]"
    >
      <Cursor size={16} weight="fill" />
    </span>
  );
}
