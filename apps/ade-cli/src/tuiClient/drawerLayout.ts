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
 *                      │ name │   the single lane line (dot + name + diff)
 *                      [chat rows]
 *                      ╰──────╯   bottom border
 *                    + 1 blank row of marginTop between adjacent cards
 *
 * Selected and non-selected cards render the SAME tight chat list (1 row per
 * chat, no gaps) so a card barely changes when you select it — it just gains a
 * violet border. The two shapes differ only by their trailing row:
 *   - Expanded lane (the selected/browsing one): chats directly under the lane
 *     line + a "+ new chat" row. Unavailable worktrees render a single
 *     "worktree missing" row instead of chats.
 *   - Every other lane: the same chats + an optional "+N more" row when the
 *     row budget can't fit them all.
 */

// Non-selected lanes show all their chats too (capped only by the row budget);
// the cap just guards a pathological lane with dozens of chats.
export const DRAWER_COMPACT_CHAT_CAP = 12;

/** Rows of drawer chrome outside lane cards: borders 2 + header 1 + footer hints 2 + new-lane 1. */
const DRAWER_CHROME_ROWS = 6;
/** Base cost of a lane card: borders 2 + single lane line 1 + inter-card margin 1. */
const CARD_BASE_ROWS = 4;

export function visibleDrawerLaneCount(panelHeight: number, laneCount: number): number {
  const lanesMaxRows = Math.max(2, Math.floor((panelHeight - DRAWER_CHROME_ROWS) / CARD_BASE_ROWS));
  return Math.min(laneCount, 12, lanesMaxRows);
}

export function visibleDrawerChatCount(chatCount: number, availableRows?: number): number {
  const cap = 12;
  if (availableRows == null) return Math.min(chatCount, cap);
  // Chats are 1 row each (no inter-chat gaps). The expanded block adds a single
  // "+ new chat" footer row, so reserve 1 row of chrome.
  const chromeRows = 1;
  const maxByHeight = Math.max(1, availableRows - chromeRows);
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
  /** Absolute index of the selected lane, or null. */
  selectedLaneIndex: number | null;
  scrollOffsetRows: number;
}): DrawerLayout {
  void selectedLaneIndex; // selection no longer changes a lane's row footprint
  const { start: laneStart, count } = drawerLaneWindow(panelHeight, lanes.length, scrollOffsetRows);
  const visible = lanes.slice(laneStart, laneStart + count);

  // Leftover rows after chrome + base card costs go to chat rows: the expanded
  // block first, then compact previews top-to-bottom with whatever remains.
  const chatRowBudget = panelHeight - DRAWER_CHROME_ROWS - count * CARD_BASE_ROWS;

  const plans: DrawerLanePlan[] = visible.map((lane, offset) => ({
    laneId: lane.laneId,
    laneIndex: laneStart + offset,
    expanded: laneStart + offset === expandedLaneIndex,
    visibleChatCount: 0,
    moreCount: 0,
    worktreeAvailable: lane.worktreeAvailable,
  }));

  let remaining = Math.max(0, chatRowBudget);
  const expandedPlan = plans.find((plan) => plan.expanded) ?? null;
  if (expandedPlan) {
    const lane = lanes[expandedPlan.laneIndex]!;
    if (!lane.worktreeAvailable) {
      // single "worktree missing" row — no chat rows, no header.
      remaining = Math.max(0, remaining - 1);
    } else {
      const chats = visibleDrawerChatCount(lane.chatCount, chatRowBudget);
      expandedPlan.visibleChatCount = chats;
      const blockRows = chats + 1; // tight chats + "+ new chat"
      remaining = Math.max(0, remaining - blockRows);
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
    // Card body: top border + the single lane line.
    const cardBodyHeight = 2;
    if (y >= line && y < line + cardBodyHeight) return { kind: "lane", index };
    line += cardBodyHeight;
    if (plan.expanded) {
      if (!plan.worktreeAvailable) {
        // single "worktree missing" row
        if (y === line) return { kind: "lane", index };
        line += 1;
      } else {
        const chatCount = plan.visibleChatCount;
        // Chats render directly under the lane line (tight, 1 row each), then a
        // trailing "+ new chat" row — no header, matching the compact preview.
        for (let chatIdx = 0; chatIdx < chatCount; chatIdx += 1) {
          if (y === line + chatIdx) return { kind: "chat", laneIndex: index, chatIndex: chatIdx };
        }
        const newChatY = line + chatCount;
        if (y === newChatY) return { kind: "new-chat" };
        line += chatCount + 1;
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
