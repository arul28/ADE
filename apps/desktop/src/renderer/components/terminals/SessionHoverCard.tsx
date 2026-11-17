import React from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "motion/react";
import { useClampedFixedPosition, type FixedAnchor } from "../../hooks/useClampedFixedPosition";
import { cn } from "../ui/cn";
import { MONO_FONT } from "../lanes/laneDesignTokens";
import { isInsideRowHoverSuppress, isPointerOnRowHoverSuppress } from "../ui/rowHoverSuppress";
import { ViewportOverlayHost } from "../ui/ViewportOverlayHost";

/* ──────────────────────────────────────────────────────────────────────────
   The session row's DETAIL CARD.

   Not a tooltip, and deliberately not `SmartTooltip`. Three things the shared
   tooltip cannot do, none of which can be added to it without changing every
   tooltip in the app:

     • it opens on a 320ms tooltip delay — far too eager for a panel this
       heavy, which should only appear when someone has genuinely stopped on a
       row;
     • it positions itself above/below its own trigger, and this card has to
       land over the content area to the RIGHT of the sidebar, never on top of
       the list it describes;
     • its body is a single pre-line string, so it can render `Label: value`
       lines and nothing else — no icons, no per-row colour, no clickable row.

   The content model here is icon-led: there are no `Label:` prefixes because
   the ICON is the label. Each row's icon carries its own colour, and colour is
   load-bearing — see `sessionStatusPresentation.ts` for the one-hue-one-meaning
   rule. Amber means "your move" and nothing else; the only amber in this file
   is the machine tower, an identity mark, exactly as on the row itself.
   ────────────────────────────────────────────────────────────────────────── */

/** How long a pointer must rest on a row before the card appears. */
export const SESSION_HOVER_CARD_DELAY_MS = 1000;
/** Grace for crossing the gap from the row into the card. */
const SESSION_HOVER_CARD_CLOSE_DELAY_MS = 140;
/** Gap between the sidebar's right edge and the card. */
const SESSION_HOVER_CARD_GAP = 10;
/** The card hangs a touch above the row it describes, so the row stays visible. */
const SESSION_HOVER_CARD_LIFT = 6;

/**
 * Module scope on purpose: direct row-to-row handoff crosses hook instances.
 * It is deliberately NOT a timed "warm window": only a pointer entering from
 * the exact row whose card is open skips the cold delay. Coming from blank
 * space, the detail pane, or a row whose card never opened always starts fresh.
 */
let activeHoverCard: {
  rowId: string | null;
  trigger: HTMLElement;
  dismiss: () => void;
} | null = null;

/**
 * A key press or a click means the person is acting, not resting on a row. It
 * cancels a card that is waiting to open, closes an open one, and keeps cards
 * closed until the pointer really moves again. Without the last part, a list
 * that re-sorts under a still pointer (a new chat lands at the top) fires
 * `mouseenter` on another row, and a card opens over the composer the person
 * is typing into.
 */
let waitForPointerMove = false;
let pointerMoveListener: ((event: PointerEvent) => void) | null = null;
/** Movement that counts as the person moving the pointer, in CSS pixels. */
const POINTER_MOVE_THRESHOLD_PX = 3;
/**
 * The row the pointer is resting on, so the end of a hold can restart that
 * row's delay instead of making the person leave and come back. Rows set it on
 * enter and clear it on leave; the release only acts on it while the row still
 * reports hover, so a row the list scrolled away under a still pointer cannot
 * open a card for a pointer that has moved on.
 */
let hoveredRow: { element: HTMLElement; reopen: () => void } | null = null;
/**
 * While the pointer rests on a row, a key press or a press anywhere arms the
 * hold even when no card is open or waiting (a scroll may have just closed
 * one). Otherwise typing with the pointer parked on the list leaves the hold
 * off, and a re-sort that slides another row under the pointer opens a card
 * over the composer one second after the typing pauses. One listener pair,
 * present only while a row is hovered.
 */
let restingActionListener: ((event: Event) => void) | null = null;

function setHoveredRow(next: { element: HTMLElement; reopen: () => void } | null): void {
  hoveredRow = next;
  if (typeof window === "undefined") return;
  if (next && !restingActionListener) {
    restingActionListener = (event: Event) => {
      if (!hoveredRow?.element.isConnected) {
        setHoveredRow(null);
        return;
      }
      if (belongsToHoverCard(event)) return;
      holdCardsUntilPointerMoves(
        event instanceof MouseEvent ? { x: event.clientX, y: event.clientY } : null,
      );
      activeHoverCard?.dismiss();
    };
    window.addEventListener("keydown", restingActionListener, true);
    window.addEventListener("pointerdown", restingActionListener, true);
  } else if (!next && restingActionListener) {
    window.removeEventListener("keydown", restingActionListener, true);
    window.removeEventListener("pointerdown", restingActionListener, true);
    restingActionListener = null;
  }
}

/**
 * `from` is where the press that armed the hold happened, when it was a
 * pointer press. Measuring the first `pointermove` against it means a fast
 * move that arrives as a single event still counts; without it the first
 * event could only seed the origin, and a pointer that then stopped would
 * leave every card shut.
 */
function holdCardsUntilPointerMoves(from: { x: number; y: number } | null): void {
  waitForPointerMove = true;
  if (pointerMoveListener || typeof window === "undefined") return;
  let origin = from;
  pointerMoveListener = (event: PointerEvent) => {
    if (!origin) {
      // A key press has no press position to measure from, but this event's
      // own delta still says how far the pointer came to reach it — so a
      // single move that crossed onto a row counts, instead of only seeding
      // the origin and leaving every card shut until a second move.
      const dx = Number.isFinite(event.movementX) ? event.movementX : 0;
      const dy = Number.isFinite(event.movementY) ? event.movementY : 0;
      origin = { x: event.clientX - dx, y: event.clientY - dy };
    }
    const moved = Math.abs(event.clientX - origin.x) + Math.abs(event.clientY - origin.y);
    if (moved < POINTER_MOVE_THRESHOLD_PX) return;
    releasePointerHold();
  };
  window.addEventListener("pointermove", pointerMoveListener, { capture: true, passive: true });
}

function releasePointerHold(): void {
  waitForPointerMove = false;
  if (pointerMoveListener) window.removeEventListener("pointermove", pointerMoveListener, true);
  pointerMoveListener = null;
  const resting = hoveredRow;
  if (resting?.element.isConnected && resting.element.matches(":hover")) resting.reopen();
}

/**
 * A press, a key, or a text selection on the card's own activatable rows
 * belongs to the card — the branch and tag rows exist to be copied
 * character-exact, and a key press must not unmount the selection first.
 */
function belongsToHoverCard(event: Event): boolean {
  const target = event.target;
  if (target instanceof Element && target.closest("[data-session-hover-card]")) return true;
  if (event.type !== "keydown" || typeof window === "undefined") return false;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  const node = selection.getRangeAt(0).commonAncestorContainer;
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest("[data-session-hover-card]") != null;
}

export type SessionHoverCardRow = {
  /** React key + a stable hook for tests (`data-session-hover-row`). */
  id: string;
  /** Already coloured by the caller — the icon IS the label. */
  icon: React.ReactNode;
  value: React.ReactNode;
  /** Branch names, tags: things that have to be copied character-exact. */
  mono?: boolean;
  /**
   * `fact` (default) is one scannable line; `advice` wraps and recedes — it is
   * a suggestion, not an attribute of the session.
   */
  variant?: "fact" | "advice";
  /** Turns the row into a clickable target (e.g. "open the parent thread"). */
  onActivate?: () => void;
  /** Native title + accessible name for an activatable row. */
  activateLabel?: string;
  testId?: string;
};

/**
 * Hover-intent state machine for one row. Owns the open delay, the close grace
 * and the cancel-on-scroll rule; the card itself is pure presentation.
 */
export function useSessionHoverCard(options?: { disabled?: boolean; rowId?: string }): {
  /** Non-null while the card should be mounted. */
  anchor: FixedAnchor | null;
  triggerProps: Pick<React.HTMLAttributes<HTMLElement>, "onMouseEnter" | "onMouseLeave" | "onMouseOver">;
  cardProps: Pick<React.HTMLAttributes<HTMLElement>, "onMouseEnter" | "onMouseLeave">;
  close: () => void;
} {
  const disabled = Boolean(options?.disabled);
  const rowId = options?.rowId ?? null;
  const [anchor, setAnchor] = React.useState<FixedAnchor | null>(null);
  const [pendingOpen, setPendingOpen] = React.useState(false);
  const openTimerRef = React.useRef<number | null>(null);
  const closeTimerRef = React.useRef<number | null>(null);
  // The element measured when the timer FIRES, not when the pointer arrived:
  // one second is long enough for the list to have moved underneath.
  const triggerElementRef = React.useRef<HTMLElement | null>(null);

  /**
   * Re-resolve the row by id when the captured node has gone stale.
   *
   * One second is enough time in this sidebar for the status slot to re-render
   * every second for the elapsed ticker, rows re-sort on activity, and lane
   * groups run motion layout animations. Any of those can make React swap the
   * wrapper node, and the element captured on mouse-enter is then
   * `isConnected === false`. Bailing on that made the card silently never
   * appear in the running app while every static test still passed — the whole
   * failure mode only exists once the list is actually alive.
   */
  const resolveTriggerElement = React.useCallback((): HTMLElement | null => {
    const captured = triggerElementRef.current;
    if (captured?.isConnected) return captured;
    if (!rowId) return null;
    const selector = `[data-session-row][data-session-id="${CSS.escape(rowId)}"]`;
    const replacement = document.querySelector<HTMLElement>(selector);
    // Only adopt a replacement the pointer is genuinely still resting on —
    // otherwise a row that scrolled away would pop a card for a cursor that
    // has long since moved on.
    if (replacement && replacement.matches(":hover")) {
      triggerElementRef.current = replacement;
      return replacement;
    }
    return null;
  }, [rowId]);

  const clearTimers = React.useCallback(() => {
    setPendingOpen(false);
    if (openTimerRef.current != null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const close = React.useCallback(() => {
    clearTimers();
    setAnchor(null);
    if (activeHoverCard?.rowId === rowId) activeHoverCard = null;
  }, [clearTimers, rowId]);

  const scheduleOpen = React.useCallback(
    (element: HTMLElement, directHandoff: boolean) => {
      // One hover pane at a time. A direct sibling handoff opens below without
      // delay; every other arrival dismisses stale UI and earns a fresh second.
      activeHoverCard?.dismiss();
      triggerElementRef.current = element;
      clearTimers();

      const open = () => {
        setPendingOpen(false);
        // A key press or a click landed while the delay ran and the pointer has
        // not moved since, so this is still a list re-sorting under a resting
        // pointer, not a rest of its own.
        if (waitForPointerMove) return;
        // The pointer moved onto the PR pill (or its list) while the delay ran.
        if (isPointerOnRowHoverSuppress()) return;
        const target = resolveTriggerElement();
        if (!target) return;
        const rect = target.getBoundingClientRect();
        /* The row is full-bleed (see `SESSION_ROW_BLEED_CLASS`), so its right
           edge IS the sidebar pane's right edge — no pane ref, no data
           attribute on a file another owner maintains. The card therefore
           lands over the content area, never over the list it describes. */
        setAnchor({ x: rect.right + SESSION_HOVER_CARD_GAP, y: rect.top - SESSION_HOVER_CARD_LIFT });
        activeHoverCard = { rowId, trigger: target, dismiss: close };
      };

      if (directHandoff) {
        open();
        return;
      }
      setPendingOpen(true);
      openTimerRef.current = window.setTimeout(() => {
        openTimerRef.current = null;
        open();
      }, SESSION_HOVER_CARD_DELAY_MS);
    },
    [clearTimers, close, resolveTriggerElement, rowId],
  );

  const onMouseEnter = React.useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (disabled) return;
      const element = event.currentTarget;
      setHoveredRow({ element, reopen: () => scheduleOpen(element, false) });
      const related = event.relatedTarget;
      const sourceRow = related instanceof Element
        ? related.closest<HTMLElement>("[data-session-row]")
        : null;
      const directHandoff = Boolean(
        activeHoverCard
        && sourceRow
        && sourceRow !== element
        && activeHoverCard.trigger === sourceRow,
      );
      scheduleOpen(element, directHandoff);
    },
    [disabled, scheduleOpen],
  );

  // `mouseover` bubbles, so the row hears the pointer cross into and out of a
  // nested hover control. React also routes events from that control's
  // portalled card through here, which is why the card carries the marker too.
  const pointerOnNestedControlRef = React.useRef(false);
  const onMouseOver = React.useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (disabled) return;
      const nested = isInsideRowHoverSuppress(event.target);
      if (nested === pointerOnNestedControlRef.current) return;
      pointerOnNestedControlRef.current = nested;
      if (nested) {
        close();
        return;
      }
      // Back on the row itself: the card earns its delay again.
      scheduleOpen(event.currentTarget, false);
    },
    [close, disabled, scheduleOpen],
  );

  const onMouseLeave = React.useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (hoveredRow?.element === event.currentTarget) setHoveredRow(null);
    pointerOnNestedControlRef.current = false;
    if (openTimerRef.current != null) {
      // Still waiting: a leave cancels outright, with no close grace.
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      close();
    }, SESSION_HOVER_CARD_CLOSE_DELAY_MS);
  }, [close]);

  const onCardEnter = React.useCallback(() => {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  // A scrolled list moves the anchor out from under the card, and re-measuring
  // mid-scroll would make it chase the row. Cancel instead — the pointer has
  // not "rested" on anything while the list is moving. A key press or a press
  // outside the card cancels too, and holds every card until the pointer moves
  // again; `releasePointerHold` resumes the row the pointer never left. These
  // listeners exist only while a card is open or waiting to open; while the
  // pointer only rests on a row, `setHoveredRow`'s listener arms the hold.
  React.useEffect(() => {
    if (!anchor && !pendingOpen) return undefined;
    const cancel = () => close();
    const yieldToAction = (event: Event) => {
      if (belongsToHoverCard(event)) return;
      holdCardsUntilPointerMoves(
        event instanceof MouseEvent ? { x: event.clientX, y: event.clientY } : null,
      );
      close();
    };
    window.addEventListener("scroll", cancel, true);
    window.addEventListener("resize", cancel);
    window.addEventListener("keydown", yieldToAction, true);
    window.addEventListener("pointerdown", yieldToAction, true);
    return () => {
      window.removeEventListener("scroll", cancel, true);
      window.removeEventListener("resize", cancel);
      window.removeEventListener("keydown", yieldToAction, true);
      window.removeEventListener("pointerdown", yieldToAction, true);
    };
  }, [anchor, close, pendingOpen]);

  React.useEffect(() => clearTimers, [clearTimers]);

  return {
    anchor,
    triggerProps: { onMouseEnter, onMouseLeave, onMouseOver },
    cardProps: { onMouseEnter: onCardEnter, onMouseLeave },
    close,
  };
}

/** Test seam: the active cross-row handoff is module state. */
export function resetSessionHoverCardGroupForTests(): void {
  activeHoverCard = null;
  setHoveredRow(null);
  releasePointerHold();
}

export function SessionHoverCard({
  anchor,
  title,
  rows,
  cardProps,
}: {
  anchor: FixedAnchor;
  title: string;
  rows: SessionHoverCardRow[];
  cardProps?: Pick<React.HTMLAttributes<HTMLElement>, "onMouseEnter" | "onMouseLeave">;
}) {
  // `rows.length` as the remeasure key: the card's height changes with its
  // content, and a stale height would clamp against the wrong box.
  const { ref, position } = useClampedFixedPosition(anchor, rows.length);
  const reduceMotion = useReducedMotion();

  const card = (
    <motion.div
      ref={ref}
      role="tooltip"
      data-testid="session-hover-card"
      data-session-hover-card=""
      className="ade-liquid-glass ade-liquid-glass-menu pointer-events-auto w-[24rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-fg/[0.08] px-3 py-2.5 shadow-2xl"
      initial={false}
      animate={{
        opacity: position ? 1 : 0,
        x: reduceMotion ? 0 : position ? 0 : -6,
      }}
      transition={{
        duration: reduceMotion ? 0 : 0.14,
        ease: [0.22, 1, 0.36, 1],
      }}
      style={{
        /* `position` MUST be set inline. `.ade-liquid-glass` declares
           `position: relative` (index.css), and a class at the same specificity
           loses to it on source order — the card once laid out as a RELATIVE
           box below the fold, painting correctly where nobody could see it.
           The host is a viewport-sized fixed layer, so `absolute` here places
           the card in viewport coordinates. */
        position: "absolute",
        left: position?.left ?? anchor.x,
        top: position?.top ?? anchor.y,
      }}
      {...cardProps}
    >
      <div className="mb-1.5 truncate text-[13px] font-semibold leading-snug text-fg/90">
        {title}
      </div>
      <div className="flex flex-col gap-1">
        {rows.map((row) => (
          <SessionHoverCardFact key={row.id} row={row} />
        ))}
      </div>
    </motion.div>
  );

  return typeof document !== "undefined" && document.body
    ? createPortal(<ViewportOverlayHost layer="tooltip">{card}</ViewportOverlayHost>, document.body)
    : card;
}

function SessionHoverCardFact({ row }: { row: SessionHoverCardRow }) {
  const advice = row.variant === "advice";
  const body = (
    <>
      <span aria-hidden className="flex h-4 w-4 shrink-0 items-center justify-center">
        {row.icon}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1",
          advice ? "leading-snug text-muted-fg/60" : "truncate text-fg/80",
        )}
        style={row.mono ? { fontFamily: MONO_FONT } : undefined}
      >
        {row.value}
      </span>
    </>
  );

  const className = cn(
    "flex w-full gap-2 rounded-md px-1 py-0.5 text-left text-[12px]",
    // Advice wraps to several lines, so its icon aligns to the first line.
    advice ? "items-start" : "items-center",
  );

  if (!row.onActivate) {
    return (
      <div className={className} data-session-hover-row={row.id} data-testid={row.testId}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      // Out of the tab order on purpose: the card is hover-only and must never
      // become a focus stop that steals the keyboard from the row itself.
      tabIndex={-1}
      data-session-hover-row={row.id}
      data-testid={row.testId}
      title={row.activateLabel}
      aria-label={row.activateLabel}
      className={cn(className, "cursor-pointer transition-colors hover:bg-fg/[0.06]")}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        row.onActivate?.();
      }}
    >
      {body}
    </button>
  );
}
