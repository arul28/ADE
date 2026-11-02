/**
 * What a bulk action leaves out and why, one line per reason in first-seen
 * order: "2 skipped · Studio is offline". Bulk menus show these so a row that
 * will not be touched says so instead of quietly dropping out of the count.
 */
export function skippedReasonLines(reasons: Iterable<string>): string[] {
  const counts = new Map<string, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts].map(([reason, count]) => `${count} skipped · ${reason}`);
}
