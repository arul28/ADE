/**
 * Grouping and labelling for the CI tab's list views.
 *
 * The list used to be one undifferentiated grid of ~34 identical rows, each
 * repeating its workflow name as a `"CI / "` prefix. Every row looked exactly
 * as important as every other, and a third of the horizontal space in each row
 * was spent restating the group it was already in.
 *
 * This module produces the hierarchy instead: sections keyed by workflow,
 * ordered so the section that needs attention is first, with the redundant
 * prefix stripped from the row label because the section header already carries
 * it. Pure and React-free so the ordering rules are unit-testable.
 */

import { STATE_RANK } from "../../../../shared/prPipelineState";
import type { PrPipelineState } from "../../../../shared/types";
import { pipelineStateOf, type UnifiedCheckItem } from "../shared/prUnifiedChecks";
import { stripWorkflowPrefix, workflowNameOf } from "./prChecksModel";

/** Section for checks that name no workflow — preview bots, external statuses. */
export const OTHER_CHECKS_SECTION = "Other checks";

/**
 * Workflow a check belongs to. Actions jobs carry it directly; a check-run row
 * spells it `"<workflow> / <job>"`, which is the only handle available for PRs
 * where the jobs API could not answer.
 */
export function workflowOf(item: UnifiedCheckItem): string {
  return workflowNameOf(item) ?? OTHER_CHECKS_SECTION;
}

/**
 * Row label with the section's own name stripped off the front. `"CI / build"`
 * inside the `CI` section reads as `build`; a name that does not carry the
 * prefix is left exactly as it is.
 */
export function rowLabel(item: UnifiedCheckItem, workflowName: string): string {
  return stripWorkflowPrefix(item.displayName, workflowName);
}

export type ChecksListSection = {
  workflowName: string;
  items: UnifiedCheckItem[];
  /** Worst state across the section, for its header glyph. */
  state: PrPipelineState;
  failedCount: number;
};

/**
 * Group checks into workflow sections.
 *
 * Ordering is by *urgency*, not alphabet: the workflow with failures comes
 * first, then anything still moving, then the settled ones — because on a PR
 * whose CI is red the only question the user has is "what broke", and making
 * them scan an alphabetised list for it is the clutter complaint in one line.
 * `Other checks` is pinned last regardless: it is the leftovers bucket.
 */
export function groupChecksForList(items: UnifiedCheckItem[]): ChecksListSection[] {
  const byWorkflow = new Map<string, UnifiedCheckItem[]>();
  for (const item of items) {
    const key = workflowOf(item);
    const bucket = byWorkflow.get(key);
    if (bucket) bucket.push(item);
    else byWorkflow.set(key, [item]);
  }

  const sections: ChecksListSection[] = Array.from(byWorkflow.entries()).map(
    ([workflowName, sectionItems]) => {
      const states = sectionItems.map(pipelineStateOf);
      const state = states.reduce(
        (worst, next) => (STATE_RANK[next] < STATE_RANK[worst] ? next : worst),
        states[0] ?? "unknown",
      );
      return {
        workflowName,
        // Inside a section, surface the broken rows first for the same reason.
        items: [...sectionItems].sort((left, right) => (
          STATE_RANK[pipelineStateOf(left)] - STATE_RANK[pipelineStateOf(right)]
          || left.displayName.localeCompare(right.displayName)
        )),
        state,
        failedCount: states.filter((value) => value === "failed").length,
      };
    },
  );

  return sections.sort((left, right) => {
    const leftOther = left.workflowName === OTHER_CHECKS_SECTION ? 1 : 0;
    const rightOther = right.workflowName === OTHER_CHECKS_SECTION ? 1 : 0;
    return (leftOther - rightOther)
      || (STATE_RANK[left.state] - STATE_RANK[right.state])
      || left.workflowName.localeCompare(right.workflowName);
  });
}
