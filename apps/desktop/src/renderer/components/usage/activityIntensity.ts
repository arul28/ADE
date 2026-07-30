import type { AdeUsageDailyPoint } from "../../../shared/types";

/**
 * Single source of truth for a day's activity magnitude. Both the heatmap
 * intensity and the has-activity predicate (dayHasActivity) derive from this,
 * so the two can never drift over which daily-point dimensions count. Every
 * activity dimension is covered: tokens, sessions, interactions, local git
 * commits/PRs/files/lines, and the GitHub-reported counterparts. Counts
 * (sessions, commits, PRs, files) carry heavier weights than raw line counts,
 * which are additive.
 */
export function dayActivityScore(point: AdeUsageDailyPoint): number {
  return (
    point.totalTokens
    + point.sessions * 4_000
    + (point.interactions ?? 0) * 1_500
    + point.commits * 3_000
    + point.prs * 5_000
    + point.filesChanged * 500
    + point.insertions
    + point.deletions
    + (point.githubCommits ?? 0) * 3_000
    + (point.githubPrs ?? 0) * 5_000
    + (point.githubAdditions ?? 0)
    + (point.githubDeletions ?? 0)
  );
}

export function dayHasActivity(point: AdeUsageDailyPoint): boolean {
  return dayActivityScore(point) > 0;
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
