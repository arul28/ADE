import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
} from "react";
import { createPortal } from "react-dom";
import { computeTooltipPosition, type TooltipPlacement, type TooltipSide } from "./tooltipPosition";

/**
 * The one tooltip the Work tools pane uses.
 *
 * `SmartTooltip` is the app's *rich* tooltip — a titled card with a command, an
 * effect line and a docs link, gated behind a user preference. Pane chrome
 * needs the opposite: one short string, always available, and small enough that
 * it never becomes the thing you are reading. The previous chrome used native
 * `title=`, which the OS clipped at the pane edge ("Clos"), stranded after a
 * click, and happily painted over the control it described.
 *
 * Contract:
 * - 500ms hover intent before it appears; KEYBOARD focus shows it immediately
 *   (a focused control has already been chosen deliberately). Mouse focus does
 *   not — a `<button>` takes focus after `pointerdown`, so treating any focus
 *   as a summon popped the tooltip open on the very click meant to dismiss it.
 * - Dismissed by pointer leave, any click, any keydown, scroll, or window blur.
 * - Portalled to `document.body` and positioned by `computeTooltipPosition`,
 *   which flips then shifts to stay inside the window and is guaranteed never
 *   to overlap the trigger.
 * - `pointer-events: none`, so it can never eat the click it is describing.
 */

const HOVER_DELAY_MS = 500;

/**
 * True when anything inside the trigger is cut off by its own box.
 *
 * `scrollWidth > clientWidth` is the browser's own answer to "did this
 * truncate", so it stays correct at every pane width without a resize
 * observer. Read once per hover, over the handful of nodes a piece of pane
 * chrome contains.
 */
function containsClippedText(root: HTMLElement): boolean {
  const nodes = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))];
  return nodes.some((node) => node.scrollWidth > node.clientWidth + 1);
}

export function PaneTooltip({
  label,
  shortcut,
  side = "bottom",
  disabled = false,
  onlyWhenClipped = false,
  children,
  className,
  style,
}: {
  /** The whole tooltip. One line; keep it short enough to read at a glance. */
  label: string;
  /** Optional key-cap rendered after the label. */
  shortcut?: string;
  side?: TooltipSide;
  /** Skips the tooltip entirely — used when a control has no useful label yet. */
  disabled?: boolean;
  /**
   * Only show when the trigger's own text is truncated.
   *
   * For chrome that already displays the whole string — a picker card reading
   * "Terminal / No shells" — a tooltip repeating it is a panel that appears
   * over the NEXT row and tells you nothing. With this on, the tooltip is
   * exactly what it claims to be: the rest of a line you cannot finish reading.
   */
  onlyWhenClipped?: boolean;
  children: React.ReactNode;
  /** Applied to the inline wrapper that owns the hover/focus handlers. */
  className?: string;
  /**
   * Also applied to that wrapper. The wrapper is the real layout box — in a
   * grid it becomes the grid item — so callers occasionally need to place it.
   */
  style?: React.CSSProperties;
}) {
  const tooltipId = useId();
  const [visible, setVisible] = useState(false);
  const [placement, setPlacement] = useState<TooltipPlacement | null>(null);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const hide = useCallback(() => {
    clearTimer();
    setVisible(false);
    setPlacement(null);
  }, [clearTimer]);

  // Read at show time, not at hover time: the trigger may have been re-laid out
  // (or the pane resized) between the pointer arriving and the delay elapsing.
  const hasSomethingToAdd = useCallback(() => {
    if (disabled || !label) return false;
    if (!onlyWhenClipped) return true;
    const wrapper = wrapperRef.current;
    return wrapper ? containsClippedText(wrapper) : true;
  }, [disabled, label, onlyWhenClipped]);

  const showAfterDelay = useCallback(() => {
    if (disabled || !label) return;
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      if (hasSomethingToAdd()) setVisible(true);
    }, HOVER_DELAY_MS);
  }, [clearTimer, disabled, hasSomethingToAdd, label]);

  const showNow = useCallback(() => {
    if (!hasSomethingToAdd()) return;
    clearTimer();
    setVisible(true);
  }, [clearTimer, hasSomethingToAdd]);

  /**
   * Focus shows the tooltip only for KEYBOARD focus.
   *
   * A `<button>` takes focus AFTER `pointerdown`, so `onPointerDown={hide}`
   * followed by `onFocus={showNow}` ran in exactly the wrong order: clicking a
   * wrapped control that stays mounted popped the tooltip open on the click —
   * the behaviour the pointerdown handler exists to prevent. `:focus-visible`
   * is the browser's own "was this focus keyboard-driven" answer.
   */
  const showOnKeyboardFocus = useCallback((event: ReactFocusEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null;
    // jsdom and older engines have no `:focus-visible`; there, keep the old
    // behaviour rather than silently losing the tooltip on Tab.
    let keyboardFocused = true;
    try {
      keyboardFocused = target?.matches?.(":focus-visible") ?? true;
    } catch {
      keyboardFocused = true;
    }
    if (keyboardFocused) showNow();
  }, [showNow]);

  useEffect(() => clearTimer, [clearTimer]);

  // Any of these means the person moved on: a tooltip that outlives the gesture
  // that summoned it is the "stuck tooltip" bug, not a helpful hint.
  useEffect(() => {
    if (!visible) return undefined;
    const dismiss = () => hide();
    window.addEventListener("keydown", dismiss, true);
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("wheel", dismiss, true);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("keydown", dismiss, true);
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("wheel", dismiss, true);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("blur", dismiss);
    };
  }, [hide, visible]);

  useLayoutEffect(() => {
    if (!visible) return;
    const wrapper = wrapperRef.current;
    const tooltip = tooltipRef.current;
    if (!wrapper || !tooltip) return;
    const triggerBox = wrapper.getBoundingClientRect();
    const tooltipBox = tooltip.getBoundingClientRect();
    const next = computeTooltipPosition({
      preferredSide: side,
      trigger: {
        top: triggerBox.top,
        left: triggerBox.left,
        right: triggerBox.right,
        bottom: triggerBox.bottom,
        width: triggerBox.width,
        height: triggerBox.height,
      },
      tooltip: { width: tooltipBox.width, height: tooltipBox.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    setPlacement((previous) => (
      previous && previous.x === next.x && previous.y === next.y && previous.side === next.side
        ? previous
        : next
    ));
  }, [side, visible]);

  /**
   * `aria-describedby` belongs on the FOCUSABLE node, not on the wrapper.
   *
   * The wrapper is a layout `<span>`; a screen reader announces the description
   * of the element the user is on, which is the `<button>` inside. Merged with
   * any value the child already carries so a caller's own description is not
   * dropped, and only while the tooltip is actually up.
   */
  const describedChildren = React.isValidElement(children) && visible
    ? React.cloneElement(children as React.ReactElement<{ "aria-describedby"?: string }>, {
      "aria-describedby": [
        (children as React.ReactElement<{ "aria-describedby"?: string }>).props["aria-describedby"],
        tooltipId,
      ].filter(Boolean).join(" "),
    })
    : children;

  return (
    <>
      <span
        ref={wrapperRef}
        className={className}
        style={{ display: "inline-flex", ...style }}
        onPointerEnter={showAfterDelay}
        onPointerLeave={hide}
        onPointerDown={hide}
        onFocus={showOnKeyboardFocus}
        onBlur={hide}
        // Fallback only: when `children` is not a single element (a fragment,
        // a string) there is nothing to clone, and the wrapper is the closest
        // thing to the described control there is.
        aria-describedby={visible && !React.isValidElement(children) ? tooltipId : undefined}
      >
        {describedChildren}
      </span>
      {visible
        ? createPortal(
            <div
              ref={tooltipRef}
              id={tooltipId}
              role="tooltip"
              className="ade-pane-tooltip"
              data-side={placement?.side ?? side}
              style={{
                position: "fixed",
                zIndex: 9999,
                left: placement?.x ?? 0,
                top: placement?.y ?? 0,
                pointerEvents: "none",
                // Hidden for the measuring pass so it never flashes at 0,0.
                visibility: placement ? "visible" : "hidden",
              }}
            >
              <span>{label}</span>
              {shortcut ? <kbd className="ade-pane-tooltip-kbd">{shortcut}</kbd> : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
