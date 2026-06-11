/**
 * Shared row-layout math for the lane drawer.
 *
 * The drawer renders lane cards (Drawer.tsx) and the terminal mouse handler
 * (app.tsx) maps click rows back onto lanes/chats. Both sides MUST agree on
 * exactly how many rows each card consumes; this module is the single source
 * of truth so the render and the hit-test cannot drift.
 *
 * Row model (full density, terminal Y is 1-based inside the drawer):
 *   row 1            outer drawer top border
 *   row 2            "LANES · N" header
 *   row 3+           lane cards, each:
 *                      ╭──────╮   top border
 *                      │ name │   line 1
 *                      │ meta │   line 2
 *                      │ diff │   only on the expanded card when diff stats exist
 *                      [chat rows]
 *                      ╰──────╯   bottom border
 *                    + 1 blank row of marginTop between adjacent cards
 *
 * Chat rows come in two shapes:
 *   - Expanded lane (the selected/browsing one): the full chat block —
 *     marginTop + "CHATS · N" header + chats (1 row each, 1-row gaps) +
 *     "+ new chat" row. Unavailable worktrees render header + "worktree
 *     missing" instead.
 *   - Every other lane: a compact always-visible preview — up to
 *     DRAWER_COMPACT_CHAT_CAP single-row chats plus an optional "+N more"
 *     row, budget permitting.
 */

export const DRAWER_COMPACT_CHAT_CAP = 3;

/** Rows of drawer chrome outside lane cards: borders 2 + header 1 + footer hints 2 + new-lane 1. */
const DRAWER_CHROME_ROWS = 6;
/** Base cost of a lane card: borders 2 + content 2 + inter-card margin 1. */
const CARD_BASE_ROWS = 5;

export function visibleDrawerLaneCount(panelHeight: number, laneCount: number): number {
  const lanesMaxRows = Math.max(2, Math.floor((panelHeight - DRAWER_CHROME_ROWS) / CARD_BASE_ROWS));
  return Math.min(laneCount, 12, lanesMaxRows);
}

export function visibleDrawerChatCount(chatCount: number, availableRows?: number): number {
  const cap = 12;
  if (availableRows == null) return Math.min(chatCount, cap);
  // Each chat row costs 2 rows (content + margin); first row has no margin.
  // The chat block also has a header ("CHATS · N") and a footer ("+ new chat"),
  // costing 3 rows of chrome (header + marginTop + footer).
  const chromeRows = 3;
  const maxByHeight = Math.max(1, Math.floor((availableRows - chromeRows + 1) / 2));
  return Math.min(chatCount, cap, maxByHeight);
}

/** The scroll window of lane cards the drawer can show: slice start + count. */
export function drawerLaneWindow(
  panelHeight: number,
  laneCount: number,
  scrollOffsetRows: number,
): { start: number; count: number } {
  const count = visibleDrawerLaneCount(panelHeight, laneCount);
  const start = Math.max(0, Math.min(scrollOffsetRows, Math.max(0, laneCount - count)));
  return { start, count };
}

export type DrawerLaneInput = {
  laneId: string;
  /** Total chat sessions in the lane. */
  chatCount: number;
  /** Lane worktree exists on disk (missing worktrees swap the expanded chat block for a warning). */
  worktreeAvailable: boolean;
  /** The expanded card renders a third content row with +adds/−dels. */
  hasDiffRow: boolean;
};

export type DrawerLanePlan = {
  laneId: string;
  /** Absolute index into the full ordered lane list. */
  laneIndex: number;
  expanded: boolean;
  /** Chats rendered for this lane (expanded block rows or compact preview rows). */
  visibleChatCount: number;
  /** Hidden-chat count behind the compact preview's "+N more" row (0 = no row). */
  moreCount: number;
  /** The expanded card actually renders its diff row. */
  hasDiffRow: boolean;
  worktreeAvailable: boolean;
};

export type DrawerLayout = {
  laneStart: number;
  lanes: DrawerLanePlan[];
};

export function computeDrawerLayout({
  panelHeight,
  lanes,
  expandedLaneIndex,
  selectedLaneIndex,
  scrollOffsetRows,
}: {
  panelHeight: number;
  /** All lanes in drawer (stack-graph) order. */
  lanes: DrawerLaneInput[];
  /** Absolute index of the lane whose full chat block is expanded, or null. */
  expandedLaneIndex: number | null;
  /** Absolute index of the selected lane (renders the diff row), or null. */
  selectedLaneIndex: number | null;
  scrollOffsetRows: number;
}): DrawerLayout {
  const { start: laneStart, count } = drawerLaneWindow(panelHeight, lanes.length, scrollOffsetRows);
  const visible = lanes.slice(laneStart, laneStart + count);

  // Leftover rows after chrome + base card costs go to chat rows: the expanded
  // block first (matching the legacy chatRowBudget), then compact previews
  // top-to-bottom with whatever remains.
  const chatRowBudget = panelHeight - DRAWER_CHROME_ROWS - count * CARD_BASE_ROWS;

  const plans: DrawerLanePlan[] = visible.map((lane, offset) => ({
    laneId: lane.laneId,
    laneIndex: laneStart + offset,
    expanded: laneStart + offset === expandedLaneIndex,
    visibleChatCount: 0,
    moreCount: 0,
    // The diff row renders on the selected card only, and only when the lane
    // has diff stats and a live worktree (laneDetailSuffix's rule).
    hasDiffRow: laneStart + offset === selectedLaneIndex && lane.hasDiffRow && lane.worktreeAvailable,
    worktreeAvailable: lane.worktreeAvailable,
  }));

  let remaining = Math.max(0, chatRowBudget);
  // A selected-but-not-expanded lane (chats mode browsing another lane) still
  // renders its diff row; reserve it before handing rows to previews.
  const nonExpandedDiffRows = plans.filter((plan) => plan.hasDiffRow && !plan.expanded).length;
  remaining = Math.max(0, remaining - nonExpandedDiffRows);
  const expandedPlan = plans.find((plan) => plan.expanded) ?? null;
  if (expandedPlan) {
    const lane = lanes[expandedPlan.laneIndex]!;
    if (!lane.worktreeAvailable) {
      // header + "worktree missing" message (+ marginTop) — no chat rows.
      remaining = Math.max(0, remaining - 3);
    } else {
      const chats = visibleDrawerChatCount(lane.chatCount, chatRowBudget);
      expandedPlan.visibleChatCount = chats;
      const blockRows = 2 + (chats > 0 ? chats * 2 - 1 : 0) + 1; // margin+header + chats + new-chat
      remaining = Math.max(0, remaining - blockRows - (expandedPlan.hasDiffRow ? 1 : 0));
    }
  }
  for (const plan of plans) {
    if (plan.expanded || remaining <= 0) continue;
    const lane = lanes[plan.laneIndex]!;
    if (!lane.worktreeAvailable || lane.chatCount === 0) continue;
    let shown = Math.min(lane.chatCount, DRAWER_COMPACT_CHAT_CAP, remaining);
    let more = lane.chatCount - shown;
    let rowsUsed = shown + (more > 0 ? 1 : 0);
    if (rowsUsed > remaining && shown > 0) {
      // Trade the last chat row for the "+N more" row when both can't fit.
      shown -= 1;
      more = lane.chatCount - shown;
      rowsUsed = shown + 1;
    }
    if (shown <= 0) continue;
    plan.visibleChatCount = shown;
    plan.moreCount = more;
    remaining -= rowsUsed;
  }
  return { laneStart, lanes: plans };
}

export type DrawerMouseHit =
  | { kind: "lane"; index: number }
  | { kind: "chat"; laneIndex: number; chatIndex: number }
  | { kind: "new-chat" }
  | null;

/**
 * Map a drawer-local 1-based row onto the lane/chat/new-chat target it renders.
 * `layout` must come from computeDrawerLayout with the same inputs the Drawer
 * rendered from. Returned lane/chat indexes are positions within
 * `layout.lanes` / that lane's visible chats (NOT absolute lane indexes).
 */
export function drawerMouseHitForLayout({
  y,
  layout,
}: {
  y: number | null;
  layout: DrawerLayout;
}): DrawerMouseHit {
  if (y == null || layout.lanes.length === 0) return null;
  let line = 3; // first lane card's top border row
  for (let index = 0; index < layout.lanes.length; index += 1) {
    const plan = layout.lanes[index]!;
    // Card body: top border + line1 + line2 + optional diff row.
    const cardBodyHeight = 3 + (plan.hasDiffRow ? 1 : 0);
    if (y >= line && y < line + cardBodyHeight) return { kind: "lane", index };
    line += cardBodyHeight;
    if (plan.expanded) {
      if (!plan.worktreeAvailable) {
        // marginTop + header + "worktree missing"
        if (y >= line && y < line + 3) return { kind: "lane", index };
        line += 3;
      } else {
        const chatCount = plan.visibleChatCount;
        const blockStart = line + 2; // marginTop + "CHATS · N" header
        if (y >= line && y < blockStart) return { kind: "lane", index };
        for (let chatIdx = 0; chatIdx < chatCount; chatIdx += 1) {
          const chatRowY = blockStart + chatIdx * 2;
          if (y === chatRowY) return { kind: "chat", laneIndex: index, chatIndex: chatIdx };
        }
        const newChatY = chatCount > 0 ? blockStart + (chatCount - 1) * 2 + 1 : blockStart;
        if (y === newChatY) return { kind: "new-chat" };
        line += 2 + (chatCount > 0 ? chatCount * 2 - 1 : 0) + 1;
      }
    } else if (plan.visibleChatCount > 0) {
      // Compact preview: one row per chat, then an optional "+N more" row.
      for (let chatIdx = 0; chatIdx < plan.visibleChatCount; chatIdx += 1) {
        if (y === line + chatIdx) return { kind: "chat", laneIndex: index, chatIndex: chatIdx };
      }
      line += plan.visibleChatCount;
      if (plan.moreCount > 0) {
        if (y === line) return { kind: "lane", index };
        line += 1;
      }
    }
    if (y === line) return { kind: "lane", index }; // bottom border
    line += 1;
    if (index < layout.lanes.length - 1) line += 1; // marginTop separator
  }
  return null;
}
