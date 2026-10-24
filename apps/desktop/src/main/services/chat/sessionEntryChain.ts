/**
 * The conversation a session file resumes: the chain from its leaf back to
 * the root, root first. Claude and Pi both keep a session as a tree of entries
 * linked by parent id, where a rewind or a branch leaves other branches in
 * the file; only the leaf's chain is the conversation.
 *
 * The leaf is the last entry `isLeaf` accepts (by default, the last entry). A
 * cycle stops the walk rather than looping.
 */
export function sessionEntryChain<T>(
  entries: readonly T[],
  idOf: (entry: T) => string,
  parentOf: (entry: T) => string | null,
  isLeaf: (entry: T) => boolean = () => true,
): T[] {
  const byId = new Map(entries.map((entry) => [idOf(entry), entry]));
  let leaf: T | null = null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (isLeaf(entries[index]!)) {
      leaf = entries[index]!;
      break;
    }
  }
  const chain: T[] = [];
  const seen = new Set<string>();
  for (let cursor = leaf; cursor && !seen.has(idOf(cursor)); ) {
    seen.add(idOf(cursor));
    chain.push(cursor);
    const parent = parentOf(cursor);
    cursor = parent ? byId.get(parent) ?? null : null;
  }
  return chain.reverse();
}
