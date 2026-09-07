import { useId } from "react";
import type { WorkSidebarTab } from "../../state/appStore";
import { isMac } from "../../lib/platform";
import { cn } from "../ui/cn";
import { PaneTooltip } from "../ui/PaneTooltip";
import {
  WORK_TOOL_DEFINITIONS,
  workToolAvailability,
  type WorkToolContext,
} from "./workTools";
import {
  workToolDotColor,
  workToolDotState,
  type WorkToolDotState,
  type WorkToolStatusMap,
} from "./useWorkToolStatuses";
import { workToolErrorSuffix } from "./workToolErrors";

/**
 * Two columns above 340px of pane, one below.
 *
 * Expressed as a track minimum rather than a media/container query so it can
 * never disagree with the real width: with 12px of padding either side and an
 * 8px gutter, two 154px tracks need exactly 340px of pane. Below that the
 * second track cannot be placed and `auto-fit` collapses to one — which is what
 * stops the labels breaking mid-word at 300px.
 */
const CARD_MIN_TRACK_PX = 154;

/** No trailing colon: the footer is a signpost, not the start of a sentence. */
const PALETTE_HINT = isMac ? "⌘K → Tools" : "Ctrl+K → Tools";

/**
 * The tools pane's front page: every tool ADE can open beside this session, what
 * each one is doing right now, and one click to take it over the pane.
 *
 * Deliberately a grid of cards rather than the old icon rail. The rail could
 * only say "these six things exist"; a card can say "two shells are running,
 * one of them is your dev server" — which is the actual question you open this
 * pane to answer.
 *
 * Card anatomy is fixed at one row: a 28px tinted square holding the tool's
 * glyph, the name, one line of status, and a state dot. The old two-line
 * layout let a short status ("clean") sit under a short name and leave most of
 * a 70px card empty; one row of known height reads as a list you can scan.
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

  return (
    <div className="ade-pane-chrome flex h-full min-h-0 flex-col overflow-auto">
      <div
        role="group"
        aria-label="Work tools"
        className="grid gap-2 p-3"
        style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${CARD_MIN_TRACK_PX}px, 1fr))` }}
      >
        {WORK_TOOL_DEFINITIONS.map((definition, index) => {
          const availability = workToolAvailability(definition.id, context);
          const status = statuses[definition.id];
          const reasonId = `${reasonIdPrefix}-${definition.id}`;
          const dotState: WorkToolDotState = availability.available
            ? workToolDotState(status)
            : "idle";
          // Appended to whatever the tool was already saying rather than
          // replacing it: "localhost:3000 · 3 errors" tells you both what is
          // open and that it is unhappy.
          const line = availability.available
            ? `${status?.line ?? definition.blurb}${workToolErrorSuffix(status?.errorCount ?? 0)}`
            : availability.reason;
          const showSkeleton = loading && availability.available && status?.line == null;
          const Icon = definition.icon;
          const isActive = activeTool === definition.id;
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
              label={`${definition.label} — ${line}`}
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
                className={cn(
                  "group relative flex min-h-[64px] w-full items-center gap-2 rounded-[var(--radius-lg)]",
                  "border border-white/[0.07] bg-card/60 p-3 text-left",
                  "transition-[transform,border-color,background-color,box-shadow] duration-[120ms] ease-out",
                  "hover:-translate-y-px hover:border-white/[0.16] hover:bg-card",
                  "active:translate-y-0 active:scale-[0.985]",
                  "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
                  "motion-reduce:transition-none motion-reduce:hover:translate-y-0 motion-reduce:active:scale-100",
                  isActive && "border-white/20 bg-card",
                  !availability.available
                    && "cursor-not-allowed opacity-45 hover:translate-y-0 hover:border-white/[0.07] hover:bg-card/60",
                )}
              >
                <span
                  aria-hidden="true"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-md)]"
                  style={{
                    background: availability.available
                      ? `color-mix(in srgb, ${definition.color} 12%, transparent)`
                      : "color-mix(in srgb, var(--color-muted-fg) 10%, transparent)",
                  }}
                >
                  <Icon
                    size={16}
                    weight="duotone"
                    style={{ color: availability.available ? definition.color : undefined }}
                    className={availability.available ? undefined : "text-muted-fg"}
                  />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  {/* `pr-3` is the dot's clearance. The dot itself is taken
                      out of flow (below) — reserving a column for it cost the
                      name ~16px, which is the difference between "iOS
                      Simulator" and "iOS Simula…" in a 375px pane. */}
                  <span className="truncate pr-3 text-[13px] font-semibold leading-4 text-fg">
                    {definition.label}
                  </span>
                  {showSkeleton ? (
                    <span
                      aria-hidden="true"
                      className="ade-tool-skeleton mr-3 h-[10px] w-3/4 rounded-full"
                    />
                  ) : (
                    <span
                      id={availability.available ? undefined : reasonId}
                      className="truncate pr-3 text-[12px] leading-4 text-muted-fg"
                    >
                      {line}
                    </span>
                  )}
                </span>
                {availability.available ? (
                  <WorkToolStatusDot state={dotState} color={definition.color} tool={definition.label} />
                ) : null}
              </button>
            </PaneTooltip>
          );
        })}
      </div>
      {/* One quiet line telling you how to get back here and how to get here
          from anywhere else. Below a hairline so it reads as a footer rather
          than as an eighth card. */}
      <div className="mt-auto shrink-0 border-t border-white/[0.06] px-3 py-2">
        <p className="truncate text-[11px] leading-4 text-muted-fg/70">
          Esc returns here · {PALETTE_HINT}
        </p>
      </div>
    </div>
  );
}

/**
 * The right-side dot on a card. Coloured by STATE, never by tool: red is
 * broken, amber is waiting on you, the tool's own hue is live, and idle is a
 * flat muted dot. Same mapping as the header's activity dots.
 *
 * The card's own text already names the tool and its status, so the dot adds
 * only the one word the colour carries — and adds nothing at all when idle,
 * which is the absence of news.
 */
function WorkToolStatusDot({ state, color, tool }: { state: WorkToolDotState; color: string; tool: string }) {
  const resolved = workToolDotColor(state, color);
  const isQuiet = state === "idle";
  return (
    <span
      role="img"
      // Named even when idle. A 6px dot with no accessible name is a decoration
      // to a screen reader, so "Terminal · idle" — the absence of news — was
      // simply missing rather than quiet. The card's own tooltip carries the
      // full status line for sighted hover; this is the same fact, spoken.
      aria-label={`${tool} · ${WORK_TOOL_DOT_LABELS[state]}`}
      data-tool-glyph-state={state}
      className="absolute right-3 top-3 h-[6px] w-[6px] shrink-0 rounded-full"
      style={
        isQuiet
          ? { background: resolved }
          : { background: resolved, boxShadow: `0 0 0 2.5px color-mix(in srgb, ${resolved} 18%, transparent)` }
      }
    />
  );
}

const WORK_TOOL_DOT_LABELS: Record<WorkToolDotState, string> = {
  idle: "idle",
  live: "live",
  attention: "needs you",
  error: "errors",
};
