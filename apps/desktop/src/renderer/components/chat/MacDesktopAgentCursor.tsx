import { useEffect, useRef, useState } from "react";
import { Cursor } from "@phosphor-icons/react";
import { useReducedMotion } from "motion/react";

import type { MacDesktopCursorPoint } from "./MacDesktopTakeoverCursor";

/**
 * The agent's cursor on the lane's picture: where its last action landed.
 *
 * It used to be drawn at `left`/`top` straight from the newest observation, so
 * it jumped from one point to the next and vanished outright when the fade
 * timer cleared it — the owner found it "never smooth to move". It now glides
 * to each new point, and when the agent has been idle for
 * `MAC_DESKTOP_CURSOR_FADE_MS` (the caller passes null) it fades out where it
 * stopped. The next action after a fade appears in place and does not fly in
 * from the old point. With reduced motion there is no glide and no fade.
 *
 * Drawn in the renderer, over the decoded picture. The driver's own captured
 * pointer is hidden while an agent drives, so this is the only one on screen.
 */

/** How long a glide from one action's point to the next takes. */
export const MAC_DESKTOP_AGENT_CURSOR_GLIDE_MS = 200;
/** How long the cursor takes to fade out once the agent is idle. */
export const MAC_DESKTOP_AGENT_CURSOR_FADE_OUT_MS = 350;
/** A fast start and a soft landing: it reads as a hand moving, not a slide. */
const GLIDE_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

type CursorState = {
  point: MacDesktopCursorPoint;
  shown: boolean;
  /** The move into `point` animates: it was on screen at the previous point. */
  glide: boolean;
};

/** The CSS transition for one state of the glyph. Exported for the test. */
export function macDesktopAgentCursorTransition(args: { glide: boolean; reduceMotion: boolean }): string {
  if (args.reduceMotion) return "none";
  const fade = `opacity ${MAC_DESKTOP_AGENT_CURSOR_FADE_OUT_MS}ms ease-out`;
  return args.glide ? `transform ${MAC_DESKTOP_AGENT_CURSOR_GLIDE_MS}ms ${GLIDE_EASING}, ${fade}` : fade;
}

export function MacDesktopAgentCursor({
  point,
}: {
  /** The last action's point in the picture's own box, or null once idle. */
  point: MacDesktopCursorPoint | null;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  const [state, setState] = useState<CursorState | null>(() => (
    point ? { point, shown: true, glide: false } : null
  ));
  const x = point?.x ?? null;
  const y = point?.y ?? null;
  const lastRef = useRef(state);
  lastRef.current = state;

  useEffect(() => {
    const previous = lastRef.current;
    if (x == null || y == null) {
      // Idle: fade where it stopped rather than disappear.
      if (previous?.shown) setState({ ...previous, shown: false, glide: false });
      return;
    }
    if (previous?.shown && previous.point.x === x && previous.point.y === y) return;
    setState({ point: { x, y }, shown: true, glide: Boolean(previous?.shown) });
  }, [x, y]);

  if (!state) return null;
  // Once faded out under reduced motion there is nothing to wait for.
  if (!state.shown && reduceMotion) return null;
  return (
    <span
      aria-hidden
      data-testid="mac-desktop-agent-cursor"
      data-shown={state.shown ? "true" : "false"}
      data-glide={state.glide ? "true" : "false"}
      className="pointer-events-none absolute left-0 top-0 z-10 text-accent will-change-transform"
      style={{
        transform: `translate3d(${state.point.x}px, ${state.point.y}px, 0) translate(-50%, -50%)`,
        opacity: state.shown ? 1 : 0,
        transition: macDesktopAgentCursorTransition({ glide: state.glide, reduceMotion }),
      }}
    >
      <Cursor size={16} weight="fill" />
    </span>
  );
}
