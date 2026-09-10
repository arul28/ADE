import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useAppStore, type WorkSidebarTab } from "../../state/appStore";
import { cn } from "../ui/cn";
import { WorkToolPickerBackdrop } from "./WorkToolPickerBackdrop";
import { PaneTooltip } from "../ui/PaneTooltip";
import {
  WORK_TOOL_DEFINITIONS,
  workToolAvailability,
  type WorkToolContext,
} from "./workTools";
import {
  workToolHasError,
  workToolSummary,
  type WorkToolStatusMap,
} from "./useWorkToolStatuses";

/**
 * Two columns, or one. Never three.
 *
 * Expressed as a track minimum rather than a media/container query so it can
 * never disagree with the real width: with 24px of padding either side and an
 * 8px gutter, two 188px tracks need 432px of pane and three need 628px — more
 * than the column is ever allowed to be. That arithmetic is the cap. A wide
 * pane used to reach three tracks and spend the extra width making every card
 * SMALLER (149px at 527px of pane); the cards now grow with the pane instead,
 * from 188px at the two-column threshold to 252px at the column's full width.
 *
 * 188 rather than 196 because the pane's DEFAULT width is 447px, which cleared
 * the old 448px threshold by exactly one pixel the wrong way: the picker
 * everybody sees on first open rendered a single column of six cards down a
 * pane wide enough for two. A 188px card still holds the 16px glyph, the label
 * and the one status line at their current sizes with the 16px padding intact
 * — the longest fixed line ("3 ahead · dirty") measures well inside it.
 */
const CARD_MIN_TRACK_PX = 188;

/** The column the whole page is built around. */
const COLUMN_MAX_PX = 512;

/**
 * The tools pane's front page: every tool ADE can open beside this session, what
 * each one is doing right now, and one click to take it over the pane.
 *
 * One centred 512px column — a two-column grid of cards, vertically centred
 * against the whole pane rather than against the space left under the header.
 * There is no title and no subline: the tab strip above already says "Tools",
 * and a page with six labelled cards on it does not need to be introduced.
 *
 * Behind the grid, a slow violet mesh (`WorkToolPickerBackdrop`) — the one
 * decorated surface in the pane, because it is the one surface with nothing on
 * it. The cards float on it: translucent, blurred, one hairline each, lifting
 * 2px under the cursor. Each is still deliberately thin — a monochrome 16px
 * glyph, the name, and exactly one line underneath. No tinted squares, no key
 * caps, no per-card activity dot; the only mark a card can carry is a red dot
 * when that tool is actually broken, because that is the one fact worth
 * interrupting a calm page for.
 */
export function WorkToolPicker({
  activeTool,
  context,
  statuses,
  loading,
  onPick,
}: {
  activeTool: WorkSidebarTab | null;
  context: WorkToolContext;
  statuses: WorkToolStatusMap;
  loading: boolean;
  onPick: (tool: WorkSidebarTab) => void;
}) {
  const theme = useAppStore((s) => s.theme);
  const reasonIdPrefix = useId();
  const cardCount = WORK_TOOL_DEFINITIONS.length;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  // Starts at nothing highlighted, exactly like t3's launcher: this is a page
  // you look at, not a palette you are already typing into, and opening with a
  // card pre-selected reads as a choice already made for you.
  const [highlight, setHighlight] = useState(-1);

  const focusCard = useCallback((index: number) => {
    const cards = gridRef.current?.querySelectorAll<HTMLButtonElement>("button[data-tool-id]");
    cards?.[index]?.focus();
  }, []);

  // Arrows move the highlight and take focus with them, so Enter is the
  // browser's own activation rather than a second key handler that could
  // disagree with the click path about which card is disabled.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const step = event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
      if (step === 0) return;
      const target = event.target;
      const node = target instanceof Node ? target : null;
      const mine = target === document.body || (node != null && rootRef.current?.contains(node) === true);
      if (!mine) return;
      event.preventDefault();
      setHighlight((current) => {
        const next = current < 0
          ? (step > 0 ? 0 : cardCount - 1)
          : (current + step + cardCount) % cardCount;
        focusCard(next);
        return next;
      });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cardCount, focusCard]);

  return (
    // Two boxes, because the backdrop must not scroll. `inset: 0` inside the
    // scroller resolves against the scroll ORIGIN, so on a pane too short for
    // the column the mesh ended at the fold and the rest of the page scrolled
    // onto bare chrome. Pinned to this non-scrolling wrapper it always covers
    // exactly what you can see.
    <div ref={rootRef} className="ade-pane-chrome relative h-full min-h-0">
      {/* Behind everything and untouchable: the canvas must never eat a click
          meant for the card on top of it, and it is never in the tab order. */}
      <WorkToolPickerBackdrop theme={theme} className="ade-tool-picker-backdrop" />
      <div
        data-tool-picker-scroll=""
        className="relative flex h-full min-h-0 flex-col overflow-auto"
      >
        {/* `m-auto` rather than `justify-center`: a centred flex child in an
            overflow container has its overflowing top clipped and unreachable,
            and this column is taller than a short pane. The extra bottom pad is
            the 36px header — spending it here centres the block against the
            WHOLE pane, not against the leftover space beneath the header. */}
        <div
          className="relative m-auto w-full px-6 pb-[60px] pt-6"
          style={{ maxWidth: COLUMN_MAX_PX }}
        >
          <div
            ref={gridRef}
            role="group"
            aria-label="Work tools"
            // The pointer takes the highlight back the moment it moves: hover is
            // already drawn by `:hover`, so a stale keyboard highlight left on a
            // card the mouse has since left is a second card that looks hovered.
            onPointerMove={() => setHighlight((current) => (current === -1 ? current : -1))}
            className="grid gap-2"
            // `min()` rather than the bare minimum: below one card's width the
            // track must shrink with the pane, or the grid overflows the column
            // it is centred in and the cards clip on the right.
            style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${CARD_MIN_TRACK_PX}px), 1fr))` }}
          >
            {WORK_TOOL_DEFINITIONS.map((definition, index) => {
              const availability = workToolAvailability(definition.id, context);
              const status = statuses[definition.id];
              const reasonId = `${reasonIdPrefix}-${definition.id}`;
              // Status, reason, or the catalogue's hint — `workToolSummary` owns
              // that priority, and the tooltip below reads the same resolution.
              const { line: detail, tooltipLabel } = workToolSummary(definition, status, availability);
              const showSkeleton = loading && availability.available && status?.line == null;
              const Icon = definition.icon;
              const isActive = activeTool === definition.id;
              const hasError = availability.available && workToolHasError(status);
              // An odd card count leaves the last one alone on its row. Letting it
              // span the full width finishes the block instead of orphaning it;
              // with one column every card already spans, so this is a no-op there.
              const spansRow = cardCount % 2 === 1 && index === cardCount - 1;
              return (
                <PaneTooltip
                  key={definition.id}
                  // Only when the card actually cut something off. A tooltip that
                  // repeats a line you can already read is a panel over the NEXT
                  // card for no reason; a tooltip over a truncated one is the rest
                  // of the sentence.
                  label={tooltipLabel}
                  side="bottom"
                  onlyWhenClipped
                  disabled={showSkeleton}
                  className="min-w-0"
                  style={spansRow ? { gridColumn: "1 / -1" } : undefined}
                >
                  <button
                    type="button"
                    disabled={!availability.available}
                    aria-current={isActive ? "true" : undefined}
                    aria-describedby={availability.available ? undefined : reasonId}
                    onClick={() => onPick(definition.id)}
                    data-tool-id={definition.id}
                    data-highlighted={highlight === index ? "true" : undefined}
                    className={cn(
                      "ade-tool-card group flex w-full flex-col items-start p-4 text-left",
                      !availability.available && "cursor-not-allowed opacity-40",
                    )}
                  >
                    <span className="flex w-full min-w-0 items-center gap-2">
                      <Icon
                        size={16}
                        weight="regular"
                        aria-hidden="true"
                        className="shrink-0 text-muted-fg transition-colors duration-[160ms] ease-out group-hover:text-accent group-data-[highlighted=true]:text-accent"
                      />
                      <span className="min-w-0 flex-1 truncate text-[14px] font-medium leading-5 text-fg">
                        {definition.label}
                      </span>
                      {hasError ? (
                        <span
                          role="img"
                          aria-label={`${definition.label} · errors`}
                          data-tool-error-dot={definition.id}
                          className="h-[6px] w-[6px] shrink-0 rounded-full bg-[var(--color-error)]"
                        />
                      ) : null}
                    </span>
                    {showSkeleton ? (
                      <span
                        aria-hidden="true"
                        className="ade-tool-skeleton mt-1.5 h-[10px] w-3/5 rounded-full"
                      />
                    ) : detail ? (
                      <span
                        id={availability.available ? undefined : reasonId}
                        className="mt-1.5 w-full truncate text-[12px] leading-4 text-muted-fg"
                      >
                        {detail}
                      </span>
                    ) : null}
                  </button>
                </PaneTooltip>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
