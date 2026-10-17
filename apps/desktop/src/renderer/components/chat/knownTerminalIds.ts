/**
 * Remembers a terminal id the pane must not reveal again, so a replayed
 * "created" cannot reopen the Tools pane the user closed. There is no size
 * cap: evicting an id whose terminal is still live would let a replay reopen
 * the pane, so an id leaves the set only when that terminal is deleted. The set
 * therefore holds the terminals this pane has seen and that still exist.
 */
export function rememberKnownTerminalId(known: Set<string>, id: string): void {
  known.add(id);
}
