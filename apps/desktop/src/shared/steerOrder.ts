/**
 * Staged-queue ordering, shared by the chat service, the desktop pane and
 * composer, and the TUI. iOS mirrors `applySteerOrder` by hand in
 * `derivePendingWorkSteers`.
 */

/**
 * `items` sorted to `order` (a list of ids). Items `order` does not name keep
 * their relative place after the named ones; ids with no item are skipped.
 */
export function applySteerOrder<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  order: readonly string[],
): T[] {
  const rank = new Map(order.map((id, index) => [id, index] as const));
  return items
    .map((item, index) => ({ item, key: rank.get(idOf(item)) ?? order.length + index }))
    .sort((a, b) => a.key - b.key)
    .map(({ item }) => item);
}

/**
 * `ids` with `id` moved to `toIndex` (clamped to the list), or null when `id`
 * is not in it.
 */
export function moveSteerId(ids: readonly string[], id: string, toIndex: number): string[] | null {
  const from = ids.indexOf(id);
  if (from === -1) return null;
  const next = ids.filter((candidate) => candidate !== id);
  const target = Math.max(0, Math.min(next.length, Number.isFinite(toIndex) ? Math.trunc(toIndex) : from));
  next.splice(target, 0, id);
  return next;
}
