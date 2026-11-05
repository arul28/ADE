import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AnchoredTooltip } from "./AnchoredTooltip";
import type { TooltipSide } from "./tooltipPosition";

/**
 * A "?" with one short explanation behind it: a settings title, a status chip.
 *
 * Hover, focus and click open it, so it is reachable without a mouse; a click
 * after hover keeps it open rather than toggling it shut. The pointer can move
 * onto the text (to magnify it, say) without it closing; it closes once the
 * pointer leaves both, on blur, and on Escape wherever focus is. It renders on the tooltip layer (`AnchoredTooltip`), so no
 * scrolling or clipping parent can cut it off. Callers bring their own look:
 * `triggerStyle` may depend on whether it is open.
 */
const HIDE_DELAY_MS = 140;

export function HelpHint({
  text,
  label = "What is this?",
  side = "bottom",
  triggerClassName,
  triggerStyle,
  tooltipClassName,
  tooltipStyle,
}: {
  text: ReactNode;
  label?: string;
  side?: TooltipSide;
  triggerClassName?: string | ((open: boolean) => string);
  triggerStyle?: CSSProperties | ((open: boolean) => CSSProperties);
  tooltipClassName?: string;
  tooltipStyle?: CSSProperties;
}) {
  const id = useId();
  const descriptionId = useId();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    setOpen(true);
  }, []);
  // A short grace to cross the gap between the "?" and the text.
  const hideSoon = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), HIDE_DELAY_MS);
  }, []);
  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-describedby={descriptionId}
        aria-expanded={open}
        onMouseEnter={show}
        onMouseLeave={hideSoon}
        onFocus={show}
        onBlur={() => setOpen(false)}
        onClick={show}
        className={typeof triggerClassName === "function" ? triggerClassName(open) : triggerClassName}
        style={typeof triggerStyle === "function" ? triggerStyle(open) : triggerStyle}
      >
        ?
      </button>
      {/* Always there for assistive tech; the tooltip is for the eye. */}
      <span id={descriptionId} className="sr-only">{text}</span>
      {open ? (
        <AnchoredTooltip
          open
          triggerRef={triggerRef}
          side={side}
          remeasureKey={text}
          onDismiss={() => setOpen(false)}
          id={id}
          className={tooltipClassName}
          // The tooltip layer passes the pointer through; this one is hoverable.
          style={{ pointerEvents: "auto", ...tooltipStyle }}
        >
          <div onMouseEnter={show} onMouseLeave={hideSoon}>{text}</div>
        </AnchoredTooltip>
      ) : null}
    </>
  );
}
