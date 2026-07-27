import React, { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Moon } from "@phosphor-icons/react";
import type { TerminalSessionSummary } from "../../../shared/types";
import { useClampedFixedPosition } from "../../hooks/useClampedFixedPosition";
import { SNOOZE_DURATION_OPTIONS, type SnoozeDurationKey } from "../../lib/sessionSnooze";
import { snoozeSessionForDuration, wakeSessionNow } from "./sessionLifecycleActions";
import { cn } from "../ui/cn";

/**
 * Hover-revealed snooze affordance on a session row. Kept out of `SessionCard`'s
 * render body so the hot Work list only pays for a single always-mounted button
 * (revealed with CSS, not a hover state that would re-render the row) plus menu
 * state that exists only after a click.
 *
 * The menu is a locally-owned fixed popover clamped to the viewport, matching
 * `SessionContextMenu` — no document-level listener is added; the backdrop
 * element closes it.
 */
export function SessionSnoozeControl({
  session,
  snoozed,
  compact = false,
}: {
  session: Pick<TerminalSessionSummary, "id">;
  /** Already snoozed rows offer "Wake now" instead of a duration menu. */
  snoozed: boolean;
  compact?: boolean;
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const { ref: menuRef, position } = useClampedFixedPosition(anchor);

  const close = useCallback(() => setAnchor(null), []);

  const openMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = buttonRef.current?.getBoundingClientRect();
    setAnchor(rect ? { x: rect.left, y: rect.bottom + 4 } : { x: event.clientX, y: event.clientY });
  }, []);

  const choose = useCallback(
    (key: SnoozeDurationKey) => {
      close();
      void snoozeSessionForDuration(session, key);
    },
    [close, session],
  );

  const label = snoozed ? "Wake session now" : "Snooze session";

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-testid="session-snooze-button"
        aria-label={label}
        aria-haspopup={snoozed ? undefined : "menu"}
        aria-expanded={snoozed ? undefined : anchor != null}
        title={label}
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-md border border-white/[0.08] bg-bg/85 text-muted-fg/60 backdrop-blur-sm transition-colors",
          "hover:border-white/[0.14] hover:text-fg/85 focus-visible:opacity-100",
          // Revealed by the row's `group` hover; always focusable for keyboard users.
          snoozed || anchor ? "opacity-100" : "opacity-0 focus:opacity-100 group-hover:opacity-100",
          compact ? "h-4 w-4" : "h-5 w-5",
        )}
        onClick={(event) => {
          if (snoozed) {
            event.preventDefault();
            event.stopPropagation();
            void wakeSessionNow(session);
            return;
          }
          openMenu(event);
        }}
      >
        <Moon size={compact ? 10 : 12} weight={snoozed ? "fill" : "regular"} />
      </button>

      {/* Portalled: the row's hover-action wrapper is `pointer-events-none`
          until hovered, and a fixed child would inherit that and stop being
          clickable the moment the pointer left the card. */}
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
            className="ade-liquid-glass-menu fixed z-50 min-w-[180px] py-1"
            style={{
              ...(position ?? { left: anchor.x, top: anchor.y }),
              visibility: position ? "visible" : "hidden",
            }}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {SNOOZE_DURATION_OPTIONS.map((option) => (
              <button
                key={option.key}
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted/40"
                onClick={() => choose(option.key)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </>,
        document.body,
      ) : null}
    </>
  );
}
