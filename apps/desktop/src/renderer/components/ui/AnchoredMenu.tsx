import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { clampFixedPosition } from "../../hooks/useClampedFixedPosition";
import { usePortalContainer } from "./portalContainer";

export type AnchoredMenuPlacement = "bottom-start" | "bottom-end" | "top-start" | "top-end";

type AnchoredMenuProps = Omit<React.HTMLAttributes<HTMLDivElement>, "children"> & {
  open: boolean;
  /** The trigger. The menu opens next to it and clicks on it do not count as "outside". */
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  placement?: AnchoredMenuPlacement;
  /** Gap between the trigger and the menu, in px. */
  offset?: number;
  /** Make the menu exactly as wide as the trigger (for select-style pickers). */
  matchAnchorWidth?: boolean;
  zIndex?: number;
  /** Change this when the menu's content changes size, so it is placed again. */
  remeasureKey?: unknown;
  children: React.ReactNode;
};

/**
 * A dropdown that renders into `document.body` with `position: fixed`, placed
 * next to its trigger and kept inside the window.
 *
 * Rendering it inline as `absolute` lets any scrolling or `overflow: hidden`
 * parent (the project sidebar, a scroll pane, a card) cut it off. Portalled, it
 * always draws on top. Inside a Radix dialog it portals into the dialog instead
 * (see `usePortalContainer`), because the dialog blocks clicks outside itself.
 *
 * Closes on a click outside the trigger and the menu, on Escape, on window
 * resize, and when a scroll moves the trigger (so the menu never floats away
 * from it).
 */
export function AnchoredMenu({
  open,
  anchorRef,
  onClose,
  placement = "bottom-start",
  offset = 4,
  matchAnchorWidth = false,
  zIndex = 200,
  remeasureKey = null,
  style,
  children,
  ...rest
}: AnchoredMenuProps) {
  const portalContainer = usePortalContainer();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number; width?: number } | null>(null);
  // Where the trigger was when we placed the menu, so a scroll can tell whether it moved.
  const anchorAtOpenRef = useRef<{ left: number; top: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const place = useCallback(() => {
    const anchor = anchorRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    const rect = anchor.getBoundingClientRect();
    // Size the menu to the trigger before measuring, so its height is the final one.
    if (matchAnchorWidth) menu.style.width = `${rect.width}px`;
    const size = { width: menu.offsetWidth, height: menu.offsetHeight };
    const width = matchAnchorWidth ? rect.width : size.width;
    const alignEnd = placement.endsWith("end");
    let above = placement.startsWith("top");
    // Flip to the other side when the preferred side has no room and the other does.
    const roomBelow = window.innerHeight - rect.bottom - offset;
    const roomAbove = rect.top - offset;
    if (!above && size.height > roomBelow && roomAbove > roomBelow) above = true;
    else if (above && size.height > roomAbove && roomBelow > roomAbove) above = false;
    const clamped = clampFixedPosition(
      {
        x: alignEnd ? rect.right - width : rect.left,
        y: above ? rect.top - offset - size.height : rect.bottom + offset,
      },
      { width, height: size.height },
    );
    // A transformed container (a centred dialog) becomes the origin for fixed
    // children, so convert window coordinates into its space.
    let originLeft = 0;
    let originTop = 0;
    if (portalContainer && getComputedStyle(portalContainer).transform !== "none") {
      const box = portalContainer.getBoundingClientRect();
      originLeft = box.left;
      originTop = box.top;
    }
    anchorAtOpenRef.current = { left: rect.left, top: rect.top };
    setPosition({
      left: clamped.left - originLeft,
      top: clamped.top - originTop,
      ...(matchAnchorWidth ? { width: rect.width } : null),
    });
  }, [anchorRef, matchAnchorWidth, offset, placement, portalContainer]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    place();
  }, [open, place, remeasureKey]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onCloseRef.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    const onScroll = (event: Event) => {
      // Scrolling inside the menu itself is fine.
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      const rect = anchorRef.current?.getBoundingClientRect();
      const before = anchorAtOpenRef.current;
      if (!rect || !before) return;
      if (Math.abs(rect.left - before.left) > 1 || Math.abs(rect.top - before.top) > 1) onCloseRef.current();
    };
    const onResize = () => onCloseRef.current();
    document.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [anchorRef, open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      {...rest}
      ref={menuRef}
      style={{
        ...style,
        position: "fixed",
        zIndex,
        // A modal Radix dialog turns off pointer events on <body>; the menu must
        // stay clickable when it portals there.
        pointerEvents: "auto",
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        ...(position?.width != null ? { width: position.width } : null),
        // Hidden for the one frame before it is measured, so it never flashes in the corner.
        visibility: position ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    portalContainer ?? document.body,
  );
}
