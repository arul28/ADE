import { useLayoutEffect, type CSSProperties, type RefObject } from "react";

/**
 * Project and route surfaces stay mounted while another one is on screen
 * ("parked") so switching back is instant.
 *
 * A parked surface is hidden with `content-visibility: hidden`: it keeps its
 * rendering state, leaves hit-testing and focus, and stops its animations, and
 * it toggles in a few milliseconds. Do not hide one with `inert`,
 * `pointer-events: none`, or a `[attr] *` rule — each of those restyles every
 * element of the surface, which froze project switches for hundreds of
 * milliseconds when a surface held a long chat. A browser without
 * `content-visibility` (an old one serving the web client) falls back to
 * `inert`.
 */
export const PARKED_SURFACE_ATTRIBUTE = "data-ade-surface-hidden";

const SUPPORTS_CONTENT_VISIBILITY =
  typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("content-visibility", "hidden");

const PARKED_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: -1,
  opacity: 0,
  ...(SUPPORTS_CONTENT_VISIBILITY ? { contentVisibility: "hidden" } : { pointerEvents: "none" }),
};

/** Props for a surface root that may be parked. */
export function parkedSurfaceProps(parked: boolean) {
  return {
    "aria-hidden": parked,
    "data-ade-animation-state": parked ? "paused" : "running",
    [PARKED_SURFACE_ATTRIBUTE]: parked ? "" : undefined,
    style: parked ? PARKED_STYLE : undefined,
  };
}

/**
 * Parking drops focus from inside the surface, as `inert` did. `mountKey`
 * re-runs it when the surface element itself mounts or remounts.
 */
export function useParkedSurfaceFocus(
  ref: RefObject<HTMLElement | null>,
  parked: boolean,
  mountKey?: unknown,
): void {
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (!SUPPORTS_CONTENT_VISIBILITY) {
      node.toggleAttribute("inert", parked);
      return;
    }
    if (!parked) return;
    const focused = node.ownerDocument.activeElement;
    if (focused instanceof HTMLElement && node.contains(focused)) focused.blur();
  }, [parked, ref, mountKey]);
}

/** True when `element` sits in a parked (or inert) surface, so it is not on screen. */
export function isInParkedSurface(element: Element): boolean {
  return element.closest(`[inert], [${PARKED_SURFACE_ATTRIBUTE}]`) != null;
}
