/**
 * Pieces of the Focus grid that the normal grid does not have.
 *
 * The Focus grid IS the normal Work grid (`WorkGridView` over
 * `PaneTilingLayout`, standard chat surfaces). Membership comes from the
 * sidebar's Focus list instead of drags (`useWorkFocusQueueReport`), the grid's
 * state lives in `useWorkFocusGrid`, and each chat header shows "open in full
 * view" instead of the Tools toggle. This file holds the pure page math and
 * the extra UI: the empty state, the bottom roster strip, the toolbar pager,
 * and the Focus pill.
 */
import React, { useEffect, useRef } from "react";
import { CaretLeft, CaretRight, SquaresFour, Target } from "@phosphor-icons/react";
import type { TerminalSessionSummary } from "../../../shared/types";
import { primarySessionLabel } from "../../lib/sessions";
import { SmartTooltip } from "../ui/SmartTooltip";
import { ToolLogo } from "./ToolLogos";

/**
 * Keep the previous order for ids that stay, drop the ones that left, and add
 * new ones at the end. Pure, so a re-render with the same ids never moves a tile.
 */
export function stableFocusOrder(previous: readonly string[], next: readonly string[]): string[] {
  const nextSet = new Set(next);
  const kept = previous.filter((id) => nextSet.has(id));
  const keptSet = new Set(kept);
  return [...kept, ...next.filter((id) => !keptSet.has(id))];
}

export function WorkFocusGridEmpty({
  workingCount,
  onLeaveGrid,
}: {
  workingCount: number;
  onLeaveGrid: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 w-full items-center justify-center p-6" data-empty="true">
      <div className="flex max-w-[340px] flex-col items-center gap-3 text-center">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] text-[var(--color-accent)]">
          <Target size={20} weight="bold" aria-hidden />
        </span>
        <div className="text-[13px] font-medium text-fg">Nothing waits for you</div>
        <div className="text-[11.5px] leading-relaxed text-muted-fg">
          {workingCount > 0
            ? `${workingCount} chat${workingCount === 1 ? " is" : "s are"} working. ${workingCount === 1 ? "It shows" : "They show"} here when ${workingCount === 1 ? "it finishes" : "they finish"} or ${workingCount === 1 ? "asks" : "ask"} you something.`
            : "When an agent finishes a turn or asks you something, its chat shows here."}
        </div>
        <button
          type="button"
          onClick={onLeaveGrid}
          className="mt-1 inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--work-pane-border)] px-2.5 text-[11px] text-muted-fg transition-colors hover:bg-fg/[0.05] hover:text-fg"
        >
          Show one chat instead
        </button>
      </div>
    </div>
  );
}

/**
 * The smallest chat tile that stays usable: the header, a readable piece of
 * the reply, and the composer with its controls on one row. The height is
 * high on purpose: a short tile is mostly composer, so a laptop-height grid
 * pages side-by-side tiles instead of stacking two rows.
 */
const FOCUS_TILE_MIN_WIDTH = 420;
const FOCUS_TILE_MIN_HEIGHT = 480;

export type FocusFit = {
  /** Tiles that fit side by side. */
  columns: number;
  /** Rows of tiles that fit. */
  rows: number;
  /** Tiles one page can hold: columns × rows, between 1 and the grid cap. */
  capacity: number;
};

/**
 * What fits in a `width` × `height` grid area at the minimum tile size. A 0×0
 * area (not measured yet) holds one tile.
 */
export function focusFit(width: number, height: number, max: number): FocusFit {
  if (width <= 0 || height <= 0) return { columns: 1, rows: 1, capacity: 1 };
  const columns = Math.max(1, Math.floor(width / FOCUS_TILE_MIN_WIDTH));
  const rows = Math.max(1, Math.floor(height / FOCUS_TILE_MIN_HEIGHT));
  return { columns, rows, capacity: Math.max(1, Math.min(max, columns * rows)) };
}

/**
 * Split the chats into as few pages as the capacity allows, then spread them
 * evenly: eight chats with room for six are 4 + 4, not 6 + 2, so no page looks
 * nearly empty. Earlier pages take the remainder (7 → 4 + 3). Order is kept.
 */
export function focusEvenPages<T>(items: readonly T[], capacity: number): T[][] {
  if (items.length === 0) return [];
  const pageCount = Math.ceil(items.length / Math.max(1, capacity));
  const base = Math.floor(items.length / pageCount);
  const remainder = items.length % pageCount;
  const pages: T[][] = [];
  let offset = 0;
  for (let index = 0; index < pageCount; index += 1) {
    const size = base + (index < remainder ? 1 : 0);
    pages.push(items.slice(offset, offset + size));
    offset += size;
  }
  return pages;
}

/**
 * Tiles per row for a page of `count` chats. Side by side first, because a
 * chat reads better tall than wide: as few rows as the width allows, then the
 * tiles spread evenly over those rows (4 in room for 3 columns is 2 + 2, not
 * 3 + 1; 3 is one row of 3).
 */
export function focusPageColumns(count: number, columnsThatFit: number): number {
  if (count <= 1) return 1;
  const rows = Math.ceil(count / Math.max(1, columnsThatFit));
  return Math.ceil(count / rows);
}

/**
 * True when some element between `target` and `root` can still scroll
 * horizontally in the wheel's direction, so a sideways swipe over a wide code
 * block scrolls the block instead of flipping the page.
 */
export function wheelScrollsInside(target: EventTarget | null, root: HTMLElement, deltaX: number): boolean {
  let node = target instanceof HTMLElement ? target : null;
  while (node && node !== root) {
    if (node.scrollWidth > node.clientWidth + 1) {
      const style = window.getComputedStyle(node);
      if (style.overflowX === "auto" || style.overflowX === "scroll") {
        if (deltaX > 0 && node.scrollLeft + node.clientWidth < node.scrollWidth - 1) return true;
        if (deltaX < 0 && node.scrollLeft > 0) return true;
      }
    }
    node = node.parentElement;
  }
  return false;
}

export type FocusPageSummary = {
  page: number;
  pageCount: number;
  /** 1-based position of the first and last chat on this page. */
  first: number;
  last: number;
  total: number;
  /** An unseen chat waits on an earlier / a later page. */
  newBefore: boolean;
  newAfter: boolean;
};

/** Where page `page` sits among all the chats, for the strip and the pager. */
export function focusPageSummary(
  pages: readonly (readonly TerminalSessionSummary[])[],
  page: number,
  unseenIds: ReadonlySet<string>,
): FocusPageSummary {
  const count = (entries: readonly (readonly TerminalSessionSummary[])[]) =>
    entries.reduce((sum, items) => sum + items.length, 0);
  const hasUnseen = (entries: readonly (readonly TerminalSessionSummary[])[]) =>
    entries.some((items) => items.some((session) => unseenIds.has(session.id)));
  const first = count(pages.slice(0, page)) + 1;
  return {
    page,
    pageCount: pages.length,
    first,
    last: first + (pages[page]?.length ?? 0) - 1,
    total: count(pages),
    newBefore: hasUnseen(pages.slice(0, page)),
    newAfter: hasUnseen(pages.slice(page + 1)),
  };
}

/**
 * The Focus grid's roster: every chat that waits for the user, always on
 * screen, grouped by page. The page on screen is lit; a chip names its chat
 * with the agent's logo, a click goes to that chat's page and focuses its
 * tile, and a right-click opens the sidebar's session menu. A chat that arrived on another page carries the accent
 * until the user gets there. Same height and rule as the sidebar footer beside
 * it, so the two read as one bottom edge.
 */
export function WorkFocusRoster({
  pages,
  page,
  activeSessionId,
  unseenIds,
  onPage,
  onChat,
  onChatContextMenu,
}: {
  pages: readonly (readonly TerminalSessionSummary[])[];
  page: number;
  activeSessionId: string | null;
  unseenIds: ReadonlySet<string>;
  onPage: (page: number) => void;
  onChat: (sessionId: string) => void;
  /** The session menu the sidebar cards open, for this chat. */
  onChatContextMenu: (session: TerminalSessionSummary, event: React.MouseEvent) => void;
}) {
  const { total, first, last, newBefore, newAfter } = focusPageSummary(pages, page, unseenIds);
  const multiPage = pages.length > 1;

  // Keep the lit group in view when the roster is wider than the bar.
  const stripRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const group = stripRef.current?.querySelector<HTMLElement>(`[data-focus-roster-page="${page}"]`);
    group?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [page]);

  return (
    <div className="ade-focus-roster" data-testid="work-focus-grid-pager">
      {multiPage ? (
        <RosterArrow direction="previous" disabled={page === 0} attention={newBefore} onClick={() => onPage(page - 1)} />
      ) : null}
      <div ref={stripRef} className="ade-focus-roster-strip" role="tablist" aria-label="Chats waiting for you">
        {pages.map((entries, index) => (
          <div
            key={index}
            className="ade-focus-roster-page"
            data-focus-roster-page={index}
            data-active={index === page ? "true" : undefined}
          >
            {entries.map((session) => (
              <RosterChip
                key={session.id}
                session={session}
                focused={index === page && session.id === activeSessionId}
                unseen={unseenIds.has(session.id)}
                onClick={() => onChat(session.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onChatContextMenu(session, event);
                }}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="ade-focus-roster-summary" aria-live="polite">
        {multiPage ? (
          <>
            <span className="text-fg/85">
              Chats {first === last ? first : `${first}–${last}`} of {total}
            </span>
            <span className="text-muted-fg/70">Page {page + 1} of {pages.length}</span>
          </>
        ) : (
          <span className="text-fg/85">{total} waiting</span>
        )}
      </div>
      {multiPage ? (
        <RosterArrow direction="next" disabled={page >= pages.length - 1} attention={newAfter} onClick={() => onPage(page + 1)} />
      ) : null}
    </div>
  );
}

/**
 * One waiting chat: the agent's logo and the chat's name, nothing else. Every
 * chat here waits for the user, so a status would repeat itself. No hover
 * card; right-click opens the same session menu as the sidebar card.
 */
function RosterChip({
  session,
  focused,
  unseen,
  onClick,
  onContextMenu,
}: {
  session: TerminalSessionSummary;
  focused: boolean;
  unseen: boolean;
  onClick: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  const title = primarySessionLabel(session);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={focused}
      aria-label={title}
      className="ade-focus-roster-chip"
      data-focused={focused ? "true" : undefined}
      data-unseen={unseen ? "true" : undefined}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <ToolLogo toolType={session.toolType} size={13} className="shrink-0" />
      <span className="min-w-0 truncate">{title}</span>
    </button>
  );
}

function RosterArrow({
  direction,
  disabled,
  attention,
  onClick,
}: {
  direction: "previous" | "next";
  disabled: boolean;
  attention: boolean;
  onClick: () => void;
}) {
  const Icon = direction === "previous" ? CaretLeft : CaretRight;
  const label = direction === "previous" ? "Previous page" : "Next page";
  return (
    <SmartTooltip content={{ label, description: attention ? "A new chat is waiting there." : "Swipe sideways with two fingers to flip pages." }}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className="ade-focus-roster-arrow"
      >
        <Icon size={13} weight="bold" aria-hidden />
        {attention && !disabled ? (
          <span aria-hidden className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" />
        ) : null}
      </button>
    </SmartTooltip>
  );
}

/** What the toolbar pager shows; built by `useWorkFocusGrid` from the pages. */
export type WorkFocusPagerModel = FocusPageSummary & { onPage: (page: number) => void };

/**
 * The Focus grid's page control in the sidebar toolbar, beside the Focus pill.
 * With the sidebar open the sidebar itself is the roster, so the bottom row
 * goes away and paging lives here: ‹ 5–7/7 ›. Same height and border as the
 * pill and the segmented control next to it.
 */
export function WorkFocusToolbarPager({ model }: { model: WorkFocusPagerModel }) {
  const range = model.first === model.last ? `${model.first}` : `${model.first}–${model.last}`;
  return (
    <div className="ade-focus-toolbar-pager shrink-0" role="group" aria-label="Focus grid pages" data-testid="work-focus-toolbar-pager">
      <button
        type="button"
        className="ade-focus-toolbar-pager-arrow"
        aria-label="Previous page"
        title="Previous page"
        disabled={model.page === 0}
        onClick={() => model.onPage(model.page - 1)}
      >
        <CaretLeft size={10} weight="bold" aria-hidden />
        {model.newBefore && model.page > 0 ? <span aria-hidden className="ade-focus-toolbar-pager-new" /> : null}
      </button>
      <span
        className="ade-focus-toolbar-pager-label tabular-nums"
        title={`Chats ${range} of ${model.total} · page ${model.page + 1} of ${model.pageCount}`}
      >
        {range}/{model.total}
      </span>
      <button
        type="button"
        className="ade-focus-toolbar-pager-arrow"
        aria-label="Next page"
        title="Next page"
        disabled={model.page >= model.pageCount - 1}
        onClick={() => model.onPage(model.page + 1)}
      >
        <CaretRight size={10} weight="bold" aria-hidden />
        {model.newAfter && model.page < model.pageCount - 1 ? <span aria-hidden className="ade-focus-toolbar-pager-new" /> : null}
      </button>
    </div>
  );
}

/**
 * The Focus pill in the sidebar toolbar. The left half folds lanes where
 * agents are busy; the right half (live only while Focus is on) swaps the work
 * area for the Focus grid, so the bar itself says the grid belongs to Focus.
 * The board has its own Working column, so in board mode the pill dims.
 */
export function WorkFocusPill({
  on,
  grid,
  disabled,
  waitingCount,
  onToggle,
  onToggleGrid,
}: {
  on: boolean;
  grid: boolean;
  disabled: boolean;
  waitingCount: number;
  onToggle: () => void;
  /** Absent when the host has no Focus grid. */
  onToggleGrid?: () => void;
}) {
  const gridLive = on && !disabled;
  return (
    <div
      className="ade-work-focus-pill shrink-0"
      data-on={on ? "true" : undefined}
      data-grid={on && grid ? "true" : undefined}
      data-disabled={disabled ? "true" : undefined}
      data-testid="work-focus-pill"
    >
      <SmartTooltip
        content={{
          label: on ? "Turn Focus off" : "Focus",
          description: disabled
            ? "Focus works in the list. The board already has a Working column."
            : "Fold lanes where agents are busy into a Working section. They come back when something needs you.",
        }}
      >
        <button
          type="button"
          className="ade-work-focus-pill-main"
          aria-pressed={on}
          aria-label={on ? `Focus on, ${waitingCount} waiting for you` : "Focus"}
          disabled={disabled}
          onClick={onToggle}
          data-testid="work-focus-toggle"
        >
          <Target size={12} weight={on ? "bold" : "regular"} aria-hidden />
          <span>Focus</span>
          {on && waitingCount > 0 ? (
            <span className="ade-work-focus-pill-count tabular-nums">{waitingCount}</span>
          ) : null}
        </button>
      </SmartTooltip>
      {onToggleGrid ? (
        <SmartTooltip
          content={{
            label: grid ? "Show one chat" : "Focus grid",
            description: grid
              ? "Go back to one open chat with the tools pane."
              : "Show every chat that waits for you side by side.",
          }}
        >
          <button
            type="button"
            className="ade-work-focus-pill-grid"
            aria-pressed={grid}
            aria-label="Focus grid"
            tabIndex={gridLive ? 0 : -1}
            aria-hidden={gridLive ? undefined : true}
            disabled={!gridLive}
            onClick={onToggleGrid}
            data-testid="work-focus-grid-toggle"
          >
            <SquaresFour size={12} weight={grid ? "fill" : "regular"} aria-hidden />
          </button>
        </SmartTooltip>
      ) : null}
    </div>
  );
}
