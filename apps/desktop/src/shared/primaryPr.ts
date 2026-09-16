// ---------------------------------------------------------------------------
// Which pull request represents a lane, when only one can be shown.
// ---------------------------------------------------------------------------
//
// PR identity is `(repo, number)`, not the lane's head branch, so one lane
// legitimately owns SEVERAL rows: a follow-up PR cut from the same chat, or a
// colleague's PR referenced from this lane. Every surface with room for exactly
// one PR has to CHOOSE — the lane badge, the chat header, the chat PR pane, the
// TUI lane-details and `/pr` panes, and the deeplink envelope the CLI stamps
// onto `ade://` links.
//
// They must all choose the SAME row. A CLI-minted link that points at a
// different PR than the badge shows is the bug this file prevents, so the rule
// lives in `shared/` where the renderer and the CLI process can both import it.
// It is deliberately NOT in `renderer/lib/lanePrBadge.ts`: that module also
// carries route builders and design tokens, which drag renderer-only modules
// into any CLI program that imports it.
//
// Keep this file free of DOM, React, Electron, and `window.ade`.

import type { PrState } from "./types/prs";

/** Ordering rank: open first, then draft, then anything terminal. */
export function primaryPrStateRank(state: PrState): number {
  switch (state) {
    case "open":
      return 0;
    case "draft":
      return 1;
    case "merged":
      return 2;
    default:
      return 2; // closed
  }
}

export type PrimaryPrComparable = {
  state: PrState;
  updatedAt?: string | null;
  githubPrNumber: number;
};

/**
 * Sort comparator for the primary PR: live work first, then most recently
 * updated, then the highest number.
 *
 * A row with no parseable `updatedAt` sorts AFTER one that has a timestamp
 * rather than being treated as epoch-zero, so a row the runtime has not yet
 * enriched cannot displace a real one.
 */
export function comparePrimaryPr(a: PrimaryPrComparable, b: PrimaryPrComparable): number {
  // A READABLE NUMBER outranks everything else. Every surface renders `#N` or
  // stamps that number onto a deeplink, so a row without one serves none of
  // them. `github_pr_number` has no positive-value constraint and `listAll`
  // returns whatever the row holds, so a 0 can appear and — ranked only by
  // state and recency — win.
  //
  // This rule lives HERE rather than in one caller because that is the whole
  // reason this module exists: the CLI picker had it and the desktop picker did
  // not, so the lane badge and a CLI-minted deeplink could name different PRs,
  // which is exactly the drift the shared module was extracted to prevent.
  const aUsable = a.githubPrNumber > 0;
  const bUsable = b.githubPrNumber > 0;
  if (aUsable !== bUsable) return aUsable ? -1 : 1;
  const byRank = primaryPrStateRank(a.state) - primaryPrStateRank(b.state);
  if (byRank !== 0) return byRank;
  const aUpdated = Date.parse(a.updatedAt ?? "");
  const bUpdated = Date.parse(b.updatedAt ?? "");
  const aHasUpdated = Number.isFinite(aUpdated);
  const bHasUpdated = Number.isFinite(bUpdated);
  if (aHasUpdated !== bHasUpdated) return aHasUpdated ? -1 : 1;
  if (aHasUpdated && aUpdated !== bUpdated) {
    return bUpdated - aUpdated;
  }
  return b.githubPrNumber - a.githubPrNumber;
}

/** The one PR that represents this set, or null when the set is empty. */
export function pickPrimaryPr<T extends PrimaryPrComparable>(prs: readonly T[]): T | null {
  let best: T | null = null;
  for (const pr of prs) {
    if (best === null || comparePrimaryPr(pr, best) < 0) best = pr;
  }
  return best;
}
