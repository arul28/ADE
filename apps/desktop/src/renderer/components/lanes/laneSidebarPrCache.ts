import type { GitHubPrListItem, PrSummary } from "../../../shared/types";

/**
 * The Lanes page's last successful PR list and GitHub snapshot for each
 * project, kept across page mounts. The page clears its PR rows on mount and
 * on a branch change, then reads them again; a revisit paints the cached rows
 * with the first lane rows instead of a frame later. The same reads run as
 * before, and their result replaces these rows when it lands.
 *
 * Keyed by the project's state key, so one project's PRs never paint under
 * another project or machine. PR rows are project-wide and each lane's badges
 * are derived from them at render, so a branch change needs no invalidation
 * here; a failed read clears its scope, the same as the rows on screen.
 */

export type LanePrReads = {
  prs: PrSummary[];
  githubPrs: GitHubPrListItem[];
};

const MAX_LANE_PR_READS_ENTRIES = 8;
const entries = new Map<string, LanePrReads>();

export function readLanePrReadsCache(scope: string | null): LanePrReads | null {
  if (!scope) return null;
  const entry = entries.get(scope);
  if (!entry) return null;
  entries.delete(scope);
  entries.set(scope, entry);
  return entry;
}

export function writeLanePrReadsCache(scope: string | null, patch: Partial<LanePrReads>): void {
  if (!scope) return;
  const previous = entries.get(scope) ?? { prs: [], githubPrs: [] };
  entries.delete(scope);
  entries.set(scope, { ...previous, ...patch });
  while (entries.size > MAX_LANE_PR_READS_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

export function clearLanePrReadsCache(scope: string | null): void {
  if (scope) entries.delete(scope);
}

export function __resetLanePrReadsCacheForTests(): void {
  entries.clear();
}
