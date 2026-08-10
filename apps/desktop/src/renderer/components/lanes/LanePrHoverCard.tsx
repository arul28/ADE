import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useClampedFixedPosition, type FixedAnchor } from "../../hooks/useClampedFixedPosition";

const GAP = 8;
const CLOSE_DELAY_MS = 140;
const VIEWPORT_PADDING = 8;

/**
 * PR detail lists live outside their lane/session card so card overflow cannot
 * clip them. The anchor is measured only when the card opens; viewport
 * scroll/resize dismisses it instead of installing a hot-path reposition
 * listener. Internal panel scrolling remains available for long PR lists.
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
  const focusPanelOnOpenRef = useRef(false);
  const [anchor, setAnchor] = useState<FixedAnchor | null>(null);
  const { ref: panelRef, position } = useClampedFixedPosition(anchor, label);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current == null) return;
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const close = useCallback(() => {
    cancelClose();
    focusPanelOnOpenRef.current = false;
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

  const focusTrigger = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const focusable = trigger.querySelector<HTMLElement>(
      "button, a[href], input, select, textarea, [tabindex]:not([tabindex=\"-1\"])",
    );
    focusable?.focus();
  }, []);

  const openFromKeyboard = useCallback(() => {
    focusPanelOnOpenRef.current = true;
    open();
  }, [open]);

  const closeAndRestoreFocus = useCallback(() => {
    close();
    requestAnimationFrame(focusTrigger);
  }, [close, focusTrigger]);

  const isWithinCard = useCallback((target: EventTarget | null): boolean => {
    return target instanceof Node && Boolean(
      triggerRef.current?.contains(target) || panelRef.current?.contains(target),
    );
  }, [panelRef]);

  useEffect(() => {
    if (!anchor) return undefined;
    const closeOnViewportChange = (event: Event) => {
      if (event.type === "scroll" && event.target instanceof Node && panelRef.current?.contains(event.target)) {
        return;
      }
      close();
    };
    window.addEventListener("scroll", closeOnViewportChange, true);
    window.addEventListener("resize", closeOnViewportChange);
    return () => {
      window.removeEventListener("scroll", closeOnViewportChange, true);
      window.removeEventListener("resize", closeOnViewportChange);
    };
  }, [anchor, close, panelRef]);

  useLayoutEffect(() => {
    if (!anchor || !focusPanelOnOpenRef.current || !panelRef.current) return;
    focusPanelOnOpenRef.current = false;
    const firstInteractive = panelRef.current.querySelector<HTMLElement>(
      "button, a[href], input, select, textarea, [role=\"button\"], [tabindex]:not([tabindex=\"-1\"])",
    );
    firstInteractive?.focus();
  }, [anchor, panelRef]);

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
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          event.stopPropagation();
          openFromKeyboard();
        } else if (event.key === "Escape" && anchor) {
          event.preventDefault();
          event.stopPropagation();
          closeAndRestoreFocus();
        }
      }}
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
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        closeAndRestoreFocus();
      }}
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
