// ---------------------------------------------------------------------------
// Which pull request represents a lane, when only one can be shown.
// ---------------------------------------------------------------------------
//
// PR identity is `(repo, number)`, not the lane's head branch, so one lane
// legitimately owns SEVERAL rows: a follow-up PR cut from the same chat, or a
// colleague's PR referenced from this lane. Anything that has room for exactly
// one PR — the TUI lane-details pane, the `/pr` pane, the deeplink envelope the
// CLI stamps onto `ade://` links — therefore has to CHOOSE, and taking the
// first row the runtime happened to return let a long-merged PR out-rank the
// open work the user is looking at.
//
// The ranking itself is IMPORTED from `desktop/src/shared/primaryPr.ts`, the
// same module the desktop lane badge uses, so a link minted by the CLI can
// never point at a different PR than the badge shows. Only the defensive
// record reads below are CLI-specific: `pr listAll` returns loosely typed rows
// over the wire, so every field is read defensively before it is ranked.
//
// Inputs are raw runtime records (`pr listAll` returns loosely typed rows over
// the wire), so every field is read defensively.

import type { PrState } from "../../../desktop/src/shared/types/prs";
import {
  comparePrimaryPr,
  type PrimaryPrComparable,
} from "../../../desktop/src/shared/primaryPr";

export type PrRecord = Record<string, unknown>;

/**
 * A PR row's lifecycle state, narrowed to the four GitHub knows. Unknown or
 * missing reads as `open`: an unrecognised state must not demote a live PR
 * below a merged one.
 */
export function prRecordState(value: unknown): PrState {
  return value === "draft" || value === "merged" || value === "closed" ? value : "open";
}

/** A PR row's GitHub number, across the field names the wire has used. */
export function prRecordNumber(pr: PrRecord): number {
  const raw = pr.githubPrNumber ?? pr.number ?? pr.prNumber;
  return typeof raw === "number" && Number.isSafeInteger(raw) ? raw : 0;
}

/** Normalize one loose wire row into the shared comparator's shape. */
function comparableOf(pr: PrRecord): PrimaryPrComparable {
  return {
    state: prRecordState(pr.state),
    updatedAt: typeof pr.updatedAt === "string" ? pr.updatedAt : null,
    githubPrNumber: prRecordNumber(pr),
  };
}

/**
 * The single PR that best represents `prs`. Detached rows are dropped — their
 * `lane_id` keeps pointing at a lane that no longer owns them — and an empty
 * list answers `null`.
 */
export function pickPrimaryPrRecord(prs: readonly PrRecord[]): PrRecord | null {
  let best: PrRecord | null = null;
  let bestKey: PrimaryPrComparable | null = null;
  for (const pr of prs) {
    if (pr.detached === true) continue;
    const key = comparableOf(pr);
    if (best === null || bestKey === null || comparePrimaryPr(key, bestKey) < 0) {
      best = pr;
      bestKey = key;
    }
  }
  return best;
}
