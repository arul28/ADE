export type ActivityPhaseMemberKind = "reasoning" | "work";

export type ActivityPhaseCounts = {
  totalRows: number;
  reasoningRows: number;
  workRows: number;
};

export function shouldCollapseActivityPhase(counts: ActivityPhaseCounts): boolean {
  return counts.totalRows >= 3
    || counts.reasoningRows >= 2
    || counts.workRows >= 2;
}

export type ActivityPhaseMergeMeta = {
  workFirst: boolean;
};

/**
 * Collapse contiguous runs of reasoning + work activity rows within the same
 * turn. Hard boundaries and non-activity rows end a phase without merging.
 */
export function collapseActivityPhaseRows<T>(
  rows: readonly T[],
  classify: (row: T) => { kind: ActivityPhaseMemberKind; turnId: string | null } | null,
  mergePhase: (phase: readonly T[], meta: ActivityPhaseMergeMeta) => readonly T[],
): T[] {
  const result: T[] = [];
  let index = 0;

  while (index < rows.length) {
    const row = rows[index]!;
    const activity = classify(row);
    if (!activity) {
      result.push(row);
      index += 1;
      continue;
    }

    const phaseTurnId = activity.turnId;
    const phase: T[] = [row];
    let reasoningRows = activity.kind === "reasoning" ? 1 : 0;
    let workRows = activity.kind === "work" ? 1 : 0;
    const workFirst = activity.kind === "work";
    let cursor = index + 1;

    while (cursor < rows.length) {
      const next = rows[cursor]!;
      const nextActivity = classify(next);
      if (!nextActivity) break;
      if ((nextActivity.turnId ?? null) !== (phaseTurnId ?? null)) break;
      phase.push(next);
      if (nextActivity.kind === "reasoning") reasoningRows += 1;
      else workRows += 1;
      cursor += 1;
    }

    if (shouldCollapseActivityPhase({
      totalRows: phase.length,
      reasoningRows,
      workRows,
    })) {
      result.push(...mergePhase(phase, { workFirst }));
    } else {
      result.push(...phase);
    }
    index = cursor;
  }

  return result;
}

/**
 * Join two reasoning fragments without repeating text the provider re-sent.
 *
 * Providers stream a thought as deltas and then re-emit the completed block
 * (Claude sends the SDK snapshot after the deltas, Cursor re-sends a run's
 * text), so a blind concatenation doubles the paragraph. Cumulative re-emits
 * (`incoming` extends `existing`), exact duplicates, and a full suffix re-emit
 * collapse to the text once.
 *
 * A partial boundary overlap is deliberately NOT spliced: two genuine deltas
 * can share a boundary character (e.g. "look" then "keep going"), and dropping
 * the overlap would eat real text ("lookeep going"). Only a full containment —
 * the whole incoming is already present — proves a replay, so anything else is
 * concatenated verbatim.
 */
export function mergeReasoningFragment(existing: string, incoming: string): string {
  if (!existing.length) return incoming;
  if (!incoming.length) return existing;
  if (existing === incoming) return existing;
  if (incoming.startsWith(existing)) return incoming;
  if (existing.startsWith(incoming)) return existing;
  if (incoming.trim().length > 0 && existing.trimEnd().endsWith(incoming.trim())) return existing;
  return `${existing}${incoming}`;
}

/**
 * Collapse a list of reasoning blocks into the blocks that actually differ.
 *
 * Used when a whole list is folded at once (activity-phase merge, the TUI's
 * aggregate) rather than appended pairwise like {@link mergeReasoningFragment}.
 * Identical blocks drop, a cumulative re-emit replaces the block it extends, and
 * blocks already contained in another drop — including every earlier block a
 * cumulative re-emit swallowed, not just the first one found. Genuinely
 * distinct blocks are joined by `---`, which is presentation the pairwise
 * stream accumulator deliberately does not apply.
 */
export function mergeReasoningTextFragments(texts: readonly string[]): string {
  const fragments: string[] = [];
  for (const raw of texts) {
    const text = raw.trim();
    if (!text.length) continue;
    if (fragments.includes(text)) continue;
    const contained = fragments
      .map((fragment, index) => (text.includes(fragment) ? index : -1))
      .filter((index) => index >= 0);
    if (contained.length) {
      // Replace the earliest contained block with the cumulative text and drop
      // the others it also contains, so a re-emit covering two earlier blocks
      // leaves neither behind.
      const firstIndex = contained[0]!;
      fragments[firstIndex] = text;
      for (const index of contained.slice(1).sort((left, right) => right - left)) {
        fragments.splice(index, 1);
      }
      continue;
    }
    if (fragments.some((fragment) => fragment.includes(text))) continue;
    fragments.push(text);
  }
  return fragments.join("\n\n---\n\n");
}
