import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { WorkSidebarTab } from "../../state/appStore";
import { cn } from "../ui/cn";
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
 * 8px gutter, two 196px tracks need 448px of pane and three need 652px — more
 * than the column is ever allowed to be. That arithmetic is the cap. A wide
 * pane used to reach three tracks and spend the extra width making every card
 * SMALLER (149px at 527px of pane); the cards now grow with the pane instead,
 * from 196px at the two-column threshold to 252px at the column's full width.
 */
const CARD_MIN_TRACK_PX = 196;

/** The column the whole page is built around — title, subline and grid alike. */
const COLUMN_MAX_PX = 512;

/**
 * What a tool is FOR, in three to five words.
 *
 * Only ever shown when the tool has measured nothing yet: a live status ("2
 * shells", "3 tabs · agent") is always the better answer, and a card that
 * carries both a status and a blurb is the over-explained layout this page
 * replaced. Kept here rather than on the catalogue entry because it is picker
 * copy — the header, the palette and the activity dots have no use for it.
 */
/*
 * Files has no entry: the lane store always knows whether the worktree is
 * dirty, so its card always has a real status ("Changes" / "Clean") and a
 * blurb there would be copy that can never render.
 */
const WORK_TOOL_DESCRIPTIONS: Partial<Record<WorkSidebarTab, string>> = {
  terminal: "Run a shell here",
  browser: "Drive a real browser",
  git: "Commit, push, rebase",
  ios: "Boot a simulator",
  "app-control": "Drive a desktop app",
};

/**
 * The tools pane's front page: every tool ADE can open beside this session, what
 * each one is doing right now, and one click to take it over the pane.
 *
 * One centred 512px column — a titled two-column grid of flat cards, vertically
 * centred against the whole pane rather than against the space left under the
 * header. The card is deliberately thin: a monochrome 16px glyph, the name, and
 * exactly one line underneath. No tinted squares, no key caps, no shadows, no
 * per-card activity dot; the only mark a card can carry is a red dot when that
 * tool is actually broken, because that is the one fact worth interrupting a
 * calm page for.
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
    <div
      ref={rootRef}
      className="ade-pane-chrome flex h-full min-h-0 flex-col overflow-auto"
    >
      {/* `m-auto` rather than `justify-center`: a centred flex child in an
          overflow container has its overflowing top clipped and unreachable,
          and this column is taller than a short pane. The extra bottom pad is
          the 36px header — spending it here centres the block against the
          WHOLE pane, not against the leftover space beneath the header. */}
      <div className="m-auto w-full px-6 pb-[60px] pt-6" style={{ maxWidth: COLUMN_MAX_PX }}>
        <div className="mb-5 text-center">
          <h2 className="text-[14px] font-medium leading-5 text-fg">Tools</h2>
          <p className="mt-1 text-[12px] leading-4 text-muted-fg">
            Pick what this lane works with
          </p>
        </div>
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
            const { line, tooltipLabel } = workToolSummary(definition, status, availability);
            const showSkeleton = loading && availability.available && status?.line == null;
            // The status when there is one, the reason when the tool cannot run
            // here, and only otherwise the blurb. Never two of them.
            const detail = line || (availability.available ? WORK_TOOL_DESCRIPTIONS[definition.id] ?? "" : "");
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
                      className="shrink-0 text-muted-fg transition-colors duration-[120ms] ease-out group-hover:text-fg group-data-[highlighted=true]:text-fg"
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
  );
}
