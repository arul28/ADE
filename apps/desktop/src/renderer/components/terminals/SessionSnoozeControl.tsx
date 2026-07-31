import React, { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Moon } from "@phosphor-icons/react";
import type { OpenProjectBinding, TerminalSessionSummary } from "../../../shared/types";
import { useClampedFixedPosition } from "../../hooks/useClampedFixedPosition";
import {
  resolveSnoozePresets,
  snoozeWakeDescription,
  type SnoozeDurationKey,
  type SnoozePreset,
} from "../../lib/sessionSnooze";
import { snoozeSessionForDuration, wakeSessionNow } from "./sessionLifecycleActions";
import { cn } from "../ui/cn";

/**
 * Snooze affordance for a session row, living inside the row's status slot
 * (`SessionStatusSlot`). Kept out of `SessionCard`'s render body so the hot
 * Work list only pays for a single always-mounted button plus menu state that
 * exists only after a click.
 *
 * Visibility is NOT this component's business any more: the status slot swaps
 * the whole action cluster in on hover/focus, so a second hover rule here would
 * fight it. The button is always painted; the slot decides whether the slot is.
 *
 * The menu is a locally-owned fixed popover clamped to the viewport, matching
 * `SessionContextMenu` — no document-level listener is added; the backdrop
 * element closes it.
 *
 * Its rows are NOT a constant: `resolveSnoozePresets` computes them against the
 * wall clock, so the list is resolved on open (see `openMenu`) rather than
 * built once at module load.
 */
export function SessionSnoozeControl({
  session,
  snoozed,
  compact = false,
  runtimePin = null,
  onOpenChange,
}: {
  session: Pick<TerminalSessionSummary, "id" | "snoozedUntil">;
  /** Already snoozed rows offer "Wake now" instead of a duration menu. */
  snoozed: boolean;
  compact?: boolean;
  runtimePin?: OpenProjectBinding | null;
  /**
   * Reported on every open/close so the status slot can pin itself visible
   * while the popover is up — the pointer is over the menu, not the row, and
   * the hover-driven actions would otherwise fade out from under it.
   */
  onOpenChange?: (open: boolean) => void;
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  // Resolved once per open rather than per render: the rows are time-dependent
  // (see `resolveSnoozePresets`) and a list that reshuffled underneath an open
  // menu would move the row the pointer is already travelling towards.
  const [presets, setPresets] = useState<readonly SnoozePreset[]>([]);
  const { ref: menuRef, position } = useClampedFixedPosition(anchor);

  const close = useCallback(() => {
    setAnchor(null);
    onOpenChange?.(false);
  }, [onOpenChange]);

  const openMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = buttonRef.current?.getBoundingClientRect();
    setPresets(resolveSnoozePresets(Date.now()));
    setAnchor(rect ? { x: rect.left, y: rect.bottom + 4 } : { x: event.clientX, y: event.clientY });
    onOpenChange?.(true);
  }, [onOpenChange]);

  const choose = useCallback(
    (key: SnoozeDurationKey) => {
      close();
      // Re-resolved at click time, not the deadline shown when the menu opened:
      // a menu left open across the hour would otherwise write a deadline in
      // the past. The time column can drift by the age of the open menu; the
      // deadline may not.
      void snoozeSessionForDuration(session, key, Date.now(), runtimePin);
    },
    [close, runtimePin, session],
  );

  const label = snoozed ? "Wake session now" : "Snooze session";
  // The button's tooltip is the one place a snoozed row can state its wake time
  // in full — the status slot beside it only has room for the "wakes in 3h"
  // countdown.
  const wakeDescription = snoozed ? snoozeWakeDescription(session.snoozedUntil) : null;
  const title = wakeDescription ? `${label} · wakes ${wakeDescription}` : label;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-testid="session-snooze-button"
        aria-label={label}
        aria-haspopup={snoozed ? undefined : "menu"}
        aria-expanded={snoozed ? undefined : anchor != null}
        title={title}
        className={cn(
          "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md bg-transparent text-muted-fg/70 transition-colors",
          // Same hover pill as `SESSION_ACTION_BUTTON_CLASS` in
          // SessionStatusSlot (spelled out rather than imported: that module
          // renders THIS one, and importing back would close a module cycle).
          "hover:bg-white/[0.06] hover:text-fg focus-visible:bg-white/[0.06] focus-visible:text-fg",
          compact ? "px-1" : "px-1.5",
        )}
        onClick={(event) => {
          if (snoozed) {
            event.preventDefault();
            event.stopPropagation();
            void wakeSessionNow(session, runtimePin);
            return;
          }
          openMenu(event);
        }}
      >
        <Moon size={compact ? 11 : 13} weight={snoozed ? "fill" : "regular"} aria-hidden />
      </button>

      {/* Portalled: the menu must outlive the row's hover state. Rendered in
          place it would sit inside the status slot's opacity/position swap and
          vanish the moment the pointer left the card to reach it. */}
      {anchor && typeof document !== "undefined" ? createPortal(
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={(event) => {
              event.stopPropagation();
              close();
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              close();
            }}
          />
          <div
            ref={menuRef}
            role="menu"
            aria-label="Snooze session"
            className="ade-liquid-glass-menu fixed z-50 min-w-[210px] py-1"
            style={{
              ...(position ?? { left: anchor.x, top: anchor.y }),
              visibility: position ? "visible" : "hidden",
            }}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {/* Two columns: what you are choosing on the left, when it lands on
                the right. The time column is the whole reason the labels stay
                day-shaped ("Tomorrow", not "Until tomorrow 9am") — see
                `SNOOZE_DURATION_OPTIONS`. */}
            {presets.map((preset) => (
              <button
                key={preset.key}
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-3 rounded px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted/40"
                onClick={() => choose(preset.key)}
              >
                <span className="flex-1 truncate">{preset.label}</span>
                <span className="shrink-0 text-[10px] tabular-nums text-muted-fg/50">
                  {preset.whenLabel}
                </span>
              </button>
            ))}
          </div>
        </>,
        document.body,
      ) : null}
    </>
  );
}
