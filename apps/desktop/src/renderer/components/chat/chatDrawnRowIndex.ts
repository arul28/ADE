import type { ChatTranscriptGroupedEnvelope } from "./chatTranscriptRows";

/** Resolve row keys through the aliases created by pre-draw grouping passes. */
export function resolveDrawnRowKey(
  key: string,
  aliases: readonly ReadonlyMap<string, string>[],
): string {
  let current = key;
  const visited = new Set<string>();
  while (!visited.has(current)) {
    visited.add(current);
    let next: string | undefined;
    for (const aliasMap of aliases) {
      const candidate = aliasMap.get(current);
      if (candidate && candidate !== current) {
        next = candidate;
        break;
      }
    }
    if (!next) break;
    current = next;
  }
  return current;
}

/**
 * Map every visible row key and grouped member key to its drawn row index.
 * Additional member/alias maps can bridge rows merged before the final draw
 * pass; aliases resolve transitively so a merged row hidden in a fold resolves
 * to that fold's visible index.
 */
export function buildDrawnRowKeyIndex(
  rows: readonly ChatTranscriptGroupedEnvelope[],
  aliases: readonly ReadonlyMap<string, string>[] = [],
): Map<string, number> {
  const indexByKey = new Map<string, number>();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    indexByKey.set(row.key, index);
    if (
      row.event.type === "subagent_card_grid"
      || row.event.type === "subagent_stopped_group"
      || row.event.type === "background_job_group"
    ) {
      for (const memberKey of row.event.memberKeys) indexByKey.set(memberKey, index);
    }
  }

  const unresolved = new Map<string, string>();
  for (const aliasMap of aliases) {
    for (const [key, rowKey] of aliasMap) {
      if (!indexByKey.has(key)) unresolved.set(key, rowKey);
    }
  }
  const aliasesForResolve = [...aliases];
  for (const key of unresolved.keys()) {
    const resolvedKey = resolveDrawnRowKey(key, aliasesForResolve);
    const index = indexByKey.get(resolvedKey);
    if (index !== undefined) indexByKey.set(key, index);
  }
  return indexByKey;
}
