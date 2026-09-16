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
// The ranking deliberately mirrors `primaryPrStateRank` / `comparePrimaryPr` in
// `apps/desktop/src/renderer/lib/lanePrBadge.ts`, which is what the desktop
// lane badge uses, so a link minted by the CLI points at the PR the badge
// shows. It is restated here rather than imported because that module reaches
// the renderer's `window.ade` bridge, which does not exist in a CLI process.
//
// Inputs are raw runtime records (`pr listAll` returns loosely typed rows over
// the wire), so every field is read defensively.

import type { PrState } from "../../../desktop/src/shared/types/prs";

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

/**
 * Ordered most cautious-to-report first: an open PR is the most actionable,
 * then a draft, then terminal history. Merged and closed share the terminal
 * rank so their activity timestamps decide which history is most useful.
 * Lower wins.
 */
function primaryPrStateRank(state: PrState): number {
  switch (state) {
    case "open": return 0;
    case "draft": return 1;
    default: return 2; // merged | closed
  }
}

function comparePrimaryPr(a: PrRecord, b: PrRecord): number {
  const byRank = primaryPrStateRank(prRecordState(a.state)) - primaryPrStateRank(prRecordState(b.state));
  if (byRank !== 0) return byRank;
  const aUpdated = Date.parse(typeof a.updatedAt === "string" ? a.updatedAt : "");
  const bUpdated = Date.parse(typeof b.updatedAt === "string" ? b.updatedAt : "");
  const aHasUpdated = Number.isFinite(aUpdated);
  const bHasUpdated = Number.isFinite(bUpdated);
  if (aHasUpdated !== bHasUpdated) return aHasUpdated ? -1 : 1;
  if (aHasUpdated && aUpdated !== bUpdated) return bUpdated - aUpdated;
  return prRecordNumber(b) - prRecordNumber(a);
}

/**
 * The single PR that best represents `prs`. Detached rows are dropped — their
 * `lane_id` keeps pointing at a lane that no longer owns them — and an empty
 * list answers `null`.
 */
export function pickPrimaryPrRecord(prs: readonly PrRecord[]): PrRecord | null {
  let best: PrRecord | null = null;
  for (const pr of prs) {
    if (pr.detached === true) continue;
    if (best === null || comparePrimaryPr(pr, best) < 0) best = pr;
  }
  return best;
}
