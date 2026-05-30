/**
 * Scrollback + "new output" state for the Claude live PTY pane (TerminalPane).
 *
 * Claude turns render through a headless xterm fed by `pty_data` chunks. When the
 * user scrolls up to read earlier output we must (a) stop auto-following the
 * bottom and (b) surface an amber "↓ N new" chip counting lines that arrived
 * while they were scrolled away. This module holds the small, framework-free
 * state shape + pure helpers shared between app.tsx (owner of the per-session
 * map) and TerminalPane.tsx (consumer/renderer). Keeping it pure keeps the
 * hot path allocation-free and unit-testable without React.
 */

/** Per-session scrollback position + pending-new-output counter. */
export type TerminalScrollState = {
  /**
   * Rows scrolled up from the live bottom. 0 = pinned to bottom (auto-follow);
   * >0 = user is reading scrollback and new output should NOT yank them down.
   */
  scrollOffset: number;
  /** Lines of new output that arrived while scrolled up; drives the "↓ N new" chip. */
  pendingNewCount: number;
};

export type TerminalScrollBySessionId = Record<string, TerminalScrollState>;

export const TERMINAL_SCROLL_AT_BOTTOM: TerminalScrollState = {
  scrollOffset: 0,
  pendingNewCount: 0,
};

/** How many rows one PageUp/PageDown moves, relative to the visible window. */
export function terminalPageStep(visibleRows: number): number {
  return Math.max(1, Math.floor(Math.max(1, visibleRows) / 2));
}

/** Read a session's scroll state, defaulting to "pinned at bottom". */
export function readTerminalScroll(
  byId: TerminalScrollBySessionId,
  sessionId: string | null | undefined,
): TerminalScrollState {
  if (!sessionId) return TERMINAL_SCROLL_AT_BOTTOM;
  return byId[sessionId] ?? TERMINAL_SCROLL_AT_BOTTOM;
}

/**
 * Clamp a requested scroll offset to the valid window.
 * `maxScrollable` is (buffer rows above the viewport that can still be revealed).
 */
export function clampTerminalScrollOffset(offset: number, maxScrollable: number): number {
  const ceiling = Math.max(0, Math.floor(maxScrollable));
  if (!Number.isFinite(offset)) return 0;
  return Math.max(0, Math.min(ceiling, Math.floor(offset)));
}

/**
 * Apply a relative scroll delta (negative = toward older output / up,
 * positive = toward newest / down) producing the next state. Scrolling all the
 * way back to the bottom clears the pending-new counter (the user has caught up).
 */
export function scrollTerminalBy(
  current: TerminalScrollState,
  delta: number,
  maxScrollable: number,
): TerminalScrollState {
  // Up (older) increases offset; our `delta` convention: up = +, down = -.
  const nextOffset = clampTerminalScrollOffset(current.scrollOffset + delta, maxScrollable);
  // No-op scroll past the clamp (offset unchanged) must not allocate a new state
  // object — but still clear a stale pending counter once we're pinned at bottom.
  if (nextOffset === current.scrollOffset) {
    return nextOffset === 0 && current.pendingNewCount !== 0
      ? { scrollOffset: 0, pendingNewCount: 0 }
      : current;
  }
  return {
    scrollOffset: nextOffset,
    pendingNewCount: nextOffset === 0 ? 0 : current.pendingNewCount,
  };
}

/** Jump to the live bottom and clear the "N new" counter (chip dismiss / End). */
export function jumpTerminalToBottom(current: TerminalScrollState): TerminalScrollState {
  if (current.scrollOffset === 0 && current.pendingNewCount === 0) return current;
  return TERMINAL_SCROLL_AT_BOTTOM;
}

/**
 * Record that `arrivedRows` of fresh output landed. When pinned to the bottom we
 * stay pinned (no chip). When scrolled up we accumulate the count so the chip can
 * say how far behind the user is.
 */
export function noteTerminalNewRows(
  current: TerminalScrollState,
  arrivedRows: number,
  maxScrollable = Number.POSITIVE_INFINITY,
): TerminalScrollState {
  if (current.scrollOffset <= 0) return current;
  const add = Math.max(0, Math.floor(arrivedRows));
  if (add === 0) return current;
  // The render window starts at viewportY - scrollOffset and viewportY grows by
  // `add` per arrived row, so advance scrollOffset by the same amount to keep the
  // user's viewed content anchored to its absolute buffer line instead of
  // drifting down a line per write. Clamp to the (grown) maxScrollable.
  return {
    scrollOffset: clampTerminalScrollOffset(current.scrollOffset + add, maxScrollable),
    pendingNewCount: current.pendingNewCount + add,
  };
}
