import React, { useCallback, useMemo, useRef, useState } from "react";
import { Clock, GitPullRequest, Moon } from "@phosphor-icons/react";
import type { TerminalSessionSummary } from "../../../shared/types";
import { cn } from "../ui/cn";
import { COLORS, laneRailTint } from "../lanes/laneDesignTokens";
import { relativeTimeCompact } from "../../lib/format";
import { WORK_BOARD_COLUMN_LABEL, type WorkBoardColumn } from "../../../shared/types/chat";
import type { WorkBoardWaitingReason } from "./useWorkSessions";
import { sessionActivityInstant } from "../../lib/sessions";

/* ──────────────────────────────────────────────────────────────────────────
   The Work tab's KANBAN BOARD.

   It renders no session chrome of its own. Every card body is the caller's
   `renderCard`, which is `SessionListPane`'s own card renderer — so a board
   card and a list row are the SAME component with the same click, context
   menu, hover card, PR pill, provider glyph, lineage chip and note line. The
   board owns exactly three things the list does not have: the column, the lane
   rail down the card's left edge, and the drop target.

   ── Colour ──────────────────────────────────────────────────────────────────
   The four accents are not new. They are ADE's one-hue-one-meaning status
   vocabulary (`shared/sessionStatusPresentation.ts`) read one level up:

     Needs you   amber    var(--color-warning)   YOUR MOVE, and nothing else
     Working     blue     var(--color-info)      work is happening, nothing asked
     Waiting     neutral  var(--color-muted-fg)  true, but not actionable
     Done        emerald  var(--color-success)   finished, you have not looked

   They are taken as CSS variables rather than as the Tailwind hue classes the
   status slot uses, because those are fixed hues and these have to survive the
   light theme (`index.css` redefines all three variables under
   `[data-theme="light"]`). Every tint below is a `color-mix` off one of them,
   the same way `inlineBadge` and `laneSurfaceTint` build theirs — so there is
   no raw colour in this file at all.

   The accent is spent in three places and nowhere else: the header dot, a very
   low-alpha header wash, and the drop highlight. The card body stays neutral,
   or the board becomes four blocks of colour and the status dot on each card —
   which is the thing that actually carries per-row state — stops reading.
   ────────────────────────────────────────────────────────────────────────── */

/** DnD payload for a board move. Distinct from the grid mime so a card dragged
 *  onto the work area still means "add to grid", never "change column". */
export const WORK_BOARD_DND_MIME = "application/x-ade-work-board-session";

type BoardColumnSpec = {
  key: WorkBoardColumn;
  label: string;
  /** Shown under an empty column. One quiet line, never an empty state. */
  emptyHint: string;
  accent: string;
  /**
   * Waiting is DERIVED — a row sits there because it is snoozed or because its
   * PR is mid-CI, and neither is something a drag can assert. A drop there
   * would have to lie, so the column refuses it and shows no affordance.
   */
  droppable: boolean;
  /** Spoken description of what the accent means, so colour is never the only cue. */
  hint: string;
};

export const WORK_BOARD_COLUMNS: readonly BoardColumnSpec[] = [
  {
    key: "needs_you",
    label: WORK_BOARD_COLUMN_LABEL.needs_you,
    emptyHint: "Nothing is waiting on you.",
    accent: COLORS.warning,
    droppable: true,
    hint: "Blocked on you",
  },
  {
    key: "working",
    label: WORK_BOARD_COLUMN_LABEL.working,
    emptyHint: "No agent is mid-turn.",
    accent: COLORS.info,
    droppable: true,
    hint: "An agent is mid-turn",
  },
  {
    key: "waiting",
    label: WORK_BOARD_COLUMN_LABEL.waiting,
    emptyHint: "Nothing is snoozed or waiting on CI.",
    accent: COLORS.textMuted,
    droppable: false,
    hint: "Snoozed, or waiting on CI or review",
  },
  {
    key: "done",
    label: WORK_BOARD_COLUMN_LABEL.done,
    emptyHint: "Nothing has finished yet.",
    accent: COLORS.success,
    droppable: true,
    hint: "Finished or settled",
  },
] as const;

const WAITING_REASON_LABEL: Record<WorkBoardWaitingReason, string> = {
  snoozed: "Snoozed",
  ci: "CI running",
  review: "Review requested",
};

export type WorkKanbanBoardProps = {
  buckets: Record<WorkBoardColumn, TerminalSessionSummary[]>;
  /** Only set for rows in Waiting; drives the "why" chip on the card. */
  waitingReasons: ReadonlyMap<string, WorkBoardWaitingReason>;
  /**
   * The list's own card renderer. Handed in rather than re-implemented so a
   * board card cannot drift from a list row — click, right-click menu, hover
   * card and every chip come from exactly one place.
   */
  renderCard: (session: TerminalSessionSummary) => React.ReactNode;
  /** Lane accent for the card's left rail; null renders the neutral hairline. */
  laneAccentFor: (session: TerminalSessionSummary) => string | null;
  /**
   * Apply a board move. Called only for droppable columns, and only when the
   * card is not already in the target column. The caller routes this to
   * `session.moveOnBoard`, which owns both the lifecycle write and the message
   * the agent reacts to.
   */
  onMoveSession: (session: TerminalSessionSummary, column: WorkBoardColumn) => void;
  /**
   * Sessions moved but not yet answered, keyed by id. The card pulses while it
   * is in here — the honest gap between the column changing (instant) and the
   * agent reacting to being told (not instant).
   */
  pulsingSessionIds?: ReadonlyMap<string, string>;
};

export function WorkKanbanBoard({
  buckets,
  waitingReasons,
  renderCard,
  laneAccentFor,
  onMoveSession,
  pulsingSessionIds,
}: WorkKanbanBoardProps) {
  const [dragOverColumn, setDragOverColumn] = useState<WorkBoardColumn | null>(null);
  // The dragged row, captured on dragstart. `dataTransfer.getData` is empty
  // during dragover in every browser, so the "is this card already here"
  // test — which decides whether the column even lights up — cannot be
  // answered from the event. It is a ref, not state: it changes once per drag
  // and re-rendering the whole board on dragstart is pure waste.
  const draggingRef = useRef<{ sessionId: string; from: WorkBoardColumn } | null>(null);

  const sessionById = useMemo(() => {
    const map = new Map<string, TerminalSessionSummary>();
    for (const column of WORK_BOARD_COLUMNS) {
      for (const session of buckets[column.key]) map.set(session.id, session);
    }
    return map;
  }, [buckets]);

  const endDrag = useCallback(() => {
    draggingRef.current = null;
    setDragOverColumn(null);
  }, []);

  const canAcceptDrop = useCallback((column: BoardColumnSpec): boolean => {
    if (!column.droppable) return false;
    const dragging = draggingRef.current;
    return Boolean(dragging) && dragging?.from !== column.key;
  }, []);

  return (
    <div
      className="flex h-full min-h-0 items-stretch gap-1.5 overflow-x-auto overflow-y-hidden px-1 pb-1"
      data-testid="work-kanban-board"
    >
      {WORK_BOARD_COLUMNS.map((column) => {
        const sessions = buckets[column.key];
        const active = dragOverColumn === column.key;
        return (
          <section
            key={column.key}
            // Keyboard-reachable as a region: tabbing across the board lands on
            // each column before its cards, which is the only way a keyboard
            // user can tell four vertical stacks apart.
            tabIndex={0}
            role="region"
            aria-label={`${column.label}, ${sessions.length} ${sessions.length === 1 ? "session" : "sessions"}. ${column.hint}.`}
            data-testid={`work-board-column-${column.key}`}
            data-column-active={active ? "true" : undefined}
            className={cn(
              // Same recessed-panel idiom as the Work list's drawer surfaces:
              // hairline border, 8px radius, no shadow. A board of four
              // shadowed cards floating on a flat pane reads as a widget shelf.
              //
              // `flex-1` + `basis-0` with a floor, NOT a fixed width: the board
              // owns the whole Work tab, so on a normal window the four columns
              // divide it evenly and nothing scrolls sideways. `basis-0` is
              // what makes them EQUAL — with the default `basis-auto` a column
              // holding a long chat title would claim more than its share. The
              // floor is where a genuinely narrow window starts scrolling
              // instead of crushing the cards.
              "flex min-h-0 min-w-[15.5rem] flex-1 basis-0 flex-col rounded-lg border transition-colors duration-100",
              "outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]",
            )}
            style={{
              background: active ? `color-mix(in srgb, ${column.accent} 6%, transparent)` : "transparent",
              borderColor: active
                ? `color-mix(in srgb, ${column.accent} 45%, transparent)`
                : "color-mix(in srgb, var(--color-border) 55%, transparent)",
            }}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes(WORK_BOARD_DND_MIME)) return;
              if (!canAcceptDrop(column)) return;
              // Only a preventDefault'd dragover makes an element a drop target,
              // so a non-droppable column shows the browser's "no drop" cursor
              // for free — no affordance to suppress.
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setDragOverColumn((previous) => (previous === column.key ? previous : column.key));
            }}
            onDragLeave={(event) => {
              // Ignore the leave events fired while crossing between the
              // column's own children, or the highlight strobes on every card.
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              setDragOverColumn((previous) => (previous === column.key ? null : previous));
            }}
            onDrop={(event) => {
              const sessionId = draggingRef.current?.sessionId
                ?? event.dataTransfer.getData(WORK_BOARD_DND_MIME);
              const accepted = canAcceptDrop(column);
              endDrag();
              if (!accepted || !sessionId) return;
              const session = sessionById.get(sessionId);
              if (!session) return;
              event.preventDefault();
              onMoveSession(session, column.key);
            }}
          >
            <BoardColumnHeader column={column} count={sessions.length} />
            <div
              className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1 pb-1"
              // The lane-group body's marker: it zeroes `SESSION_ROW_BLEED_CLASS`
              // so a card stays inside the column instead of bleeding 12px past
              // both of its edges (see SessionCard).
              data-indented="true"
            >
              {sessions.length === 0 ? (
                <p
                  className="px-1.5 py-2 text-[10px] leading-relaxed text-muted-fg/45"
                  data-testid={`work-board-empty-${column.key}`}
                >
                  {column.emptyHint}
                </p>
              ) : (
                <div className="flex flex-col gap-1">
                  {sessions.map((session) => (
                    <BoardCard
                      key={session.id}
                      session={session}
                      column={column.key}
                      accent={column.accent}
                      laneAccent={laneAccentFor(session)}
                      waitingReason={waitingReasons.get(session.id) ?? null}
                      pulsing={pulsingSessionIds?.has(session.id) ?? false}
                      onDragStart={(sessionId) => {
                        draggingRef.current = { sessionId, from: column.key };
                      }}
                      onDragEnd={endDrag}
                    >
                      {renderCard(session)}
                    </BoardCard>
                  ))}
                </div>
              )}
              {/* Where the card will land. A tinted column edge says "this
                  column accepts it"; this says "and it goes here" — the same
                  job the lane list's `lane-drop-indicator` does, in the shape a
                  column can carry. */}
              {active ? (
                <div
                  aria-hidden
                  data-testid={`work-board-drop-indicator-${column.key}`}
                  className="mt-1 h-8 rounded-md border border-dashed"
                  style={{
                    borderColor: `color-mix(in srgb, ${column.accent} 55%, transparent)`,
                    background: `color-mix(in srgb, ${column.accent} 8%, transparent)`,
                  }}
                />
              ) : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/**
 * The column head.
 *
 * DO NOT "deduplicate" this by switching to `StickyGroupHeader` — that
 * component returns `null` at `count === 0`, which would silently delete every
 * empty column from the board.
 *
 * That is correct behaviour for a LIST section (a divider describing nothing is
 * pure chrome) and wrong for a board column, whose header is the thing that
 * says the column exists at all. `StickyGroupHeader` also owns collapse,
 * drag-reorder and quiet-lane counts, none of which a column has. So this
 * matches the header's SHAPE exactly — the same 28px row, 6px radius, 1.5
 * gutter, 11px medium label, trailing tabular count — and drops the machinery.
 */
function BoardColumnHeader({ column, count }: { column: BoardColumnSpec; count: number }) {
  return (
    <div
      className="flex h-7 shrink-0 items-center gap-1.5 rounded-t-lg px-1.5"
      data-testid={`work-board-header-${column.key}`}
      style={{
        // Low-alpha wash, not a block: enough to say "this band belongs to this
        // column" at a glance and not enough to compete with the cards under it.
        background: `color-mix(in srgb, ${column.accent} 7%, transparent)`,
        borderBottom: `1px solid color-mix(in srgb, ${column.accent} 22%, transparent)`,
      }}
      title={column.hint}
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: column.accent }}
      />
      <span className="min-w-0 flex-1 truncate text-[11px] font-medium leading-tight text-fg/85">
        {column.label}
      </span>
      <span
        className="shrink-0 text-[10px] font-medium tabular-nums text-muted-fg/55"
        data-testid={`work-board-count-${column.key}`}
      >
        {count}
      </span>
    </div>
  );
}

/**
 * One tile: the lane rail, the shared card, and the board-only footer.
 *
 * Grab-anywhere drag. The card inside is itself `draggable` (it is the work
 * grid's drag source), so this wrapper does NOT set `draggable` — it would
 * shadow the inner one and break grid drops. It listens for the inner card's
 * `dragstart` as it bubbles, adds the board payload to the SAME DataTransfer,
 * and lets the grid payload ride along untouched. One gesture, two meanings,
 * resolved by whichever drop target catches it.
 */
function BoardCard({
  session,
  column,
  accent,
  laneAccent,
  waitingReason,
  pulsing,
  onDragStart,
  onDragEnd,
  children,
}: {
  session: TerminalSessionSummary;
  column: WorkBoardColumn;
  accent: string;
  laneAccent: string | null;
  waitingReason: WorkBoardWaitingReason | null;
  /** Moved by the user, not yet answered by the agent. */
  pulsing: boolean;
  onDragStart: (sessionId: string) => void;
  onDragEnd: () => void;
  children: React.ReactNode;
}) {
  const [dragging, setDragging] = useState(false);
  const activityIso = sessionActivityInstant(session);
  // `relativeTimeCompact` answers "" for a missing or unparseable instant, so
  // the footer is asked for a truthy string rather than for a non-null one.
  const activityLabel = relativeTimeCompact(activityIso) || null;

  return (
    <div
      data-testid={`work-board-card-${session.id}`}
      data-board-column={column}
      data-dragging={dragging ? "true" : undefined}
      data-board-move-pending={pulsing ? "true" : undefined}
      title={pulsing ? "Moved. The agent is being told — this clears on its next reply." : undefined}
      className={cn(
        // The Work list's row treatment, one step up: same 6px radius and the
        // same hover lift, plus a hairline the list rows do not need (they are
        // separated by the pane, these float on a column).
        //
        // The fill is mixed off `--color-fg`, not a white alpha, for the same
        // reason the accents are variables: a `bg-white/2` surface is invisible
        // on the light theme's near-white pane. This is `COLORS.hoverBg`'s
        // formula, one step quieter for the resting state.
        "group/board-card relative overflow-hidden rounded-md border transition-colors duration-100",
        "bg-[color-mix(in_srgb,var(--color-fg)_2%,transparent)]",
        "border-[color-mix(in_srgb,var(--color-border)_45%,transparent)]",
        "hover:bg-[color-mix(in_srgb,var(--color-fg)_6%,transparent)]",
        "hover:border-[color-mix(in_srgb,var(--color-border)_85%,transparent)]",
        // The card inside owns the row; this mirrors its focus outward so a
        // keyboard user sees the whole tile light up, not just a nested row.
        "focus-within:border-[color-mix(in_srgb,var(--color-accent)_55%,transparent)]",
        "focus-within:bg-[color-mix(in_srgb,var(--color-accent)_6%,transparent)]",
        dragging && "opacity-45",
        // Not a colour change: the card already carries a status dot and a
        // column accent, and a fourth hue here would compete with both. A slow
        // opacity breath reads as "in flight" without claiming a new state.
        pulsing && "animate-pulse",
      )}
      onDragStartCapture={(event) => {
        event.dataTransfer.setData(WORK_BOARD_DND_MIME, session.id);
        setDragging(true);
        onDragStart(session.id);
      }}
      onDragEnd={() => {
        setDragging(false);
        onDragEnd();
      }}
    >
      {/* Lane identity as a rail on the card's left edge — the same 2px tinted
          stripe an expanded lane group hangs its rows off, so "which lane" is
          read the same way in both views. The lane NAME still renders inside
          the card (the list's singleton form), so this is reinforcement, never
          the only cue. */}
      <span
        aria-hidden
        data-testid={`work-board-card-rail-${session.id}`}
        className="absolute inset-y-0 left-0 w-0.5"
        style={{ background: laneRailTint(laneAccent, 70) }}
      />
      <div className="pl-0.5">{children}</div>
      {/* The footer is ALWAYS rendered, even when both of its slots are empty.
          Columns only align if every card is the same height, and a footer that
          appears only for parked rows made the Waiting column sit 16px out of
          step with the other three. `h-4` is the cost of that alignment. */}
      <div className="flex h-4 items-center gap-1.5 px-2 pb-1.5 pl-2.5 text-[10px] leading-none text-muted-fg/50">
        {waitingReason ? (
          <span
            className="inline-flex min-w-0 shrink items-center gap-1"
            data-testid={`work-board-waiting-${session.id}`}
            // The reason is WORDS, not a hue: the column's colour says
            // "waiting" and this says what it is waiting on.
            style={{ color: `color-mix(in srgb, ${accent} 55%, var(--color-muted-fg))` }}
          >
            {waitingReason === "snoozed" ? (
              <Moon size={9} weight="fill" aria-hidden />
            ) : (
              <GitPullRequest size={9} aria-hidden />
            )}
            <span className="truncate">{WAITING_REASON_LABEL[waitingReason]}</span>
          </span>
        ) : null}
        {activityLabel ? (
          <span className="ml-auto inline-flex shrink-0 items-center gap-1 tabular-nums">
            <Clock size={9} aria-hidden />
            <span title={`Last activity ${activityIso}`}>{activityLabel}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}
