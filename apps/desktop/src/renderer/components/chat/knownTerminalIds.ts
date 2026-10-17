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

/**
 * Releases the ids of a chat's terminals that are gone. A chat read can be stale
 * or partial, so an id the read omits is not released on that alone: each one is
 * looked up, and only a terminal the lookup reports as gone (null) leaves the set.
 * This catches terminals deleted while the pane was not listening for deletions.
 * `owners` maps a remembered id to the chat it belongs to; only `chatSessionId`'s
 * ids are checked, so other chats' terminals wait for their own read.
 */
export async function releaseDeletedTerminalIds(args: {
  known: Set<string>;
  owners: Map<string, string>;
  chatSessionId: string;
  listedIds: ReadonlySet<string>;
  lookup: (id: string) => Promise<unknown>;
}): Promise<void> {
  const { known, owners, chatSessionId, listedIds, lookup } = args;
  const candidates = [...owners].filter(([id, owner]) => owner === chatSessionId && !listedIds.has(id)).map(([id]) => id);
  await Promise.all(candidates.map(async (id) => {
    let found: unknown;
    try {
      found = await lookup(id);
    } catch {
      return;
    }
    if (found !== null) return;
    known.delete(id);
    owners.delete(id);
  }));
}
