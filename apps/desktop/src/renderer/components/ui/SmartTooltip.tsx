import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
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
type TooltipCoordinates = { x: number; y: number; side: TooltipSide };

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
const TOOLTIP_TRANSFORMS: Record<TooltipSide, string> = {
  top: "translate(-50%, -100%)",
  bottom: "translate(-50%, 0)",
  right: "translate(0, -50%)",
  left: "translate(-100%, -50%)",
};

function clampToRange(value: number, min: number, max: number, fallback: number): number {
  if (min > max) return fallback;
  return Math.min(Math.max(value, min), max);
}

function flipSide(preferredSide: TooltipSide, fits: {
  top: boolean;
  bottom: boolean;
  right: boolean;
  left: boolean;
}): TooltipSide {
  switch (preferredSide) {
    case "top":
      return !fits.top && fits.bottom ? "bottom" : "top";
    case "bottom":
      return !fits.bottom && fits.top ? "top" : "bottom";
    case "right":
      return !fits.right && fits.left ? "left" : "right";
    case "left":
      return !fits.left && fits.right ? "right" : "left";
    default: {
      const _exhaustive: never = preferredSide;
      return _exhaustive;
    }
  }
}

function placeTooltip(
  preferredSide: TooltipSide,
  trigger: DOMRect,
  tooltip: DOMRect,
  vw: number,
  vh: number,
): TooltipCoordinates {
  const topY = trigger.top - GAP;
  const bottomY = trigger.bottom + GAP;
  const rightX = trigger.right + GAP;
  const leftX = trigger.left - GAP;
  const cx = trigger.left + trigger.width / 2;
  const cy = trigger.top + trigger.height / 2;
  const side = flipSide(preferredSide, {
    top: topY - tooltip.height >= VIEWPORT_PAD,
    bottom: bottomY + tooltip.height <= vh - VIEWPORT_PAD,
    right: rightX + tooltip.width <= vw - VIEWPORT_PAD,
    left: leftX - tooltip.width >= VIEWPORT_PAD,
  });

  switch (side) {
    case "top":
      return {
        side,
        x: clampToRange(cx, VIEWPORT_PAD + tooltip.width / 2, vw - VIEWPORT_PAD - tooltip.width / 2, vw / 2),
        y: clampToRange(topY, VIEWPORT_PAD + tooltip.height, vh - VIEWPORT_PAD, vh / 2),
      };
    case "bottom":
      return {
        side,
        x: clampToRange(cx, VIEWPORT_PAD + tooltip.width / 2, vw - VIEWPORT_PAD - tooltip.width / 2, vw / 2),
        y: clampToRange(bottomY, VIEWPORT_PAD, vh - VIEWPORT_PAD - tooltip.height, vh / 2),
      };
    case "right":
      return {
        side,
        x: clampToRange(rightX, VIEWPORT_PAD, vw - VIEWPORT_PAD - tooltip.width, vw / 2),
        y: clampToRange(cy, VIEWPORT_PAD + tooltip.height / 2, vh - VIEWPORT_PAD - tooltip.height / 2, vh / 2),
      };
    case "left":
      return {
        side,
        x: clampToRange(leftX, VIEWPORT_PAD + tooltip.width, vw - VIEWPORT_PAD, vw / 2),
        y: clampToRange(cy, VIEWPORT_PAD + tooltip.height / 2, vh - VIEWPORT_PAD - tooltip.height / 2, vh / 2),
      };
    default: {
      const _exhaustive: never = side;
      return _exhaustive;
    }
  }
}

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
  const [coords, setCoords] = useState<TooltipCoordinates | null>(null);
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

  const dismiss = useCallback(() => {
    setVisible(false);
    setCoords(null);
  }, []);

  const show = useCallback(() => {
    if (!enabled) return;
    clearHideTimer();
    showTimerRef.current = setTimeout(() => {
      if (!triggerRef.current) return;
      setVisible(true);
    }, HOVER_DELAY);
  }, [enabled, clearHideTimer]);

  const hide = useCallback(() => {
    clearShowTimer();
    // When a link is showing, hold the tooltip open briefly so the cursor can
    // cross the gap into the portal. Portal onMouseEnter cancels this timer.
    if (content.docUrl) {
      clearHideTimer();
      hideTimerRef.current = setTimeout(() => {
        dismiss();
      }, HIDE_DELAY);
      return;
    }
    dismiss();
  }, [clearShowTimer, clearHideTimer, content.docUrl, dismiss]);

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

  useLayoutEffect(() => {
    if (!visible) return;
    const trigger = triggerRef.current;
    const tooltip = tooltipRef.current;
    if (!trigger || !tooltip) return;
    const next = placeTooltip(
      preferredSide,
      trigger.getBoundingClientRect(),
      tooltip.getBoundingClientRect(),
      window.innerWidth,
      window.innerHeight,
    );
    setCoords((prev) => (
      prev && prev.x === next.x && prev.y === next.y && prev.side === next.side ? prev : next
    ));
  }, [visible, preferredSide]);

  const hasExtra = Boolean(content.gitCommand || content.effect || content.warning || content.shortcut);
  const childDescribedBy = children.props["aria-describedby"];
  const describedBy = visible
    ? [childDescribedBy, tooltipId].filter(Boolean).join(" ") || undefined
    : childDescribedBy;
  const trigger = React.cloneElement(children, {
    "aria-describedby": describedBy,
    ...(enabled ? {} : { title: children.props.title ?? content.label }),
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
      {visible
        ? createPortal(
            <div
              ref={tooltipRef}
              id={tooltipId}
              role="tooltip"
              className="ade-smart-tooltip"
              data-side={coords?.side}
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
                left: coords?.x ?? 0,
                top: coords?.y ?? 0,
                transform: coords ? TOOLTIP_TRANSFORMS[coords.side] : undefined,
                visibility: coords ? "visible" : "hidden",
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
