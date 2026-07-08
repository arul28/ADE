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

export function mergeReasoningTextFragments(texts: readonly string[]): string {
  return texts
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .join("\n\n---\n\n");
}
