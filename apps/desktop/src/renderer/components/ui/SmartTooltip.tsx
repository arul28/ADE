import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "../../state/appStore";
import { openExternalUrl } from "../../lib/openExternal";

export type SmartTooltipContent = {
  /** Button/action name */
  label: string;
  /** What this action does */
  description: string;
  /** The git command that runs, e.g. "git push origin main" */
  gitCommand?: string;
  /** Contextual: what would happen right now, e.g. "Push 2 commits to origin/main" */
  effect?: string;
  /** Warning text shown in danger color */
  warning?: string;
  /** Keyboard shortcut hint */
  shortcut?: string;
  /** When set, renders a "Learn more →" link opening this URL in a new tab. */
  docUrl?: string;
};

type TooltipSide = "top" | "bottom" | "left" | "right";

type SmartTooltipProps = {
  children: React.ReactElement;
  content: SmartTooltipContent;
  /** Override the global toggle (used for the toggle button itself) */
  forceEnabled?: boolean;
  side?: TooltipSide;
  wrapperClassName?: string;
  wrapperStyle?: React.CSSProperties;
};

const HOVER_DELAY = 320;
// Grace window for moving the cursor from the trigger into the tooltip portal
// when there's an actionable link — without this the portal would unmount the
// moment the cursor crosses the 6px gap.
const HIDE_DELAY = 140;
const GAP = 6;
const VIEWPORT_PAD = 10;

export function SmartTooltip({
  children,
  content,
  forceEnabled,
  side: preferredSide = "top",
  wrapperClassName,
  wrapperStyle,
}: SmartTooltipProps) {
  const globalEnabled = useAppStore((s) => s.smartTooltipsEnabled);
  const enabled = Boolean(forceEnabled ?? globalEnabled);
  const tooltipId = useId();

  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState<{ x: number; y: number; side: TooltipSide } | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearShowTimer = useCallback(() => {
    if (showTimerRef.current) {
      clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
  }, []);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const show = useCallback(() => {
    if (!enabled) return;
    clearHideTimer();
    showTimerRef.current = setTimeout(() => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;

      // Pick side: prefer requested, but flip if no room
      let side = preferredSide;
      if (side === "top" && r.top < 140) side = "bottom";
      else if (side === "bottom" && window.innerHeight - r.bottom < 140) side = "top";
      else if (side === "right" && window.innerWidth - r.right < 160) side = "left";
      else if (side === "left" && r.left < 160) side = "right";

      setCoords({
        x: side === "right" ? r.right + GAP : side === "left" ? r.left - GAP : cx,
        y: side === "top" ? r.top - GAP : side === "bottom" ? r.bottom + GAP : cy,
        side,
      });
      setVisible(true);
    }, HOVER_DELAY);
  }, [enabled, preferredSide, clearHideTimer]);

  const hide = useCallback(() => {
    clearShowTimer();
    // When a link is showing, hold the tooltip open briefly so the cursor can
    // cross the gap into the portal. Portal onMouseEnter cancels this timer.
    if (content.docUrl) {
      clearHideTimer();
      hideTimerRef.current = setTimeout(() => {
        setVisible(false);
      }, HIDE_DELAY);
      return;
    }
    setVisible(false);
  }, [clearShowTimer, clearHideTimer, content.docUrl]);

  const isTooltipFocusTarget = useCallback((target: EventTarget | null): boolean => {
    if (!content.docUrl || !(target instanceof Node)) return false;
    return Boolean(triggerRef.current?.contains(target) || tooltipRef.current?.contains(target));
  }, [content.docUrl]);

  const handleBlur = useCallback((event: React.FocusEvent) => {
    if (isTooltipFocusTarget(event.relatedTarget)) {
      clearHideTimer();
      return;
    }
    hide();
  }, [clearHideTimer, hide, isTooltipFocusTarget]);

  useEffect(
    () => () => {
      if (showTimerRef.current) clearTimeout(showTimerRef.current);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    },
    [],
  );

  // Clamp the rendered tooltip to the viewport after first paint. For
  // left/right placement, use the measured width to flip or clamp horizontally
  // instead of relying only on an estimated available-space threshold.
  useEffect(() => {
    if (!visible || !tooltipRef.current || !coords) return;
    const trigger = triggerRef.current;
    if (!trigger) return;
    const tt = tooltipRef.current;
    const ttRect = tt.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const r = trigger.getBoundingClientRect();
    let side = coords.side;
    let x = coords.x;
    let y = coords.y;

    if (side === "top" || side === "bottom") {
      const half = ttRect.width / 2;
      const minX = VIEWPORT_PAD + half;
      const maxX = vw - VIEWPORT_PAD - half;
      x = minX <= maxX ? Math.min(Math.max(coords.x, minX), maxX) : vw / 2;
    } else {
      const rightX = r.right + GAP;
      const leftX = r.left - GAP;
      const rightFits = rightX + ttRect.width <= vw - VIEWPORT_PAD;
      const leftFits = leftX - ttRect.width >= VIEWPORT_PAD;

      if (side === "right" && !rightFits && leftFits) side = "left";
      if (side === "left" && !leftFits && rightFits) side = "right";

      if (side === "right") {
        const maxX = vw - VIEWPORT_PAD - ttRect.width;
        x = maxX >= VIEWPORT_PAD ? Math.min(Math.max(rightX, VIEWPORT_PAD), maxX) : VIEWPORT_PAD;
      } else {
        const minX = VIEWPORT_PAD + ttRect.width;
        x = minX <= vw - VIEWPORT_PAD
          ? Math.max(Math.min(leftX, vw - VIEWPORT_PAD), minX)
          : vw - VIEWPORT_PAD;
      }
      y = Math.min(Math.max(r.top + r.height / 2, VIEWPORT_PAD + ttRect.height / 2), vh - VIEWPORT_PAD - ttRect.height / 2);
    }

    if (x !== coords.x || y !== coords.y || side !== coords.side) {
      setCoords((prev) => prev ? { ...prev, x, y, side } : prev);
    }
  }, [visible, coords]);

  const hasExtra = Boolean(content.gitCommand || content.effect || content.warning || content.shortcut);
  const childDescribedBy = children.props["aria-describedby"];
  const describedBy = visible
    ? [childDescribedBy, tooltipId].filter(Boolean).join(" ") || undefined
    : childDescribedBy;
  const trigger = React.cloneElement(children, {
    "aria-describedby": describedBy,
  });

  return (
    <>
      <div
        ref={triggerRef}
        className={wrapperClassName}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={handleBlur}
        style={{ display: "inline-flex", ...wrapperStyle }}
      >
        {trigger}
      </div>
      {visible && coords
        ? createPortal(
            <div
              ref={tooltipRef}
              id={tooltipId}
              role="tooltip"
              className="ade-smart-tooltip"
              data-side={coords.side}
              // Hover-grace: when the tooltip hosts an actionable link, cancel any pending
              // show/hide timers so moving the cursor trigger → tooltip doesn't dismiss
              // before the link is clicked. onMouseLeave restarts the hide timer so the
              // tooltip still disappears if the cursor wanders off the portal entirely.
              onMouseEnter={
                content.docUrl
                  ? () => {
                      clearShowTimer();
                      clearHideTimer();
                    }
                  : undefined
              }
              onMouseLeave={content.docUrl ? hide : undefined}
              onFocus={
                content.docUrl
                  ? () => {
                      clearShowTimer();
                      clearHideTimer();
                    }
                  : undefined
              }
              onBlur={content.docUrl ? handleBlur : undefined}
              style={{
                position: "fixed",
                zIndex: 9999,
                left: coords.x,
                top: coords.y,
                transform:
                  coords.side === "top"
                    ? "translate(-50%, -100%)"
                    : coords.side === "bottom"
                      ? "translate(-50%, 0)"
                      : coords.side === "right"
                        ? "translate(0, -50%)"
                        : "translate(-100%, -50%)",
                // Only allow pointer events when there's a link to click; otherwise preserve
                // the original click-through behaviour.
                pointerEvents: content.docUrl ? "auto" : "none",
              }}
            >
              {/* Header row: label + optional shortcut */}
              <div className="ade-stt-head">
                <span className="ade-stt-label">{content.label}</span>
                {content.shortcut ? <kbd className="ade-stt-kbd">{content.shortcut}</kbd> : null}
              </div>

              {/* Description */}
              <p className="ade-stt-desc">{content.description}</p>

              {/* Extra section: command, effect, warning */}
              {hasExtra ? (
                <div className="ade-stt-extra">
                  {content.gitCommand ? (
                    <code className="ade-stt-cmd">{content.gitCommand}</code>
                  ) : null}
                  {content.effect ? (
                    <span className="ade-stt-effect">{content.effect}</span>
                  ) : null}
                  {content.warning ? (
                    <span className="ade-stt-warn">{content.warning}</span>
                  ) : null}
                </div>
              ) : null}

              {content.docUrl ? (
                <a
                  className="ade-stt-doc"
                  href={content.docUrl}
                  onClick={(e) => {
                    e.preventDefault();
                    openExternalUrl(content.docUrl);
                  }}
                >
                  Learn more →
                </a>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
