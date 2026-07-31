import React from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "motion/react";
import { useClampedFixedPosition, type FixedAnchor } from "../../hooks/useClampedFixedPosition";
import { cn } from "../ui/cn";
import { MONO_FONT } from "../lanes/laneDesignTokens";

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
  triggerProps: Pick<React.HTMLAttributes<HTMLElement>, "onMouseEnter" | "onMouseLeave">;
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

  const onMouseEnter = React.useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (disabled) return;
      const element = event.currentTarget;
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

      // One hover pane at a time. A direct sibling handoff opens below without
      // delay; every other arrival dismisses stale UI and earns a fresh second.
      activeHoverCard?.dismiss();
      triggerElementRef.current = element;
      clearTimers();

      const open = () => {
        setPendingOpen(false);
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
    [clearTimers, close, disabled, resolveTriggerElement, rowId],
  );

  const onMouseLeave = React.useCallback(() => {
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
  // not "rested" on anything while the list is moving.
  React.useEffect(() => {
    if (!anchor && !pendingOpen) return undefined;
    const cancel = () => close();
    window.addEventListener("scroll", cancel, true);
    window.addEventListener("resize", cancel);
    return () => {
      window.removeEventListener("scroll", cancel, true);
      window.removeEventListener("resize", cancel);
    };
  }, [anchor, close, pendingOpen]);

  React.useEffect(() => clearTimers, [clearTimers]);

  return {
    anchor,
    triggerProps: { onMouseEnter, onMouseLeave },
    cardProps: { onMouseEnter: onCardEnter, onMouseLeave },
    close,
  };
}

/** Test seam: the active cross-row handoff is module state. */
export function resetSessionHoverCardGroupForTests(): void {
  activeHoverCard = null;
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
      className="ade-liquid-glass ade-liquid-glass-menu fixed z-[2000] w-[19rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-white/[0.08] px-3 py-2.5 shadow-2xl"
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
        /* `position` MUST be set inline, not left to the `fixed` utility in the
           class list above. `.ade-liquid-glass` declares `position: relative`
           (index.css) at the same specificity as Tailwind's `.fixed`, and it
           wins on source order — so the card silently laid out as a RELATIVE
           box offset from its normal flow position at the end of <body>.
           Measured in the browser: inline `top: 76px` resolved to a real
           `rect.top` of 938 in an 862px viewport, i.e. entirely below the fold.
           The card was mounting and painting correctly the whole time; nobody
           could see it. Inline beats both rules and pins the intent here. */
        position: "fixed",
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
    ? createPortal(card, document.body)
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
      className={cn(className, "cursor-pointer transition-colors hover:bg-white/[0.06]")}
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
