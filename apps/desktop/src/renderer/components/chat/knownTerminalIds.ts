/**
 * The most terminal ids a chat pane remembers. Each is a short string, so the
 * full set is about 5,000 strings (estimated well under a megabyte, not measured).
 * An id is evicted only after this many newer ids were remembered within one
 * pane's life, far more than the chat's own list plus the terminals agents start
 * while the pane is open.
 */
export const KNOWN_TERMINAL_IDS_LIMIT = 5000;

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
