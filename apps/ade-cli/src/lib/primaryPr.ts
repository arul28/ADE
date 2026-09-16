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
 * The single PR that best represents `prs`, or `null` for an empty list.
 *
 * Two defensive rules, both about rows this process cannot fully trust:
 *
 *   - **Detached rows are dropped.** `detached` is a RECORD
 *     (`PrDetachedLane | null`), never the boolean it reads like, so a
 *     `=== true` test silently matches nothing and lets a row whose lane no
 *     longer owns it win on recency. Any non-null value means detached.
 *   - **A row with no readable number ranks LAST, rather than being dropped.**
 *     Every consumer renders `#N` or stamps `prNumber` onto a deeplink, so such
 *     a row is useless to all of them — but excluding it outright would answer
 *     `null` if the runtime ever renamed the field on every row. Ranking it
 *     last means a usable row always wins, and an unusable one is still better
 *     than nothing.
 */
export function pickPrimaryPrRecord(prs: readonly PrRecord[]): PrRecord | null {
  let best: PrRecord | null = null;
  let bestKey: PrimaryPrComparable | null = null;
  let bestUsable = false;
  for (const pr of prs) {
    if (pr.detached != null) continue;
    const key = comparableOf(pr);
    const usable = key.githubPrNumber > 0;
    if (best === null || bestKey === null) {
      best = pr;
      bestKey = key;
      bestUsable = usable;
      continue;
    }
    // A readable number outranks every other consideration; only when both
    // rows agree on that does the shared ordering decide.
    if (usable !== bestUsable) {
      if (usable) {
        best = pr;
        bestKey = key;
        bestUsable = true;
      }
      continue;
    }
    if (comparePrimaryPr(key, bestKey) < 0) {
      best = pr;
      bestKey = key;
      bestUsable = usable;
    }
  }
  return best;
}
