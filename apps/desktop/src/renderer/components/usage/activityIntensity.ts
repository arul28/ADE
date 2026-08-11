import type { AdeUsageDailyPoint } from "../../../shared/types";

/**
 * The dimensions a day's activity is made of, and what each is worth.
 *
 * Every activity dimension is covered: tokens, sessions, interactions, local
 * git commits/PRs/files/lines, and the GitHub-reported counterparts. Local and
 * GitHub counterparts are added together here — deliberately, because this is a
 * "was this a busy day" magnitude, not a reported figure; the numbers the page
 * actually quotes keep the two sources apart.
 *
 * The weights are shares of the total, not raw multipliers, because the
 * dimensions are not in the same units and never can be. The previous version
 * summed them raw — `totalTokens + sessions * 4000 + …` — and with daily token
 * counts running 10⁸–10¹⁰, a session was worth roughly one part in a million of
 * a single day's tokens. Every non-token term was below the rounding noise of
 * the token term, so the "activity" heatmap was a token heatmap wearing a
 * different name. `scoreActivityDays` normalizes each dimension against its own
 * maximum in the series first, so a day of heavy hands-on work with modest
 * token spend can out-rank a day that ran one enormous batch job.
 */
const ACTIVITY_DIMENSIONS: ReadonlyArray<{
  weight: number;
  of: (point: AdeUsageDailyPoint) => number;
}> = [
  { weight: 3, of: (point) => point.totalTokens },
  { weight: 2.5, of: (point) => point.sessions },
  { weight: 2, of: (point) => point.interactions ?? 0 },
  { weight: 1.5, of: (point) => point.commits + (point.githubCommits ?? 0) },
  { weight: 1, of: (point) => point.prs + (point.githubPrs ?? 0) },
  {
    weight: 1,
    of: (point) =>
      point.insertions
      + point.deletions
      + (point.githubAdditions ?? 0)
      + (point.githubDeletions ?? 0),
  },
  { weight: 0.5, of: (point) => point.filesChanged },
];

/**
 * Scores a whole series at once: each dimension is scaled against its own
 * maximum across the series, then the scaled values are combined by weight.
 *
 * Series-relative by necessity — "busy" only means anything next to the other
 * days on screen — which is also why this cannot be a per-point function the
 * way the raw sum it replaces was. Returns one score per input point, in input
 * order. A dimension that is zero everywhere contributes nothing rather than
 * dividing by zero.
 */
export function scoreActivityDays(points: readonly AdeUsageDailyPoint[]): number[] {
  const maxima = ACTIVITY_DIMENSIONS.map((dimension) =>
    points.reduce((max, point) => Math.max(max, dimension.of(point)), 0));
  return points.map((point) =>
    ACTIVITY_DIMENSIONS.reduce((sum, dimension, index) => {
      const max = maxima[index] ?? 0;
      return max > 0 ? sum + dimension.weight * (dimension.of(point) / max) : sum;
    }, 0));
}

/**
 * Did anything at all happen on this day?
 *
 * Kept separate from the score, and deliberately unweighted: a day with one
 * commit and nothing else is an active day even though its normalized score
 * rounds to a rounding error next to a 35-billion-token neighbour. Shares
 * `ACTIVITY_DIMENSIONS` with the score so the two can never disagree about
 * which fields count.
 */
export function dayHasActivity(point: AdeUsageDailyPoint): boolean {
  return ACTIVITY_DIMENSIONS.some((dimension) => dimension.of(point) > 0);
}

/** 0 = no activity; 1-4 = quartile of the non-zero distribution. */
export type ActivityLevel = 0 | 1 | 2 | 3 | 4;

/** Nearest-rank percentile over an ascending-sorted, non-empty array. */
function percentile(sorted: number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] as number;
}

/**
 * Buckets daily activity scores into 5 discrete shades (GitHub's contribution
 * graph approach). A linear value/max ramp is useless here because a single
 * outlier day — one 35.9B-token session is entirely normal — pushes every other
 * day into the same near-floor tone. Quartiles are computed over the NON-ZERO
 * days only, so empty days never dilute the distribution, and the busiest day
 * always lands at level 4 even when the range is flat or has a single spike.
 */
export function bucketActivityIntensity(values: number[]): ActivityLevel[] {
  const active = values.filter((value) => value > 0).sort((a, b) => a - b);
  if (active.length === 0) return values.map(() => 0);

  const max = active[active.length - 1] as number;
  const thresholds = [percentile(active, 0.25), percentile(active, 0.5), percentile(active, 0.75)];

  return values.map((value) => {
    if (value <= 0) return 0;
    if (value >= max) return 4;
    let level = 1;
    for (const threshold of thresholds) {
      if (value > threshold) level += 1;
    }
    return Math.min(4, level) as ActivityLevel;
  });
}

/**
 * The one fact worth reading before you start work, derived from the same score
 * the heatmap is drawn from so the callout and the grid can never disagree.
 *
 * Deliberately one fact, not five: this sits above the composer, and a row of
 * statistics there competes with the input. Priority is by how much the fact
 * would change what you do next — a record day beats a weekly trend, which
 * beats "here is when you were last busy".
 */
export type ActivityInsight =
  /** Latest day is the busiest in `weeks` weeks; `weeks: null` = busiest ever recorded. */
  | { kind: "record"; weeks: number | null }
  /** Last 7 days versus the 7 before, as a whole-percent change. */
  | { kind: "trend"; percent: number }
  /** Fallback: the busiest day in the range, by date key. */
  | { kind: "peak"; date: string };

/** A record/trend claim needs enough history behind it to mean anything. */
const INSIGHT_MIN_RECORD_DAYS = 13;
const INSIGHT_MIN_TREND_DAYS = 14;
const INSIGHT_MIN_TREND_PERCENT = 15;

/** Expects any order; sorts internally. Returns null when nothing is worth saying. */
export function describeActivityInsight(points: AdeUsageDailyPoint[]): ActivityInsight | null {
  const ordered = [...points].sort((a, b) => a.date.localeCompare(b.date));
  if (ordered.length === 0) return null;
  const scores = scoreActivityDays(ordered);
  const lastIndex = scores.length - 1;
  const lastScore = scores[lastIndex] ?? 0;

  // 1. Is the most recent day a record, and how far back does the record run?
  if (lastScore > 0) {
    let back = 0;
    for (let index = lastIndex - 1; index >= 0; index -= 1) {
      if ((scores[index] ?? 0) >= lastScore) break;
      back += 1;
    }
    if (back >= INSIGHT_MIN_RECORD_DAYS) {
      const beatsEverything = back === lastIndex;
      return { kind: "record", weeks: beatsEverything ? null : Math.floor((back + 1) / 7) };
    }
  }

  // 2. Week over week, but only once two full weeks exist to compare.
  if (scores.length >= INSIGHT_MIN_TREND_DAYS) {
    const sum = (values: number[]) => values.reduce((acc, value) => acc + value, 0);
    const thisWeek = sum(scores.slice(-7));
    const lastWeek = sum(scores.slice(-14, -7));
    if (thisWeek > 0 && lastWeek > 0) {
      const percent = Math.round(((thisWeek - lastWeek) / lastWeek) * 100);
      if (Math.abs(percent) >= INSIGHT_MIN_TREND_PERCENT) return { kind: "trend", percent };
    }
  }

  // 3. Otherwise point at the high-water mark in view.
  let peakIndex = -1;
  let peakScore = 0;
  scores.forEach((score, index) => {
    if (score > peakScore) {
      peakScore = score;
      peakIndex = index;
    }
  });
  if (peakIndex < 0) return null;
  return { kind: "peak", date: ordered[peakIndex]!.date };
}

/**
 * Drops leading empty days so the grid sizes to the data instead of the preset.
 * A project with 19 active days would otherwise render a full year of dead
 * cells on the all-time range. Trailing and interior gaps are preserved: today
 * must stay the last cell, and an idle week between two active weeks is signal.
 * Expects date-ascending input; an all-empty series is returned untouched.
 */
export function trimLeadingInactiveDays(points: AdeUsageDailyPoint[]): AdeUsageDailyPoint[] {
  const firstActive = points.findIndex(dayHasActivity);
  return firstActive <= 0 ? points : points.slice(firstActive);
}
