/**
 * The most terminal ids a chat pane remembers. Far above what one pane sees in
 * practice: the chat's own list plus the terminals agents start while the pane
 * is open. An id only leaves the set after this many newer ids were remembered,
 * so a live terminal is not evicted in practice.
 */
export const KNOWN_TERMINAL_IDS_LIMIT = 1000;

/**
 * Remembers a terminal id the pane must not reveal again, so a replayed
 * "created" cannot reopen the Tools pane the user closed. A re-remembered id
 * moves to the newest position, and the oldest ids go once the set is over the limit.
 */
export function rememberKnownTerminalId(known: Set<string>, id: string): void {
  // Delete first so a re-listed id counts as recent.
  known.delete(id);
  known.add(id);
  while (known.size > KNOWN_TERMINAL_IDS_LIMIT) {
    const oldest = known.values().next().value as string | undefined;
    if (oldest === undefined) break;
    known.delete(oldest);
  }
}
