import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useClampedFixedPosition, type FixedAnchor } from "../../hooks/useClampedFixedPosition";

const GAP = 8;
const CLOSE_DELAY_MS = 140;
const VIEWPORT_PADDING = 8;

/**
 * PR detail lists live outside their lane/session card so card overflow cannot
 * clip them. The anchor is measured only when the card opens; scroll/resize
 * dismisses it instead of installing a hot-path reposition listener.
 */
export function LanePrHoverCard({
  children,
  content,
  label,
  width,
  className,
}: {
  children: React.ReactNode;
  content: React.ReactNode;
  label: string;
  width: number;
  className?: string;
}) {
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [anchor, setAnchor] = useState<FixedAnchor | null>(null);
  const { ref: panelRef, position } = useClampedFixedPosition(anchor, label);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current == null) return;
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const close = useCallback(() => {
    cancelClose();
    setAnchor(null);
  }, [cancelClose]);

  const scheduleClose = useCallback(() => {
    const activeElement = typeof document !== "undefined" ? document.activeElement : null;
    if (activeElement && (triggerRef.current?.contains(activeElement) || panelRef.current?.contains(activeElement))) {
      return;
    }
    cancelClose();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setAnchor(null);
    }, CLOSE_DELAY_MS);
  }, [cancelClose, panelRef]);

  const open = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    cancelClose();
    const rect = trigger.getBoundingClientRect();
    setAnchor({ x: rect.left, y: rect.bottom + GAP });
  }, [cancelClose]);

  const isWithinCard = useCallback((target: EventTarget | null): boolean => {
    return target instanceof Node && Boolean(
      triggerRef.current?.contains(target) || panelRef.current?.contains(target),
    );
  }, [panelRef]);

  useEffect(() => {
    if (!anchor) return undefined;
    const closeOnViewportChange = () => close();
    window.addEventListener("scroll", closeOnViewportChange, true);
    window.addEventListener("resize", closeOnViewportChange);
    return () => {
      window.removeEventListener("scroll", closeOnViewportChange, true);
      window.removeEventListener("resize", closeOnViewportChange);
    };
  }, [anchor, close]);

  useEffect(() => () => {
    if (closeTimerRef.current != null) clearTimeout(closeTimerRef.current);
  }, []);

  const trigger = (
    <span
      ref={triggerRef}
      className={className}
      onClick={(event) => {
        event.stopPropagation();
      }}
      onMouseDown={(event) => {
        event.stopPropagation();
      }}
      onMouseEnter={open}
      onMouseLeave={scheduleClose}
      onFocus={open}
      onBlur={(event) => {
        if (!isWithinCard(event.relatedTarget)) scheduleClose();
      }}
    >
      {children}
    </span>
  );

  if (!anchor || typeof document === "undefined" || !document.body) return trigger;

  const fallbackLeft = Math.min(
    Math.max(VIEWPORT_PADDING, anchor.x),
    Math.max(VIEWPORT_PADDING, window.innerWidth - width - VIEWPORT_PADDING),
  );
  const panel = (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={label}
      data-testid="lane-pr-hover-card"
      onMouseEnter={cancelClose}
      onMouseLeave={scheduleClose}
      onFocus={cancelClose}
      onBlur={(event) => {
        if (!isWithinCard(event.relatedTarget)) scheduleClose();
      }}
      style={{
        position: "fixed",
        zIndex: 9999,
        left: position?.left ?? fallbackLeft,
        top: position?.top ?? anchor.y,
        width,
        maxWidth: `calc(100vw - ${VIEWPORT_PADDING * 2}px)`,
        maxHeight: `calc(100vh - ${VIEWPORT_PADDING * 2}px)`,
        overflowY: "auto",
      }}
    >
      {content}
    </div>
  );

  return (
    <>
      {trigger}
      {createPortal(panel, document.body)}
    </>
  );
}
